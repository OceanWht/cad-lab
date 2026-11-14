/**
 * 地板轮廓：段列表模型、三点定弧、2mm 扁平化、自交校验与楼板挤出。
 *
 * 说明：
 * - 轮廓以「直线段 / 圆弧段」的段列表保存，圆弧只存起点、终点与弧上一点，
 *   圆心、半径与扫掠角在需要时推导，避免重绘时累积折线误差；
 * - 平面预览绘制真实圆弧，三角化、自交检测与导出才按 2mm 弦高扁平
 *   （与 `buildDrawing.ts` 的曲线容差一致）；
 * - 校验失败一律返回明确错误或抛错，不用包围盒 / 凸包 / 自动补全生成近似轮廓。
 */

import * as THREE from 'three'
import { sampleArc } from './geometry'

/** 轮廓顶点（米，CAD 平面坐标） */
export interface OutlinePoint {
  x: number
  y: number
}

/** 直线段：起点 + 终点 */
export interface LineOutlineSegment {
  kind: 'line'
  start: OutlinePoint
  end: OutlinePoint
}

/** 圆弧段：起点 + 终点 + 弧上一点（三点定弧） */
export interface ArcOutlineSegment {
  kind: 'arc'
  start: OutlinePoint
  end: OutlinePoint
  through: OutlinePoint
}

/** 轮廓段 */
export type OutlineSegment = LineOutlineSegment | ArcOutlineSegment

/** 闭合轮廓：段按顺序首尾相接，末段终点回到首段起点 */
export interface SlabOutline {
  segments: OutlineSegment[]
  /**
   * 内环（洞口 / 内院）：每个内环都是独立闭合轮廓。
   * 内环必须完全落在当前外环之内，内环之间不得相交或嵌套。
   */
  holes?: SlabOutline[]
}

/** 扁平化弦高误差上限（米），与墙体曲线采样一致 */
export const OUTLINE_TOLERANCE_M = 0.002
/** 相邻点去重距离（米） */
export const OUTLINE_MERGE_DISTANCE_M = 0.001
/** 轮廓最少段数 */
export const MIN_OUTLINE_SEGMENTS = 3
/** 三点共线判定：三角形面积相对弦长平方的比例 */
const COLLINEAR_RATIO = 1e-6
/** 圆弧半径下限（米） */
const MIN_ARC_RADIUS = 1e-6
/** 线段相交判定的方向叉积容差 */
const ORIENT_EPSILON = 1e-9

/** 三点定弧的推导结果 */
export interface ArcParameters {
  center: OutlinePoint
  radius: number
  /** 起点相对圆心的角度（弧度） */
  startAngle: number
  /** 有符号扫掠角（正为逆时针），保证圆弧经过 `through` */
  sweep: number
}

/** 扁平化结果：闭合点列（不重复首点）与每段在点列中的起点下标 */
export interface FlatOutline {
  points: OutlinePoint[]
  /** 段 i 的点为 points[segmentStarts[i]] 起，到下一段起点为止 */
  segmentStarts: number[]
}

/** 轮廓校验结果 */
export interface OutlineValidation {
  valid: boolean
  /** 中文错误，`valid` 为 true 时为空串 */
  message: string
  /** 冲突段下标；没有具体冲突时为空数组 */
  conflictSegments: number[]
}

/** 楼板几何：与墙体同一套米制坐标（x, y 为 CAD 平面，Y 轴向上） */
export interface SlabGeometry {
  positions: Float32Array
  normals: Float32Array
  /** 平面包围盒（米） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** 顶点数量 */
  vertexCount: number
  /** 板顶标高（恒为 0，由调用方按楼层平移） */
  topY: number
  /** 板底标高（恒为 -板厚） */
  bottomY: number
  /** 材质分组：0 为上下端盖，1 为侧壁 */
  groups: Array<{ start: number; count: number; materialIndex: number }>
}

