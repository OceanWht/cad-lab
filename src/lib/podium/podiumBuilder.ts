/**
 * 程序化建筑底座生成器
 *
 * 输入建筑轮廓环（本地场景 XZ，米）与底座配置，输出挂在建筑下的 `__buildingPodium__` 子组。
 * 六段结构按需生成：台基 → 裙墙 → 内凹背板 → 柱廊/百叶/扶手 → 雨棚 → 前场（台阶/平台/花池）。
 *
 * 坐标约定：
 * - 环按 XZ 平面逆时针归一化，与 `outdoorFaceAnchors` 的 faceIndex 顺序一致；
 * - 外法线 = (dz, -dx)，因此 faceIndex i 对应环上第 i 条边；
 * - 所有构件在建筑局部坐标（Y 从 0 起），随建筑 mesh 变换。
 *
 * 构件按九个构件键分桶（台基/裙墙/背板/百叶/扶手/柱廊/雨棚/前场/花池），
 * 每个构件独立材质与贴图、独立 draw call，三角面受预算约束；
 * 复用 `__reliefCenter` / `__reliefLodDistance` 的距离 LOD 约定。
 */
import * as THREE from 'three'
import type { PartMaterialConfig, PodiumConfig, PodiumPartKey } from '../../shared/types'
import { disposePartTextures, PODIUM_PART_KEYS } from '../building/partMaterial'
import { normalizePodiumConfig } from './podiumTypes'
import {
  holeRangesForFace,
  subtractHoleRects,
  type WallHoleRange,
  type WallOpening,
} from '../building/wallOpenings'

/** 底座组名（重建时用于定位旧子级） */
export const PODIUM_GROUP_NAME = '__buildingPodium__'

/** 单栋底座三角面预算 */
export const PODIUM_TRIANGLE_BUDGET = 6000

/** 参与生成的轮廓最大点数（弧线密采样点会先抽稀） */
const MAX_RING_POINTS = 96

const Y_AXIS = new THREE.Vector3(0, 1, 0)
const TRIANGLES_PER_BOX = 12

/** 材质键与构件键一致：每个构件一次 draw call */
export type PodiumMaterialKey = PodiumPartKey

export interface PodiumBuildOptions {
  /** 正面 faceIndex；缺省按最长边自动判定 */
  frontFaceIndex?: number | null
  triangleBudget?: number
  /** 门洞开口：与大门重叠的台基 / 裙墙 / 雨棚 / 前场会被裁剪，避免遮挡门体 */
  openings?: WallOpening[]
}

export interface PodiumBuildResult {
  group: THREE.Group
  stats: { triangles: number; drawCalls: number; clamped: boolean }
}

/* -------------------------------------------------------------------------- */
/* 轮廓环工具（纯函数，单测覆盖）                                                */
/* -------------------------------------------------------------------------- */

export type RingXZ = Array<[number, number]>

/** XZ 平面有向面积（>0 为逆时针） */
export function signedAreaXZ(ring: RingXZ): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return sum / 2
}

export function ringPerimeter(ring: RingXZ): number {
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return total
}

/** 去重（含闭合重复点）并统一为逆时针，保证 faceIndex 与边序号一致 */
export function normalizeRingXZ(ring: RingXZ): RingXZ {
  const pts: RingXZ = []
  for (const p of ring) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
    const last = pts[pts.length - 1]
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-4) continue
    pts.push([p[0], p[1]])
  }
  if (pts.length > 1) {
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-4) pts.pop()
  }
  if (pts.length < 3) return pts
  return signedAreaXZ(pts) < 0 ? pts.reverse() : pts
}

/** 弧线密采样点按弧长均匀抽稀到 maxPoints（仅用于点过多的环） */
export function decimateRing(ring: RingXZ, maxPoints: number): RingXZ {
  if (ring.length <= maxPoints || maxPoints < 3) return ring.slice()
  const total = ringPerimeter(ring)
  if (total < 1e-6) return ring.slice()
  const step = total / maxPoints
  const out: RingXZ = []
  let target = 0
  let traveled = 0
  for (let i = 0; i < ring.length && out.length < maxPoints; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    while (target <= traveled + len && out.length < maxPoints) {
      const t = len < 1e-9 ? 0 : (target - traveled) / len
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      target += step
    }
    traveled += len
  }
  return out.length >= 3 ? out : ring.slice()
}

