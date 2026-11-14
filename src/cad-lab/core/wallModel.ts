/**
 * 从选定图层提取墙体中心线，并生成可直接渲染的墙体几何。
 *
 * 说明：这是「试验性」的语义提取，不追求构件级准确：
 * - 折线的每一条边都视作墙中心线；
 * - 闭合折线按房间轮廓处理，同样沿边生成墙体；
 * - 重复线段会去重，避免双线墙出现重叠面；
 * - 几何生成前先经过顶点焊接 / 链合并 / miter 成环（见 wallTopology），
 *   转角处连续无缝，所有三角形统一为外法线朝外。
 */

import { distance } from './geometry'
import type { CadDrawing, CadPoint } from './types'
import { buildWallRings, mergeCollinearChains, weldVertices, type WallRing } from './wallTopology'

/** 墙中心线线段（图纸单位，墙厚为米） */
export interface WallSegment {
  a: CadPoint
  b: CadPoint
  layer: string
  /** 该图层墙厚（米） */
  thickness: number
  /** 稳定几何键（图层 + 原始端点，按 1mm 取整）；用于墙段删除与跨重建识别 */
  key: string
}

/** 单段中心线对应的几何片段 */
export interface WallPiece {
  /** 稳定几何键，与图纸原始中心线线段一一对应 */
  key: string
  layer: string
  /** 该段墙厚（米） */
  thickness: number
  /** 中心线长度（米） */
  length: number
  /** 中心线起点（米，CAD 平面坐标） */
  a: CadPoint
  /** 中心线终点（米，CAD 平面坐标） */
  b: CadPoint
  /** 在 positions 中的起始顶点下标（顶点 = 3 个浮点数） */
  vertexStart: number
  /** 该片段占用的顶点数量 */
  vertexCount: number
}

/** 墙体生成参数 */
export interface WallBuildOptions {
  /** 墙高（米） */
  height: number
  /** miter 长度上限，相对半墙厚的倍数 */
  miterLimit: number
}

/** 门窗类型 */
export type WallOpeningKind = 'door' | 'window'

/** 墙体洞口输入（米，CAD 平面坐标） */
export interface WallOpening {
  /**
   * 稳定对象键（`@opening:` 前缀），由生成端写入。
   * 编辑态用它点选 / 框选并删除门窗，重建后同一洞口保持同一键。
   */
  key?: string
  /** 所属墙段的稳定几何键 */
  wallKey: string
  kind: WallOpeningKind
  /** 洞口沿墙起点（落在墙中心线上） */
  start: CadPoint
  /** 洞口沿墙终点（落在墙中心线上） */
  end: CadPoint
  /** 洞口底标高（米）：门为 0，窗为窗台高 */
  sill: number
  /** 洞口高度（米） */
  height: number
  /**
   * 门窗做法预设标识（与 webmap `IndoorDoorPreset` / 窗型预设同名）。
   * 只作为语义提示，几何参数仍由洞口尺寸派生。
   */
  preset?: string
  /** 门连窗中窗所占的区段；缺省表示整个洞口都归门 */
  windowPart?: OpeningWindowPart
  /** 门连窗上亮的高度覆盖（相对洞口底，米） */
  transom?: { sill: number; height: number }
}

/**
 * 门连窗中的窗部分。
 *
 * 门窗画在同一位置时（如门连窗：一扇门 + 一樘固定窗），洞口按两者并集开一个矩形洞，
 * 门扇只占其中一段，另一段留给窗。区段偏移都相对洞口中心，沿墙方向为正。
 */
export interface OpeningWindowPart {
  /** 窗区段起点（相对洞口中心，米） */
  start: number
  /** 窗区段终点（相对洞口中心，米） */
  end: number
  /** 窗台高（相对洞口底，米） */
  sill: number
  /** 窗高（米） */
  height: number
}

/** 实际落地的洞口（米，CAD 平面坐标），供门窗构件生成使用 */
export interface WallOpeningPlacement {
  /** 稳定对象键，与来源 `WallOpening.key` 一致；缺省表示该构件不参与编辑态拾取 */
  key?: string
  wallKey: string
  kind: WallOpeningKind
  /** 洞口中心 */
  center: CadPoint
  /** 沿墙方向单位向量 */
  direction: CadPoint
  /** 洞口宽度（米，沿墙方向） */
  width: number
  /** 洞口高度（米） */
  height: number
  /** 洞口底标高（米） */
  sill: number
  /** 所在墙厚（米） */
  thickness: number
  /** 门窗做法预设标识，随洞口透传给构件生成与导出语义 */
  preset?: string
  /** 门连窗中窗所占的区段；缺省表示整个洞口都归门 */
  windowPart?: OpeningWindowPart
  /** 门连窗上亮的高度覆盖（相对洞口底，米）；缺省时按门扇常规高度自动派生 */
  transom?: { sill: number; height: number }
}

/** 门窗对象键前缀：与墙段键区分，两类键可以放进同一个选择 / 删除集合 */
export const OPENING_KEY_PREFIX = '@opening:'

/**
 * 门窗构件的稳定对象键。
 *
 * 由「所属墙段键 + 类型 + 洞口起止点（按毫米取整）」组成：重建时洞口参数不变，
 * 因此删除集合可以跨重建复用；同一墙段上的多个洞口也不会互相混淆。
 */
export function openingObjectKey(opening: {
  wallKey: string
  kind: WallOpeningKind
  start: CadPoint
  end: CadPoint
}): string {
  const pointKey = (point: CadPoint): string =>
    `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`
  return `${OPENING_KEY_PREFIX}${opening.wallKey}|${opening.kind}|${pointKey(opening.start)}|${pointKey(opening.end)}`
}

