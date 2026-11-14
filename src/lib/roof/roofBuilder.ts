/**
 * 程序化建筑屋顶：按建筑轮廓环生成压顶板、女儿墙、挑檐与屋面构筑物。
 *
 * 与底座同一套约定：
 * - 输入为本地场景 XZ 轮廓环（米），逆时针；
 * - 几何以屋顶基准面 y=0 生成，由调用方把 group 放到建筑顶面；
 * - 材质按「屋面板 / 墙体 / 金属 / 玻璃」四路合并，控制 draw call；
 * - 三角面预算内裁剪，并注册距离 LOD（`__reliefCenter` / `__reliefLodDistance`）。
 */
import * as THREE from 'three'
import type {
  PartMaterialConfig,
  RoofConfig,
  RoofEquipmentKind,
  RoofEquipmentPlacement,
  RoofPartKey,
} from '../../shared/types'
import { disposePartTextures, ROOF_PART_KEYS } from '../building/partMaterial'
import {
  decimateRing,
  faceFrameXZ,
  normalizeRingXZ,
  offsetRingXZ,
  resolveFrontFaceIndex,
  ringPerimeter,
  signedAreaXZ,
  type RingXZ,
} from '../podium/podiumBuilder'
import { normalizeRoofConfig } from './roofTypes'

export const ROOF_GROUP_NAME = '__buildingRoof__'
export const ROOF_TRIANGLE_BUDGET = 8000

const MAX_RING_POINTS = 96
const Y_AXIS = new THREE.Vector3(0, 1, 0)

/**
 * 几何函数的历史材质族（屋面板 / 墙体 / 金属 / 玻璃）；
 * 实际落到构件桶由 `withPart` 作用域决定，未包作用域时才用族到构件的默认映射。
 */
type RoofFamilyKey = 'deck' | 'wall' | 'metal' | 'glass'
export type RoofMaterialKey = RoofPartKey | RoofFamilyKey

const FAMILY_TO_PART: Record<RoofFamilyKey, RoofPartKey> = {
  deck: 'deck',
  wall: 'cornice',
  metal: 'infrastructure',
  glass: 'skylight',
}

export interface RoofBuildOptions {
  /** 正面 faceIndex；null/缺省时自动（大门所在面或最长边） */
  frontFaceIndex?: number | null
  triangleBudget?: number
}

export interface RoofBuildResult {
  group: THREE.Group
  stats: { triangles: number; drawCalls: number; clamped: boolean }
}

/* -------------------------------------------------------------------------- */
/* 轮廓环辅助                                                                   */
/* -------------------------------------------------------------------------- */

type Bucket = { positions: number[]; normals: number[]; uvs: number[]; indices: number[] }

function emptyBucket(): Bucket {
  return { positions: [], normals: [], uvs: [], indices: [] }
}

/** 世界空间平面 UV：按主法线轴投影，1 单位 = 1 米，供贴图平铺使用 */
function planarUV(normal: THREE.Vector3, point: THREE.Vector3): [number, number] {
  const ax = Math.abs(normal.x)
  const ay = Math.abs(normal.y)
  const az = Math.abs(normal.z)
  if (ay >= ax && ay >= az) return [point.x, point.z]
  if (ax >= az) return [point.z, point.y]
  return [point.x, point.y]
}

/** 环在 XZ 平面的包围盒 */
function ringBoundsXZ(ring: RingXZ): { minX: number; maxX: number; minZ: number; maxZ: number; cx: number; cz: number } {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const [x, z] of ring) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 }
}

/** 射线法判断点是否在环内 */
function pointInRing(ring: RingXZ, x: number, z: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]
    const [xj, zj] = ring[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside
  }
  return inside
}

/** 确定性伪随机（屋面设备布置用） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 把一条无限直线裁剪到轮廓环内部，返回若干段落在环内的参数区间。
 * 屋面梁 / 天窗条带都必须走这一步，保证任何轮廓（含凹多边形）都不出界。
 */
function clipLineToRing(
  ring: RingXZ,
  ox: number,
  oz: number,
  dir: [number, number],
  tMin: number,
  tMax: number,
  step = 0.28,
): Array<[number, number]> {
  if (tMax - tMin < 0.6) return []
  const samples = Math.max(8, Math.min(600, Math.ceil((tMax - tMin) / step)))
  const intervals: Array<[number, number]> = []
  let start: number | null = null
  for (let i = 0; i <= samples; i++) {
    const t = tMin + ((tMax - tMin) * i) / samples
    const inside = pointInRing(ring, ox + dir[0] * t, oz + dir[1] * t)
    if (inside && start == null) start = t
    if (!inside && start != null) {
      if (t - start > 0.35) intervals.push([start, t])
      start = null
    }
  }
  if (start != null && tMax - start > 0.35) intervals.push([start, tMax])
  return intervals
}

/* -------------------------------------------------------------------------- */
/* 几何构建器                                                                    */
/* -------------------------------------------------------------------------- */

class RoofBuilder {
  private buckets = Object.fromEntries(ROOF_PART_KEYS.map((key) => [key, emptyBucket()])) as Record<
    RoofMaterialKey,
    Bucket
  >
  triangles = 0
  clamped = false
  /** 当前构件作用域：内部子构件统一落到该构件键 */
  private activeKey: RoofPartKey | null = null

  constructor(private readonly budget: number) {}

  /** 在构件作用域内生成几何（同类子构件合并为一个构件材质） */
  withPart(key: RoofPartKey, build: () => void): void {
    const previous = this.activeKey
    this.activeKey = key
    try {
      build()
    } finally {
      this.activeKey = previous
    }
  }

  /** 解析最终构件桶：作用域 > 显式构件键 > 历史材质族默认映射 */
  private resolveKey(key: RoofMaterialKey): RoofPartKey {
    if (this.activeKey) return this.activeKey
    return key in FAMILY_TO_PART ? FAMILY_TO_PART[key as RoofFamilyKey] : (key as RoofPartKey)
  }

  private canAfford(triangles: number): boolean {
    if (this.triangles + triangles <= this.budget) return true
    this.clamped = true
    return false
  }

