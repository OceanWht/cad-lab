/**
 * HATCH 边界转换：把 libredwg 的边界路径转成填充图元或边界折线。
 *
 * 说明：
 * - 边界有「折线路径」与「边路径」两类，边又分直线 / 圆弧 / 椭圆 / 样条四种；
 * - 实心填充（solidFill = 1）输出 `CadFillPrimitive`，图案填充只输出闭合边界折线，
 *   不模拟图案线；
 * - 环的方向统一归一化为「外环逆时针、内洞顺时针」（CAD 的 y 轴向上口径）；
 * - 多层嵌套按「包含深度奇偶」判定外环与内洞，与 HATCH 的 odd parity 语义一致；
 * - 单条边数据非法时整条边界路径作废，不做部分拼接，避免产生错误面片。
 */

import type {
  DwgArcEdge,
  DwgBoundaryPath,
  DwgBoundaryPathEdge,
  DwgEdgeBoundaryPath,
  DwgEllipseEdge,
  DwgHatchEntity,
  DwgPolylineBoundaryPath,
} from '@mlightcad/libredwg-web'
import { DwgHatchSolidFill } from '@mlightcad/libredwg-web'
import { buildPolylinePoints, distance, sampleArc, sampleEllipse } from './geometry'
import { isSplineValid, sampleSpline } from './spline'
import type { CadPoint, CadPrimitive } from './types'

/** 环去重时使用的相对容差（相对弦高容差），用于剔除解析产生的重合点 */
const DUPLICATE_RATIO = 1e-3

/** 面积小于该比例的环视为退化（相对弦高容差的平方） */
const AREA_RATIO = 1e-6

/** 复制成独立的 CadPoint，避免把解析库对象直接带进 IR */
function toPoint(source: { x: number; y: number }): CadPoint {
  return { x: source.x, y: source.y }
}

/** 去掉相邻重合点与首尾重复点，得到隐式闭合环（不保留重复首点） */
function normalizeLoop(points: CadPoint[], tolerance: number): CadPoint[] {
  const epsilon = tolerance * DUPLICATE_RATIO
  const result: CadPoint[] = []
  for (const point of points) {
    const last = result[result.length - 1]
    if (last && distance(last, point) <= epsilon) continue
    result.push(point)
  }
  while (result.length >= 2 && distance(result[0], result[result.length - 1]) <= epsilon) {
    result.pop()
  }
  return result
}

/** 有符号面积：CAD 的 y 轴向上，正值表示逆时针 */
function signedArea(points: CadPoint[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** 射线法判断点是否在多边形内（含洞的环面也按单环判断） */
function containsPoint(polygon: CadPoint[], point: CadPoint): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses = (a.y > point.y) !== (b.y > point.y)
    if (!crosses) continue
    const intersectionX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (point.x < intersectionX) inside = !inside
  }
  return inside
}

/** 折线边界路径 → 闭合环 */
function polylinePathToLoop(
  path: DwgPolylineBoundaryPath,
  tolerance: number,
): CadPoint[] {
  const vertices = path.vertices ? path.vertices : []
  // 折线边界本身是环，开放标志也按闭合处理：填充区域必须闭合
  const points = buildPolylinePoints(vertices, true, tolerance)
  return normalizeLoop(points, tolerance)
}

/** 圆弧角度扫掠：isCCW 为 false 时按顺时针取负向扫掠 */
function arcSweep(startAngle: number, endAngle: number, isCCW: boolean): number {
  let sweep = endAngle - startAngle
  if (isCCW) {
    while (sweep <= 0) sweep += Math.PI * 2
  } else {
    while (sweep >= 0) sweep -= Math.PI * 2
  }
  return sweep
}

/** 圆弧边 → 折线点列（含起点与终点） */
function sampleArcEdge(edge: DwgArcEdge, tolerance: number): CadPoint[] {
  const center = toPoint(edge.center)
  const sweep = arcSweep(edge.startAngle, edge.endAngle, edge.isCCW !== false)
  const points = sampleArc(center, edge.radius, edge.startAngle, sweep, tolerance)
  points.push({
    x: center.x + edge.radius * Math.cos(edge.startAngle + sweep),
    y: center.y + edge.radius * Math.sin(edge.startAngle + sweep),
  })
  return points
}

/** 椭圆边 → 折线点列（含起点与终点） */
function sampleEllipseEdge(edge: DwgEllipseEdge, tolerance: number): CadPoint[] {
  const center = toPoint(edge.center)
  // `end` 为长轴端点相对圆心的向量，`lengthOfMinorAxis` 实际存的是短长轴比
  const majorAxis = toPoint(edge.end)
  const axisRatio = edge.lengthOfMinorAxis
  const isCCW = edge.isCCW !== false
  if (isCCW) {
    const points = sampleEllipse(
      center,
      majorAxis,
      axisRatio,
      edge.startAngle,
      edge.endAngle,
      tolerance,
    )
    points.push({
      x:
        center.x +
        majorAxis.x * Math.cos(edge.endAngle) -
        majorAxis.y * axisRatio * Math.sin(edge.endAngle),
      y:
        center.y +
        majorAxis.y * Math.cos(edge.endAngle) +
        majorAxis.x * axisRatio * Math.sin(edge.endAngle),
    })
    return points
  }
  // 顺时针等价于「从终点逆时针到起点」再反向
  const reversed = sampleEllipse(
    center,
    majorAxis,
    axisRatio,
    edge.endAngle,
    edge.startAngle,
    tolerance,
  )
  reversed.push({
    x:
      center.x +
      majorAxis.x * Math.cos(edge.startAngle) -
      majorAxis.y * axisRatio * Math.sin(edge.startAngle),
    y:
      center.y +
      majorAxis.y * Math.cos(edge.startAngle) +
      majorAxis.x * axisRatio * Math.sin(edge.startAngle),
  })
  reversed.reverse()
  return reversed
}

