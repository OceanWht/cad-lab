/**
 * 编辑态对象拾取：把墙段中心线、门窗洞口与幕墙中心线投影到屏幕空间，
 * 按距离与矩形相交做命中判定。
 *
 * 说明：
 * - 全部为纯函数，只依赖 three 的相机数学，不依赖 DOM 与渲染器，便于单元测试；
 * - 不使用三角形 raycast：墙厚只有 0.2m 量级，整栋楼视角下单面墙往往不足 10 像素，
 *   射线求交极易落空，中心线投影更稳定；
 * - 投影点在相机背后或超出远裁面（`ndcZ > 1`）时剔除，不参与命中；
 * - 拾取对象统一抽象成 `PickLine`：任何构件只要给出「键 + 一段代表线段」就能被点选 / 框选。
 */

import * as THREE from 'three'

/**
 * 恒等变换：墙体几何直接当作世界坐标。
 *
 * 三维视图的模型根做了 z 轴镜像时，调用方必须传入模型根的本地矩阵，
 * 否则中心线会投影到镜像位置，点选 / 框选全部错位。
 */
const IDENTITY_MATRIX = new THREE.Matrix4()

/** 屏幕坐标（像素，左上角为原点；ndcZ 为裁剪空间深度） */
export interface ScreenPoint {
  x: number
  y: number
  ndcZ: number
}

/** 屏幕矩形（像素，minX ≤ maxX、minY ≤ maxY） */
export interface ScreenRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 可拾取对象：一段用于屏幕投影的代表线段（模型局部坐标，米）。
 *
 * - 墙段：墙中心线（取半墙高作为代表标高）；
 * - 门窗：洞口中心线（取洞口半高作为代表标高）；
 * - 幕墙：幕墙中心线（取半墙高作为代表标高）。
 */
export interface PickLine {
  /** 对象稳定键：墙段键 / 门窗键（@opening:…）/ 幕墙键（@curtain:…） */
  key: string
  /** 线段起点（模型局部坐标） */
  a: THREE.Vector3
  /** 线段终点（模型局部坐标） */
  b: THREE.Vector3
}

/** 世界坐标投影到屏幕坐标 */
export function projectPoint(
  world: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
): ScreenPoint {
  const ndc = world.clone().project(camera)
  return {
    x: ((ndc.x + 1) / 2) * width,
    y: ((1 - ndc.y) / 2) * height,
    ndcZ: ndc.z,
  }
}

/** 取代表线段的屏幕投影；任一端在相机背后时返回 null */
function lineScreenSegment(
  line: PickLine,
  camera: THREE.Camera,
  width: number,
  height: number,
  localToWorld: THREE.Matrix4,
): { a: ScreenPoint; b: ScreenPoint } | null {
  const a = projectPoint(line.a.clone().applyMatrix4(localToWorld), camera, width, height)
  const b = projectPoint(line.b.clone().applyMatrix4(localToWorld), camera, width, height)
  if (a.ndcZ > 1 || b.ndcZ > 1) return null
  return { a, b }
}

/** 点到线段的最短距离 */
export function distanceToSegment(point: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y)
  const raw = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  const t = Math.min(1, Math.max(0, raw))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/** 光标点选：返回阈值内距离最近的对象键；距离并列时取更近的一侧 */
export function pickLineAt(
  lines: readonly PickLine[],
  camera: THREE.Camera,
  width: number,
  height: number,
  cursor: { x: number; y: number },
  thresholdPx: number,
  localToWorld: THREE.Matrix4 = IDENTITY_MATRIX,
): string | null {
  let bestKey: string | null = null
  let bestDistance = Infinity
  let bestZ = Infinity
  const point: ScreenPoint = { x: cursor.x, y: cursor.y, ndcZ: 0 }

  for (const line of lines) {
    const screen = lineScreenSegment(line, camera, width, height, localToWorld)
    if (!screen) continue
    const distance = distanceToSegment(point, screen.a, screen.b)
    if (distance > thresholdPx) continue
    const depth = Math.max(screen.a.ndcZ, screen.b.ndcZ)
    if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && depth < bestZ)) {
      bestDistance = distance
      bestZ = depth
      bestKey = line.key
    }
  }
  return bestKey
}

function pointInRect(point: ScreenPoint, rect: ScreenRect): boolean {
  return point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY
}

/** 两条线段是否相交（含端点） */
function segmentsIntersect(p1: ScreenPoint, p2: ScreenPoint, q1: ScreenPoint, q2: ScreenPoint): boolean {
  const denominator = (p2.x - p1.x) * (q2.y - q1.y) - (p2.y - p1.y) * (q2.x - q1.x)
  if (Math.abs(denominator) < 1e-12) return false
  const t = ((q1.x - p1.x) * (q2.y - q1.y) - (q1.y - p1.y) * (q2.x - q1.x)) / denominator
  const u = ((q1.x - p1.x) * (p2.y - p1.y) - (q1.y - p1.y) * (p2.x - p1.x)) / denominator
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

/** 线段与矩形是否相交（端点落在矩形内也视为相交） */
export function segmentIntersectsRect(a: ScreenPoint, b: ScreenPoint, rect: ScreenRect): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true
  const corners: ScreenPoint[] = [
    { x: rect.minX, y: rect.minY, ndcZ: 0 },
    { x: rect.maxX, y: rect.minY, ndcZ: 0 },
    { x: rect.maxX, y: rect.maxY, ndcZ: 0 },
    { x: rect.minX, y: rect.maxY, ndcZ: 0 },
  ]
  for (let i = 0; i < 4; i += 1) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true
  }
  return false
}

/** 框选：返回代表线段与矩形相交的全部对象键 */
export function selectLinesInRect(
  lines: readonly PickLine[],
  camera: THREE.Camera,
  width: number,
  height: number,
  rect: ScreenRect,
  localToWorld: THREE.Matrix4 = IDENTITY_MATRIX,
): string[] {
  const normalized: ScreenRect = {
    minX: Math.min(rect.minX, rect.maxX),
    minY: Math.min(rect.minY, rect.maxY),
    maxX: Math.max(rect.minX, rect.maxX),
    maxY: Math.max(rect.minY, rect.maxY),
  }
  const keys: string[] = []
  for (const line of lines) {
    const screen = lineScreenSegment(line, camera, width, height, localToWorld)
    if (!screen) continue
    if (segmentIntersectsRect(screen.a, screen.b, normalized)) keys.push(line.key)
  }
  return keys
}