  private pushTriangle(key: RoofMaterialKey, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, normal: THREE.Vector3): void {
    const bucket = this.buckets[this.resolveKey(key)]
    const base = bucket.positions.length / 3
    const faceNormal = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a),
      new THREE.Vector3().subVectors(c, a),
    )
    const points = faceNormal.dot(normal) < 0 ? [a, c, b] : [a, b, c]
    const n = normal.clone().normalize()
    for (const p of points) {
      bucket.positions.push(p.x, p.y, p.z)
      bucket.normals.push(normal.x, normal.y, normal.z)
      const [u, v] = planarUV(n, p)
      bucket.uvs.push(u, v)
    }
    bucket.indices.push(base, base + 1, base + 2)
    this.triangles += 1
  }

  /** 四边形，按期望法线自动修正绕序 */
  addQuad(key: RoofMaterialKey, points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3], normal: THREE.Vector3): void {
    if (!this.canAfford(2)) return
    const edgeA = new THREE.Vector3().subVectors(points[1], points[0])
    const edgeB = new THREE.Vector3().subVectors(points[2], points[0])
    const faceNormal = new THREE.Vector3().crossVectors(edgeA, edgeB)
    const ordered = faceNormal.dot(normal) < 0 ? [points[0], points[3], points[2], points[1]] : points
    const bucket = this.buckets[this.resolveKey(key)]
    const base = bucket.positions.length / 3
    const n = normal.clone().normalize()
    for (const p of ordered) {
      bucket.positions.push(p.x, p.y, p.z)
      bucket.normals.push(n.x, n.y, n.z)
      const [u, v] = planarUV(n, p)
      bucket.uvs.push(u, v)
    }
    bucket.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    this.triangles += 2
  }

  /**
   * 定向盒体：dir 沿边、outward 为外法线，size = [沿边, 高, 进深]。
   * tilt（弧度）让盒体绕「沿边」轴倾斜，用于倾斜百叶与光伏板。
   */
  addOrientedBox(
    key: RoofMaterialKey,
    center: THREE.Vector3,
    size: [number, number, number],
    dir: [number, number],
    outward: [number, number],
    tilt = 0,
  ): void {
    if (!this.canAfford(12)) return
    const u = new THREE.Vector3(dir[0], 0, dir[1]).normalize()
    const wFlat = new THREE.Vector3(outward[0], 0, outward[1]).normalize()
    let yAxis = Y_AXIS
    let w = wFlat
    if (tilt !== 0) {
      const c = Math.cos(tilt)
      const s = Math.sin(tilt)
      yAxis = Y_AXIS.clone().multiplyScalar(c).addScaledVector(wFlat, s)
      w = wFlat.clone().multiplyScalar(c).addScaledVector(Y_AXIS, -s)
    }
    const halfU = size[0] / 2
    const halfY = size[1] / 2
    const halfW = size[2] / 2
    const p = (su: number, sy: number, sw: number): THREE.Vector3 =>
      center.clone().addScaledVector(u, su * halfU).addScaledVector(yAxis, sy * halfY).addScaledVector(w, sw * halfW)

    const faces: Array<{ pts: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]; n: THREE.Vector3 }> = [
      { pts: [p(1, -1, -1), p(1, -1, 1), p(1, 1, 1), p(1, 1, -1)], n: u.clone() },
      { pts: [p(-1, -1, 1), p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1)], n: u.clone().negate() },
      { pts: [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)], n: w.clone() },
      { pts: [p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1)], n: w.clone().negate() },
      { pts: [p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1)], n: yAxis.clone() },
      { pts: [p(-1, -1, 1), p(1, -1, 1), p(1, -1, -1), p(-1, -1, -1)], n: yAxis.clone().negate() },
    ]
    for (const face of faces) this.addQuad(key, face.pts, face.n)
  }

  /** 轴向盒体（屋面设备箱，尺寸 [x, y, z]） */
  addAxisBox(key: RoofMaterialKey, center: THREE.Vector3, size: [number, number, number]): void {
    this.addOrientedBox(key, center, size, [1, 0], [0, 1])
  }

  /** 环的外立面（竖直环带） */
  addRingWall(key: RoofMaterialKey, ring: RingXZ, y0: number, y1: number): void {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      const dx = b[0] - a[0]
      const dz = b[1] - a[1]
      const len = Math.hypot(dx, dz)
      if (len < 1e-9) continue
      const outward = new THREE.Vector3(dz / len, 0, -dx / len)
      this.addQuad(
        key,
        [
          new THREE.Vector3(a[0], y0, a[1]),
          new THREE.Vector3(b[0], y0, b[1]),
          new THREE.Vector3(b[0], y1, b[1]),
          new THREE.Vector3(a[0], y1, a[1]),
        ],
        outward,
      )
    }
  }

  /** 环之间的水平面 */
  addRingHorizontal(key: RoofMaterialKey, inner: RingXZ, outer: RingXZ, y: number, up: boolean): void {
    const n = Math.min(inner.length, outer.length)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      this.addQuad(
        key,
        [
          new THREE.Vector3(outer[i][0], y, outer[i][1]),
          new THREE.Vector3(outer[j][0], y, outer[j][1]),
          new THREE.Vector3(inner[j][0], y, inner[j][1]),
          new THREE.Vector3(inner[i][0], y, inner[i][1]),
        ],
        new THREE.Vector3(0, up ? 1 : -1, 0),
      )
    }
  }

  /** 封顶：把环三角化成水平板（朝上或朝下） */
  addCap(key: RoofMaterialKey, ring: RingXZ, y: number, up: boolean): void {
    if (ring.length < 3) return
    if (!this.canAfford((ring.length - 2) * 3)) return
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z))
    // 三角化要求轮廓为逆时针；XZ 平面下逆时针与 ShapeUtils 的约定相反
    const oriented = signedAreaXZ(ring) > 0 ? contour : [...contour].reverse()
    const faces = THREE.ShapeUtils.triangulateShape(oriented, [])
    const normal = new THREE.Vector3(0, up ? 1 : -1, 0)
    for (const face of faces) {
      this.pushTriangle(
        key,
        new THREE.Vector3(oriented[face[0]].x, y, oriented[face[0]].y),
        new THREE.Vector3(oriented[face[1]].x, y, oriented[face[1]].y),
        new THREE.Vector3(oriented[face[2]].x, y, oriented[face[2]].y),
        normal,
      )
    }
  }

  /** 竖直方柱 */
  addColumn(key: RoofMaterialKey, x: number, z: number, y0: number, height: number, size: number): void {
    this.addAxisBox(key, new THREE.Vector3(x, y0 + height / 2, z), [size, height, size])
  }

  /** 竖直多棱柱（冷却塔筒身 / 风机筒身），带顶底盖 */
  addPrism(key: RoofMaterialKey, cx: number, cz: number, radius: number, y0: number, y1: number, sides = 12): void {
    const n = Math.max(3, Math.round(sides))
    const ring: RingXZ = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      ring.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius])
    }
    this.addRingWall(key, ring, y0, y1)
    this.addCap(key, ring, y1, true)
    this.addCap(key, ring, y0, false)
  }

  /** 竖直棱台（水箱收口 / 排风筒收口 / 避雷尖）：底半径 r0、顶半径 r1 */
  addTaperPrism(
    key: RoofMaterialKey,
    cx: number,
    cz: number,
    r0: number,
    r1: number,
    y0: number,
    y1: number,
    sides = 12,
  ): void {
    const n = Math.max(3, Math.round(sides))
    const bottom: RingXZ = []
    const top: RingXZ = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      bottom.push([cx + Math.cos(a) * r0, cz + Math.sin(a) * r0])
      top.push([cx + Math.cos(a) * r1, cz + Math.sin(a) * r1])
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const mid = ((i + 0.5) / n) * Math.PI * 2
      this.addQuad(
        key,
        [
          new THREE.Vector3(bottom[i][0], y0, bottom[i][1]),
          new THREE.Vector3(bottom[j][0], y0, bottom[j][1]),
          new THREE.Vector3(top[j][0], y1, top[j][1]),
          new THREE.Vector3(top[i][0], y1, top[i][1]),
        ],
        new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)),
      )
    }
    this.addCap(key, top, y1, true)
    this.addCap(key, bottom, y0, false)
  }

  toGeometry(key: RoofMaterialKey): THREE.BufferGeometry | null {
    const bucket = this.buckets[key]
    if (bucket.indices.length === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2))
    geometry.setIndex(bucket.indices)
    geometry.computeBoundingSphere()
    return geometry
  }

  get drawCalls(): number {
    return (Object.keys(this.buckets) as RoofMaterialKey[]).filter((key) => this.buckets[key].indices.length > 0).length
  }
}

/* -------------------------------------------------------------------------- */
/* 材质：按颜色签名共享                                                          */
/* -------------------------------------------------------------------------- */

const materialCache = new Map<string, THREE.MeshStandardMaterial>()
const MATERIAL_CACHE_LIMIT = 48

/**
 * 构件深度的屏幕空间偏移（1 = 1 个深度缓冲最小单位）。
 *
 * 屋面板只比建筑顶面高 2cm，相机拉远后两者深度分不开，会交替显示成泛白闪烁。
 * 屋面板统一相对建筑本体前移一档；其上的构件再深一档，保证压在屋面板之上。
 */
const ROOF_PART_DEPTH_BIAS: Record<RoofPartKey, number> = {
  deck: -1,
  cornice: -2,
  parapet: -2,
  crown: -2,
  penthouse: -2,
  skylight: -2,
  skylightFrame: -2,
  equipment: -2,
  solar: -2,
  zonePad: -2,
  infrastructure: -2,
}

