/**
 * 几何工具：圆弧 / 椭圆离散、bulge 展开、仿射变换与包围盒。
 *
 * 这里的函数全部是纯函数，便于单元测试；不依赖 three.js 与 DOM。
 */

import type { CadBounds, CadPoint } from './types'

/** 仿射变换矩阵（CAD 二维：x' = a*x + c*y + e, y' = b*x + d*y + f） */
export interface AffineMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY_MATRIX: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** 应用仿射变换 */
export function applyMatrix(matrix: AffineMatrix, point: CadPoint): CadPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }
}

/**
 * 组合变换：先应用 local，再应用 parent。
 * 用于 INSERT 嵌套展开。
 */
export function composeMatrix(parent: AffineMatrix, local: AffineMatrix): AffineMatrix {
  return {
    a: parent.a * local.a + parent.c * local.b,
    b: parent.b * local.a + parent.d * local.b,
    c: parent.a * local.c + parent.c * local.d,
    d: parent.b * local.c + parent.d * local.d,
    e: parent.a * local.e + parent.c * local.f + parent.e,
    f: parent.b * local.e + parent.d * local.f + parent.f,
  }
}

/** 构造 INSERT 的块坐标 → 世界坐标变换：平移(插入点) · 旋转 · 缩放 · 平移(-基点) */
export function buildInsertMatrix(
  insertionPoint: CadPoint,
  rotation: number,
  scaleX: number,
  scaleY: number,
  basePoint: CadPoint,
): AffineMatrix {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return {
    a: cos * scaleX,
    b: sin * scaleX,
    c: -sin * scaleY,
    d: cos * scaleY,
    e: insertionPoint.x - (cos * scaleX * basePoint.x - sin * scaleY * basePoint.y),
    f: insertionPoint.y - (sin * scaleX * basePoint.x + cos * scaleY * basePoint.y),
  }
}

/** 两点距离 */
export function distance(a: CadPoint, b: CadPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * 把单段圆弧离散为折线点（含起点，不含终点）。
 * @param center 圆心
 * @param radius 半径
 * @param startAngle 起始角（弧度）
 * @param sweep 有符号扫掠角（弧度，正为逆时针）
 * @param tolerance 弦高误差上限（图纸单位）
 */
export function sampleArc(
  center: CadPoint,
  radius: number,
  startAngle: number,
  sweep: number,
  tolerance: number,
): CadPoint[] {
  if (radius <= 0 || Math.abs(sweep) < 1e-9) {
    return [{ x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) }]
  }
  const absSweep = Math.abs(sweep)
  const points: CadPoint[] = []
  const steps = arcSegmentCount(radius, absSweep, tolerance)
  for (let i = 0; i < steps; i += 1) {
    const angle = startAngle + (sweep * i) / steps
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) })
  }
  return points
}

/** 根据弦高误差计算圆弧分段数（限制在 2..512，避免极端数据拖垮渲染） */
function arcSegmentCount(radius: number, absSweep: number, tolerance: number): number {
  if (tolerance >= radius) {
    const coarse = Math.ceil(absSweep / (Math.PI / 2))
    return coarse < 2 ? 2 : coarse
  }
  const maxStep = 2 * Math.acos(1 - tolerance / radius)
  const steps = Math.ceil(absSweep / maxStep)
  if (steps < 2) return 2
  if (steps > 512) return 512
  return steps
}

/**
 * 把多段线 bulge 段展开为圆弧点列。
 *
 * DXF 约定：bulge = tan(θ/4)，θ 为有符号包含角，正值表示从起点到终点逆时针。
 * 返回的数组包含 p1（首点）与 p2（末点），便于直接拼接。
 */
export function sampleBulgeSegment(
  p1: CadPoint,
  p2: CadPoint,
  bulge: number,
  tolerance: number,
): CadPoint[] {
  // 返回纯坐标对象，避免把顶点的 bulge 等附加字段带入折线点列
  const startPoint: CadPoint = { x: p1.x, y: p1.y }
  const endPoint: CadPoint = { x: p2.x, y: p2.y }
  if (Math.abs(bulge) < 1e-9) return [startPoint, endPoint]

  const theta = 4 * Math.atan(bulge)
  const chord = distance(p1, p2)
  if (chord < 1e-9) return [startPoint, endPoint]

  // 有符号半径：sin(θ/2) 的符号与 θ 一致
  const signedRadius = chord / (2 * Math.sin(theta / 2))
  const radius = Math.abs(signedRadius)

  const ux = (p2.x - p1.x) / chord
  const uy = (p2.y - p1.y) / chord
  // 左法线方向
  const nx = -uy
  const ny = ux
  const offset = signedRadius * Math.cos(theta / 2)
  const center: CadPoint = {
    x: (p1.x + p2.x) / 2 + nx * offset,
    y: (p1.y + p2.y) / 2 + ny * offset,
  }
  const startAngle = Math.atan2(p1.y - center.y, p1.x - center.x)
  const points = sampleArc(center, radius, startAngle, theta, tolerance)
  points.push(endPoint)
  return points
}

