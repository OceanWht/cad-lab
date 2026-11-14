/**
 * 墙体闭合：把用户手动绘制的连接线转为墙体中心线。
 *
 * 说明：
 * - 连接线无条件成为墙段：用户按下「完成连接」即生成墙体，不要求两端落在既有墙链端点上，
 *   也不检查是否一定形成闭合环；
 * - 每个折点若落在既有墙段端点 0.3m 内，都会精确对齐到该端点，
 *   消除墙带半厚造成的视觉偏差，让绘制线真正与既有墙带焊接；
 * - 每段连接线独立匹配它所连接的墙体：取该段起点所连墙段的图层与墙厚，
 *   起点未连墙时取终点所连墙段，两端都未连墙时才使用调用方给定的默认值；
 * - 只有「不足一条有效直线段」时才报错，不做静默丢弃。
 */

import type { CadPoint } from './types'
import type { OutlinePoint } from './slabOutline'
import type { WallSegment } from './wallModel'
import { WALL_WELD_TOLERANCE } from './wallModel'

/** 单段连接线匹配到的墙体规格 */
export interface WallClosureProfile {
  layer: string
  thickness: number
}

/** 连接线不受任何几何限制：任何直线段都会成为墙体 */
export interface WallClosurePath {
  /** 折点（米，CAD 平面坐标）；折点可能已对齐到既有墙段端点 */
  points: CadPoint[]
  /** 每段连接线匹配到的墙体规格，长度恒为 points.length - 1 */
  profiles: WallClosureProfile[]
}

/** 校验通过后的闭合方案 */
export interface WallClosurePlan {
  /** 连接线路径（折点已对齐端点，每段带匹配到的墙体规格） */
  path: WallClosurePath
  /** 可直接并入墙体中心线的分段（图纸单位） */
  segments: WallSegment[]
}

/** 闭合方案生成结果 */
export interface WallClosureResult {
  /** 生成成功时的方案；失败为 null */
  plan: WallClosurePlan | null
  /** 中文失败原因；成功时为空串 */
  error: string
}

/** 没有既有墙段可参照时使用的默认图层与墙厚 */
export interface WallClosureFallback {
  layer: string
  thickness: number
}

/** 首尾折点吸附到既有墙段端点的最大距离（米），覆盖半墙厚造成的视觉偏差 */
export const CLOSURE_SNAP_M = 0.3

/** 两点距离 */
function distanceOf(a: CadPoint, b: CadPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** 两点是否在焊接容差内重合 */
function samePoint(a: CadPoint, b: CadPoint): boolean {
  return distanceOf(a, b) <= WALL_WELD_TOLERANCE
}

/** 图纸单位墙段换算到米 */
function toMetric(segments: readonly WallSegment[], unitScale: number): WallSegment[] {
  return segments.map((segment) => ({
    a: { x: segment.a.x * unitScale, y: segment.a.y * unitScale },
    b: { x: segment.b.x * unitScale, y: segment.b.y * unitScale },
    layer: segment.layer,
    thickness: segment.thickness,
    key: segment.key,
  }))
}

/** 点到线段的最短距离（米） */
function distanceToSegment(point: CadPoint, a: CadPoint, b: CadPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (!(lengthSq > 1e-18)) return distanceOf(point, a)
  const raw = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  const t = Math.max(0, Math.min(1, raw))
  return distanceOf(point, { x: a.x + t * dx, y: a.y + t * dy })
}

/** 返回 `limit` 范围内最近的既有墙段端点；没有则返回 null */
function nearestEndpoint(
  endpoints: readonly CadPoint[],
  point: CadPoint,
  limit: number,
): CadPoint | null {
  let best: CadPoint | null = null
  let bestDistance = limit
  for (const endpoint of endpoints) {
    const distance = distanceOf(endpoint, point)
    if (distance <= bestDistance) {
      best = endpoint
      bestDistance = distance
    }
  }
  return best
}

/** 返回离折点最近的既有墙段及其距离 */
function nearestWall(
  segments: readonly WallSegment[],
  point: CadPoint,
): { segment: WallSegment; distance: number } | null {
  let best: WallSegment | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const segment of segments) {
    const distance = distanceToSegment(point, segment.a, segment.b)
    if (distance < bestDistance) {
      best = segment
      bestDistance = distance
    }
  }
  return best ? { segment: best, distance: bestDistance } : null
}

/**
 * 折点是否连在该墙段上：落在墙带范围内（半墙厚 + 焊接容差）或吸附容差内。
 * 用半墙厚放宽，是因为用户视觉上点在墙带边缘，离中心线正好半个墙厚。
 */