/** 按构件材质的颜色/金属度/粗糙度签名共享基础材质（贴图由场景层另行克隆补挂） */
function getRoofMaterial(spec: PartMaterialConfig, depthBias = 0): THREE.MeshStandardMaterial {
  const cacheKey = `${spec.color}|${spec.roughness}|${spec.metalness}|${depthBias}`
  const hit = materialCache.get(cacheKey)
  if (hit) {
    materialCache.delete(cacheKey)
    materialCache.set(cacheKey, hit)
    return hit
  }
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(spec.color),
    roughness: spec.roughness,
    metalness: spec.metalness,
  })
  if (depthBias !== 0) {
    material.polygonOffset = true
    material.polygonOffsetFactor = depthBias
    material.polygonOffsetUnits = depthBias
  }
  material.userData.__buildingRoofMaterial = true
  materialCache.set(cacheKey, material)
  if (materialCache.size > MATERIAL_CACHE_LIMIT) {
    const oldest = materialCache.keys().next().value
    if (oldest !== undefined) materialCache.delete(oldest)
  }
  return material
}

/* -------------------------------------------------------------------------- */
/* 距离 LOD 注册表                                                              */
/* -------------------------------------------------------------------------- */

const roofGroups = new Set<THREE.Group>()

export function updateBuildingRoofLod(camera: THREE.Camera): void {
  if (roofGroups.size === 0) return
  const cameraPos = new THREE.Vector3()
  camera.getWorldPosition(cameraPos)
  const world = new THREE.Vector3()
  for (const group of Array.from(roofGroups)) {
    if (!group.parent) {
      roofGroups.delete(group)
      continue
    }
    const center = group.userData.__reliefCenter as THREE.Vector3 | undefined
    if (!center) continue
    const limit = Number(group.userData.__reliefLodDistance) || 140
    world.copy(center).applyMatrix4(group.matrixWorld)
    group.visible = cameraPos.distanceTo(world) <= limit
  }
}

export function clearBuildingRoofRegistry(): void {
  roofGroups.clear()
}

export function disposeBuildingRoofGroup(group: THREE.Object3D | null | undefined): void {
  if (!group) return
  disposePartTextures(group)
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if ((mesh as unknown as { isMesh?: boolean }).isMesh && mesh.geometry) mesh.geometry.dispose()
  })
  group.removeFromParent()
  if (group instanceof THREE.Group) roofGroups.delete(group)
}

export function disposeBuildingRoofMaterialCache(): void {
  for (const material of materialCache.values()) material.dispose()
  materialCache.clear()
}

/* -------------------------------------------------------------------------- */
/* 各类屋顶构件                                                                  */
/* -------------------------------------------------------------------------- */

/** 压顶板（屋面板）+ 可选挑檐线脚 */
function addDeckAndCornice(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  builder.addCap('deck', ring, 0.02, true)
  if (cfg.corniceOffset > 0.05) {
    const outer = offsetRingXZ(ring, cfg.corniceOffset)
    const y0 = -cfg.corniceThickness
    builder.withPart('cornice', () => {
      builder.addRingWall('wall', outer, y0, 0)
      builder.addRingHorizontal('wall', ring, outer, 0, true)
      builder.addRingHorizontal('wall', ring, outer, y0, false)
    })
  }
}

/** 女儿墙：外立面 + 内立面 + 压顶环带 */
function addParapet(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig, height = cfg.parapetHeight): void {
  if (height < 0.05 || cfg.parapetThickness < 0.03) return
  const half = cfg.parapetThickness / 2
  const outer = offsetRingXZ(ring, half)
  const inner = offsetRingXZ(ring, -half)
  builder.withPart('parapet', () => {
    builder.addRingWall('wall', outer, 0, height)
    builder.addRingWall('wall', [...inner].reverse(), 0, height)
    builder.addRingHorizontal('wall', inner, outer, height, true)
  })
}

/** 屋面设备：按种类细化的机组建模（确定性布置，互不重叠） */
type EquipmentKind = RoofEquipmentKind

interface EquipmentFrame {
  x: number
  z: number
  size: number
  height: number
  /** 沿正面方向的单位向量 */
  u: [number, number]
  /** 外法线单位向量 */
  w: [number, number]
}

/** 设备统一落在屋面板上（屋面板顶面约 y = 0.02） */
const EQUIP_Y = 0.02

function vec3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z)
}

/** 空调机组：混凝土基础 + 分缝机柜 + 倾斜检修百叶 + 侧挂控制箱 + 顶部排风筒与防雨帽 */
function addAhu(builder: RoofBuilder, f: EquipmentFrame): void {
  const { x, z, size, u, w } = f
  const h = Math.max(1.1, f.height)
  const d = size * 0.72
  const baseY = EQUIP_Y + 0.2
  builder.addOrientedBox('wall', vec3(x, EQUIP_Y + 0.1, z), [size * 1.14, 0.2, d * 1.14], u, w)
  builder.addOrientedBox('metal', vec3(x, baseY + h / 2, z), [size, h, d], u, w)
  // 顶部压边，避免整块平板顶面
  builder.addOrientedBox('metal', vec3(x, baseY + h + 0.05, z), [size * 1.04, 0.1, d * 1.04], u, w)

  // 外侧面板分缝
  for (const t of [-0.36, 0.02, 0.4]) {
    builder.addOrientedBox(
      'metal',
      vec3(
        x + u[0] * size * t + w[0] * (d / 2 + 0.015),
        baseY + h * 0.52,
        z + u[1] * size * t + w[1] * (d / 2 + 0.015),
      ),
      [0.05, h * 0.84, 0.03],
      u,
      w,
    )
  }

  // 外侧检修百叶：倾斜叶片
  const slats = Math.max(3, Math.min(10, Math.round(h / 0.3)))
  const lx = x + w[0] * (d / 2 + 0.05)
  const lz = z + w[1] * (d / 2 + 0.05)
  for (let i = 0; i < slats; i++) {
    const y = EQUIP_Y + 0.34 + ((h - 0.36) * (i + 0.5)) / slats
    builder.addOrientedBox('metal', vec3(lx, y, lz), [size * 0.82, 0.04, 0.11], u, w, 0.5)
  }

  // 侧挂控制箱
  builder.addOrientedBox(
    'metal',
    vec3(x + u[0] * (size / 2 + 0.11), baseY + h * 0.55, z + u[1] * (size / 2 + 0.11)),
    [0.16, 0.44, 0.3],
    u,
    w,
  )

  // 顶部排风筒（收口）+ 防雨帽
  const sx = x - u[0] * size * 0.26
  const sz = z - u[1] * size * 0.26
  const stackY = baseY + h + 0.1
  const stackH = Math.max(0.5, h * 0.26)
  builder.addTaperPrism('metal', sx, sz, size * 0.16, size * 0.13, stackY, stackY + stackH, 8)
  builder.addTaperPrism('metal', sx, sz, size * 0.13, size * 0.23, stackY + stackH, stackY + stackH + 0.1, 8)
}

/** 冷却塔：混凝土基础 + 十二棱筒身 + 底部进风百叶 + 检修门 + 风机筒身 / 叶片 / 护网 */
function addCoolingTower(builder: RoofBuilder, f: EquipmentFrame): void {
  const { x, z, size, u, w } = f
  const bodyH = Math.max(1.2, f.height * 0.82)
  const r = size * 0.44
  builder.addOrientedBox('wall', vec3(x, EQUIP_Y + 0.1, z), [size * 1.18, 0.2, size * 1.18], u, w)

  const base = EQUIP_Y + 0.2
  builder.addPrism('wall', x, z, r, base, base + bodyH, 12)

  // 底部进风百叶：绕筒身一圈竖窄条
  const louverY = base + bodyH * 0.2
  const louverH = bodyH * 0.26
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    builder.addOrientedBox(
      'metal',
      vec3(x + ca * r * 1.02, louverY, z + sa * r * 1.02),
      [r * 0.42, louverH, 0.06],
      [-sa, ca],
      [ca, sa],
    )
  }

  // 检修门（正面外侧）
  builder.addOrientedBox(
    'metal',
    vec3(x + w[0] * r * 0.99, base + bodyH * 0.52, z + w[1] * r * 0.99),
    [Math.min(0.9, r * 0.72), Math.min(bodyH * 0.4, 1.5), 0.08],
    u,
    w,
  )

  const top = base + bodyH
  builder.addPrism('metal', x, z, r * 1.06, top, top + 0.1, 12)

  // 顶部风机筒身
  const shroudH = Math.max(0.35, bodyH * 0.2)
  const fanBase = top + 0.1
  builder.addPrism('metal', x, z, r * 0.66, fanBase, fanBase + shroudH, 10)

  // 叶片（略微倾斜）
  const yFan = fanBase + shroudH * 0.62
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.45
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    builder.addOrientedBox(
      'metal',
      vec3(x + ca * r * 0.28, yFan, z + sa * r * 0.28),
      [r * 0.92, 0.04, 0.11],
      [ca, sa],
      [-sa, ca],
      0.35,
    )
  }

  // 顶部护网（十字）
  const grillY = fanBase + shroudH + 0.04
  builder.addOrientedBox('metal', vec3(x, grillY, z), [r * 1.28, 0.035, 0.045], [1, 0], [0, 1])
  builder.addOrientedBox('metal', vec3(x, grillY, z), [r * 1.28, 0.035, 0.045], [0, 1], [1, 0])
}