/** 两点距离 */
function distanceOf(a: OutlinePoint, b: OutlinePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 叉积 (b - a) × (c - a) */
function crossOf(a: OutlinePoint, b: OutlinePoint, c: OutlinePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/** 两点是否重合（1mm 内） */
function samePoint(a: OutlinePoint, b: OutlinePoint): boolean {
  return distanceOf(a, b) < OUTLINE_MERGE_DISTANCE_M
}

/** 空轮廓 */
export function emptyOutline(): SlabOutline {
  return { segments: [] }
}

/** 由直线段的起终点构造一条直线段；两点重合时抛错 */
export function createLineSegment(start: OutlinePoint, end: OutlinePoint): LineOutlineSegment {
  if (samePoint(start, end)) throw new Error('直线段的起点与终点重合，无法成段')
  return { kind: 'line', start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } }
}

/**
 * 三点定弧：由两条弦的中垂线求外接圆心，扫掠角取「经过弧上点」的那一侧。
 * 三点共线或弧上点与端点重合时抛错。
 */
export function arcParameters(
  start: OutlinePoint,
  through: OutlinePoint,
  end: OutlinePoint,
): ArcParameters {
  const chord = distanceOf(start, end)
  if (!(chord > MIN_ARC_RADIUS)) {
    throw new Error('圆弧段的起点与终点重合，无法成弧')
  }
  // 弧上点落在端点附近时弧退化为直线，同样不接受
  if (samePoint(start, through) || samePoint(end, through)) {
    throw new Error('圆弧的弧上点与端点重合，无法成弧')
  }

  const ax = start.x
  const ay = start.y
  const bx = end.x
  const by = end.y
  const cx = through.x
  const cy = through.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  // 三角形面积相对弦长平方过小即视为共线
  if (!(Math.abs(d) > 2 * COLLINEAR_RATIO * chord * chord)) {
    throw new Error('圆弧的三点共线，无法确定圆心')
  }

  const sqA = ax * ax + ay * ay
  const sqB = bx * bx + by * by
  const sqC = cx * cx + cy * cy
  const center: OutlinePoint = {
    x: (sqA * (by - cy) + sqB * (cy - ay) + sqC * (ay - by)) / d,
    y: (sqA * (cx - bx) + sqB * (ax - cx) + sqC * (bx - ax)) / d,
  }
  const radius = Math.hypot(ax - center.x, ay - center.y)
  if (!(radius > MIN_ARC_RADIUS) || !Number.isFinite(radius)) {
    throw new Error(`圆弧半径无效：${radius}`)
  }

  const startAngle = Math.atan2(ay - center.y, ax - center.x)
  const endAngle = Math.atan2(by - center.y, bx - center.x)
  const throughAngle = Math.atan2(cy - center.y, cx - center.x)
  const ccwSweep = normalizeAngle(endAngle - startAngle)
  const ccwThrough = normalizeAngle(throughAngle - startAngle)
  // 弧上点落在逆时针区间内就是逆时针弧，否则取补弧（顺时针）
  const sweep = ccwThrough < ccwSweep ? ccwSweep : ccwSweep - Math.PI * 2

  return { center, radius, startAngle, sweep }
}

/** 把角度归一化到 [0, 2π) */
function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2
  let value = angle % twoPi
  if (value < 0) value += twoPi
  return value
}

/** 由三点构造圆弧段；三点共线等非法输入直接抛错 */
export function createArcSegment(
  start: OutlinePoint,
  through: OutlinePoint,
  end: OutlinePoint,
): ArcOutlineSegment {
  arcParameters(start, through, end)
  return {
    kind: 'arc',
    start: { x: start.x, y: start.y },
    end: { x: end.x, y: end.y },
    through: { x: through.x, y: through.y },
  }
}

/** 追加一段；与上一段终点不连续（偏差超过 1mm）时抛错 */
export function appendOutlineSegment(outline: SlabOutline, segment: OutlineSegment): SlabOutline {
  const previous = outline.segments[outline.segments.length - 1]
  if (previous && distanceOf(previous.end, segment.start) > OUTLINE_MERGE_DISTANCE_M) {
    const offset = distanceOf(previous.end, segment.start)
    throw new Error(`新段的起点必须接在上一段终点：偏差 ${offset.toFixed(3)} m`)
  }
  return { segments: [...outline.segments, segment] }
}