function connectsTo(point: CadPoint, segment: WallSegment, distance: number): boolean {
  return distance <= Math.max(CLOSURE_SNAP_M, segment.thickness / 2 + WALL_WELD_TOLERANCE)
}

/** 折点所连墙段的墙体规格；未连墙时返回 null */
function connectedProfile(
  segments: readonly WallSegment[],
  point: CadPoint,
): WallClosureProfile | null {
  const nearest = nearestWall(segments, point)
  if (!nearest || !connectsTo(point, nearest.segment, nearest.distance)) return null
  return { layer: nearest.segment.layer, thickness: nearest.segment.thickness }
}

/** 连接线分段的稳定几何键：以米制坐标按 1mm 取整，跨重建保持不变 */
function closureKey(a: CadPoint, b: CadPoint, layer: string): string {
  const ax = Math.round(a.x / WALL_WELD_TOLERANCE)
  const ay = Math.round(a.y / WALL_WELD_TOLERANCE)
  const bx = Math.round(b.x / WALL_WELD_TOLERANCE)
  const by = Math.round(b.y / WALL_WELD_TOLERANCE)
  return `closure|${layer}|${ax},${ay}|${bx},${by}`
}

/**
 * 把连接线折点转成墙体中心线分段（图纸单位）。
 * 折点重合或单位换算非法时直接抛错，不做静默跳段。
 */
export function buildClosureSegments(
  path: WallClosurePath,
  unitScale: number,
): WallSegment[] {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  if (path.points.length < 2) throw new Error('墙体闭合连接线至少需要两个折点')
  if (path.profiles.length !== path.points.length - 1) {
    throw new Error('墙体闭合连接线的墙体规格数量与分段数量不一致')
  }

  const segments: WallSegment[] = []
  for (let index = 0; index < path.points.length - 1; index += 1) {
    const start = path.points[index]
    const end = path.points[index + 1]
    const profile = path.profiles[index]
    if (samePoint(start, end)) {
      throw new Error(`墙体闭合连接线第 ${index + 1} 段的起点与终点重合`)
    }
    if (!(profile.thickness > 0)) {
      throw new Error(`墙体闭合连接线第 ${index + 1} 段的墙厚无效：${profile.thickness}`)
    }
    segments.push({
      a: { x: start.x / unitScale, y: start.y / unitScale },
      b: { x: end.x / unitScale, y: end.y / unitScale },
      layer: profile.layer,
      thickness: profile.thickness,
      key: closureKey(start, end, profile.layer),
    })
  }
  return segments
}

/**
 * 由用户绘制的折点生成墙体分段。
 *
 * 不校验两端是否落在墙链端点上，也不要求一定闭合：绘制的每一段都会成为墙体。
 */
export function planWallClosure(
  existing: readonly WallSegment[],
  points: readonly OutlinePoint[],
  unitScale: number,
  fallback: WallClosureFallback,
): WallClosureResult {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  if (points.length < 2) {
    return { plan: null, error: '墙体闭合连接线至少需要一条直线段，请再落一个点。' }
  }

  const metric = toMetric(existing, unitScale)
  const endpoints: CadPoint[] = []
  for (const segment of metric) {
    endpoints.push(segment.a, segment.b)
  }

  // 每个折点都吸附到 0.3m 内的墙段端点：视觉上的墙端与中心线端点相差半个墙厚，
  // 中间折点同样需要对齐，才能和既有墙带真正焊接
  const aligned: CadPoint[] = points.map((point) => ({ x: point.x, y: point.y }))
  for (let index = 0; index < aligned.length; index += 1) {
    const snap = nearestEndpoint(endpoints, aligned[index], CLOSURE_SNAP_M)
    if (snap) aligned[index] = { x: snap.x, y: snap.y }
  }

  // 逐段匹配所连墙体：优先取该段起点所连墙段的图层与墙厚，
  // 起点悬空时取终点所连墙段，两端都未连墙时才退回默认规格
  const vertexProfiles = aligned.map((point) => connectedProfile(metric, point))
  const profiles: WallClosureProfile[] = []
  for (let index = 0; index < aligned.length - 1; index += 1) {
    profiles.push(
      vertexProfiles[index] ??
        vertexProfiles[index + 1] ?? {
          layer: fallback.layer,
          thickness: fallback.thickness,
        },
    )
  }

  const path: WallClosurePath = { points: aligned, profiles }
  try {
    const segments = buildClosureSegments(path, unitScale)
    return { plan: { path, segments }, error: '' }
  } catch (error) {
    return { plan: null, error: error instanceof Error ? error.message : String(error) }
  }
}