/** 墙体几何结果（米，three.js 的 XZ 平面 + Y 轴向上） */
export interface WallGeometryResult {
  positions: Float32Array
  /** 平面包围盒（米） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** 实际参与生成的墙带边数 */
  segmentCount: number
  /** 实际参与生成的墙带中心线总长度（米） */
  totalLength: number
  /** 因几何退化被跳过的墙带数量 */
  skippedRingCount: number
  /** 逐段几何片段，按中心线原始边划分，用于点选与删除 */
  pieces: WallPiece[]
  /** miter 后的墙带边界（米），保留给需要墙环轮廓的下游使用，避免重复做一次拓扑计算 */
  rings: WallRing[]
  /** 实际落地的洞口（含所属墙段与墙厚） */
  openings: WallOpeningPlacement[]
  /** 因越界或同边重叠被跳过的洞口数量 */
  skippedOpeningCount: number
}

/** 共线合并角度容差（0.5°） */
const COLLINEAR_ANGLE = (0.5 * Math.PI) / 180

/** 顶点焊接容差（米），即 1mm */
export const WALL_WELD_TOLERANCE = 0.001

/** 生成线段的去重键（无序端点，按容差取整） */
function segmentKey(a: CadPoint, b: CadPoint, tolerance: number): string {
  const ax = Math.round(a.x / tolerance)
  const ay = Math.round(a.y / tolerance)
  const bx = Math.round(b.x / tolerance)
  const by = Math.round(b.y / tolerance)
  const forward = `${ax},${ay}|${bx},${by}`
  const backward = `${bx},${by}|${ax},${ay}`
  return forward < backward ? forward : backward
}

/**
 * 从图层名 / 线型名里解析墙体厚度（米）。
 *
 * 施工图的图层名通常直接带墙厚：`A-WALL-200`、`墙-240`、`Q100`、`WALL_0.2`。
 * 规则：
 * - 带小数的数字按米解释（0.1 ~ 2）；
 * - 整数按毫米解释（40 ~ 1000），超出范围（楼层号、图号、年份）直接忽略；
 * - 紧邻「厚 / thick / 墙 / W-」等关键词的数字优先，其次取三位数。
 *
 * @returns 解析出的墙厚（米）；图层名没有可用的厚度标注时返回 null，
 *          由调用方决定跳过并提示，不使用任何默认墙厚。
 */
export function resolveLayerThicknessFromName(name: string): number | null {
  if (!name) return null
  let best: number | null = null
  let bestScore = -Infinity
  for (const match of name.matchAll(/\d+(?:\.\d+)?/g)) {
    const text = match[0]
    const value = Number(text)
    if (!Number.isFinite(value) || value <= 0) continue
    let meters: number | null = null
    if (text.includes('.')) {
      if (value >= 0.05 && value <= 2) meters = value
    } else if (Number.isInteger(value) && value >= 40 && value <= 1000) {
      meters = value / 1000
    }
    if (meters === null) continue
    const start = match.index ?? 0
    const prefix = name.slice(Math.max(0, start - 6), start)
    const suffix = name.slice(start + text.length, start + text.length + 3)
    let score = 0
    // 厚度关键词紧邻的数字最可信
    if (/厚|thick|wid|墙/i.test(prefix)) score += 3
    if (/^\s*(mm|厚)/i.test(suffix)) score += 2
    if (text.length === 3) score += 1
    if (score > bestScore) {
      bestScore = score
      best = meters
    }
  }
  if (best === null) return null
  return Math.round(best * 1000) / 1000
}

/** 收集墙线几何；`thicknessOf` 返回 0 表示该图层墙厚未知 */
function collectSegments(
  drawing: CadDrawing,
  layerNames: string[],
  thicknessOf: (layerName: string) => number,
): WallSegment[] {
  const wanted = new Set(layerNames)
  if (wanted.size === 0 || drawing.unitScale <= 0) return []

  // 去重容差取 1mm（图纸单位）
  const tolerance = 0.001 / drawing.unitScale
  const minLength = tolerance * 0.5
  const seen = new Set<string>()
  const thicknessByLayer = new Map<string, number>()
  const segments: WallSegment[] = []

  const resolveThickness = (layerName: string): number => {
    const cached = thicknessByLayer.get(layerName)
    if (cached !== undefined) return cached
    const thickness = thicknessOf(layerName)
    if (!Number.isFinite(thickness) || thickness < 0) {
      throw new Error(`图层「${layerName}」的墙厚无效：${thickness}`)
    }
    thicknessByLayer.set(layerName, thickness)
    return thickness
  }

  for (const entity of drawing.entities) {
    if (!wanted.has(entity.layer)) continue
    for (const primitive of entity.primitives) {
      // 填充面片没有中心线语义，不参与墙体提取；
      // 这里用 continue 而不是 else 分支，新增 kind 时会被类型检查捕获
      if (primitive.kind === 'fill') continue
      const points = primitive.points
      if (points.length < 2) continue
      const edgeCount = primitive.closed ? points.length : points.length - 1
      for (let i = 0; i < edgeCount; i += 1) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        if (distance(a, b) < minLength) continue
        // 去重键带上图层：不同墙层的同名线段是两道独立的墙
        const key = `${entity.layer}|${segmentKey(a, b, tolerance)}`
        if (seen.has(key)) continue
        seen.add(key)
        segments.push({ a, b, layer: entity.layer, thickness: resolveThickness(entity.layer), key })
      }
    }
  }
  return segments
}

/**
 * 收集指定图层的墙体中心线。
 * @param layerNames 用户勾选的墙体图层
 * @param thicknessOf 按图层取墙厚（米）；返回值非法时直接抛错，不做兜底
 */
export function collectWallSegments(
  drawing: CadDrawing,
  layerNames: string[],
  thicknessOf: (layerName: string) => number,
): WallSegment[] {
  return collectSegments(drawing, layerNames, (layerName) => {
    const thickness = thicknessOf(layerName)
    if (!Number.isFinite(thickness) || thickness <= 0) {
      throw new Error(`图层「${layerName}」的墙厚无效：${thickness}`)
    }
    return thickness
  })
}