/** 单条边界 → 折线点列；数据非法时返回 null，由调用方整条路径作废 */
function sampleEdge(edge: DwgBoundaryPathEdge, tolerance: number): CadPoint[] | null {
  // 四种边共用同一个 type 字段类型，无法靠它做判别联合，改用特征字段收窄
  if ('start' in edge) {
    return [toPoint(edge.start), toPoint(edge.end)]
  }
  if ('radius' in edge) {
    return sampleArcEdge(edge, tolerance)
  }
  if ('lengthOfMinorAxis' in edge) {
    return sampleEllipseEdge(edge, tolerance)
  }
  const controlPoints = edge.controlPoints.map((point) => ({
    x: point.x,
    y: point.y,
    weight: typeof point.weight === 'number' ? point.weight : undefined,
  }))
  if (!isSplineValid(edge.degree, edge.knots.length, controlPoints.length)) return null
  return sampleSpline(edge.degree, edge.knots, controlPoints, tolerance, false)
}

/** 边路径 → 闭合环；任一条边非法时返回 null */
function edgePathToLoop(
  path: DwgEdgeBoundaryPath<DwgBoundaryPathEdge>,
  tolerance: number,
): CadPoint[] | null {
  const edges = path.edges ? path.edges : []
  const points: CadPoint[] = []
  for (const edge of edges) {
    const segment = sampleEdge(edge, tolerance)
    if (!segment) return null
    for (const point of segment) points.push(point)
  }
  return normalizeLoop(points, tolerance)
}

/** 边界路径 → 闭合环；无法转换时返回 null */
function boundaryPathToLoop(path: DwgBoundaryPath, tolerance: number): CadPoint[] | null {
  if ('vertices' in path) return polylinePathToLoop(path, tolerance)
  return edgePathToLoop(path, tolerance)
}

/** 判断环是否退化（面积过小） */
function isDegenerateArea(area: number, tolerance: number): boolean {
  return Math.abs(area) < tolerance * tolerance * AREA_RATIO
}

/**
 * 把一条 HATCH 实体转成可渲染图元。
 * - 实心填充：每个外环产出一个 `fill` 图元，内洞挂在同一图元里；
 * - 图案填充：每个环产出一条闭合边界折线。
 * 无有效边界时返回空数组，由调用方计入未渲染实体。
 */
export function hatchToPrimitives(entity: DwgHatchEntity, tolerance: number): CadPrimitive[] {
  const paths = entity.boundaryPaths ? entity.boundaryPaths : []
  const loops: CadPoint[][] = []
  for (const path of paths) {
    const loop = boundaryPathToLoop(path, tolerance)
    if (!loop || loop.length < 3) continue
    if (isDegenerateArea(signedArea(loop), tolerance)) continue
    loops.push(loop)
  }
  if (loops.length === 0) return []

  const isSolidFill = entity.solidFill === DwgHatchSolidFill.SolidFill
  if (!isSolidFill) {
    return loops.map((loop) => ({ kind: 'polyline', points: loop, closed: true }))
  }

  // 包含深度：被奇数个环包含的是内洞，偶数个的是外环
  const depths = loops.map((loop, index) => {
    let depth = 0
    for (let other = 0; other < loops.length; other += 1) {
      if (other === index) continue
      if (containsPoint(loops[other], loop[0])) depth += 1
    }
    return depth
  })

  // 内洞只挂到「包含它的最深层外环」，避免三层嵌套时被重复扣除
  const parents = loops.map((loop, index) => {
    let parent = -1
    let parentDepth = -1
    for (let other = 0; other < loops.length; other += 1) {
      if (other === index) continue
      if (!containsPoint(loops[other], loop[0])) continue
      if (depths[other] > parentDepth) {
        parentDepth = depths[other]
        parent = other
      }
    }
    return parent
  })

  const result: CadPrimitive[] = []
  for (let index = 0; index < loops.length; index += 1) {
    if (depths[index] % 2 !== 0) continue
    const outer = loops[index].slice()
    // 外环统一为逆时针，保证面片朝上
    if (signedArea(outer) < 0) outer.reverse()
    const children: CadPoint[][] = []
    for (let inner = 0; inner < loops.length; inner += 1) {
      if (depths[inner] % 2 === 0) continue
      if (parents[inner] !== index) continue
      const hole = loops[inner].slice()
      // 内洞统一为顺时针
      if (signedArea(hole) > 0) hole.reverse()
      children.push(hole)
    }
    result.push({ kind: 'fill', loops: [outer, ...children] })
  }
  return result
}