/** 屋顶风机：基础墩 + 阻尼箱 + 十棱筒身 + 顶盖 + 支腿 + 护网 */
function addRoofFan(builder: RoofBuilder, f: EquipmentFrame): void {
  const { x, z, size, u, w } = f
  const s = size * 0.82
  builder.addOrientedBox('wall', vec3(x, EQUIP_Y + 0.15, z), [s, 0.3, s], u, w)
  builder.addOrientedBox('metal', vec3(x, EQUIP_Y + 0.34, z), [s * 0.62, 0.1, s * 0.62], u, w)
  const y0 = EQUIP_Y + 0.4
  const h = Math.max(0.6, f.height * 0.55)
  builder.addPrism('metal', x, z, s * 0.36, y0, y0 + h, 10)
  builder.addPrism('metal', x, z, s * 0.44, y0 + h, y0 + h + 0.08, 10)
  // 支腿
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4
    builder.addColumn('metal', x + Math.cos(a) * s * 0.42, z + Math.sin(a) * s * 0.42, y0, h * 0.9, 0.06)
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    builder.addOrientedBox('metal', vec3(x, y0 + h + 0.11, z), [s * 0.8, 0.035, 0.045], [ca, sa], [-sa, ca])
  }
}

/** 管道组：双管 + 法兰 + 管卡支架 + 端部立管与防雨帽 */
function addDuctRun(builder: RoofBuilder, f: EquipmentFrame, halfLen: number): void {
  const { x, z, size, u, w } = f
  const y = Math.max(0.3, f.height * 0.22)
  const pipe = Math.max(0.14, size * 0.1)
  for (const k of [-1, 1]) {
    const off = k * Math.max(0.28, size * 0.19)
    builder.addOrientedBox(
      'metal',
      vec3(x + w[0] * off, y, z + w[1] * off),
      [halfLen * 2, pipe * 2, pipe * 2],
      u,
      w,
    )
    // 法兰
    for (const t of [-0.52, 0.52]) {
      builder.addOrientedBox(
        'metal',
        vec3(x + u[0] * halfLen * t + w[0] * off, y, z + u[1] * halfLen * t + w[1] * off),
        [0.06, pipe * 2.6, pipe * 2.6],
        u,
        w,
      )
    }
  }
  // 管卡支架
  for (const t of [-0.62, 0, 0.62]) {
    builder.addOrientedBox(
      'metal',
      vec3(x + u[0] * halfLen * t, y / 2, z + u[1] * halfLen * t),
      [0.1, y, Math.max(0.4, size * 0.6)],
      u,
      w,
    )
  }
  // 端部立管 + 防雨帽
  const ex = x + u[0] * halfLen
  const ez = z + u[1] * halfLen
  const riserH = Math.max(0.5, y + 0.6)
  builder.addOrientedBox('metal', vec3(ex, y + riserH / 2, ez), [pipe * 2.2, riserH, pipe * 2.2], u, w)
  builder.addOrientedBox('metal', vec3(ex, y + riserH + 0.04, ez), [pipe * 3.0, 0.08, pipe * 3.0], u, w)
}

/** 太阳能板阵列：滑轨底座 + 支柱 + 两排三列倾斜光伏板 */
function addSolarArray(builder: RoofBuilder, f: EquipmentFrame): void {
  const { x, z, size, u, w } = f
  const cols = 3
  const rows = 2
  const tilt = 0.42
  const panelU = (size / cols) * 0.94
  const panelD = size * 0.46

  // 滑轨
  for (const k of [-1, 1]) {
    builder.addOrientedBox(
      'metal',
      vec3(x + w[0] * k * size * 0.24, EQUIP_Y + 0.09, z + w[1] * k * size * 0.24),
      [size * 1.02, 0.12, 0.14],
      u,
      w,
    )
  }
  // 支柱
  for (const cu of [-0.32, 0, 0.32]) {
    builder.addOrientedBox(
      'metal',
      vec3(x + u[0] * size * cu, EQUIP_Y + 0.28, z + u[1] * size * cu),
      [0.1, 0.44, size * 0.56],
      u,
      w,
    )
  }
  // 光伏板：2 排 3 列，向正面方向倾斜
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const offU = (c - (cols - 1) / 2) * (size / cols)
      const offW = (r - (rows - 1) / 2) * size * 0.52
      builder.addOrientedBox(
        'glass',
        vec3(x + u[0] * offU + w[0] * offW, EQUIP_Y + 0.58, z + u[1] * offU + w[1] * offW),
        [panelU, 0.06, panelD],
        u,
        w,
        tilt,
      )
    }
  }
}

/** 水箱：混凝土基础 + 十二棱筒身 + 加强箍 + 锥台收口 + 检修梯 + 人孔 */
function addWaterTank(builder: RoofBuilder, f: EquipmentFrame): void {
  const { x, z, size, u, w } = f
  const r = size * 0.42
  const h = Math.max(1.4, f.height * 0.9)
  builder.addOrientedBox('wall', vec3(x, EQUIP_Y + 0.1, z), [size * 1.08, 0.2, size * 1.08], u, w)
  const base = EQUIP_Y + 0.2
  const bodyH = h * 0.84
  builder.addPrism('metal', x, z, r, base, base + bodyH, 12)
  builder.addTaperPrism('metal', x, z, r, r * 0.4, base + bodyH, base + h, 12)
  // 加强箍
  for (const t of [0.28, 0.56]) {
    builder.addPrism('metal', x, z, r * 1.02, base + bodyH * t, base + bodyH * t + 0.07, 12)
  }
  // 检修梯
  const lx = x + w[0] * (r + 0.14)
  const lz = z + w[1] * (r + 0.14)
  for (let i = 0; i < 4; i++) {
    builder.addOrientedBox(
      'metal',
      vec3(lx, base + 0.4 + ((bodyH - 0.5) * i) / 3, lz),
      [0.44, 0.035, 0.035],
      u,
      w,
    )
  }
  // 顶部人孔
  builder.addPrism('metal', x + u[0] * r * 0.4, z + u[1] * r * 0.4, r * 0.16, base + h, base + h + 0.18, 8)
}

/** 天线杆：配重底座 + 细杆 + 横臂 + 三面扇区天线 + 避雷尖 */
function addAntennaMast(builder: RoofBuilder, f: EquipmentFrame): void {
  const { x, z, size, u, w } = f
  const h = Math.max(2.6, f.height * 1.35)
  const pad = Math.max(0.7, size * 0.42)
  builder.addOrientedBox('wall', vec3(x, EQUIP_Y + 0.12, z), [pad, 0.24, pad], u, w)
  const base = EQUIP_Y + 0.24
  const r = Math.max(0.07, size * 0.055)
  builder.addPrism('metal', x, z, r, base, base + h, 6)
  // 横臂
  for (const t of [0.56, 0.76]) {
    builder.addOrientedBox('metal', vec3(x, base + h * t, z), [Math.max(0.6, size * 0.52), 0.05, 0.05], u, w)
  }
  // 扇区天线
  const ar = Math.max(0.16, size * 0.14)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.6
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    builder.addOrientedBox(
      'metal',
      vec3(x + ca * ar, base + h * 0.68, z + sa * ar),
      [0.24, 0.55, 0.06],
      [-sa, ca],
      [ca, sa],
    )
  }
  // 避雷尖
  builder.addTaperPrism('metal', x, z, 0.04, 0.006, base + h, base + h + Math.max(0.35, h * 0.12), 4)
}