/** 删除最后一段；空轮廓返回空轮廓 */
export function removeLastOutlineSegment(outline: SlabOutline): SlabOutline {
  if (outline.segments.length === 0) return outline
  return { segments: outline.segments.slice(0, -1) }
}

/** 追加一个内环；内环不能再嵌套内环 */
export function appendOutlineHole(outline: SlabOutline, hole: SlabOutline): SlabOutline {
  if (hole.holes && hole.holes.length > 0) {
    throw new Error('内环不能再包含内环')
  }
  return { ...outline, holes: [...(outline.holes ?? []), hole] }
}

/** 删除最后一个内环；没有内环时原样返回 */
export function removeLastOutlineHole(outline: SlabOutline): SlabOutline {
  const holes = outline.holes ?? []
  if (holes.length === 0) return outline
  return { ...outline, holes: holes.slice(0, -1) }
}

/** 清空全部内环，保留外环 */
export function clearOutlineHoles(outline: SlabOutline): SlabOutline {
  return { segments: outline.segments }
}

/** 替换指定段（拖动弧上点时使用） */
export function replaceOutlineSegment(
  outline: SlabOutline,
  index: number,
  segment: OutlineSegment,
): SlabOutline {
  if (!Number.isInteger(index) || index < 0 || index >= outline.segments.length) {
    throw new Error(`轮廓段下标超出范围：${index}`)
  }
  const segments = outline.segments.slice()
  segments[index] = segment
  return { segments }
}

/** 轮廓是否已闭合：段数达标且末段终点回到首段起点 */
export function isOutlineClosed(outline: SlabOutline): boolean {
  const { segments } = outline
  if (segments.length < MIN_OUTLINE_SEGMENTS) return false
  return samePoint(segments[segments.length - 1].end, segments[0].start)
}

/** 轮廓总长度（米）：直线取弦长，圆弧按推导半径与扫掠角算弧长；含全部内环 */
export function outlineLength(outline: SlabOutline): number {
  let total = loopLength(outline)
  for (const hole of outline.holes ?? []) total += loopLength(hole)
  return total
}

/** 单条闭合环的长度（米） */
function loopLength(outline: SlabOutline): number {
  let total = 0
  for (const segment of outline.segments) {
    if (segment.kind === 'line') {
      total += distanceOf(segment.start, segment.end)
      continue
    }
    const arc = arcParameters(segment.start, segment.through, segment.end)
    total += Math.abs(arc.sweep) * arc.radius
  }
  return total
}

/**
 * 按顺序扁平各段：直线取端点，圆弧按 2mm 弦高采样。
 * 相邻点距离小于 1mm 时去重，末点与首点重合时丢弃，输出闭合点列。
 */
export function flattenOutline(outline: SlabOutline): FlatOutline {
  if (outline.segments.length === 0) throw new Error('地板轮廓为空，至少需要 3 条段')

  const points: OutlinePoint[] = []
  const pointSegments: number[] = []
  const push = (point: OutlinePoint, segmentIndex: number): void => {
    const last = points[points.length - 1]
    if (last && distanceOf(last, point) < OUTLINE_MERGE_DISTANCE_M) return
    points.push({ x: point.x, y: point.y })
    pointSegments.push(segmentIndex)
  }

  outline.segments.forEach((segment, index) => {
    if (segment.kind === 'line') {
      push(segment.start, index)
      return
    }
    const arc = arcParameters(segment.start, segment.through, segment.end)
    // sampleArc 含起点、不含终点，终点由下一段起点补上
    for (const point of sampleArc(arc.center, arc.radius, arc.startAngle, arc.sweep, OUTLINE_TOLERANCE_M)) {
      push(point, index)
    }
  })

  if (points.length > 1 && distanceOf(points[points.length - 1], points[0]) < OUTLINE_MERGE_DISTANCE_M) {
    points.pop()
    pointSegments.pop()
  }

  const segmentStarts: number[] = []
  for (let index = 0; index < outline.segments.length; index += 1) {
    const found = pointSegments.indexOf(index)
    segmentStarts.push(found === -1 ? points.length : found)
  }

  return { points, segmentStarts }
}