/**
 * 收集墙线几何，但不要求图层已标注墙厚。
 *
 * 墙厚先取图层名里的数字标注；解析不到时厚度记 0（未知），
 * 交给 `pairDoubleLineWalls` 的双线实测结果回填，仍未配对的线段由调用方跳过并提示。
 */
export function collectWallSegmentsLoose(
  drawing: CadDrawing,
  layerNames: string[],
): WallSegment[] {
  return collectSegments(drawing, layerNames, (layerName) => resolveLayerThicknessFromName(layerName) ?? 0)
}

/** 双线墙配对参数 */
export interface WallPairingOptions {
  /** 可识别的最小墙厚（米），小于它的平行线视为双线绘图误差或门窗线 */
  minThickness?: number
  /** 可识别的最大墙厚（米），大于它多为两道独立墙体 */
  maxThickness?: number
  /** 平行判定容差（度） */
  angleTolerance?: number
  /** 两条线投影重叠率下限（相对较短的一条） */
  minOverlapRatio?: number
}

/** 双线墙配对结果 */
export interface WallPairingResult {
  /** 配对后用于建墙的墙段：配对成功的取实测墙厚与中线，未配对的沿用图层墙厚 */
  segments: WallSegment[]
  /** 成功配对的墙段数（每对计一段） */
  pairedCount: number
  /** 未找到平行搭档、沿用图层墙厚的线段数 */
  unpairedCount: number
  /** 实测到的墙厚取值（米，升序去重），供界面提示 */
  measuredThickness: number[]
}

/** 双线墙识别的默认参数 */
const PAIR_MIN_THICKNESS = 0.05
const PAIR_MAX_THICKNESS = 1
const PAIR_ANGLE_TOLERANCE = 1
const PAIR_MIN_OVERLAP_RATIO = 0.5

/**
 * 把「双线墙」识别成一道墙。
 *
 * 施工图的墙体通常画成两条平行等距线：如果直接把每条线都当中心线，
 * 一道 200 的墙会被挤成两道 200 的墙叠在一起（约 400 厚），
 * 门窗洞口又只挖在其中一条线上，另一条墙永远挡在洞口前后。
 *
 * 这里在同一图层内把平行、等距、投影重叠的两条线配成一对：
 * - 墙厚取两条线的垂直距离（图纸实测值，不再统一）；
 * - 中心线取两条线对应端点的中点，miter 转角处正好互为补充，闭合环仍然闭合；
 * - 找不到搭档的线保留原样（沿用图层墙厚），并计数交给界面提示，不做静默处理。
 */
export function pairDoubleLineWalls(
  segments: readonly WallSegment[],
  unitScale: number,
  options: WallPairingOptions = {},
): WallPairingResult {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  const minThickness = options.minThickness ?? PAIR_MIN_THICKNESS
  const maxThickness = options.maxThickness ?? PAIR_MAX_THICKNESS
  const angleTolerance = options.angleTolerance ?? PAIR_ANGLE_TOLERANCE
  const minOverlapRatio = options.minOverlapRatio ?? PAIR_MIN_OVERLAP_RATIO

  // 统一换算到米后判断平行与距离；中心线仍用图纸坐标计算，避免来回换算引入误差
  const metric = segments.map((segment) => {
    const dx = (segment.b.x - segment.a.x) * unitScale
    const dy = (segment.b.y - segment.a.y) * unitScale
    const length = Math.hypot(dx, dy)
    return {
      dx,
      dy,
      length,
      ux: length > 0 ? dx / length : 0,
      uy: length > 0 ? dy / length : 0,
    }
  })

  const sinTolerance = Math.sin((angleTolerance * Math.PI) / 180)
  interface Candidate {
    i: number
    j: number
    distance: number
  }
  const candidates: Candidate[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const first = metric[i]
    if (!(first.length > 0)) continue
    for (let j = i + 1; j < segments.length; j += 1) {
      // 只配合同一图层的线：不同图层是不同的墙
      if (segments[i].layer !== segments[j].layer) continue
      const second = metric[j]
      if (!(second.length > 0)) continue
      // 平行判定：单位向量叉积的绝对值即夹角正弦
      if (Math.abs(first.ux * second.uy - first.uy * second.ux) > sinTolerance) continue
      // 垂直距离：第二条线起点到第一条线所在直线的距离
      const rx = (segments[j].a.x - segments[i].a.x) * unitScale
      const ry = (segments[j].a.y - segments[i].a.y) * unitScale
      const distance = Math.abs(-rx * first.uy + ry * first.ux)
      if (distance < minThickness || distance > maxThickness) continue
      // 投影重叠：两条线必须有足够长的一段是并肩的
      const t0 = rx * first.ux + ry * first.uy
      const t1 = t0 + second.dx * first.ux + second.dy * first.uy
      const overlap = Math.min(first.length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1))
      if (overlap < minOverlapRatio * Math.min(first.length, second.length)) continue
      candidates.push({ i, j, distance })
    }
  }

  // 由近及远贪心配对：近的平行线才是同一道墙的两侧，远的往往是隔壁墙
  candidates.sort((left, right) => left.distance - right.distance || left.i - right.i || left.j - right.j)
  const used = new Array<boolean>(segments.length).fill(false)
  const paired = new Map<number, WallSegment>()
  let pairedCount = 0
  const tolerance = 0.001 / unitScale

  for (const candidate of candidates) {
    if (used[candidate.i] || used[candidate.j]) continue
    const first = segments[candidate.i]
    const second = segments[candidate.j]
    // 统一方向后再取端点中点：两条线同向时对应端点才是同一个墙角
    const forward = metric[candidate.i].ux * metric[candidate.j].ux + metric[candidate.i].uy * metric[candidate.j].uy >= 0
    const jStart = forward ? second.a : second.b
    const jEnd = forward ? second.b : second.a
    const start = { x: (first.a.x + jStart.x) / 2, y: (first.a.y + jStart.y) / 2 }
    const end = { x: (first.b.x + jEnd.x) / 2, y: (first.b.y + jEnd.y) / 2 }
    // 中心线统一朝向（+x 优先），保证同一份图纸每次重建得到同一个稳定键
    const dx = end.x - start.x
    const dy = end.y - start.y
    const flipped = dx < 0 || (dx === 0 && dy < 0)
    const a = flipped ? end : start
    const b = flipped ? start : end
    const key = `${first.layer}|pair:${segmentKey(a, b, tolerance)}`
    used[candidate.i] = true
    used[candidate.j] = true
    pairedCount += 1
    paired.set(candidate.i, { a, b, layer: first.layer, thickness: candidate.distance, key })
  }

  const result: WallSegment[] = []
  let unpairedCount = 0
  const thicknesses = new Set<number>()
  for (let i = 0; i < segments.length; i += 1) {
    const wall = paired.get(i)
    if (wall) {
      result.push(wall)
      thicknesses.add(Math.round(wall.thickness * 1000) / 1000)
      continue
    }
    if (used[i]) continue
    result.push(segments[i])
    unpairedCount += 1
  }

  return {
    segments: result,
    pairedCount,
    unpairedCount,
    measuredThickness: [...thicknesses].sort((left, right) => left - right),
  }
}