/**
 * 把一段多段线（含 bulge）展开为折线点列。
 * closed 为 true 时会把末点闭合回起点（不重复记录起点）。
 */
export function buildPolylinePoints(
  vertices: Array<CadPoint & { bulge?: number }>,
  closed: boolean,
  tolerance: number,
): CadPoint[] {
  if (vertices.length === 0) return []
  if (vertices.length === 1) return [{ x: vertices[0].x, y: vertices[0].y }]

  const result: CadPoint[] = [{ x: vertices[0].x, y: vertices[0].y }]
  const count = closed ? vertices.length : vertices.length - 1
  for (let i = 0; i < count; i += 1) {
    const from = vertices[i]
    const to = vertices[(i + 1) % vertices.length]
    const segment = sampleBulgeSegment(from, to, from.bulge ?? 0, tolerance)
    for (let k = 1; k < segment.length; k += 1) result.push(segment[k])
  }
  return result
}

/**
 * 椭圆离散：中心 + 长轴端点向量 + 短长轴比。
 * start/end 为参数角（弧度），整椭圆传 0..2π。
 */
export function sampleEllipse(
  center: CadPoint,
  majorAxis: CadPoint,
  axisRatio: number,
  startAngle: number,
  endAngle: number,
  tolerance: number,
): CadPoint[] {
  const majorLength = Math.hypot(majorAxis.x, majorAxis.y)
  if (majorLength < 1e-9) return [center]
  const minorLength = majorLength * axisRatio
  const maxRadius = majorLength > minorLength ? majorLength : minorLength
  let sweep = endAngle - startAngle
  if (sweep <= 0) sweep += Math.PI * 2
  const steps = arcSegmentCount(maxRadius, sweep, tolerance)

  // 短轴方向为长轴逆时针旋转 90°
  const minorAxis: CadPoint = { x: -majorAxis.y * axisRatio, y: majorAxis.x * axisRatio }
  const points: CadPoint[] = []
  for (let i = 0; i < steps; i += 1) {
    const t = startAngle + (sweep * i) / steps
    points.push({
      x: center.x + majorAxis.x * Math.cos(t) + minorAxis.x * Math.sin(t),
      y: center.y + majorAxis.y * Math.cos(t) + minorAxis.y * Math.sin(t),
    })
  }
  return points
}

/** 圆离散为闭合折线（不重复首点） */
export function sampleCircle(
  center: CadPoint,
  radius: number,
  tolerance: number,
): CadPoint[] {
  return sampleArc(center, radius, 0, Math.PI * 2, tolerance)
}

/** 计算点集包围盒；空集返回 null */
export function boundsOfPoints(points: CadPoint[]): CadBounds | null {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 剔除离群点后的主体包围盒（2% ~ 98% 分位）。
 * 图纸里常有远离主体的图块（例如 4.7km 外的构件），
 * 直接用全量包围盒会导致初始视图缩放得极小。
 */
export function robustBoundsOfPoints(points: CadPoint[]): CadBounds | null {
  if (points.length === 0) return null
  const xs = points.map((p) => p.x).sort((a, b) => a - b)
  const ys = points.map((p) => p.y).sort((a, b) => a - b)
  const low = Math.floor((xs.length - 1) * 0.02)
  const high = Math.ceil((xs.length - 1) * 0.98)
  return {
    minX: xs[low],
    minY: ys[low],
    maxX: xs[high],
    maxY: ys[high],
  }
}

/** 合并两个包围盒 */
export function mergeBounds(a: CadBounds | null, b: CadBounds | null): CadBounds | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: a.minX < b.minX ? a.minX : b.minX,
    minY: a.minY < b.minY ? a.minY : b.minY,
    maxX: a.maxX > b.maxX ? a.maxX : b.maxX,
    maxY: a.maxY > b.maxY ? a.maxY : b.maxY,
  }
}

/** 判断折线是否几何闭合（首尾距离小于容差） */
export function isGeometricallyClosed(points: CadPoint[], tolerance: number): boolean {
  if (points.length < 3) return false
  return distance(points[0], points[points.length - 1]) <= tolerance
}