/** 沿外法线偏移轮廓环（正数外扩、负数内缩），角点用角平分线斜接 */
export function offsetRingXZ(ring: RingXZ, offset: number): RingXZ {
  if (Math.abs(offset) < 1e-6) return ring.slice()
  const n = ring.length
  const out: RingXZ = []
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]
    const cur = ring[i]
    const next = ring[(i + 1) % n]
    let d1x = cur[0] - prev[0]
    let d1z = cur[1] - prev[1]
    let d2x = next[0] - cur[0]
    let d2z = next[1] - cur[1]
    const l1 = Math.hypot(d1x, d1z)
    const l2 = Math.hypot(d2x, d2z)
    if (l1 < 1e-9 || l2 < 1e-9) {
      out.push([cur[0], cur[1]])
      continue
    }
    d1x /= l1
    d1z /= l1
    d2x /= l2
    d2z /= l2
    const n1x = d1z
    const n1z = -d1x
    const n2x = d2z
    const n2z = -d2x
    let mx = n1x + n2x
    let mz = n1z + n2z
    const ml = Math.hypot(mx, mz)
    if (ml < 1e-9) {
      out.push([cur[0] + n1x * offset, cur[1] + n1z * offset])
      continue
    }
    mx /= ml
    mz /= ml
    const cosHalf = mx * n1x + mz * n1z
    const scale = offset / Math.max(0.35, cosHalf)
    out.push([cur[0] + mx * scale, cur[1] + mz * scale])
  }
  return out
}

export interface RingSample {
  point: [number, number]
  /** 沿边单位向量 */
  dir: [number, number]
  /** 外法线单位向量 */
  outward: [number, number]
}

/** 按弧长等距采样（用于柱廊），起点错开半个柱距避免落在角点上 */
export function sampleRing(ring: RingXZ, spacing: number, maxSamples = 400): RingSample[] {
  if (spacing <= 1e-6) return []
  const total = ringPerimeter(ring)
  if (total <= 1e-6) return []
  const out: RingSample[] = []
  for (let dist = spacing * 0.5; dist < total && out.length < maxSamples; dist += spacing) {
    let traveled = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 1e-9) continue
      if (dist <= traveled + len) {
        const t = (dist - traveled) / len
        const dx = (b[0] - a[0]) / len
        const dz = (b[1] - a[1]) / len
        out.push({
          point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
          dir: [dx, dz],
          outward: [dz, -dx],
        })
        break
      }
      traveled += len
    }
  }
  return out
}

export interface RingFaceFrame {
  index: number
  mid: [number, number]
  dir: [number, number]
  outward: [number, number]
  width: number
}

export function faceFrameXZ(ring: RingXZ, index: number): RingFaceFrame | null {
  if (index < 0 || index >= ring.length) return null
  const a = ring[index]
  const b = ring[(index + 1) % ring.length]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len < 1e-6) return null
  const dx = (b[0] - a[0]) / len
  const dz = (b[1] - a[1]) / len
  return {
    index,
    mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    dir: [dx, dz],
    outward: [dz, -dx],
    width: len,
  }
}

/** 正面：优先调用方给出的 faceIndex（大门所在面），否则取最长边 */
export function resolveFrontFaceIndex(ring: RingXZ, preferred?: number | null): number | null {
  if (preferred != null && Number.isInteger(preferred) && preferred >= 0 && preferred < ring.length) {
    return preferred
  }
  let best = -1
  let bestLen = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len > bestLen) {
      bestLen = len
      best = i
    }
  }
  return best >= 0 ? best : null
}

/* -------------------------------------------------------------------------- */
/* 几何构建                                                                     */
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

class PodiumBuilder {
  private buckets = Object.fromEntries(PODIUM_PART_KEYS.map((key) => [key, emptyBucket()])) as Record<
    PodiumMaterialKey,
    Bucket
  >
  triangles = 0
  clamped = false
  /** 门洞开口（按 faceIndex 索引） */
  private openings: WallOpening[] = []
  private holeCache = new Map<number, WallHoleRange[]>()