/** 屋面分区平台：贴合轮廓的分层薄板 + 边缘矮挡边 */
function addZonePad(
  builder: RoofBuilder,
  ring: RingXZ,
  frame: NonNullable<ReturnType<typeof faceFrameXZ>>,
  d0: number,
  d1: number,
  plateKey: RoofMaterialKey,
  withFrontCurb: boolean,
): void {
  const depth = d1 - d0
  if (depth < 1.0) return
  const u = frame.dir
  const w = frame.outward
  const half = ringPerimeter(ring) * 0.5 + 4
  const strips = Math.max(1, Math.ceil(depth / 1.6))
  const strip = depth / strips

  for (let i = 0; i < strips; i++) {
    const d = d0 + strip * (i + 0.5)
    const ox = frame.mid[0] - w[0] * d
    const oz = frame.mid[1] - w[1] * d
    for (const [t0, t1] of clipLineToRing(ring, ox, oz, u, -half, half)) {
      const len = t1 - t0
      if (len < 0.9) continue
      const tc = (t0 + t1) / 2
      builder.addOrientedBox(
        plateKey,
        vec3(ox + u[0] * tc, EQUIP_Y + 0.01, oz + u[1] * tc),
        [len, 0.04, strip * 0.96],
        u,
        w,
      )
      // 行端挡边，随轮廓形成阶梯边
      for (const t of [t0 + 0.06, t1 - 0.06]) {
        builder.addOrientedBox(
          'metal',
          vec3(ox + u[0] * t, EQUIP_Y + 0.09, oz + u[1] * t),
          [0.1, 0.16, strip * 0.96],
          u,
          w,
        )
      }
    }
  }

  // 分区边界矮挡边（前后各一道，避免与相邻分区重复绘制）
  const curbAt = (d: number): void => {
    const ox = frame.mid[0] - w[0] * d
    const oz = frame.mid[1] - w[1] * d
    for (const [t0, t1] of clipLineToRing(ring, ox, oz, u, -half, half)) {
      const len = t1 - t0
      if (len < 0.9) continue
      const tc = (t0 + t1) / 2
      builder.addOrientedBox('metal', vec3(ox + u[0] * tc, EQUIP_Y + 0.09, oz + u[1] * tc), [len, 0.16, 0.1], u, w)
    }
  }
  if (withFrontCurb) curbAt(d0 + 0.05)
  curbAt(d1 - 0.05)
}

/**
 * 单台设备的独立平台：面板 + 四周金属收边。
 * 用于无法确定正面、无法按分区铺设整片平台的手动放置场景。
 */
function addPlacedPad(
  builder: RoofBuilder,
  x: number,
  z: number,
  side: number,
  u: [number, number],
  w: [number, number],
): void {
  const half = side / 2
  builder.addOrientedBox('wall', vec3(x, EQUIP_Y + 0.02, z), [side, 0.04, side], u, w)
  const y = EQUIP_Y + 0.1
  const rim = 0.08
  builder.addOrientedBox('metal', vec3(x + u[0] * (half - rim / 2), y, z + u[1] * (half - rim / 2)), [rim, 0.16, side], u, w)
  builder.addOrientedBox('metal', vec3(x - u[0] * (half - rim / 2), y, z - u[1] * (half - rim / 2)), [rim, 0.16, side], u, w)
  builder.addOrientedBox('metal', vec3(x + w[0] * (half - rim / 2), y, z + w[1] * (half - rim / 2)), [side, 0.16, rim], u, w)
  builder.addOrientedBox('metal', vec3(x - w[0] * (half - rim / 2), y, z - w[1] * (half - rim / 2)), [side, 0.16, rim], u, w)
}

/**
 * 屋面设备：按分区确定性布置（正面通道之后依次为设备区与光伏区），
 * 分区平台只为实际用到的类型铺设，设备之间做最小间距避让。
 */
function addEquipment(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  const count = Math.round(cfg.equipmentCount)
  if (count <= 0) return
  const bounds = ringBoundsXZ(ring)
  const rand = mulberry32(cfg.seed * 977 + 13)
  const margin = Math.max(cfg.equipmentSize * 0.7, 0.8)
  const innerRing = offsetRingXZ(ring, -margin * 0.6)
  const spanX = bounds.maxX - bounds.minX
  const spanZ = bounds.maxZ - bounds.minZ

  const frontIndex = resolveFrontFaceIndex(ring, cfg.frontFace)
  const frame = frontIndex == null ? null : faceFrameXZ(ring, frontIndex)
  const u: [number, number] = frame ? frame.dir : [1, 0]
  const w: [number, number] = frame ? frame.outward : [0, 1]
  const mid = frame ? frame.mid : null

  // 分区：正面留通道，其后按「设备区 → 光伏区」沿进深方向切分
  interface Zone {
    kind: 'mech' | 'solar'
    d0: number
    d1: number
  }
  const zones: Zone[] = []
  if (frame && mid && Math.min(spanX, spanZ) >= 5.5) {
    let maxDepth = 0
    for (const [x, z] of ring) {
      const d = -((x - mid[0]) * w[0] + (z - mid[1]) * w[1])
      if (d > maxDepth) maxDepth = d
    }
    const access = Math.max(0.9, cfg.parapetThickness + 0.75) + 1.25
    const rear = maxDepth - 0.45
    const usable = rear - access
    if (usable > 3.4) {
      // 设备数够多且光伏配额不为 0 时才拆「设备区 / 光伏区」
      if (count >= 3 && cfg.solarZoneQuota > 0.01) {
        const split = access + usable * Math.min(0.85, Math.max(0.3, cfg.mechZoneRatio))
        zones.push({ kind: 'mech', d0: access, d1: split })
        zones.push({ kind: 'solar', d0: split, d1: rear })
      } else {
        zones.push({ kind: 'mech', d0: access, d1: rear })
      }
    }
  }
  const allowSolar = zones.some((zn) => zn.kind === 'solar')

  // 按分区配额确定类型：光伏区只放光伏板，设备区混合机组（数量够时含一根天线杆）
  const plans: Array<{ zone: 'mech' | 'solar'; target: number }> = []
  if (allowSolar && count >= 3) {
    const quota = Math.min(0.8, Math.max(0, cfg.solarZoneQuota))
    const solarTarget = Math.min(count - 1, Math.max(1, Math.round(count * quota)))
    plans.push({ zone: 'solar', target: solarTarget })
    plans.push({ zone: 'mech', target: count - solarTarget })
  } else {
    plans.push({ zone: 'mech', target: count })
  }
  const pickMechKind = (): EquipmentKind => {
    const r = rand()
    return r < 0.34 ? 'ahu' : r < 0.62 ? 'tower' : r < 0.82 ? 'fan' : r < 0.93 ? 'duct' : 'tank'
  }

  const placed: Array<{ x: number; z: number; r: number; zone: 'mech' | 'solar' }> = []
  for (const plan of plans) {
    const zone = zones.find((zn) => zn.kind === plan.zone)
    let mastUsed = false
    let done = 0
    for (let i = 0; i < plan.target * 40 && done < plan.target; i++) {
      let kind: EquipmentKind = plan.zone === 'solar' ? 'solar' : pickMechKind()
      if (plan.zone === 'mech' && !mastUsed && count >= 5) {
        kind = 'mast'
        mastUsed = true
      }
      const size = cfg.equipmentSize * (0.8 + rand() * 0.4)
      const height = cfg.equipmentHeight * (0.75 + rand() * 0.5)
      const x = bounds.minX + margin + rand() * Math.max(0.01, spanX - margin * 2)
      const z = bounds.minZ + margin + rand() * Math.max(0.01, spanZ - margin * 2)
      if (!pointInRing(innerRing, x, z)) continue

      if (zone && mid) {
        const d = -((x - mid[0]) * w[0] + (z - mid[1]) * w[1])
        if (d < zone.d0 + 0.2 || d > zone.d1 - 0.2) continue
      }

      let radius = size * 0.62
      let halfLen = 0
      if (kind === 'duct') {
        halfLen = Math.min(size * 2.2, 6) / 2
        // 管道两端都必须落在轮廓内，否则这一轮换点重试
        const endsInside =
          pointInRing(innerRing, x + u[0] * halfLen, z + u[1] * halfLen) &&
          pointInRing(innerRing, x - u[0] * halfLen, z - u[1] * halfLen)
        if (!endsInside) continue
        radius = Math.max(size * 0.3, halfLen)
      } else if (kind === 'solar') {
        radius = size * 0.66
      } else if (kind === 'tank') {
        radius = size * 0.48
      } else if (kind === 'tower') {
        radius = size * 0.56
      } else if (kind === 'fan') {
        radius = size * 0.5
      } else if (kind === 'mast') {
        radius = Math.max(0.45, size * 0.3)
      }

      const clash = placed.some((p) => Math.hypot(p.x - x, p.z - z) < (p.r + radius) * 0.92)
      if (clash) continue

      placed.push({ x, z, r: radius, zone: plan.zone })
      const ef: EquipmentFrame = { x, z, size, height, u, w }
      if (kind === 'ahu') builder.withPart('equipment', () => addAhu(builder, ef))
      else if (kind === 'tower') builder.withPart('equipment', () => addCoolingTower(builder, ef))
      else if (kind === 'fan') builder.withPart('equipment', () => addRoofFan(builder, ef))
      else if (kind === 'solar') builder.withPart('solar', () => addSolarArray(builder, ef))
      else if (kind === 'tank') builder.withPart('equipment', () => addWaterTank(builder, ef))
      else if (kind === 'mast') builder.withPart('equipment', () => addAntennaMast(builder, ef))
      else builder.withPart('infrastructure', () => addDuctRun(builder, ef, halfLen))
      done++
    }
  }

  // 分区平台：只为实际放了设备的分区铺设，相邻分区共用一条挡边
  if (frame) {
    let curbDrawn = false
    for (const zone of zones) {
      if (!placed.some((p) => p.zone === zone.kind)) continue
      builder.withPart('zonePad', () =>
        addZonePad(builder, ring, frame, zone.d0, zone.d1, zone.kind === 'solar' ? 'metal' : 'wall', !curbDrawn),
      )
      curbDrawn = true
    }
  }
}

