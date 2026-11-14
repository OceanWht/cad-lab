/**
 * 程序化立面几何附件生成器
 *
 * 输入建筑外壳（ExtrudeGeometry）与各面立面配置，输出挂在建筑下的 `facadeRelief` 子组：
 * 竖梃、窗洞内凹框、窗台、楼层腰线、檐口、女儿墙、可选阳台。
 *
 * 局部坐标系：以边起点为原点，X 沿边、Y 向上、Z 为外法线；所有尺寸为真实米，
 * 与模块 tile 的分区共用 `resolveFacadeModuleGrid` 的同一套取整结果。
 *
 * 附件按材质分组（metal / stone）合并，单栋 draw call ≤ 2，三角面受预算上限约束。
 * 编辑器与 standalone-engine 共用本模块。
 */
import * as THREE from 'three'
import type { FacadeFaceConfig, FacadeReliefPartKey, PartMaterialConfig } from '../../shared/types'
import {
  FACADE_PART_KEYS,
  disposePartTextures,
  makeFacadePartMaterials,
  normalizePartMaterials,
} from '../building/partMaterial'
import { FACADE_TEXTURE_SIZE, facadeCacheKey, normalizeFacadeProfile } from './facadeTypes'
import { FACADE_TRIM_REGIONS, facadeModuleMetrics, getFacadeTrimsheet, type FacadeTrimKey } from './facadeTexture'
import { resolveFacadeModuleGrid } from './facadeFaceTiling'
import {
  holeRangesForFace,
  subtractHoleRects,
  type WallHoleRange,
  type WallOpening,
  type WallRect,
} from '../building/wallOpenings'

/** 单栋建筑附件三角面预算（design.md：20 层 ≤ 8k） */
export const FACADE_RELIEF_TRIANGLE_BUDGET = 8000

/** 场景内启用附件的最多建筑数，超出按距离降级 */
export const FACADE_RELIEF_MAX_BUILDINGS = 40

/** 附件组名（构建 / 重建时用于定位旧子级） */
export const FACADE_RELIEF_GROUP_NAME = '__facadeRelief__'

/** 附件材质族：metal = 竖梃 / 窗套 / 栏杆，stone = 窗台 / 腰线 / 檐口 / 女儿墙 / 阳台板 */
export type FacadeReliefMaterialKey = 'metal' | 'stone'

/** 构件 → 材质族（决定基础 trimsheet 分区与默认观感） */
const PART_FAMILY: Record<FacadeReliefPartKey, FacadeReliefMaterialKey> = {
  mullion: 'metal',
  reveal: 'metal',
  sill: 'stone',
  slabBand: 'stone',
  cornice: 'stone',
  parapet: 'stone',
  balconySlab: 'stone',
  balconyRail: 'metal',
}

const TRIM_KEY: Record<FacadeReliefMaterialKey, FacadeTrimKey> = {
  metal: 'metal',
  stone: 'stone',
}

const Y_AXIS = new THREE.Vector3(0, 1, 0)
const TRIANGLES_PER_BOX = 12
const UV_METERS_PER_REPEAT = 2

/** 单面局部坐标系（建筑局部空间） */
export interface FacadeWallFrame {
  /** 对应 ExtrudeGeometry 的墙面序号（materialIndex - 1） */
  faceIndex: number
  origin: THREE.Vector3
  /** 沿边单位向量 */
  dir: THREE.Vector3
  /** 外法线单位向量（水平） */
  outward: THREE.Vector3
  width: number
  height: number
}

export interface FacadeReliefStats {
  triangles: number
  drawCalls: number
  faces: number
  budget: number
  /** 是否触发预算裁剪 */
  clamped: boolean
}

export interface FacadeReliefBuildResult {
  group: THREE.Group
  stats: FacadeReliefStats
  /** 每个附件网格的构件键 → 材质（键与网格 userData.__buildingPart 对应） */
  parts: Record<string, PartMaterialConfig>
}

interface Bucket {
  positions: number[]
  normals: number[]
  /** trimsheet 分区 UV（基础材质用，channel 0） */
  uvs: number[]
  /** 平面米坐标 UV（自定义贴图用，channel 1） */
  uvs2: number[]
  indices: number[]
}

function emptyBucket(): Bucket {
  return { positions: [], normals: [], uvs: [], uvs2: [], indices: [] }
}

/** 单个构件的几何桶：同一构件且材质完全相同的面合并为一个 draw call */
interface PartBucket {
  part: FacadeReliefPartKey
  spec: PartMaterialConfig
  key: string
  bucket: Bucket
}

function fract(v: number): number {
  return v - Math.floor(v)
}

/**
 * 从 ExtrudeGeometry 中提取各墙面框架（起点 / 方向 / 外法线 / 边长 / 高度）。
 * 墙面的 materialIndex 从 1 开始（0 为顶底盖面）。
 */