/** 短斜线过滤结果 */
export interface DiagonalFilterResult {
  /** 过滤后的墙段 */
  segments: WallSegment[]
  /** 被判为斜向短线而剔除的数量 */
  droppedCount: number
}

/** 斜向短线的长度上限（米）：门扇、开启弧线、索引线都在这个尺度上 */
const DIAGONAL_MAX_LENGTH = 1.5
/** 偏离坐标轴的角度下限（度）：小于它的线仍按水平 / 竖直墙处理 */
const DIAGONAL_MIN_ANGLE = 5

/**
 * 剔除斜向短线。
 *
 * 平面图里的门扇、开启弧线、索引线都是「短 + 斜」的线段，
 * 一旦被当成墙，就会沿斜向立起一道又厚又歪的假墙。
 * 正交墙（水平 / 竖直）与长斜墙（如弧形外墙的正常分段）都保留。
 */
export function filterDiagonalShortSegments(
  segments: readonly WallSegment[],
  unitScale: number,
): DiagonalFilterResult {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  const sinAngle = Math.sin((DIAGONAL_MIN_ANGLE * Math.PI) / 180)
  const kept: WallSegment[] = []
  let droppedCount = 0
  for (const segment of segments) {
    const dx = (segment.b.x - segment.a.x) * unitScale
    const dy = (segment.b.y - segment.a.y) * unitScale
    const length = Math.hypot(dx, dy)
    const diagonal = length > 0 && Math.min(Math.abs(dx) / length, Math.abs(dy) / length) > sinAngle
    if (diagonal && length <= DIAGONAL_MAX_LENGTH) {
      droppedCount += 1
      continue
    }
    kept.push(segment)
  }
  return { segments: kept, droppedCount }
}

/** 墙端吸附结果 */
export interface WallSnapResult {
  /** 吸附后的墙段 */
  segments: WallSegment[]
  /** 被延伸过的墙端数量 */
  snappedCount: number
}

/** 墙端吸附的默认距离上限（米） */
const SNAP_MAX_TOLERANCE = 0.3
/** 墙端吸附的最小距离下限（米）：小于它的误差交给顶点焊接 */
const SNAP_MIN_TOLERANCE = 0.02
/** 近似平行判定（度）：平行墙线之间是洞口或不同的墙，不能互吸 */
const SNAP_PARALLEL_ANGLE = 2

/**
 * 把墙段端点延伸到相邻墙体上，消除转角 / T 形接头的缝隙。
 *
 * 施工图的墙线通常画到相邻墙的墙面为止，双线配对取中点后，
 * 中心线就短了半个墙厚，miter 接不上，转角处留下一道小口子。
 * 这里沿墙自身方向找最近的**相交**墙段并延伸到交点：
 * - 只延伸、不缩短，因此不会吞掉门窗洞口；
 * - 只吸非平行墙段，平行（共线）方向上的缺口是洞口，必须保留；
 * - 吸附距离上限取两端墙厚的较大值（不超过 0.3m），不会把远处的墙硬拉过来。
 */