  constructor(private readonly budget: number) {}

  /** 绑定门洞开口（全局一次） */
  setOpenings(openings: WallOpening[] | undefined): void {
    this.openings = openings ?? []
    this.holeCache.clear()
  }

  /** 环边（faceIndex）上的孔洞区间；u 以该边起点为 0 */
  private holesForEdge(
    a: [number, number],
    dirX: number,
    dirZ: number,
    len: number,
    faceIndex: number,
  ): WallHoleRange[] {
    if (!this.openings.length) return []
    const hit = this.holeCache.get(faceIndex)
    if (hit) return hit
    const holes = holeRangesForFace(
      this.openings,
      faceIndex,
      { x: a[0], z: a[1] },
      { x: dirX, z: dirZ },
      len,
    )
    this.holeCache.set(faceIndex, holes)
    return holes
  }

  /** 指定轮廓环上的第 faceIndex 条边的孔洞区间（供前场判定） */
  holesForRingEdge(ring: RingXZ, faceIndex: number): WallHoleRange[] {
    if (!this.openings.length || faceIndex < 0 || faceIndex >= ring.length) return []
    const a = ring[faceIndex]
    const b = ring[(faceIndex + 1) % ring.length]
    if (!a || !b) return []
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const len = Math.hypot(dx, dz)
    if (len < 1e-9) return []
    return this.holesForEdge(a, dx / len, dz / len, len, faceIndex)
  }

  /**
   * 点是否落在任一孔洞范围内（柱 / 花池等实体构件整体跳过判定）。
   * 用侧向距离排除其他面上的构件被同一 u 误判。
   */
  blockedAt(x: number, z: number, yBottom: number, yTop: number, radius = 0): boolean {
    if (!this.openings.length) return false
    for (const o of this.openings) {
      if (Math.min(yTop, o.height) - Math.max(yBottom, 0) <= 0.002) continue
      const proj = (x - o.center.x) * o.dir.x + (z - o.center.z) * o.dir.z
      if (Math.abs(proj) > o.width / 2 + radius) continue
      const lateral = Math.abs((x - o.center.x) * -o.dir.z + (z - o.center.z) * o.dir.x)
      if (lateral > 2.5) continue
      return true
    }
    return false
  }

  private canAfford(triangles: number): boolean {
    if (this.triangles + triangles <= this.budget) return true
    this.clamped = true
    return false
  }