/**
 * 手动放置的屋面设备：按点击位置逐个生成，无数量上限。
 * 位置为建筑局部 XZ（场景米），落在轮廓外时跳过。
 */
function addPlacedEquipment(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  const items: RoofEquipmentPlacement[] = cfg.equipment ?? []
  if (!items.length) return
  const margin = Math.max(cfg.equipmentSize * 0.35, 0.4)
  const innerRing = offsetRingXZ(ring, -margin)
  const frontIndex = resolveFrontFaceIndex(ring, cfg.frontFace)
  const frame = frontIndex == null ? null : faceFrameXZ(ring, frontIndex)
  const u: [number, number] = frame ? frame.dir : [1, 0]
  const w: [number, number] = frame ? frame.outward : [0, 1]
  const mid = frame ? frame.mid : null
  const size = Math.max(0.5, cfg.equipmentSize)
  const height = Math.max(0.5, cfg.equipmentHeight)
  const placed: Array<{ x: number; z: number; d: number | null }> = []

  for (const item of items) {
    if (!Number.isFinite(item.x) || !Number.isFinite(item.z)) continue
    if (innerRing.length >= 3 && !pointInRing(innerRing, item.x, item.z)) continue
    const ef: EquipmentFrame = { x: item.x, z: item.z, size, height, u, w }
    if (item.kind === 'ahu') builder.withPart('equipment', () => addAhu(builder, ef))
    else if (item.kind === 'tower') builder.withPart('equipment', () => addCoolingTower(builder, ef))
    else if (item.kind === 'fan') builder.withPart('equipment', () => addRoofFan(builder, ef))
    else if (item.kind === 'solar') builder.withPart('solar', () => addSolarArray(builder, ef))
    else if (item.kind === 'tank') builder.withPart('equipment', () => addWaterTank(builder, ef))
    else if (item.kind === 'mast') builder.withPart('equipment', () => addAntennaMast(builder, ef))
    else {
      builder.withPart('infrastructure', () =>
        addDuctRun(builder, ef, Math.min(size * 2.2, 6) / 2),
      )
    }
    placed.push({
      x: item.x,
      z: item.z,
      d: mid ? -((item.x - mid[0]) * w[0] + (item.z - mid[1]) * w[1]) : null,
    })
  }

  // 设备区平台：与自动布置一致，按手动设备的实际进深范围铺设 zonePad 平台（含金属挡边）
  if (frame && mid && placed.length) {
    const depths = placed.map((p) => p.d).filter((d): d is number => d != null)
    if (depths.length) {
      const padMargin = Math.max(0.6, size * 0.4)
      const d0 = Math.max(0.35, Math.min(...depths) - padMargin)
      const d1 = Math.max(...depths) + padMargin
      if (d1 - d0 >= 0.8) {
        builder.withPart('zonePad', () => addZonePad(builder, ring, frame, d0, d1, 'wall', true))
      }
    }
  } else if (placed.length) {
    // 无法确定正面时按单台设备铺小平台，保证「设备区平台」不缺失
    const pad = Math.max(1.4, size * 1.6)
    for (const p of placed) {
      builder.withPart('zonePad', () => addPlacedPad(builder, p.x, p.z, pad, u, w))
    }
  }
}

/** 屋面设备入口：有手动放置列表时逐个生成，否则回退旧版确定性布置 */
function addRoofEquipment(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  if ((cfg.equipment ?? []).length) addPlacedEquipment(builder, ring, cfg)
  else addEquipment(builder, ring, cfg)
}

/** 透气管：细筒 + 横弯头 + 防雨帽 */
function addVentPipe(builder: RoofBuilder, x: number, z: number, cfg: RoofConfig): void {
  const h = 0.7 + (cfg.seed % 5) * 0.08
  builder.addPrism('metal', x, z, 0.085, EQUIP_Y, EQUIP_Y + h, 6)
  builder.addOrientedBox('metal', vec3(x, EQUIP_Y + h + 0.04, z), [0.4, 0.1, 0.1], [1, 0], [0, 1])
  builder.addPrism('metal', x, z, 0.13, EQUIP_Y + h, EQUIP_Y + h + 0.06, 6)
}

/**
 * 屋面基础设施：正面检修步道 + 内侧护栏 + 透气管 + 检修口 + 避雷针。
 * 步道与配件都按轮廓裁剪/校验，任何轮廓都不会伸到屋面之外。
 */