export function snapWallEndpoints(
  segments: readonly WallSegment[],
  unitScale: number,
): WallSnapResult {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  const result = segments.map((segment) => ({ ...segment, a: { ...segment.a }, b: { ...segment.b } }))
  const sinParallel = Math.sin((SNAP_PARALLEL_ANGLE * Math.PI) / 180)
  let snappedCount = 0

  const direction = (segment: WallSegment): { ux: number; uy: number; length: number } => {
    const dx = (segment.b.x - segment.a.x) * unitScale
    const dy = (segment.b.y - segment.a.y) * unitScale
    const length = Math.hypot(dx, dy)
    return { ux: length > 0 ? dx / length : 0, uy: length > 0 ? dy / length : 0, length }
  }

  for (let i = 0; i < result.length; i += 1) {
    const segment = result[i]
    const own = direction(segment)
    if (!(own.length > 0)) continue
    for (const key of ['a', 'b'] as const) {
      const endpoint = segment[key]
      const other = key === 'a' ? segment.b : segment.a
      // 端点朝外的方向：延伸后必须更远离另一端，保证只延长不缩短
      const outwardX = (endpoint.x - other.x) * unitScale
      const outwardY = (endpoint.y - other.y) * unitScale
      let best: { x: number; y: number; distance: number } | null = null
      for (let j = 0; j < result.length; j += 1) {
        if (j === i) continue
        const target = result[j]
        const line = direction(target)
        if (!(line.length > 0)) continue
        // 平行墙段之间的缺口是门窗洞口，不能吸附
        if (Math.abs(own.ux * line.uy - own.uy * line.ux) <= sinParallel) continue
        const tolerance = Math.min(
          SNAP_MAX_TOLERANCE,
          Math.max(SNAP_MIN_TOLERANCE, Math.max(segment.thickness, target.thickness)),
        )
        // 两条无限直线的交点（own 过 endpoint，target 过 target.a）
        const tx = (target.a.x - endpoint.x) * unitScale
        const ty = (target.a.y - endpoint.y) * unitScale
        const denominator = own.ux * line.uy - own.uy * line.ux
        if (Math.abs(denominator) < 1e-9) continue
        const alongOwn = (tx * line.uy - ty * line.ux) / denominator
        const alongTarget = (tx * own.uy - ty * own.ux) / denominator
        if (!Number.isFinite(alongOwn) || !Number.isFinite(alongTarget)) continue
        // 交点必须落在目标墙段范围内（留 1mm 容差）
        const targetMargin = 0.001
        if (alongTarget < -targetMargin || alongTarget > line.length + targetMargin) continue
        if (Math.abs(alongOwn) > tolerance) continue
        // 只朝外延伸（长度都以米计）
        const moveX = own.ux * alongOwn
        const moveY = own.uy * alongOwn
        if (moveX * outwardX + moveY * outwardY <= 0) continue
        const distance = Math.abs(alongOwn)
        if (best !== null && distance >= best.distance) continue
        best = {
          x: endpoint.x + moveX / unitScale,
          y: endpoint.y + moveY / unitScale,
          distance,
        }
      }
      if (best === null || best.distance < 0.001) continue
      endpoint.x = best.x
      endpoint.y = best.y
      snappedCount += 1
    }
  }
  return { segments: result, snappedCount }
}

/** 墙厚回填统计 */
export interface ThicknessFillStats {
  /** 按同图层已解墙段的厚度回填的条数 */
  sameLayer: number
  /** 按与其他平行墙线的实测垂距回填的条数 */
  parallel: number
  /** 按端部相连墙段回填的条数 */
  neighbor: number
  /** 三种方式都取不到厚度、按图层汇总的剩余条数 */
  unresolved: Record<string, number>
}

/** 墙厚回填结果 */
export interface ThicknessFillResult {
  /** 回填后的墙段；仍取不到厚度的保持 thickness = 0，由调用方跳过并提示 */
  segments: WallSegment[]
  stats: ThicknessFillStats
}

/** 端部相连判定容差（米）：墙肢端点落在另一段墙上即视为同一道墙的延续 */
const NEIGHBOR_TOLERANCE = 0.05
/** 平行实测回填的墙厚取值范围（米），与双线配对保持一致 */
const FILL_MIN_THICKNESS = 0.05
const FILL_MAX_THICKNESS = 1
/** 图纸里一处墙厚都量不到时的回填上限（米）：再厚的单线几乎都是门扇、索引线之类的图元 */
const FILL_TYPICAL_MAX = 0.35
/** 平行实测回填的投影重叠率下限 */
const FILL_MIN_OVERLAP_RATIO = 0.5
/** 回填轮数上限：每一轮都可能让新的单线获得厚度，进而解出更多相邻墙段 */
const FILL_MAX_PASSES = 3