/**
 * 扁平化外环与全部内环：返回值第 0 个是外环，其余依次为内环。
 * 任一条环为空或不足 3 条段时由 `flattenOutline` 抛错。
 */
export function flattenOutlineRings(outline: SlabOutline): FlatOutline[] {
  const rings: FlatOutline[] = [flattenOutline(outline)]
  for (const hole of outline.holes ?? []) rings.push(flattenOutline(hole))
  return rings
}

/** 点列中边 i（points[i] → points[i+1]）所属的段下标 */
function segmentOfEdge(flat: FlatOutline, edgeIndex: number): number {
  const { segmentStarts } = flat
  for (let index = segmentStarts.length - 1; index >= 0; index -= 1) {
    if (segmentStarts[index] <= edgeIndex) return index
  }
  return 0
}

/** 判断点 p 是否落在线段 ab 的包围盒内（共线时用） */
function onSegment(a: OutlinePoint, b: OutlinePoint, p: OutlinePoint): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - ORIENT_EPSILON &&
    p.x <= Math.max(a.x, b.x) + ORIENT_EPSILON &&
    p.y >= Math.min(a.y, b.y) - ORIENT_EPSILON &&
    p.y <= Math.max(a.y, b.y) + ORIENT_EPSILON
  )
}

/** 两条线段是否相交（含端点接触与共线重叠） */
function segmentsIntersect(
  a: OutlinePoint,
  b: OutlinePoint,
  c: OutlinePoint,
  d: OutlinePoint,
): boolean {
  const o1 = crossOf(a, b, c)
  const o2 = crossOf(a, b, d)
  const o3 = crossOf(c, d, a)
  const o4 = crossOf(c, d, b)
  const sameSide12 = (o1 > ORIENT_EPSILON && o2 > ORIENT_EPSILON) || (o1 < -ORIENT_EPSILON && o2 < -ORIENT_EPSILON)
  const sameSide34 = (o3 > ORIENT_EPSILON && o4 > ORIENT_EPSILON) || (o3 < -ORIENT_EPSILON && o4 < -ORIENT_EPSILON)
  if (!sameSide12 && !sameSide34) return true
  if (Math.abs(o1) <= ORIENT_EPSILON && onSegment(a, b, c)) return true
  if (Math.abs(o2) <= ORIENT_EPSILON && onSegment(a, b, d)) return true
  if (Math.abs(o3) <= ORIENT_EPSILON && onSegment(c, d, a)) return true
  if (Math.abs(o4) <= ORIENT_EPSILON && onSegment(c, d, b)) return true
  return false
}

/**
 * 在扁平点列上检测自交：只比较非相邻边，先按 AABB 剪枝。
 * 返回两条冲突边所属的段下标；无自交返回 null。
 */
function findSelfIntersection(flat: FlatOutline): [number, number] | null {
  const { points } = flat
  const count = points.length
  if (count < 4) return null

  const edgeCount = count
  for (let i = 0; i < edgeCount; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % count]
    const boxA = {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    }
    for (let j = i + 1; j < edgeCount; j += 1) {
      // 相邻边共享端点，不算自交
      if (j === i + 1 || (i === 0 && j === edgeCount - 1)) continue
      const c = points[j]
      const d = points[(j + 1) % count]
      if (boxA.maxX < Math.min(c.x, d.x) || Math.min(a.x, b.x) > Math.max(c.x, d.x)) continue
      if (boxA.maxY < Math.min(c.y, d.y) || Math.min(a.y, b.y) > Math.max(c.y, d.y)) continue
      if (!segmentsIntersect(a, b, c, d)) continue
      const first = segmentOfEdge(flat, i)
      const second = segmentOfEdge(flat, j)
      if (first === second) continue
      return first < second ? [first, second] : [second, first]
    }
  }
  return null
}