function addRoofInfrastructure(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  const bounds = ringBoundsXZ(ring)
  const spanX = bounds.maxX - bounds.minX
  const spanZ = bounds.maxZ - bounds.minZ
  if (Math.min(spanX, spanZ) < 5.5) return

  const frontIndex = resolveFrontFaceIndex(ring, cfg.frontFace)
  const frame = frontIndex == null ? null : faceFrameXZ(ring, frontIndex)
  if (!frame) return

  const u = frame.dir
  const w = frame.outward
  const inset = Math.max(0.9, cfg.parapetThickness + 0.75)
  const ox = frame.mid[0] - w[0] * inset
  const oz = frame.mid[1] - w[1] * inset
  const half = frame.width / 2 + inset
  const railOff = 0.55

  // 检修步道：沿正面内侧，逐段裁剪到轮廓内
  const intervals = clipLineToRing(ring, ox, oz, u, -half, half)
  for (const [t0, t1] of intervals) {
    const len = t1 - t0
    const segs = Math.max(1, Math.ceil(len / 2.2))
    const seg = len / segs
    for (let i = 0; i < segs; i++) {
      const tc = t0 + seg * (i + 0.5)
      const cx = ox + u[0] * tc
      const cz = oz + u[1] * tc
      builder.addOrientedBox('metal', vec3(cx, EQUIP_Y + 0.06, cz), [seg - 0.06, 0.1, 1.0], u, w)
      // 内侧护栏：立柱 + 双横杆
      const rx = cx - w[0] * railOff
      const rz = cz - w[1] * railOff
      for (const t of [tc - seg / 2 + 0.05, tc + seg / 2 - 0.05]) {
        builder.addColumn(
          'metal',
          ox + u[0] * t - w[0] * railOff,
          oz + u[1] * t - w[1] * railOff,
          EQUIP_Y + 0.11,
          0.92,
          0.06,
        )
      }
      for (const y of [0.58, 0.88]) {
        builder.addOrientedBox('metal', vec3(rx, EQUIP_Y + 0.11 + y, rz), [seg - 0.04, 0.045, 0.045], u, w)
      }
    }
  }

  // 透气管：避开正面步道，确定性落点
  const rand = mulberry32(cfg.seed * 313 + 7)
  let pipes = 0
  for (let attempt = 0; attempt < 10 && pipes < 2; attempt++) {
    const px = bounds.minX + 1.1 + rand() * Math.max(0.01, spanX - 2.2)
    const pz = bounds.minZ + 1.1 + rand() * Math.max(0.01, spanZ - 2.2)
    if (!pointInRing(ring, px, pz)) continue
    const inward = -((px - frame.mid[0]) * w[0] + (pz - frame.mid[1]) * w[1])
    if (inward < inset + 1.2) continue
    addVentPipe(builder, px, pz, cfg)
    pipes++
  }

  // 检修口：步道端头的方形上翻框
  const hatchT = intervals[0] ? (intervals[0][0] + intervals[0][1]) / 2 : 0
  const hx = ox + u[0] * hatchT - w[0] * 1.1
  const hz = oz + u[1] * hatchT - w[1] * 1.1
  if (pointInRing(ring, hx, hz)) {
    builder.addOrientedBox('metal', vec3(hx, EQUIP_Y + 0.12, hz), [1.0, 0.2, 0.78], u, w)
    builder.addOrientedBox('metal', vec3(hx, EQUIP_Y + 0.24, hz), [1.12, 0.06, 0.9], u, w)
  }

  // 避雷针：落在最外侧轮廓折点内侧
  const ccx = bounds.cx
  const ccz = bounds.cz
  let bx = ring[0][0]
  let bz = ring[0][1]
  let best = -1
  for (const [x, z] of ring) {
    const d = (x - ccx) ** 2 + (z - ccz) ** 2
    if (d > best) {
      best = d
      bx = x
      bz = z
    }
  }
  const dl = Math.hypot(ccx - bx, ccz - bz) || 1
  const offset = cfg.parapetThickness * 0.5 + 0.3
  const mx = bx + ((ccx - bx) / dl) * offset
  const mz = bz + ((ccz - bz) / dl) * offset
  builder.addColumn('metal', mx, mz, EQUIP_Y + 0.02, 1.1, 0.08)
  builder.addTaperPrism('metal', mx, mz, 0.045, 0.004, EQUIP_Y + 1.12, EQUIP_Y + 1.5, 4)
}

/**
 * 架空格栅冠：贴合轮廓的外圈梁 + 环顶点立柱 + 仅落在轮廓内的井字梁。
 * 所有梁都按轮廓裁剪，非矩形/凹多边形也不会伸出屋顶。
 */
function addLatticeCrown(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  const height = Math.max(0.6, cfg.crownHeight)
  const bar = Math.max(0.12, cfg.crownThickness)
  const yTop = height - bar / 2
  const n = ring.length

  // 外圈梁：向内缩半个梁厚，梁外沿与屋顶轮廓齐平
  const beamRing = offsetRingXZ(ring, -bar / 2)
  for (let i = 0; i < n; i++) {
    const a = beamRing[i]
    const b = beamRing[(i + 1) % n]
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) continue
    builder.addOrientedBox(
      'metal',
      new THREE.Vector3((a[0] + b[0]) / 2, yTop, (a[1] + b[1]) / 2),
      [len, bar, bar],
      [dx / len, dz / len],
      [dz / len, -dx / len],
    )
  }

  // 立柱：落在外圈梁的每个折点上
  for (const [x, z] of beamRing) builder.addColumn('metal', x, z, 0, height, bar)

  // 井字梁：按正面方向建立局部轴，逐条线裁剪到轮廓内
  const bounds = ringBoundsXZ(ring)
  const frontIndex = resolveFrontFaceIndex(ring, cfg.frontFace)
  const frame = frontIndex == null ? null : faceFrameXZ(ring, frontIndex)
  const u: [number, number] = frame ? frame.dir : [1, 0]
  const w: [number, number] = frame ? frame.outward : [0, 1]
  const mid: [number, number] = frame ? frame.mid : [bounds.cx, bounds.cz]

  let minU = Infinity
  let maxU = -Infinity
  let minW = Infinity
  let maxW = -Infinity
  for (const [x, z] of ring) {
    const px = x - mid[0]
    const pz = z - mid[1]
    const pu = px * u[0] + pz * u[1]
    const pw = px * w[0] + pz * w[1]
    if (pu < minU) minU = pu
    if (pu > maxU) maxU = pu
    if (pw < minW) minW = pw
    if (pw > maxW) maxW = pw
  }

  const crownCount = Math.max(1, Math.round(cfg.crownCount))
  for (let i = 1; i < crownCount; i++) {
    const t = i / crownCount
    // 沿 u 方向、固定 w 偏移的梁
    const offsetW = minW + (maxW - minW) * t
    const oxU = mid[0] + w[0] * offsetW
    const ozU = mid[1] + w[1] * offsetW
    for (const [a, b] of clipLineToRing(ring, oxU, ozU, u, minU, maxU)) {
      const len = b - a - bar
      if (len < 0.5) continue
      const c = (a + b) / 2
      builder.addOrientedBox(
        'metal',
        new THREE.Vector3(oxU + u[0] * c, yTop, ozU + u[1] * c),
        [len, bar, bar],
        u,
        w,
      )
    }

    // 沿 w 方向、固定 u 偏移的梁
    const offsetU = minU + (maxU - minU) * t
    const oxW = mid[0] + u[0] * offsetU
    const ozW = mid[1] + u[1] * offsetU
    for (const [a, b] of clipLineToRing(ring, oxW, ozW, w, minW, maxW)) {
      const len = b - a - bar
      if (len < 0.5) continue
      const c = (a + b) / 2
      builder.addOrientedBox(
        'metal',
        new THREE.Vector3(oxW + w[0] * c, yTop, ozW + w[1] * c),
        [len, bar, bar],
        w,
        u,
      )
    }
  }
}

/** 偏置屋顶机房：贴在正面一侧，向内延伸 */
function addPenthouse(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  const frontIndex = resolveFrontFaceIndex(ring, cfg.frontFace)
  const frame = frontIndex == null ? null : faceFrameXZ(ring, frontIndex)
  if (!frame) return
  const bounds = ringBoundsXZ(ring)
  const depthLimit = Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
  const width = Math.min(Math.max(3, frame.width * cfg.penthouseWidthRatio), frame.width * 0.92)
  const depth = Math.min(Math.max(2, depthLimit * cfg.penthouseDepthRatio), Math.max(2, depthLimit - 1.2))
  const outward = new THREE.Vector3(frame.outward[0], 0, frame.outward[1])
  const mid = new THREE.Vector3(frame.mid[0], 0, frame.mid[1])
  const center = mid.clone().addScaledVector(outward, -(cfg.penthouseInset + depth / 2))
  builder.addOrientedBox(
    'wall',
    new THREE.Vector3(center.x, cfg.penthouseHeight / 2, center.z),
    [width, cfg.penthouseHeight, depth],
    frame.dir,
    frame.outward,
  )
  // 机房顶部的深色压边，避免大面积浅色顶面
  builder.addOrientedBox(
    'deck',
    new THREE.Vector3(center.x, cfg.penthouseHeight + 0.06, center.z),
    [width + 0.3, 0.12, depth + 0.3],
    frame.dir,
    frame.outward,
  )
}

/**
 * 分格天窗带：沿正面方向的等距条带，每条都裁剪到轮廓内部，
 * 长条在凹多边形里会自动断成多段，不会探出屋顶。
 */