  private pushTriangle(
    key: PodiumMaterialKey,
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    normal: THREE.Vector3,
  ): void {
    const bucket = this.buckets[key]
    const base = bucket.positions.length / 3
    const faceNormal = new THREE.Vector3()
      .crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, a))
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

  /** 添加一个四边形，按期望法线自动修正绕序 */
  addQuad(
    key: PodiumMaterialKey,
    points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
    normal: THREE.Vector3,
  ): void {
    if (!this.canAfford(2)) return
    const edgeA = new THREE.Vector3().subVectors(points[1], points[0])
    const edgeB = new THREE.Vector3().subVectors(points[2], points[0])
    const faceNormal = new THREE.Vector3().crossVectors(edgeA, edgeB)
    const ordered = faceNormal.dot(normal) < 0
      ? [points[0], points[3], points[2], points[1]]
      : [points[0], points[1], points[2], points[3]]
    const bucket = this.buckets[key]
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

  /** 添加定向盒体：dir 沿边、outward 为外法线，size = [沿边, 高, 进深] */
  addOrientedBox(
    key: PodiumMaterialKey,
    center: THREE.Vector3,
    size: [number, number, number],
    dir: [number, number],
    outward: [number, number],
  ): void {
    if (!this.canAfford(TRIANGLES_PER_BOX)) return
    const u = new THREE.Vector3(dir[0], 0, dir[1]).normalize()
    const w = new THREE.Vector3(outward[0], 0, outward[1]).normalize()
    const halfU = size[0] / 2
    const halfY = size[1] / 2
    const halfW = size[2] / 2
    const p = (su: number, sy: number, sw: number): THREE.Vector3 =>
      center.clone().addScaledVector(u, su * halfU).addScaledVector(Y_AXIS, sy * halfY).addScaledVector(w, sw * halfW)

    const faces: Array<{ pts: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]; n: THREE.Vector3 }> = [
      { pts: [p(1, -1, -1), p(1, -1, 1), p(1, 1, 1), p(1, 1, -1)], n: u.clone() },
      { pts: [p(-1, -1, 1), p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1)], n: u.clone().negate() },
      { pts: [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)], n: w.clone() },
      { pts: [p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1)], n: w.clone().negate() },
      { pts: [p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1)], n: Y_AXIS.clone() },
      { pts: [p(-1, -1, 1), p(1, -1, 1), p(1, -1, -1), p(-1, -1, -1)], n: Y_AXIS.clone().negate() },
    ]
    for (const face of faces) this.addQuad(key, face.pts, face.n)
  }

  /** 添加正多边形棱柱（圆柱近似） */
  addPrism(
    key: PodiumMaterialKey,
    center: [number, number],
    radius: number,
    y0: number,
    y1: number,
    sides = 8,
  ): void {
    if (!this.canAfford(sides * 4)) return
    const h = Math.max(1e-6, y1 - y0)
    const angleAt = (i: number) => (i / sides) * Math.PI * 2
    for (let i = 0; i < sides; i++) {
      const a0 = angleAt(i)
      const a1 = angleAt(i + 1)
      const p0 = new THREE.Vector3(center[0] + Math.cos(a0) * radius, y0, center[1] + Math.sin(a0) * radius)
      const p1 = new THREE.Vector3(center[0] + Math.cos(a1) * radius, y0, center[1] + Math.sin(a1) * radius)
      const p2 = new THREE.Vector3(p1.x, y0 + h, p1.z)
      const p3 = new THREE.Vector3(p0.x, y0 + h, p0.z)
      const mid = (a0 + a1) / 2
      this.addQuad(key, [p0, p1, p2, p3], new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)))
    }
    const centerTop = new THREE.Vector3(center[0], y1, center[1])
    const centerBottom = new THREE.Vector3(center[0], y0, center[1])
    for (let i = 0; i < sides; i++) {
      const a0 = angleAt(i)
      const a1 = angleAt(i + 1)
      const top0 = new THREE.Vector3(center[0] + Math.cos(a0) * radius, y1, center[1] + Math.sin(a0) * radius)
      const top1 = new THREE.Vector3(center[0] + Math.cos(a1) * radius, y1, center[1] + Math.sin(a1) * radius)
      const bot0 = new THREE.Vector3(top0.x, y0, top0.z)
      const bot1 = new THREE.Vector3(top1.x, y0, top1.z)
      this.pushTriangle(key, centerTop, top0, top1, Y_AXIS)
      this.pushTriangle(key, centerBottom, bot1, bot0, Y_AXIS.clone().negate())
    }
  }

  /** 沿环的外立面（竖直环带），按门洞开口裁剪 */
  addRingWall(key: PodiumMaterialKey, ring: RingXZ, y0: number, y1: number): void {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      const dx = b[0] - a[0]
      const dz = b[1] - a[1]
      const len = Math.hypot(dx, dz)
      if (len < 1e-9) continue
      const outward = new THREE.Vector3(dz / len, 0, -dx / len)
      const holes = this.holesForEdge(a, dx / len, dz / len, len, i)
      if (!holes.length) {
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
        continue
      }
      const kept = subtractHoleRects({ u0: 0, u1: len, y0, y1 }, holes)
      for (const r of kept) {
        if (r.u1 - r.u0 <= 1e-4 || r.y1 - r.y0 <= 1e-4) continue
        const t0 = r.u0 / len
        const t1 = r.u1 / len
        const ax = a[0] + (b[0] - a[0]) * t0
        const az = a[1] + (b[1] - a[1]) * t0
        const bx = a[0] + (b[0] - a[0]) * t1
        const bz = a[1] + (b[1] - a[1]) * t1
        this.addQuad(
          key,
          [
            new THREE.Vector3(ax, r.y0, az),
            new THREE.Vector3(bx, r.y0, bz),
            new THREE.Vector3(bx, r.y1, bz),
            new THREE.Vector3(ax, r.y1, az),
          ],
          outward,
        )
      }
    }
  }

  /** 环之间的水平面（台基顶面 / 雨棚上下表面），按门洞开口裁剪 */
  addRingHorizontal(key: PodiumMaterialKey, inner: RingXZ, outer: RingXZ, y: number, up: boolean): void {
    const n = Math.min(inner.length, outer.length)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const oa = outer[i]
      const ob = outer[j]
      const ia = inner[i]
      const ib = inner[j]
      const normal = new THREE.Vector3(0, up ? 1 : -1, 0)
      const dx = ob[0] - oa[0]
      const dz = ob[1] - oa[1]
      const len = Math.hypot(dx, dz)
      // 水平面只在低于门洞高度时才会遮挡大门
      const holes =
        len < 1e-9
          ? []
          : this.holesForEdge(oa, dx / len, dz / len, len, i).filter((h) => y < h.height - 0.002)
      if (!holes.length) {
        this.addQuad(
          key,
          [
            new THREE.Vector3(oa[0], y, oa[1]),
            new THREE.Vector3(ob[0], y, ob[1]),
            new THREE.Vector3(ib[0], y, ib[1]),
            new THREE.Vector3(ia[0], y, ia[1]),
          ],
          normal,
        )
        continue
      }
      const kept = subtractHoleRects({ u0: 0, u1: len, y0: 0, y1: y + 1 }, holes)
      for (const r of kept) {
        if (r.u1 - r.u0 <= 1e-4) continue
        const t0 = r.u0 / len
        const t1 = r.u1 / len
        const o0: [number, number] = [oa[0] + dx * t0, oa[1] + dz * t0]
        const o1: [number, number] = [oa[0] + dx * t1, oa[1] + dz * t1]
        const i0: [number, number] = [ia[0] + (ib[0] - ia[0]) * t0, ia[1] + (ib[1] - ia[1]) * t0]
        const i1: [number, number] = [ia[0] + (ib[0] - ia[0]) * t1, ia[1] + (ib[1] - ia[1]) * t1]
        this.addQuad(
          key,
          [
            new THREE.Vector3(o0[0], y, o0[1]),
            new THREE.Vector3(o1[0], y, o1[1]),
            new THREE.Vector3(i1[0], y, i1[1]),
            new THREE.Vector3(i0[0], y, i0[1]),
          ],
          normal,
        )
      }
    }
  }

  toGeometry(key: PodiumMaterialKey): THREE.BufferGeometry | null {
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
    return (Object.keys(this.buckets) as PodiumMaterialKey[]).filter(
      (key) => this.buckets[key].indices.length > 0,
    ).length
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
 * 底座构件与建筑外墙、裙墙之间只隔 3~15cm：相机拉远后深度精度不足，
 * 两层表面会交替胜出，表现为底座整体泛白闪烁。
 * 按「离墙越远越靠前」给出递增的负偏移，让绘制顺序在远处也保持稳定。
 */
const PODIUM_PART_DEPTH_BIAS: Record<PodiumPartKey, number> = {
  tier: -1,
  band: -1,
  steps: -1,
  planter: -1,
  recess: -2,
  louver: -3,
  rail: -3,
  column: -3,
  canopy: -3,
}

/** 按构件材质的颜色/金属度/粗糙度签名共享基础材质（贴图由场景层另行克隆补挂） */
function getPodiumMaterial(spec: PartMaterialConfig, depthBias = 0): THREE.MeshStandardMaterial {
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
  material.userData.__buildingPodiumMaterial = true
  materialCache.set(cacheKey, material)
  if (materialCache.size > MATERIAL_CACHE_LIMIT) {
    const oldest = materialCache.keys().next().value
    if (oldest !== undefined) {
      // 只从缓存移除，不 dispose：材质仍被场景中既有网格引用
      materialCache.delete(oldest)
    }
  }
  return material
}

/* -------------------------------------------------------------------------- */
/* 距离 LOD 注册表                                                              */
/* -------------------------------------------------------------------------- */

const podiumGroups = new Set<THREE.Group>()

export function updateBuildingPodiumLod(camera: THREE.Camera): void {
  if (podiumGroups.size === 0) return
  const cameraPos = new THREE.Vector3()
  camera.getWorldPosition(cameraPos)
  const world = new THREE.Vector3()
  for (const group of Array.from(podiumGroups)) {
    if (!group.parent) {
      podiumGroups.delete(group)
      continue
    }
    const center = group.userData.__reliefCenter as THREE.Vector3 | undefined
    if (!center) continue
    const limit = Number(group.userData.__reliefLodDistance) || 140
    world.copy(center).applyMatrix4(group.matrixWorld)
    group.visible = cameraPos.distanceTo(world) <= limit
  }
}

export function clearBuildingPodiumRegistry(): void {
  podiumGroups.clear()
}

export function disposeBuildingPodiumGroup(group: THREE.Object3D | null | undefined): void {
  if (!group) return
  disposePartTextures(group)
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if ((mesh as unknown as { isMesh?: boolean }).isMesh && mesh.geometry) mesh.geometry.dispose()
  })
  group.removeFromParent()
  if (group instanceof THREE.Group) podiumGroups.delete(group)
}