/** 点到线段的最短距离（米） */
function pointToSegmentDistanceM(
  point: CadPoint,
  a: CadPoint,
  b: CadPoint,
  unitScale: number,
): number {
  const ax = a.x * unitScale
  const ay = a.y * unitScale
  const px = point.x * unitScale
  const py = point.y * unitScale
  const dx = (b.x - a.x) * unitScale
  const dy = (b.y - a.y) * unitScale
  const lengthSq = dx * dx + dy * dy
  if (!(lengthSq > 0)) return Math.hypot(px - ax, py - ay)
  const raw = ((px - ax) * dx + (py - ay) * dy) / lengthSq
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

/**
 * 为没有墙厚的墙段回填厚度，全部取自图纸自身的几何证据：
 *
 * 1. 同图层：同一图层通常只有一种墙厚，已解墙段（双线实测或图层名标注）的厚度可直接沿用到本图层单线；
 * 2. 平行实测：墙的两个侧面画在不同图层时，按到最近平行墙线的垂距量出真实墙厚；
 * 3. 端部相连：墙肢、洞口垛的端点落在另一段墙上，沿用那段墙的厚度。
 *
 * 三步按顺序重复若干轮，直到不再有新墙段被解出。三种证据都没有的墙段保留 thickness = 0，
 * 由调用方跳过并在面板列出图层与条数——不使用任何全局默认墙厚。
 *
 * @param segments 待回填的墙段（双线配对之后的结果）
 * @param reference 原始墙线（配对之前），用于量取真实的双线间距
 */
export function inferWallThicknesses(
  segments: readonly WallSegment[],
  reference: readonly WallSegment[],
  unitScale: number,
): ThicknessFillResult {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  const filled = segments.map((segment) => ({ ...segment }))
  const stats: ThicknessFillStats = { sameLayer: 0, parallel: 0, neighbor: 0, unresolved: {} }

  const measure = (segment: WallSegment): { length: number; dx: number; dy: number; ux: number; uy: number } => {
    const dx = (segment.b.x - segment.a.x) * unitScale
    const dy = (segment.b.y - segment.a.y) * unitScale
    const length = Math.hypot(dx, dy)
    return { length, dx, dy, ux: length > 0 ? dx / length : 0, uy: length > 0 ? dy / length : 0 }
  }
  const metrics = filled.map(measure)
  const referenceMetrics = reference.map(measure)
  const sinTolerance = Math.sin((PAIR_ANGLE_TOLERANCE * Math.PI) / 180)

  // 用图纸已知墙厚（双线实测 / 图层标注）当标尺：同一张图的墙厚通常集中在很窄的区间，
  // 单线量到的间距一旦明显偏离，说明量到的不是墙的另一侧，而是门扇、家具线、索引线之类的图元。
  const known = filled
    .filter((segment) => segment.thickness > 0)
    .map((segment) => segment.thickness)
    .sort((left, right) => left - right)
  const typical = known.length > 0 ? known[Math.floor(known.length / 2)] : null
  const minAccept = typical === null ? FILL_MIN_THICKNESS : Math.max(FILL_MIN_THICKNESS, typical * 0.6)
  const maxAccept = typical === null ? FILL_TYPICAL_MAX : Math.min(FILL_MAX_THICKNESS, typical * 1.8)

  for (let pass = 0; pass < FILL_MAX_PASSES; pass += 1) {
    let changed = false

    // 1. 同图层沿用：本图层第一个已解墙段的厚度
    const layerThickness = new Map<string, number>()
    for (const segment of filled) {
      if (segment.thickness > 0 && !layerThickness.has(segment.layer)) {
        layerThickness.set(segment.layer, segment.thickness)
      }
    }
    for (const segment of filled) {
      if (segment.thickness > 0) continue
      const thickness = layerThickness.get(segment.layer)
      if (thickness === undefined) continue
      segment.thickness = thickness
      stats.sameLayer += 1
      changed = true
    }

    // 2. 平行实测：到最近平行墙线的垂距
    for (let i = 0; i < filled.length; i += 1) {
      const segment = filled[i]
      if (segment.thickness > 0) continue
      const own = metrics[i]
      if (!(own.length > 0)) continue
      let best = Number.POSITIVE_INFINITY
      for (let j = 0; j < reference.length; j += 1) {
        // 跳过自身：同图层同键的原始线
        if (reference[j].layer === segment.layer && reference[j].key === segment.key) continue
        const line = referenceMetrics[j]
        if (!(line.length > 0)) continue
        // 平行判定：单位向量叉积的绝对值即夹角正弦
        if (Math.abs(own.ux * line.uy - own.uy * line.ux) > sinTolerance) continue
        const rx = (reference[j].a.x - segment.a.x) * unitScale
        const ry = (reference[j].a.y - segment.a.y) * unitScale
        const distance = Math.abs(-rx * own.uy + ry * own.ux)
        if (distance < minAccept || distance > maxAccept) continue
        if (distance >= best) continue
        // 投影重叠：必须有足够长的一段并肩，否则是隔壁墙
        const t0 = rx * own.ux + ry * own.uy
        const t1 = t0 + line.dx * own.ux + line.dy * own.uy
        const overlap = Math.min(own.length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1))
        if (overlap < FILL_MIN_OVERLAP_RATIO * Math.min(own.length, line.length)) continue
        best = distance
      }
      if (!Number.isFinite(best)) continue
      segment.thickness = Math.round(best * 1000) / 1000
      stats.parallel += 1
      changed = true
    }

    // 3. 端部相连：沿用端点所接触墙段的厚度
    for (const segment of filled) {
      if (segment.thickness > 0) continue
      let best: { thickness: number; distance: number } | null = null
      for (const other of filled) {
        if (other === segment || !(other.thickness > 0)) continue
        const distance = Math.min(
          pointToSegmentDistanceM(segment.a, other.a, other.b, unitScale),
          pointToSegmentDistanceM(segment.b, other.a, other.b, unitScale),
        )
        if (distance > NEIGHBOR_TOLERANCE) continue
        if (best === null || distance < best.distance) best = { thickness: other.thickness, distance }
      }
      if (best === null) continue
      segment.thickness = best.thickness
      stats.neighbor += 1
      changed = true
    }

    if (!changed) break
  }

  for (const segment of filled) {
    if (segment.thickness > 0) continue
    stats.unresolved[segment.layer] = (stats.unresolved[segment.layer] ?? 0) + 1
  }
  return { segments: filled, stats }
}

/** 把一个四边形拆成两个三角形写入顶点数组；三角形绕序由调用方保证 */
function pushQuad(
  target: number[],
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
): void {
  target.push(...p0, ...p1, ...p2)
  target.push(...p0, ...p2, ...p3)
}

/** 沿线段按参数插值（t = 0 取 a，t = 1 取 b） */
function lerpPoint(a: CadPoint, b: CadPoint, t: number): CadPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** 把点投影到线段上，返回 0..1 参数；线段退化为点时返回 NaN */
function projectParam(point: CadPoint, a: CadPoint, b: CadPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (!(lengthSq > 1e-12)) return Number.NaN
  return ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
}

/** 一条墙带边上的洞口区间（参数 0..1，标高为米） */
interface EdgeOpeningSpan {
  opening: WallOpening
  u0: number
  u1: number
  sill: number
  top: number
}

/**
 * 把一条边上的洞口投影成参数区间。
 *
 * `lineStart` / `lineEnd` 传墙中心线的两个端点：洞口本身就定义在中心线上，
 * 投影到中心线得到的参数与投影到平行边界线一致，但量纲与洞口定义保持一致。
 * 越界（洞口跨出该墙段）、退化（宽度为 0）与同边重叠的洞口都会被跳过并计数，
 * 由界面汇总提示，不做静默裁剪。
 */