/**
 * 单条闭合环校验：段数、段连续性、弧参数、扁平点数与自交。
 * `label` 用于错误信息前缀，如「地板轮廓」/「内环 1」。
 */
function validateLoop(outline: SlabOutline, label: string): OutlineValidation {
  const { segments } = outline
  const fail = (message: string, conflictSegments: number[] = []): OutlineValidation => ({
    valid: false,
    message,
    conflictSegments,
  })

  if (segments.length < MIN_OUTLINE_SEGMENTS) {
    return fail(`${label}至少需要 ${MIN_OUTLINE_SEGMENTS} 条段，当前 ${segments.length} 条`)
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const next = segments[(index + 1) % segments.length]
    if (samePoint(segment.start, segment.end)) {
      return fail(`第 ${index + 1} 段长度不足 1mm`, [index])
    }
    if (segment.kind === 'arc') {
      try {
        arcParameters(segment.start, segment.through, segment.end)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return fail(`第 ${index + 1} 段圆弧无效：${detail}`, [index])
      }
    }
    if (!samePoint(segment.end, next.start)) {
      return fail(
        `第 ${index + 1} 段与第 ${((index + 1) % segments.length) + 1} 段未首尾相接`,
        [index, (index + 1) % segments.length],
      )
    }
  }

  if (!isOutlineClosed(outline)) return fail(`${label}未闭合`)

  const flat = flattenOutline(outline)
  if (flat.points.length < 3) {
    return fail(`${label}扁平后只有 ${flat.points.length} 个点，至少需要 3 个`)
  }
  const conflict = findSelfIntersection(flat)
  if (conflict) {
    return fail(`${label}自相交：第 ${conflict[0] + 1} 段与第 ${conflict[1] + 1} 段相交`, conflict)
  }

  return { valid: true, message: '', conflictSegments: [] }
}

/**
 * 轮廓校验：外环自身合法，且每个内环合法、完全位于外环内、与外环及其它内环不相交。
 * 失败返回中文错误与冲突段下标，调用方据此停留绘制态。
 */
export function validateOutline(outline: SlabOutline): OutlineValidation {
  const outer = validateLoop(outline, '地板轮廓')
  if (!outer.valid) return outer

  const holes = outline.holes ?? []
  if (holes.length === 0) return outer

  const outerFlat = flattenOutline(outline)
  const flatHoles: FlatOutline[] = []
  for (let index = 0; index < holes.length; index += 1) {
    const hole = holes[index]
    const label = `内环 ${index + 1}`
    if (hole.holes && hole.holes.length > 0) {
      return { valid: false, message: `${label}不能再包含内环`, conflictSegments: [] }
    }
    const result = validateLoop(hole, label)
    if (!result.valid) {
      return { valid: false, message: result.message, conflictSegments: [] }
    }
    const flatHole = flattenOutline(hole)
    if (!flatHole.points.every((point) => pointInRing(point, outerFlat.points))) {
      return { valid: false, message: `${label}必须完全位于外轮廓之内`, conflictSegments: [] }
    }
    if (ringsCross(outerFlat.points, flatHole.points)) {
      return { valid: false, message: `${label}与外轮廓相交`, conflictSegments: [] }
    }
    for (let previous = 0; previous < flatHoles.length; previous += 1) {
      const other = flatHoles[previous]
      const crosses = ringsCross(other.points, flatHole.points)
      const nested = pointInRing(flatHole.points[0], other.points) || pointInRing(other.points[0], flatHole.points)
      if (crosses || nested) {
        return {
          valid: false,
          message: `内环 ${previous + 1} 与内环 ${index + 1} 相交或嵌套`,
          conflictSegments: [],
        }
      }
    }
    flatHoles.push(flatHole)
  }

  return { valid: true, message: '', conflictSegments: [] }
}