export function disposeBuildingPodiumMaterialCache(): void {
  for (const material of materialCache.values()) material.dispose()
  materialCache.clear()
}

/* -------------------------------------------------------------------------- */
/* 主入口                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 构建建筑底座。
 *
 * @param ringXZ 建筑轮廓环（本地场景 XZ，米）
 * @param config 底座配置
 * @param options 正面 faceIndex / 三角面预算
 */
export function buildBuildingPodium(
  ringXZ: RingXZ,
  config: PodiumConfig,
  options: PodiumBuildOptions = {},
): PodiumBuildResult | null {
  const cfg = normalizePodiumConfig(config)
  if (!cfg || !cfg.enabled) return null

  const baseRing = decimateRing(normalizeRingXZ(ringXZ), MAX_RING_POINTS)
  if (baseRing.length < 3) return null

  const builder = new PodiumBuilder(options.triangleBudget ?? PODIUM_TRIANGLE_BUDGET)
  builder.setOpenings(options.openings)
  const tiers = Math.round(cfg.tierCount)
  const tierHeight = cfg.tierHeight
  const baseTop = tiers * tierHeight

  // 1) 台基：每级为环形棱柱（外立面 + 顶面环带）
  for (let t = 0; t < tiers; t++) {
    const outer = offsetRingXZ(baseRing, (tiers - t) * cfg.tierOffset)
    const inner = t + 1 < tiers ? offsetRingXZ(baseRing, (tiers - t - 1) * cfg.tierOffset) : baseRing
    builder.addRingWall('tier', outer, t * tierHeight, (t + 1) * tierHeight)
    builder.addRingHorizontal('tier', inner, outer, (t + 1) * tierHeight, true)
  }

  // 2) 实心裙墙（石材）：外立面 + 顶部环带
  if (cfg.bandOffset > 0.01) {
    const outer = offsetRingXZ(baseRing, cfg.bandOffset)
    builder.addRingWall('band', outer, baseTop, baseTop + cfg.bandHeight)
    builder.addRingHorizontal('band', baseRing, outer, baseTop + cfg.bandHeight, true)
  }

  // 3) 内凹底商背板：贴在原墙外侧 3cm 的深色环面
  if (cfg.bandOffset <= 0.1) {
    const backing = offsetRingXZ(baseRing, 0.03)
    builder.addRingWall('recess', backing, baseTop, baseTop + cfg.bandHeight)
  }

  // 4) 横向百叶：裙墙上部的水平薄板
  if (cfg.louverCount > 0) {
    const louverRing = offsetRingXZ(baseRing, cfg.bandOffset + 0.04)
    const yStart = baseTop + cfg.bandHeight * 0.38
    const yEnd = baseTop + cfg.bandHeight * 0.96
    const gap = (yEnd - yStart) / cfg.louverCount
    const slatHeight = Math.min(0.14, Math.max(0.04, gap * 0.55))
    for (let i = 0; i < cfg.louverCount; i++) {
      const centerY = yStart + gap * (i + 0.5)
      builder.addRingWall('louver', louverRing, centerY - slatHeight / 2, centerY + slatHeight / 2)
    }
  }

  // 5) 横向扶手 / 横梁
  if (cfg.railCount > 0) {
    const railRing = offsetRingXZ(
      baseRing,
      Math.max(cfg.bandOffset, 0) + cfg.columnInset + cfg.columnSize * 0.5 + 0.06,
    )
    for (let r = 0; r < cfg.railCount; r++) {
      const ratio = cfg.railCount === 1 ? 1 : r / (cfg.railCount - 1)
      const y = baseTop + cfg.bandHeight * (0.3 + 0.66 * ratio)
      builder.addRingWall('rail', railRing, y - 0.04, y + 0.04)
    }
  }

  // 6) 柱廊：沿周长等距柱列
  if (cfg.columnSpacing > 0.1) {
    const columnHeight = cfg.canopyDepth > 0.05
      // 柱顶嵌入雨棚板内，避免与雨棚下表面共面闪烁（嵌入量不超过板厚一半，不会露头）
      ? Math.max(0.6, cfg.canopyHeight + Math.max(0.01, Math.min(0.08, cfg.canopyThickness * 0.5)))
      : cfg.bandHeight
    const centerOffset = cfg.columnInset + cfg.columnSize / 2
    for (const sample of sampleRing(baseRing, cfg.columnSpacing)) {
      const cx = sample.point[0] + sample.outward[0] * centerOffset
      const cz = sample.point[1] + sample.outward[1] * centerOffset
      // 柱落在门洞范围内时整体跳过，避免遮挡大门
      if (builder.blockedAt(cx, cz, baseTop, baseTop + columnHeight, cfg.columnSize / 2)) continue
      if (cfg.columnShape === 'round') {
        builder.addPrism('column', [cx, cz], cfg.columnSize / 2, baseTop, baseTop + columnHeight, 8)
      } else {
        builder.addOrientedBox(
          'column',
          new THREE.Vector3(cx, baseTop + columnHeight / 2, cz),
          [cfg.columnSize, columnHeight, cfg.columnSize],
          sample.dir,
          sample.outward,
        )
      }
    }
  }

  // 7) 悬挑雨棚：外沿立面 + 下表面 + 上表面
  if (cfg.canopyDepth > 0.05) {
    const outer = offsetRingXZ(baseRing, cfg.canopyDepth)
    const y0 = baseTop + cfg.canopyHeight
    const y1 = y0 + cfg.canopyThickness
    builder.addRingWall('canopy', outer, y0, y1)
    builder.addRingHorizontal('canopy', baseRing, outer, y0, false)
    builder.addRingHorizontal('canopy', baseRing, outer, y1, true)
  }

  // 8) 前场：中央入口平台 / 台阶 / 两侧花池
  const frontIndex = resolveFrontFaceIndex(baseRing, options.frontFaceIndex)
  const front = frontIndex == null ? null : faceFrameXZ(baseRing, frontIndex)
  if (front) {
    const platformHeight = Math.max(0.25, baseTop)
    const platformWidth = Math.min(Math.max(1.2, front.width * 0.35), 8)
    // 台基/裙墙已把外轮廓向外扩了一圈，前场构件必须从最外圈起算，否则会被台基吞掉
    const outerOffset = Math.max(cfg.tierCount * cfg.tierOffset, cfg.bandOffset)
    const outward = new THREE.Vector3(front.outward[0], 0, front.outward[1])
    const along = new THREE.Vector3(front.dir[0], 0, front.dir[1])
    const mid = new THREE.Vector3(front.mid[0], 0, front.mid[1])
    // 前场按门洞开口切分：大门覆盖的中央段被移除，两侧保留
    const frontHoles = frontIndex == null ? [] : builder.holesForRingEdge(baseRing, frontIndex)
    const centerU = front.width / 2
    const segments = subtractHoleRects(
      {
        u0: Math.max(0, centerU - platformWidth / 2),
        u1: Math.min(front.width, centerU + platformWidth / 2),
        y0: 0,
        y1: platformHeight,
      },
      frontHoles,
    ).filter((r) => r.u1 - r.u0 >= 0.4)

    if (cfg.entranceProjection > 0.05) {
      for (const seg of segments) {
        const width = seg.u1 - seg.u0
        const uOffset = (seg.u0 + seg.u1) / 2 - centerU
        const center = mid
          .clone()
          .addScaledVector(along, uOffset)
          .addScaledVector(outward, outerOffset + cfg.entranceProjection / 2)
        builder.addOrientedBox(
          'steps',
          new THREE.Vector3(center.x, platformHeight / 2, center.z),
          [width, platformHeight, cfg.entranceProjection],
          front.dir,
          front.outward,
        )
      }
    }

    if (cfg.stepCount > 0) {
      const rise = platformHeight / (cfg.stepCount + 1)
      for (let s = 0; s < cfg.stepCount; s++) {
        const topY = platformHeight - rise * (s + 1)
        if (topY <= 0.03) break
        for (const seg of segments) {
          const width = seg.u1 - seg.u0
          const uOffset = (seg.u0 + seg.u1) / 2 - centerU
          const center = mid
            .clone()
            .addScaledVector(along, uOffset)
            .addScaledVector(
              outward,
              outerOffset + cfg.entranceProjection + cfg.stepOffset * (s + 0.5),
            )
          builder.addOrientedBox(
            'steps',
            new THREE.Vector3(center.x, topY / 2, center.z),
            [width + 0.4, topY, cfg.stepOffset],
            front.dir,
            front.outward,
          )
        }
      }
    }

    if (cfg.planterHeight > 0.05) {
      const depth = outerOffset + cfg.entranceProjection + cfg.stepOffset * cfg.stepCount
        + cfg.planterThickness / 2 + 0.2
      const wallLength = Math.min(Math.max(1.2, front.width * 0.28), 8)
      const gap = platformWidth / 2 + wallLength / 2 + 0.2
      for (const sign of [-1, 1]) {
        const center = mid
          .clone()
          .addScaledVector(along, sign * gap)
          .addScaledVector(outward, depth)
        // 花池落在门洞范围内时跳过
        if (builder.blockedAt(center.x, center.z, 0, cfg.planterHeight, wallLength / 2)) continue
        builder.addOrientedBox(
          'planter',
          new THREE.Vector3(center.x, cfg.planterHeight / 2, center.z),
          [wallLength, cfg.planterHeight, cfg.planterThickness],
          front.dir,
          front.outward,
        )
      }
    }
  }

  if (builder.triangles === 0) return null

  const group = new THREE.Group()
  group.name = PODIUM_GROUP_NAME
  group.userData.isBuildingPodium = true
  for (const key of PODIUM_PART_KEYS) {
    const geometry = builder.toGeometry(key)
    if (!geometry) continue
    const material = getPodiumMaterial(cfg.parts[key], PODIUM_PART_DEPTH_BIAS[key])
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `${PODIUM_GROUP_NAME}:${key}`
    mesh.userData.isBuildingPodium = true
    mesh.userData.__buildingPodiumSharedMaterial = true
    mesh.userData.__buildingPart = key
    mesh.userData.__partBaseMaterial = material
    mesh.castShadow = false
    mesh.receiveShadow = true
    // 底座不参与拾取，避免遮挡建筑本体的点击
    mesh.raycast = () => {}
    group.add(mesh)
  }
  if (group.children.length === 0) return null

  // 距离 LOD：以轮廓包围盒为基准
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of baseRing) {
    minX = Math.min(minX, p[0])
    maxX = Math.max(maxX, p[0])
    minZ = Math.min(minZ, p[1])
    maxZ = Math.max(maxZ, p[1])
  }
  const radius = Math.max(maxX - minX, maxZ - minZ) * 0.75
  const center = new THREE.Vector3((minX + maxX) / 2, Math.max(baseTop, cfg.bandHeight) / 2, (minZ + maxZ) / 2)
  group.userData.__reliefCenter = center
  group.userData.__reliefLodDistance = Math.max(80, radius * 12)
  podiumGroups.add(group)

  return {
    group,
    stats: {
      triangles: builder.triangles,
      drawCalls: builder.drawCalls,
      clamped: builder.clamped,
    },
  }
}