function resolveEdgeSpans(
  openings: readonly WallOpening[] | undefined,
  lineStart: CadPoint,
  lineEnd: CadPoint,
  height: number,
): { spans: EdgeOpeningSpan[]; skipped: number } {
  if (!openings || openings.length === 0) return { spans: [], skipped: 0 }
  const spans: EdgeOpeningSpan[] = []
  let skipped = 0
  for (const opening of openings) {
    const t0 = projectParam(opening.start, lineStart, lineEnd)
    const t1 = projectParam(opening.end, lineStart, lineEnd)
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
      skipped += 1
      continue
    }
    const rawU0 = t0 < t1 ? t0 : t1
    const rawU1 = t0 < t1 ? t1 : t0
    if (rawU0 < -1e-6 || rawU1 > 1 + 1e-6) {
      skipped += 1
      continue
    }
    if (!(rawU1 - rawU0 > 1e-4)) {
      skipped += 1
      continue
    }
    const sill = opening.sill < 0 ? 0 : opening.sill
    const top = sill + opening.height
    if (!(opening.height > 0) || top > height + 1e-6) {
      skipped += 1
      continue
    }
    spans.push({
      opening,
      u0: rawU0 < 0 ? 0 : rawU0,
      u1: rawU1 > 1 ? 1 : rawU1,
      sill,
      top,
    })
  }

  // 同一条边上的洞口按起点排序，重叠的后者跳过，避免立面被重复挖穿
  spans.sort((left, right) => left.u0 - right.u0)
  const accepted: EdgeOpeningSpan[] = []
  for (const span of spans) {
    const previous = accepted[accepted.length - 1]
    if (previous && span.u0 < previous.u1 - 1e-6) {
      skipped += 1
      continue
    }
    accepted.push(span)
  }
  return { spans: accepted, skipped }
}

/**
 * 把墙中心线生成实体墙体几何。
 * 图纸坐标 (x, y) 映射到模型局部坐标 (x, y=高度, z=图纸 y)，即 CAD 平面落在局部 XZ 平面。
 * 视图在模型根上统一做一次 z 轴镜像（图纸 +y 北 → 世界 −z），因此这里不做翻转。
 *
 * 洞口处理：顶面保持整边连续，左右立面按洞口区间切分，并补齐门垛 / 窗台 / 过梁与洞口四壁，
 * 使洞口是真正贯通墙厚的空腔，而不是贴一张门窗面片。
 */