export function extractFacadeWallFrames(geometry: THREE.BufferGeometry): FacadeWallFrame[] {
  const position = geometry.getAttribute('position')
  if (!position) return []
  // ExtrudeGeometry 默认是非索引几何，必须同时兼容 index / non-index 两种排布
  const index = geometry.getIndex()
  const total = index ? index.count : position.count
  const vertexAt = (i: number) => (index ? index.getX(i) : i)

  const result: FacadeWallFrame[] = []
  for (const group of geometry.groups) {
    if (group.materialIndex == null || group.materialIndex < 1) continue
    const start = group.start
    const end = Math.min(total, start + group.count)

    let minY = Infinity
    let maxY = -Infinity
    const unique = new Map<string, THREE.Vector3>()
    const triangleNormals: THREE.Vector3[] = []

    for (let i = start; i + 2 < end; i += 3) {
      const i0 = vertexAt(i)
      const i1 = vertexAt(i + 1)
      const i2 = vertexAt(i + 2)
      const p0 = new THREE.Vector3().fromBufferAttribute(position, i0)
      const p1 = new THREE.Vector3().fromBufferAttribute(position, i1)
      const p2 = new THREE.Vector3().fromBufferAttribute(position, i2)
      for (const p of [p0, p1, p2]) {
        const key = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`
        if (!unique.has(key)) unique.set(key, p)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
      }
      if (triangleNormals.length < 8) {
        const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0))
        if (Math.hypot(n.x, n.z) > 1e-6 && Math.abs(n.y) < Math.hypot(n.x, n.z) * 0.6) {
          triangleNormals.push(n)
        }
      }
    }

    if (!Number.isFinite(minY) || maxY - minY < 0.2) continue

    const bottom: THREE.Vector3[] = []
    for (const p of unique.values()) {
      if (p.y <= minY + 0.002) bottom.push(p)
    }
    if (bottom.length < 2) continue

    // 取底面距离最远的两点作为边的两个端点
    let a = bottom[0]
    let b = bottom[1]
    let best = -1
    for (let i = 0; i < bottom.length; i++) {
      for (let j = i + 1; j < bottom.length; j++) {
        const d = bottom[i].distanceToSquared(bottom[j])
        if (d > best) {
          best = d
          a = bottom[i]
          b = bottom[j]
        }
      }
    }
    if (best <= 1e-4) continue

    const width = Math.sqrt(best)
    const dir = new THREE.Vector3().subVectors(b, a).normalize()
    const normal = triangleNormals[0]
      ? new THREE.Vector3(triangleNormals[0].x, 0, triangleNormals[0].z).normalize()
      : new THREE.Vector3(-dir.z, 0, dir.x)
    // 保证 (dir × up) 与外法线同向；否则翻转边方向
    const cross = new THREE.Vector3().crossVectors(dir, Y_AXIS)
    if (cross.dot(normal) < 0) {
      const tmp = a
      a = b
      b = tmp
      dir.negate()
    }
    result.push({
      faceIndex: group.materialIndex - 1,
      origin: a.clone(),
      dir,
      outward: normal,
      width,
      height: maxY - minY,
    })
  }
  return result
}

/** 面局部坐标 → 建筑局部坐标 */
function toWorld(frame: FacadeWallFrame, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out
    .copy(frame.origin)
    .addScaledVector(frame.dir, x)
    .addScaledVector(Y_AXIS, y)
    .addScaledVector(frame.outward, z)
}

class ReliefBuilder {
  /** 构件 + 材质签名 → 几何桶；同构件同材质的面跨面合并 */
  private buckets = new Map<string, PartBucket>()
  private parts: Record<FacadeReliefPartKey, PartMaterialConfig> = makeFacadePartMaterials()
  /** 门洞开口（按 faceIndex 索引），用于裁掉与大门重叠的装饰 */
  private openings: WallOpening[] = []
  private holeCache = new Map<number, WallHoleRange[]>()
  triangles = 0
  clamped = false

  constructor(private readonly budget: number) {}

  /** 绑定门洞开口（全局一次） */
  setOpenings(openings: WallOpening[] | undefined): void {
    this.openings = openings ?? []
    this.holeCache.clear()
  }

  /** 当前面的孔洞区间（缓存，避免每个构件重复计算） */
  private holesFor(frame: FacadeWallFrame): WallHoleRange[] {
    if (!this.openings.length) return []
    const hit = this.holeCache.get(frame.faceIndex)
    if (hit) return hit
    const holes = holeRangesForFace(
      this.openings,
      frame.faceIndex,
      { x: frame.origin.x, z: frame.origin.z },
      { x: frame.dir.x, z: frame.dir.z },
      frame.width,
    )
    this.holeCache.set(frame.faceIndex, holes)
    return holes
  }

  /** 绑定当前面的构件材质（每面可独立设置） */
  setParts(parts: Partial<Record<FacadeReliefPartKey, PartMaterialConfig>> | undefined): void {
    this.parts = normalizePartMaterials(parts, makeFacadePartMaterials(), FACADE_PART_KEYS)
  }

  private bucketFor(part: FacadeReliefPartKey): Bucket {
    const spec = this.parts[part]
    const key = [
      part,
      spec.color,
      spec.roughness,
      spec.metalness,
      spec.textureId ?? '',
      spec.textureUrl ?? '',
      spec.textureScale ?? 1,
    ].join('|')
    const hit = this.buckets.get(key)
    if (hit) return hit.bucket
    const bucket: PartBucket = { part, spec: { ...spec }, key, bucket: emptyBucket() }
    this.buckets.set(key, bucket)
    return bucket.bucket
  }

  private canAfford(triangles: number): boolean {
    if (this.triangles + triangles <= this.budget) return true
    this.clamped = true
    return false
  }

  private mapUv(u: number, v: number, part: FacadeReliefPartKey): [number, number] {
    const region = FACADE_TRIM_REGIONS[TRIM_KEY[PART_FAMILY[part]]]
    const fu = fract(u / UV_METERS_PER_REPEAT) * (region.size - 0.002) + 0.001
    const fv = fract(v / UV_METERS_PER_REPEAT) * (region.size - 0.002) + 0.001
    return [region.u0 + fu, region.v0 + fv]
  }

  /**
   * 添加一个四边形：按门洞开口裁剪后写入。
   * 轴对齐薄片可精确切分为多个子矩形；侧壁 / 斜面无法切分，相交即整体跳过。
   */
  addQuad(
    part: FacadeReliefPartKey,
    frame: FacadeWallFrame,
    points: Array<[number, number, number]>,
    normalLocal: [number, number, number],
    uvAxes: { u: (p: [number, number, number]) => number; v: (p: [number, number, number]) => number },
  ): void {
    const holes = this.holesFor(frame)
    if (!holes.length) {
      this.addQuadRaw(part, frame, points, normalLocal, uvAxes)
      return
    }
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const u0 = Math.min(...xs)
    const u1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    const axisAligned =
      new Set(xs.map((v) => v.toFixed(3))).size <= 2 && new Set(ys.map((v) => v.toFixed(3))).size <= 2
    if (!axisAligned || u1 - u0 <= 1e-4) {
      // 只有与孔洞真正相交时才丢弃，否则原样保留
      const blocked = holes.some(
        (h) =>
          Math.min(u1, h.u1) - Math.max(u0, h.u0) > 0.002 &&
          Math.min(y1, h.height) - Math.max(y0, 0) > 0.002,
      )
      if (!blocked) this.addQuadRaw(part, frame, points, normalLocal, uvAxes)
      return
    }
    const z = points[0][2]
    const kept: WallRect[] = subtractHoleRects({ u0, u1, y0, y1 }, holes)
    for (const r of kept) {
      if (r.u1 - r.u0 <= 1e-4 || r.y1 - r.y0 <= 1e-4) continue
      this.addQuadRaw(
        part,
        frame,
        [
          [r.u0, r.y0, z],
          [r.u0, r.y1, z],
          [r.u1, r.y1, z],
          [r.u1, r.y0, z],
        ],
        normalLocal,
        uvAxes,
      )
    }
  }

  /** 不加裁剪的四边形写入（自动按期望法线修正绕序） */
  private addQuadRaw(
    part: FacadeReliefPartKey,
    frame: FacadeWallFrame,
    points: Array<[number, number, number]>,
    normalLocal: [number, number, number],
    uvAxes: { u: (p: [number, number, number]) => number; v: (p: [number, number, number]) => number },
  ): void {
    if (!this.canAfford(2)) return
    const bucket = this.bucketFor(part)

    const p0 = new THREE.Vector3()
    const p1 = new THREE.Vector3()
    const p2 = new THREE.Vector3()
    const p3 = new THREE.Vector3()
    toWorld(frame, ...points[0], p0)
    toWorld(frame, ...points[1], p1)
    toWorld(frame, ...points[2], p2)
    toWorld(frame, ...points[3], p3)

    const edgeA = new THREE.Vector3().subVectors(p1, p0)
    const edgeB = new THREE.Vector3().subVectors(p2, p0)
    const faceNormal = new THREE.Vector3().crossVectors(edgeA, edgeB)
    const expected = new THREE.Vector3()
      .addScaledVector(frame.dir, normalLocal[0])
      .addScaledVector(Y_AXIS, normalLocal[1])
      .addScaledVector(frame.outward, normalLocal[2])

    const verts = faceNormal.dot(expected) < 0 ? [p0, p3, p2, p1] : [p0, p1, p2, p3]
    const localVerts =
      faceNormal.dot(expected) < 0 ? [points[0], points[3], points[2], points[1]] : points

    const base = bucket.positions.length / 3
    const n = expected.clone().normalize()
    for (let i = 0; i < 4; i++) {
      const p = verts[i]
      const lp = localVerts[i]
      bucket.positions.push(p.x, p.y, p.z)
      bucket.normals.push(n.x, n.y, n.z)
      const lu = uvAxes.u(lp)
      const lv = uvAxes.v(lp)
      const [uu, vv] = this.mapUv(lu, lv, part)
      bucket.uvs.push(uu, vv)
      // uv1 保留平面米坐标，供构件自定义贴图（channel 1）取样
      bucket.uvs2.push(lu, lv)
    }
    bucket.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    this.triangles += 2
  }

  /** 添加一个盒体（面局部坐标，中心 + 尺寸），按门洞开口裁剪 */
  addBox(
    part: FacadeReliefPartKey,
    frame: FacadeWallFrame,
    size: [number, number, number],
    center: [number, number, number],
  ): void {
    const holes = this.holesFor(frame)
    if (!holes.length) {
      this.addBoxRaw(part, frame, size, center)
      return
    }
    const [w, h, d] = size
    const [cx, cy, cz] = center
    const kept = subtractHoleRects(
      { u0: cx - w / 2, u1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 },
      holes,
    )
    for (const r of kept) {
      const nw = r.u1 - r.u0
      const nh = r.y1 - r.y0
      if (nw <= 1e-4 || nh <= 1e-4) continue
      this.addBoxRaw(part, frame, [nw, nh, d], [(r.u0 + r.u1) / 2, (r.y0 + r.y1) / 2, cz])
    }
  }

  /** 不加裁剪的盒体写入 */
  private addBoxRaw(
    part: FacadeReliefPartKey,
    frame: FacadeWallFrame,
    size: [number, number, number],
    center: [number, number, number],
  ): void {
    if (!this.canAfford(TRIANGLES_PER_BOX)) return
    const [w, h, d] = size
    const [cx, cy, cz] = center
    const hx = w / 2
    const hy = h / 2
    const hz = d / 2
    const x0 = cx - hx
    const x1 = cx + hx
    const y0 = cy - hy
    const y1 = cy + hy
    const z0 = cz - hz
    const z1 = cz + hz

    const faces: Array<{
      points: Array<[number, number, number]>
      normal: [number, number, number]
      u: (p: [number, number, number]) => number
      v: (p: [number, number, number]) => number
    }> = [
      { points: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], normal: [1, 0, 0], u: (p) => p[2], v: (p) => p[1] },
      { points: [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], normal: [-1, 0, 0], u: (p) => -p[2], v: (p) => p[1] },
      { points: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], normal: [0, 1, 0], u: (p) => p[0], v: (p) => p[2] },
      { points: [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], normal: [0, -1, 0], u: (p) => p[0], v: (p) => -p[2] },
      { points: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], normal: [0, 0, 1], u: (p) => p[0], v: (p) => p[1] },
      { points: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], normal: [0, 0, -1], u: (p) => -p[0], v: (p) => p[1] },
    ]

    for (const face of faces) {
      this.addQuadRaw(part, frame, face.points, face.normal, { u: face.u, v: face.v })
    }
  }

  toGeometry(bucket: Bucket): THREE.BufferGeometry | null {
    if (bucket.indices.length === 0) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3))
    // uv = trimsheet 分区坐标（基础材质），uv1 = 平面米坐标（构件自定义贴图）
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2))
    geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(bucket.uvs2, 2))
    geometry.setIndex(bucket.indices)
    geometry.computeBoundingSphere()
    return geometry
  }

  entries(): PartBucket[] {
    return Array.from(this.buckets.values())
  }

  get drawCalls(): number {
    return this.buckets.size
  }
}

/* -------------------------------------------------------------------------- */
/* 材质：按构件共享，纹理来自元素 trimsheet                                  */
/* -------------------------------------------------------------------------- */

const materialCache = new Map<string, THREE.MeshStandardMaterial>()
const MATERIAL_CACHE_LIMIT = 96

/** trimsheet 纹理按立面签名 + 档位共享，避免每个构件重复上传同一张图 */
const trimTextureCache = new Map<string, { color: THREE.CanvasTexture; orm: THREE.CanvasTexture }>()
const TRIM_TEXTURE_CACHE_LIMIT = 24

function createTrimTextures(config: FacadeFaceConfig, textureSize: number) {
  const trimsheet = getFacadeTrimsheet(config, textureSize)
  const colorTex = new THREE.CanvasTexture(trimsheet.color)
  colorTex.colorSpace = THREE.SRGBColorSpace
  colorTex.wrapS = THREE.ClampToEdgeWrapping
  colorTex.wrapT = THREE.ClampToEdgeWrapping
  colorTex.anisotropy = 4
  colorTex.channel = 0

  const ormTex = new THREE.CanvasTexture(trimsheet.orm)
  ormTex.wrapS = THREE.ClampToEdgeWrapping
  ormTex.wrapT = THREE.ClampToEdgeWrapping
  ormTex.anisotropy = 4
  ormTex.channel = 0
  return { color: colorTex, orm: ormTex }
}

function getTrimTextures(config: FacadeFaceConfig, textureSize: number) {
  const key = `${facadeCacheKey(config)}|${textureSize}`
  const hit = trimTextureCache.get(key)
  if (hit) {
    trimTextureCache.delete(key)
    trimTextureCache.set(key, hit)
    return hit
  }
  const entry = createTrimTextures(config, textureSize)
  trimTextureCache.set(key, entry)
  if (trimTextureCache.size > TRIM_TEXTURE_CACHE_LIMIT) {
    const oldest = trimTextureCache.keys().next().value
    if (oldest !== undefined) {
      const evicted = trimTextureCache.get(oldest)
      trimTextureCache.delete(oldest)
      evicted?.color.dispose()
      evicted?.orm.dispose()
    }
  }
  return entry
}

/**
 * 获取单个构件的基础材质：
 * 颜色 / 金属度 / 粗糙度来自构件配置，贴图通道来自 trimsheet（uv 为分区坐标）。
 * 用户选的自定义贴图由 `applyPartTextures` 在此基础上替换 map（改用 uv1）。
 */
function getFacadeReliefPartMaterial(
  config: FacadeFaceConfig,
  entry: PartBucket,
  textureSize = FACADE_TEXTURE_SIZE,
): THREE.MeshStandardMaterial {
  const key = `${facadeCacheKey(config)}|${entry.key}|${textureSize}`
  const hit = materialCache.get(key)
  if (hit) {
    materialCache.delete(key)
    materialCache.set(key, hit)
    return hit
  }

  const textures = getTrimTextures(config, textureSize)
  const profile = normalizeFacadeProfile(config, config.style)
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    aoMap: textures.orm,
    roughnessMap: textures.orm,
    metalnessMap: textures.orm,
    color: new THREE.Color(entry.spec.color),
    roughness: entry.spec.roughness,
    metalness: entry.spec.metalness,
    aoMapIntensity: 1,
    envMapIntensity: profile.envMapIntensity,
  })
  material.userData.__facadeReliefSharedMaterial = true

  materialCache.set(key, material)
  if (materialCache.size > MATERIAL_CACHE_LIMIT) {
    const oldest = materialCache.keys().next().value
    if (oldest !== undefined) {
      const evicted = materialCache.get(oldest)
      materialCache.delete(oldest)
      evicted?.dispose()
    }
  }
  return material
}

/** 清空附件材质与 trimsheet 纹理缓存（场景卸载时调用） */
export function disposeFacadeReliefMaterialCache(): void {
  for (const material of materialCache.values()) material.dispose()
  materialCache.clear()
  for (const entry of trimTextureCache.values()) {
    entry.color.dispose()
    entry.orm.dispose()
  }
  trimTextureCache.clear()
}

/* -------------------------------------------------------------------------- */
/* 几何构建                                                                     */
/* -------------------------------------------------------------------------- */

interface WindowSlot {
  /** 窗洞中心 X（面局部） */
  cx: number
  width: number
  bottom: number
  height: number
}

function buildFaceParts(
  builder: ReliefBuilder,
  frame: FacadeWallFrame,
  config: FacadeFaceConfig,
  baseHeight = 0,
): void {
  builder.setParts(config.parts)
  const profile = normalizeFacadeProfile(config, config.style)
  const metrics = facadeModuleMetrics(config)
  // 底座覆盖区不生成立面附件：网格仍按整面高度取整，保证与贴图分区对齐
  const skipBelow = Math.max(0, Math.min(baseHeight, frame.height * 0.75))
  const usableHeight = Math.max(0.1, frame.height - skipBelow)
  const grid = resolveFacadeModuleGrid(frame.width, frame.height, config)
  const inset = Math.max(0, Math.min(profile.cornerInset, frame.width * 0.45))
  const relief = profile.relief

  const bandHeight = Math.max(0.04, Math.min(profile.slabBandHeight, grid.floorHeight * 0.4))
  const mullionWidth = Math.max(0.03, profile.mullionWidth)
  const revealDepth = Math.max(0, profile.revealDepth)

  // 檐口：沿面宽通长，略微外挑
  if (relief.cornice) {
    const corniceDepth = Math.max(0.18, revealDepth * 2)
    const corniceHeight = Math.min(0.45, Math.max(0.2, grid.floorHeight * 0.08))
    builder.addBox(
      'cornice',
      frame,
      [frame.width, corniceHeight, corniceDepth],
      [frame.width / 2, frame.height - corniceHeight / 2, corniceDepth / 2 + 0.01],
    )
  }

  // 女儿墙：屋顶边缘向上，略微内缩
  if (relief.parapet) {
    const parapetHeight = Math.min(1.2, Math.max(0.5, grid.floorHeight * 0.25))
    builder.addBox(
      'parapet',
      frame,
      [frame.width, parapetHeight, 0.22],
      [frame.width / 2, frame.height + parapetHeight / 2, -0.11],
    )
  }

  // 竖梃：按开间均匀布置，两端各留 cornerInset
  if (relief.mullion) {
    const depth = Math.max(0.04, revealDepth * 0.8)
    for (let i = 1; i < grid.bays; i++) {
      const x = i * grid.bayWidth
      if (x < inset + mullionWidth || x > frame.width - inset - mullionWidth) continue
      builder.addBox(
        'mullion',
        frame,
        [mullionWidth, usableHeight, depth],
        [x, skipBelow + usableHeight / 2, depth / 2 + 0.015],
      )
    }
  }

  // 楼层腰线：每层交界一道
  if (grid.floors > 1) {
    for (let i = 1; i < grid.floors; i++) {
      const y = i * grid.floorHeight
      if (y < skipBelow + 0.05) continue
      builder.addBox(
        'slabBand',
        frame,
        [Math.max(0.2, frame.width - inset * 2), bandHeight, 0.08],
        [frame.width / 2, y, 0.05],
      )
    }
  }

  // 窗洞 / 窗台 / 阳台：与贴图分区共用同一套开间层数
  const windowW = Math.min(grid.bayWidth * 0.92, Math.max(0.3, metrics.windowWidth))
  const windowH = Math.max(0.3, Math.min(grid.floorHeight - 0.2, metrics.windowHeight))
  const slots: WindowSlot[] = []
  for (let floor = 0; floor < grid.floors; floor++) {
    for (let bay = 0; bay < grid.bays; bay++) {
      const cx = (bay + 0.5) * grid.bayWidth
      if (cx - windowW / 2 < inset || cx + windowW / 2 > frame.width - inset) continue
      const bottom = floor * grid.floorHeight + Math.min(metrics.windowBottom, grid.floorHeight - windowH - 0.1)
      // 落在底座覆盖区内的整排窗直接跳过，不在底座上开口
      if (bottom < skipBelow + 0.02) continue
      slots.push({ cx, width: windowW, bottom, height: windowH })
    }
  }

  const wantReveal = revealDepth >= 0.1 && relief.sill
  const frameBorder = Math.max(0.05, Math.min(0.14, windowW * 0.06 + revealDepth * 0.3))

  for (const slot of slots) {
    // 窗台：窗洞下沿外挑
    if (relief.sill) {
      const sillH = Math.max(0.05, Math.min(0.1, grid.floorHeight * 0.03))
      const sillDepth = 0.12 + revealDepth * 0.4
      builder.addBox(
        'sill',
        frame,
        [slot.width + frameBorder * 2, sillH, sillDepth],
        [slot.cx, slot.bottom - sillH / 2, sillDepth / 2 + 0.02],
      )
    }

    // 窗洞内凹框：四块斜面拼成窗套（外圈外挑、内圈回收）
    if (wantReveal) {
      const outerW = slot.width / 2 + frameBorder
      const outerTop = slot.bottom + slot.height + frameBorder
      const outerBottom = slot.bottom - frameBorder
      const innerW = slot.width / 2
      const innerTop = slot.bottom + slot.height
      const innerBottom = slot.bottom
      const zOuter = 0.03 + revealDepth
      const zInner = 0.03

      // 上沿
      builder.addQuad(
        'reveal',
        frame,
        [
          [slot.cx - outerW, outerTop, zOuter],
          [slot.cx + outerW, outerTop, zOuter],
          [slot.cx + innerW, innerTop, zInner],
          [slot.cx - innerW, innerTop, zInner],
        ],
        [0, 0.45, 1],
        { u: (p) => p[0], v: (p) => p[1] },
      )
      // 下沿
      builder.addQuad(
        'reveal',
        frame,
        [
          [slot.cx - innerW, innerBottom, zInner],
          [slot.cx + innerW, innerBottom, zInner],
          [slot.cx + outerW, outerBottom, zOuter],
          [slot.cx - outerW, outerBottom, zOuter],
        ],
        [0, -0.45, 1],
        { u: (p) => p[0], v: (p) => -p[1] },
      )
      // 左沿
      builder.addQuad(
        'reveal',
        frame,
        [
          [slot.cx - innerW, innerBottom, zInner],
          [slot.cx - innerW, innerTop, zInner],
          [slot.cx - outerW, outerTop, zOuter],
          [slot.cx - outerW, outerBottom, zOuter],
        ],
        [-0.45, 0, 1],
        { u: (p) => -p[1], v: (p) => p[2] },
      )
      // 右沿
      builder.addQuad(
        'reveal',
        frame,
        [
          [slot.cx + innerW, innerTop, zInner],
          [slot.cx + innerW, innerBottom, zInner],
          [slot.cx + outerW, outerBottom, zOuter],
          [slot.cx + outerW, outerTop, zOuter],
        ],
        [0.45, 0, 1],
        { u: (p) => p[1], v: (p) => p[2] },
      )
    }

    // 阳台（可选，默认关闭）
    if (relief.balcony) {
      const platformDepth = 1.2
      const platformH = 0.12
      builder.addBox(
        'balconySlab',
        frame,
        [slot.width * 1.15, platformH, platformDepth],
        [slot.cx, slot.bottom - platformH / 2, platformDepth / 2 + 0.02],
      )
      builder.addBox(
        'balconyRail',
        frame,
        [slot.width * 1.15, 1.0, 0.06],
        [slot.cx, slot.bottom + 0.44, platformDepth + 0.03],
      )
    }
  }
}

function buildPeripheralParts(
  builder: ReliefBuilder,
  frame: FacadeWallFrame,
  config: FacadeFaceConfig,
): void {
  // 面没有单独立面配置时，仍沿外环生成建筑级檐口 / 女儿墙
  builder.setParts(config.parts)
  const profile = normalizeFacadeProfile(config, config.style)
  const metrics = facadeModuleMetrics(config)
  if (profile.relief.cornice) {
    const corniceDepth = Math.max(0.18, profile.revealDepth * 2)
    const corniceHeight = Math.min(0.45, Math.max(0.2, metrics.floorHeight * 0.08))
    builder.addBox(
      'cornice',
      frame,
      [frame.width, corniceHeight, corniceDepth],
      [frame.width / 2, frame.height - corniceHeight / 2, corniceDepth / 2 + 0.01],
    )
  }
  if (profile.relief.parapet) {
    const parapetHeight = Math.min(1.2, Math.max(0.5, metrics.floorHeight * 0.25))
    builder.addBox(
      'parapet',
      frame,
      [frame.width, parapetHeight, 0.22],
      [frame.width / 2, frame.height + parapetHeight / 2, -0.11],
    )
  }
}

/** 已注册的附件组，供逐帧距离 LOD 使用 */
const reliefGroups = new Set<THREE.Group>()

/** 建筑立面附件生成参数 */
export interface FacadeReliefOptions {
  textureSize?: number
  triangleBudget?: number
  maxBuildings?: number
  baseHeight?: number
  /** 门洞开口：与大门面积重叠的装饰构件会被裁剪，避免遮挡门体 */
  openings?: WallOpening[]
}

/**
 * 构建建筑立面附件。
 *
 * @param shell 建筑外壳（ExtrudeGeometry）
 * @param facadeFaces 各面立面配置（faceIndex 与外壳材质组对应）
 * @param options 纹理档位 / 三角面预算 / 底座覆盖高度（低于该高度的窗洞与线脚不生成）
 */
export function buildFacadeRelief(
  shell: THREE.BufferGeometry,
  facadeFaces: FacadeFaceConfig[],
  options: FacadeReliefOptions = {},
): FacadeReliefBuildResult | null {
  if (reliefGroups.size >= (options.maxBuildings ?? FACADE_RELIEF_MAX_BUILDINGS)) return null

  const frames = extractFacadeWallFrames(shell)
  if (frames.length === 0) return null

  return buildFacadeReliefFromFrames(frames, facadeFaces, options)
}

/**
 * 用显式墙面框架构建立面附件。
 *
 * 与 `buildFacadeRelief` 的唯一差别是框架来源：这里不要求挤出壳与材质组，
 * 由调用方直接给出每段墙面的 origin / 方向 / 法线 / 宽度 / 层高。
 * CAD 墙带路径使用本入口，避免为墙带伪造外壳。
 */
export function buildFacadeReliefFromFrames(
  frames: FacadeWallFrame[],
  facadeFaces: FacadeFaceConfig[],
  options: FacadeReliefOptions = {},
): FacadeReliefBuildResult | null {
  if (reliefGroups.size >= (options.maxBuildings ?? FACADE_RELIEF_MAX_BUILDINGS)) return null
  if (frames.length === 0) return null

  const byIndex = new Map<number, FacadeFaceConfig>()
  for (const face of facadeFaces) {
    if (face?.faceIndex != null) byIndex.set(face.faceIndex, face)
  }
  const baseConfig = facadeFaces.find((f) => f) ?? null
  if (!baseConfig) return null

  const builder = new ReliefBuilder(options.triangleBudget ?? FACADE_RELIEF_TRIANGLE_BUDGET)
  builder.setOpenings(options.openings)
  const baseHeight = Math.max(0, options.baseHeight ?? 0)
  for (const frame of frames) {
    const config = byIndex.get(frame.faceIndex)
    if (config) buildFaceParts(builder, frame, config, baseHeight)
    else buildPeripheralParts(builder, frame, baseConfig)
  }

  if (builder.triangles === 0) return null

  const textureSize = options.textureSize ?? FACADE_TEXTURE_SIZE
  const group = new THREE.Group()
  group.name = FACADE_RELIEF_GROUP_NAME
  group.userData.isFacadeRelief = true

  const parts: Record<string, PartMaterialConfig> = {}
  for (const entry of builder.entries()) {
    const geometry = builder.toGeometry(entry.bucket)
    if (!geometry) continue
    const material = getFacadeReliefPartMaterial(baseConfig, entry, textureSize)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `${FACADE_RELIEF_GROUP_NAME}:${entry.part}:${entry.key}`
    mesh.userData.isFacadeRelief = true
    mesh.userData.__facadeReliefSharedMaterial = true
    // 构件材质：供 applyPartTextures 异步补挂自定义贴图（uv1 平面米坐标）
    mesh.userData.__buildingPart = entry.key
    mesh.userData.__partBaseMaterial = material
    parts[entry.key] = entry.spec
    // 附件默认不投影阴影，仅接收主墙面的投影
    mesh.castShadow = false
    mesh.receiveShadow = true
    // 附件不参与拾取，避免遮挡建筑本体的点击
    mesh.raycast = () => {}
    group.add(mesh)
  }
  if (group.children.length === 0) return null

  // 距离 LOD：以建筑包围尺度为基准
  let maxWidth = 0
  let maxHeight = 0
  const center = new THREE.Vector3()
  for (const frame of frames) {
    maxWidth = Math.max(maxWidth, frame.width)
    maxHeight = Math.max(maxHeight, frame.height)
    center.addScaledVector(frame.origin, 1)
  }
  center.multiplyScalar(1 / frames.length)
  center.y += maxHeight / 2
  const radius = Math.max(maxWidth, maxHeight) * 0.75
  group.userData.__reliefCenter = center
  group.userData.__reliefLodDistance = Math.max(60, radius * 10)

  reliefGroups.add(group)

  return {
    group,
    stats: {
      triangles: builder.triangles,
      drawCalls: builder.drawCalls,
      faces: frames.length,
      budget: options.triangleBudget ?? FACADE_RELIEF_TRIANGLE_BUDGET,
      clamped: builder.clamped,
    },
    parts,
  }
}

/** 仅从距离 LOD 注册表移除（几何由外部统一 dispose 时使用） */
export function unregisterFacadeReliefGroup(group: THREE.Object3D | null | undefined): void {
  if (!group) return
  reliefGroups.delete(group as THREE.Group)
}

/** 释放附件组：从注册表移除，释放几何与构件自有贴图（共享材质由缓存管理） */
export function disposeFacadeReliefGroup(group: THREE.Group | THREE.Object3D | null | undefined): void {
  if (!group) return
  disposePartTextures(group)
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if ((mesh as unknown as { isMesh?: boolean }).isMesh && mesh.geometry) {
      mesh.geometry.dispose()
    }
  })
  group.removeFromParent()
  unregisterFacadeReliefGroup(group)
}

/** 逐帧按相机距离切换附件可见性（编辑器和引擎共用） */
export function updateFacadeReliefLod(camera: THREE.Camera): void {
  if (reliefGroups.size === 0) return
  const cameraPos = new THREE.Vector3()
  camera.getWorldPosition(cameraPos)
  const world = new THREE.Vector3()
  for (const group of Array.from(reliefGroups)) {
    if (!group.parent) {
      reliefGroups.delete(group)
      continue
    }
    const center = group.userData.__reliefCenter as THREE.Vector3 | undefined
    if (!center) continue
    const limit = Number(group.userData.__reliefLodDistance) || 120
    world.copy(center).applyMatrix4(group.matrixWorld)
    group.visible = cameraPos.distanceTo(world) <= limit
  }
}

/** 清空附件 LOD 注册表（场景卸载时调用） */
export function clearFacadeReliefRegistry(): void {
  reliefGroups.clear()
}

/** 当前注册的附件组数量（调试 / 预算统计） */
export function getFacadeReliefGroupCount(): number {
  return reliefGroups.size
}