/** 点是否落在闭合点列内（射线法；边界接触由相交检测负责判定） */
function pointInRing(point: OutlinePoint, ring: OutlinePoint[]): boolean {
  let inside = false
  const count = ring.length
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const a = ring[i]
    const b = ring[j]
    if ((a.y > point.y) !== (b.y > point.y)) {
      const crossX = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y)
      if (point.x < crossX) inside = !inside
    }
  }
  return inside
}

/** 两个闭合点列是否存在边相交（不同环之间不做相邻边豁免） */
function ringsCross(a: OutlinePoint[], b: OutlinePoint[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i]
    const a2 = a[(i + 1) % a.length]
    const aMinX = Math.min(a1.x, a2.x)
    const aMaxX = Math.max(a1.x, a2.x)
    const aMinY = Math.min(a1.y, a2.y)
    const aMaxY = Math.max(a1.y, a2.y)
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j]
      const b2 = b[(j + 1) % b.length]
      if (aMaxX < Math.min(b1.x, b2.x) || Math.max(b1.x, b2.x) < aMinX) continue
      if (aMaxY < Math.min(b1.y, b2.y) || Math.max(b1.y, b2.y) < aMinY) continue
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }
  return false
}

/**
 * 把轮廓沿板厚挤出为楼板。
 *
 * `THREE.ExtrudeGeometry` 生成 (x, y, z=depth) 的棱柱，绕 X 轴 +90° 后
 * (x, y, z) → (x, −z, y)：板顶落在 y = 0，板厚向下占用 [−板厚, 0]，
 * 与墙体的局部映射 `(x, y) → (x, height, y)` 完全一致。
 * 图纸北向到世界 −z 的翻转由视图在模型根上统一镜像，这里同样不做翻转。
 */
export function buildSlabGeometry(outline: SlabOutline, slabThickness: number): SlabGeometry {
  if (!(slabThickness > 0)) throw new Error(`板厚必须为正数：${slabThickness}`)

  const validation = validateOutline(outline)
  if (!validation.valid) throw new Error(validation.message)

  const flat = flattenOutline(outline)
  const shape = new THREE.Shape(flat.points.map((point) => new THREE.Vector2(point.x, point.y)))
  // 内环以 Shape.holes 表达：ExtrudeGeometry 会挖空洞口并自动生成洞壁
  for (const hole of outline.holes ?? []) {
    const flatHole = flattenOutline(hole)
    shape.holes.push(new THREE.Path(flatHole.points.map((point) => new THREE.Vector2(point.x, point.y))))
  }
  const extruded = new THREE.ExtrudeGeometry(shape, {
    depth: slabThickness,
    bevelEnabled: false,
    curveSegments: 1,
  })
  extruded.rotateX(Math.PI / 2)

  const position = extruded.getAttribute('position')
  const normal = extruded.getAttribute('normal')
  const positions = Float32Array.from(position.array as ArrayLike<number>)
  const normals = normal
    ? Float32Array.from(normal.array as ArrayLike<number>)
    : new Float32Array(positions.length)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let bottomY = Infinity
  let topY = -Infinity
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index]
    const height = positions[index + 1]
    const z = positions[index + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minY) minY = z
    if (z > maxY) maxY = z
    if (height < bottomY) bottomY = height
    if (height > topY) topY = height
  }

  // 板顶必须严格落在 y = 0、板底落在 −板厚；方向错了整块板会悬在墙脚之上
  if (Math.abs(topY) > 1e-6) throw new Error(`楼板顶面未落在 y = 0：${topY}`)
  if (Math.abs(bottomY + slabThickness) > 1e-6) {
    throw new Error(`楼板底面标高错误：${bottomY}（期望 ${-slabThickness}）`)
  }

  const groups = extruded.groups.map((group) => ({
    start: group.start,
    count: group.count,
    materialIndex: group.materialIndex ?? 0,
  }))
  extruded.dispose()

  return {
    positions,
    normals,
    bounds: { minX, minY, maxX, maxY },
    vertexCount: positions.length / 3,
    topY: 0,
    bottomY: -slabThickness,
    groups,
  }
}