export function buildWallGeometry(
  segments: WallSegment[],
  options: WallBuildOptions,
  unitScale: number,
  openings: readonly WallOpening[] = [],
): WallGeometryResult {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  if (!(options.height > 0)) throw new Error('墙高必须为正数')
  if (!(options.miterLimit >= 1)) throw new Error('miter 上限必须不小于 1')

  // 统一换算到米后再做拓扑，避免墙厚（米）与中心线（图纸单位）混量纲
  const metric = segments.map((segment) => ({
    a: { x: segment.a.x * unitScale, y: segment.a.y * unitScale },
    b: { x: segment.b.x * unitScale, y: segment.b.y * unitScale },
    layer: segment.layer,
    thickness: segment.thickness,
    key: segment.key,
  }))

  const graph = weldVertices(metric, WALL_WELD_TOLERANCE)
  const chains = mergeCollinearChains(graph, COLLINEAR_ANGLE)
  const { rings, skippedCount } = buildWallRings(graph, chains, options.miterLimit)

  // 洞口按墙段键分组：每条原始边只查一次，避免逐边扫描全量洞口
  const openingIndex = new Map<string, WallOpening[]>()
  for (const opening of openings) {
    const list = openingIndex.get(opening.wallKey)
    if (list) list.push(opening)
    else openingIndex.set(opening.wallKey, [opening])
  }

  const positions: number[] = []
  const pieces: WallPiece[] = []
  const placements: WallOpeningPlacement[] = []
  let skippedOpeningCount = 0
  const height = options.height
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let totalLength = 0
  let segmentCount = 0

  const track = (point: CadPoint): void => {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }

  for (const ring of rings) {
    const { left, right, closed } = ring
    const count = left.length
    const pairCount = closed ? count : count - 1
    totalLength += ring.length
    segmentCount += ring.edgeCount
    for (const point of left) track(point)
    for (const point of right) track(point)

    let currentPiece: WallPiece | null = null

    for (let i = 0; i < pairCount; i += 1) {
      const j = (i + 1) % count
      const l0 = left[i]
      const l1 = left[j]
      const r0 = right[i]
      const r1 = right[j]

      // 门窗构件必须落在墙中心线上：left / right 是墙带的两个边界（各自偏离中心线半个墙厚），
      // 二者中点才是中心线点。直接拿 l0 / l1 会把门窗整体平移到墙面上，
      // 造成门扇与墙面共面闪烁、门套一半埋进墙体、贴脸悬在墙外（穿模）。
      const midStart = { x: (l0.x + r0.x) / 2, y: (l0.y + r0.y) / 2 }
      const midEnd = { x: (l1.x + r1.x) / 2, y: (l1.y + r1.y) / 2 }
      const centerLength = distance(midStart, midEnd)
      // 180° 折返或 miter 超限时，同一条中心线顶点会被插入两个边界点，
      // 从而产生零长度的边界段：它没有可画的墙带，也不可能承载洞口，直接跳过。
      if (!(centerLength > 0)) continue

      const edge = graph.edges[ring.edges[i]]
      if (currentPiece === null || currentPiece.key !== edge.key) {
        const a = graph.vertices[edge.a]
        const b = graph.vertices[edge.b]
        currentPiece = {
          key: edge.key,
          layer: edge.layer,
          thickness: edge.thickness,
          length: distance(a, b),
          a,
          b,
          vertexStart: positions.length / 3,
          vertexCount: 0,
        }
        pieces.push(currentPiece)
        if (!closed && i === 0) {
          // 起点端面并入首段，保证片段顶点区间连续
          pushQuad(
            positions,
            [l0.x, 0, l0.y],
            [l0.x, height, l0.y],
            [r0.x, height, r0.y],
            [r0.x, 0, r0.y],
          )
          currentPiece.vertexCount += 6
        }
      }

      const vertexBase = positions.length / 3

      // 顶面：整边连续，洞口只切立面，因此墙顶保持一条完整的压顶
      // CAD→three 映射会翻转绕序，按 (L_i, L_i+1, R_i+1, R_i) 才能让法线朝 +Y
      pushQuad(
        positions,
        [l0.x, height, l0.y],
        [l1.x, height, l1.y],
        [r1.x, height, r1.y],
        [r0.x, height, r0.y],
      )

      /**
       * 按中心线参数取墙带两侧边界点。
       *
       * 参数 0 / 1 直接取 miter 端点，保证与相邻墙段的转角连续；
       * 内部参数先把中心线点垂直投影到两侧边界，使洞口两端始终垂直于墙。
       * 若两侧都按参数直接插值，闭合墙环的内外边界长度相差一个墙厚，
       * 洞口会变成梯形（一侧偏宽、一侧偏窄），门窗构件必然一侧贴不严、另一侧切进墙体。
       */
      const boundaryAt = (u: number): { l: CadPoint; r: CadPoint } => {
        if (u <= 1e-9) return { l: l0, r: r0 }
        if (u >= 1 - 1e-9) return { l: l1, r: r1 }
        const center = lerpPoint(midStart, midEnd, u)
        return {
          l: lerpPoint(l0, l1, projectParam(center, l0, l1)),
          r: lerpPoint(r0, r1, projectParam(center, r0, r1)),
        }
      }

      /** 生成一段实心墙立面（左右两侧），u 为该边上的 0..1 参数 */
      const pushBand = (uStart: number, uEnd: number, yBottom: number, yTop: number): void => {
        if (!(uEnd - uStart > 1e-9) || !(yTop - yBottom > 1e-9)) return
        const { l: ls, r: rs } = boundaryAt(uStart)
        const { l: le, r: re } = boundaryAt(uEnd)
        // 左侧面：法线朝左法线方向
        pushQuad(
          positions,
          [ls.x, yBottom, ls.y],
          [le.x, yBottom, le.y],
          [le.x, yTop, le.y],
          [ls.x, yTop, ls.y],
        )
        // 右侧面：法线朝右法线方向
        pushQuad(
          positions,
          [rs.x, yBottom, rs.y],
          [rs.x, yTop, rs.y],
          [re.x, yTop, re.y],
          [re.x, yBottom, re.y],
        )
      }

      const resolved = resolveEdgeSpans(openingIndex.get(edge.key), midStart, midEnd, height)
      skippedOpeningCount += resolved.skipped

      let cursor = 0
      for (const span of resolved.spans) {
        // 洞口左侧的实心墙
        pushBand(cursor, span.u0, 0, height)
        // 窗台以下的实心墙（门洞底标高为 0，不生成）
        pushBand(span.u0, span.u1, 0, span.sill)
        // 过梁以上的实心墙
        pushBand(span.u0, span.u1, span.top, height)

        const startEdge = boundaryAt(span.u0)
        const endEdge = boundaryAt(span.u1)
        const ls = startEdge.l
        const rs = startEdge.r
        const le = endEdge.l
        const re = endEdge.r
        // 洞口起点侧壁：法线朝沿墙正方向
        pushQuad(
          positions,
          [ls.x, span.sill, ls.y],
          [rs.x, span.sill, rs.y],
          [rs.x, span.top, rs.y],
          [ls.x, span.top, ls.y],
        )
        // 洞口终点侧壁：法线朝沿墙反方向
        pushQuad(
          positions,
          [le.x, span.sill, le.y],
          [le.x, span.top, le.y],
          [re.x, span.top, re.y],
          [re.x, span.sill, re.y],
        )
        // 窗台面（洞口底面）：法线朝上
        if (span.sill > 0) {
          pushQuad(
            positions,
            [ls.x, span.sill, ls.y],
            [le.x, span.sill, le.y],
            [re.x, span.sill, re.y],
            [rs.x, span.sill, rs.y],
          )
        }
        // 过梁底面：法线朝下
        if (span.top < height) {
          pushQuad(
            positions,
            [ls.x, span.top, ls.y],
            [rs.x, span.top, rs.y],
            [re.x, span.top, re.y],
            [le.x, span.top, le.y],
          )
        }

        placements.push({
          ...(span.opening.key ? { key: span.opening.key } : {}),
          wallKey: edge.key,
          kind: span.opening.kind,
          center: lerpPoint(midStart, midEnd, (span.u0 + span.u1) / 2),
          direction: {
            x: (midEnd.x - midStart.x) / centerLength,
            y: (midEnd.y - midStart.y) / centerLength,
          },
          width: (span.u1 - span.u0) * centerLength,
          height: span.top - span.sill,
          sill: span.sill,
          // 墙带厚度取整条链的最大墙厚（见 wallTopology.buildWallRings），
          // 构件必须按实际渲染出来的墙厚取深，否则同一条链混不同墙厚时
          // 门窗框会比墙体薄一截，斜视下看到框料缩在洞口里、像被墙咬掉一块
          thickness: ring.thickness,
          ...(span.opening.preset ? { preset: span.opening.preset } : {}),
          ...(span.opening.windowPart ? { windowPart: span.opening.windowPart } : {}),
          ...(span.opening.transom ? { transom: span.opening.transom } : {}),
        })
        cursor = span.u1
      }
      // 最后一个洞口右侧的实心墙
      pushBand(cursor, 1, 0, height)

      currentPiece.vertexCount += positions.length / 3 - vertexBase
    }

    if (!closed) {
      const last = count - 1
      const ln = left[last]
      const rn = right[last]
      // 终点端面并入末段；起始端面与立面加总维持片段顶点区间连续
      pushQuad(
        positions,
        [ln.x, 0, ln.y],
        [rn.x, 0, rn.y],
        [rn.x, height, rn.y],
        [ln.x, height, ln.y],
      )
      pieces[pieces.length - 1].vertexCount += 6
    }
  }

  const hasGeometry = segmentCount > 0
  return {
    positions: new Float32Array(positions),
    bounds: hasGeometry
      ? { minX, minY, maxX, maxY }
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    segmentCount,
    totalLength,
    skippedRingCount: skippedCount,
    pieces,
    rings,
    openings: placements,
    skippedOpeningCount,
  }
}