function addSkylights(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  const count = Math.round(cfg.skylightCount)
  if (count <= 0) return
  const bounds = ringBoundsXZ(ring)
  const frontIndex = resolveFrontFaceIndex(ring, cfg.frontFace)
  const frame = frontIndex == null ? null : faceFrameXZ(ring, frontIndex)
  const u: [number, number] = frame ? frame.dir : [1, 0]
  const w: [number, number] = frame ? frame.outward : [0, 1]
  const mid: [number, number] = frame ? frame.mid : [bounds.cx, bounds.cz]

  let minU = Infinity
  let maxU = -Infinity
  let minW = Infinity
  let maxW = -Infinity
  for (const [x, z] of ring) {
    const px = x - mid[0]
    const pz = z - mid[1]
    const pu = px * u[0] + pz * u[1]
    const pw = px * w[0] + pz * w[1]
    if (pu < minU) minU = pu
    if (pu > maxU) maxU = pu
    if (pw < minW) minW = pw
    if (pw > maxW) maxW = pw
  }
  const spanW = maxW - minW
  if (spanW < 1.2) return

  const endMargin = 0.7
  const stripWidth = Math.max(0.4, Math.min(cfg.skylightWidth, (spanW / count) * 0.7))
  const height = Math.max(0.05, cfg.skylightHeight)

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : (i + 0.5) / count
    const offsetW = minW + spanW * t
    const ox = mid[0] + w[0] * offsetW
    const oz = mid[1] + w[1] * offsetW
    for (const [a, b] of clipLineToRing(ring, ox, oz, u, minU, maxU)) {
      const len = b - a - endMargin * 2
      if (len < 1.2) continue
      const c = (a + b) / 2
      const cx = ox + u[0] * c
      const cz = oz + u[1] * c
      builder.withPart('skylight', () =>
        builder.addOrientedBox('glass', new THREE.Vector3(cx, height / 2, cz), [len, height, stripWidth], u, w),
      )
      builder.withPart('skylightFrame', () =>
        builder.addOrientedBox(
          'metal',
          new THREE.Vector3(cx, height + 0.06, cz),
          [len + 0.16, 0.1, stripWidth + 0.16],
          u,
          w,
        ),
      )
    }
  }
}

/** 悬挑薄檐口：外挑压顶板 + 檐下阴影线 */
function addEave(builder: RoofBuilder, ring: RingXZ, cfg: RoofConfig): void {
  if (cfg.eaveOffset < 0.05) return
  const outer = offsetRingXZ(ring, cfg.eaveOffset)
  const y0 = -cfg.eaveThickness
  builder.addRingWall('wall', outer, y0, 0)
  builder.addRingHorizontal('wall', ring, outer, 0, true)
  builder.addRingHorizontal('wall', ring, outer, y0, false)
}

/* -------------------------------------------------------------------------- */
/* 主入口                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 构建建筑屋顶（y 基准为建筑顶面，group 由调用方定位）。
 *
 * @param ringXZ 建筑轮廓环（本地场景 XZ，米）
 * @param config 屋顶配置
 * @param options 正面 faceIndex / 三角面预算
 */
export function buildBuildingRoof(
  ringXZ: RingXZ,
  config: RoofConfig,
  options: RoofBuildOptions = {},
): RoofBuildResult | null {
  const cfg = normalizeRoofConfig(config)
  if (!cfg || !cfg.enabled) return null

  const ring = decimateRing(normalizeRingXZ(ringXZ), MAX_RING_POINTS)
  if (ring.length < 3) return null
  if (cfg.frontFace == null && options.frontFaceIndex != null) cfg.frontFace = options.frontFaceIndex

  const builder = new RoofBuilder(options.triangleBudget ?? ROOF_TRIANGLE_BUDGET)

  switch (cfg.type) {
    case 'lattice': {
      addDeckAndCornice(builder, ring, cfg)
      addParapet(builder, ring, cfg)
      builder.withPart('crown', () => addLatticeCrown(builder, ring, cfg))
      addRoofEquipment(builder, ring, cfg)
      break
    }
    case 'oval_rim': {
      // 贴合轮廓的环形压顶：外圈挑檐 + 女儿墙 + 同心内檐圈
      builder.addCap('deck', ring, 0.02, true)
      if (cfg.corniceOffset > 0.05) {
        const outer = offsetRingXZ(ring, cfg.corniceOffset)
        builder.withPart('cornice', () => {
          builder.addRingWall('wall', outer, -cfg.corniceThickness, 0)
          builder.addRingHorizontal('wall', ring, outer, 0, true)
          builder.addRingHorizontal('wall', ring, outer, -cfg.corniceThickness, false)
        })
      }
      addParapet(builder, ring, cfg)

      const rb = ringBoundsXZ(ring)
      const minDim = Math.min(rb.maxX - rb.minX, rb.maxZ - rb.minZ)
      const inset = Math.min(Math.max(0.9, cfg.parapetThickness + 1.0), Math.max(0.4, minDim * 0.32))
      const inner = offsetRingXZ(ring, -inset)
      if (inner.length === ring.length) {
        const rimHeight = Math.max(0.3, cfg.parapetHeight * 0.5)
        const rimOuter = offsetRingXZ(ring, -cfg.parapetThickness * 0.5)
        builder.withPart('parapet', () => {
          builder.addRingWall('wall', inner, 0, rimHeight)
          builder.addRingHorizontal('wall', inner, rimOuter, rimHeight, true)
        })
        addRoofEquipment(builder, inner, cfg)
      } else {
        addRoofEquipment(builder, ring, cfg)
      }
      break
    }
    case 'penthouse': {
      addDeckAndCornice(builder, ring, cfg)
      addParapet(builder, ring, cfg)
      builder.withPart('penthouse', () => addPenthouse(builder, ring, cfg))
      addRoofEquipment(builder, ring, cfg)
      break
    }
    case 'skylight': {
      addDeckAndCornice(builder, ring, cfg)
      addParapet(builder, ring, cfg)
      addSkylights(builder, ring, cfg)
      addRoofEquipment(builder, ring, cfg)
      break
    }
    case 'eave': {
      builder.addCap('deck', ring, 0.02, true)
      builder.withPart('cornice', () => addEave(builder, ring, cfg))
      addParapet(builder, ring, cfg)
      addRoofEquipment(builder, ring, cfg)
      break
    }
    default: {
      addDeckAndCornice(builder, ring, cfg)
      addParapet(builder, ring, cfg)
      addRoofEquipment(builder, ring, cfg)
      break
    }
  }

  // 屋面基础设施（步道/护栏/透气管/检修口/避雷针）对所有类型统一追加
  builder.withPart('infrastructure', () => addRoofInfrastructure(builder, ring, cfg))

  if (builder.triangles === 0) return null

  const group = new THREE.Group()
  group.name = ROOF_GROUP_NAME
  group.userData.isBuildingRoof = true
  for (const key of ROOF_PART_KEYS) {
    const geometry = builder.toGeometry(key)
    if (!geometry) continue
    const material = getRoofMaterial(cfg.parts[key], ROOF_PART_DEPTH_BIAS[key])
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `${ROOF_GROUP_NAME}:${key}`
    mesh.userData.isBuildingRoof = true
    mesh.userData.__buildingRoofSharedMaterial = true
    mesh.userData.__buildingPart = key
    mesh.userData.__partBaseMaterial = material
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.raycast = () => {}
    group.add(mesh)
  }
  if (group.children.length === 0) return null

  const bounds = ringBoundsXZ(ring)
  const radius = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.75
  group.userData.__reliefCenter = new THREE.Vector3(bounds.cx, Math.max(1, cfg.parapetHeight), bounds.cz)
  group.userData.__reliefLodDistance = Math.max(90, radius * 14)
  roofGroups.add(group)

  return {
    group,
    stats: {
      triangles: builder.triangles,
      drawCalls: builder.drawCalls,
      clamped: builder.clamped,
    },
  }
}

/** 供外部使用的环周长工具（测试/布局） */
export function roofRingPerimeter(ring: RingXZ): number {
  return ringPerimeter(normalizeRingXZ(ring))
}
