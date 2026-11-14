/**
 * 玻璃幕墙识别与程序化建模。
 *
 * 施工图里「窗」有两种完全不同的表达：
 * - 门窗详图里的窗块（C1515 之类）：尺寸与墙洞一一对应，属于嵌在墙里的窗；
 * - 沿建筑外轮廓拉通的窗线：整层玻璃外立面，即玻璃幕墙。
 *
 * 仅凭图层名无法区分二者，因此生成方式完全由用户在图层下拉里的显式选择决定：
 * 选「幕墙」才按玻璃外立面生成；选「窗」一律按嵌墙窗开洞，几何范围只用来提示
 * 该图层也可以改成幕墙。
 *
 * 幕墙几何按成品幕墙的构造分层：
 * - 铝合金竖梃：沿墙约 1.2m 一根，等分间距，转角处自然重叠形成角柱；
 * - 上下横档：封住玻璃两侧，同时充当层间防火 / 收边；
 * - 中空玻璃：每格两片，沿墙法线前后分置，形成可见的空气层厚度。
 *
 * 未设置门窗类型的图层按「白膜墙」生成：沿用幕墙的沿中心线拉板方式，
 * 但只生成一片薄墙，不带竖梃 / 横档 / 玻璃，材质为无贴图的白色实体，
 * 用于只看体量、不要幕墙构造的白模效果。
 *
 * 坐标约定与墙体一致：局部 (x, y=高度, z=图纸 y)，单位米。
 */

import type { CadDrawing, CadPoint } from './types'
import type { OpeningKind } from './doorWindowModel'
import { distance } from './geometry'
import { pushBox } from './openingModel'
import * as THREE from 'three'

/** 幕墙材质组：0 铝合金框（竖梃 / 横档），1 玻璃，2 白膜墙 */
export const CURTAIN_FRAME_GROUP = 0
export const CURTAIN_GLASS_GROUP = 1
export const CURTAIN_MASSING_GROUP = 2

/** 铝合金框颜色 / 玻璃颜色（与门窗构件的玻璃保持同一色系） / 白膜墙颜色 */
export const CURTAIN_FRAME_COLOR = 0x8f98a3
export const CURTAIN_GLASS_COLOR = 0x9fc4d8
export const CURTAIN_MASSING_COLOR = 0xf2f1ed

/** 幕墙几何参数默认值（米） */
export const DEFAULT_MULLION_SPACING = 1.2
export const DEFAULT_MULLION_WIDTH = 0.06
export const DEFAULT_FRAME_DEPTH = 0.12
export const DEFAULT_TRANSOM_HEIGHT = 0.1
export const DEFAULT_GLASS_THICKNESS = 0.008
export const DEFAULT_GLASS_GAP = 0.02
/**
 * 白膜墙厚度（米）。
 *
 * 未设置门窗类型的图层沿窗线拉一片薄墙，不做墙体厚度推断；
 * 厚度取幕墙框料进深（0.12m），既保持「幕墙式」的生成方式，又不会生成又厚又斜的假墙。
 */
export const DEFAULT_MASSING_THICKNESS = DEFAULT_FRAME_DEPTH

/** 幕墙判定的最短总长（米）：低于它只能是零星窗线 */
export const CURTAIN_MIN_TOTAL_LENGTH = 8
/** 幕墙判定的最短平均段长（米）：短窗线属于嵌墙窗 */
export const CURTAIN_MIN_AVERAGE_SEGMENT = 1.5
/** 参与幕墙判定的最少段数 */
export const CURTAIN_MIN_SEGMENTS = 2
/** 单段短于该值的线不参与幕墙建模（米），多为窗块炸开后的残留 */
const MIN_CURTAIN_SEGMENT = 0.2

/** 一条幕墙中心线（图纸坐标） */
export interface CurtainLine {
  a: CadPoint
  b: CadPoint
}

/** 幕墙段对象键前缀：与墙段键、门窗键区分，三类键可以放进同一个选择 / 删除集合 */
export const CURTAIN_KEY_PREFIX = '@curtain:'

/**
 * 幕墙段对象键：入参必须是米制中心线。
 *
 * `buildCurtainWallGeometry` 输出的 `centerlines` 已是米制坐标，编辑态拾取直接复用它；
 * 规划阶段的图纸坐标要先乘 `unitScale` 再取键，两端才能对上。
 */
export function curtainObjectKey(line: CurtainLine): string {
  const pointKey = (point: CadPoint): string =>
    `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`
  return `${CURTAIN_KEY_PREFIX}${pointKey(line.a)}|${pointKey(line.b)}`
}

/** 窗类图层的几何范围统计（长度均为米） */
export interface CurtainLayerStats {
  segmentCount: number
  totalLength: number
  maxSegmentLength: number
  averageLength: number
  /** 是否闭合成环（显式闭合折线或端点两两相连） */
  closed: boolean
}

/** 窗类图层的处理方式 */
export type WindowLayerMode = 'curtain' | 'opening'

/** 幕墙规划结果 */
export interface CurtainPlan {
  /** 按玻璃幕墙处理的图层 */
  layers: string[]
  /** 按白膜墙处理的图层（未设置门窗类型的默认口径） */
  massingLayers: string[]
  /** 玻璃幕墙中心线（图纸坐标） */
  lines: CurtainLine[]
  /** 白膜墙中心线（图纸坐标） */
  massingLines: CurtainLine[]
  /** 直接展示给用户的说明 */
  notes: string[]
}

/** 幕墙几何结果（米，three.js 的 XZ 平面 + Y 轴向上） */
export interface CurtainWallGeometry {
  /** 铝合金框顶点（三角形列表） */
  frames: Float32Array
  /** 玻璃顶点（三角形列表） */
  glass: Float32Array
  /** 白膜墙顶点（三角形列表）：沿窗线拉出的薄墙，无框料、无玻璃 */
  massing: Float32Array
  /** 平面包围盒（米） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** 幕墙中心线段数 */
  segmentCount: number
  /** 中心线总长（米） */
  totalLength: number
  /** 竖梃数量（含端柱） */
  mullionCount: number
  /** 玻璃片数（双层玻璃按片计） */
  paneCount: number
  /** 玻璃幕墙中心线（米，CAD 平面坐标），供建筑包导出 */
  centerlines: CurtainLine[]
  /** 白膜墙中心线（米，CAD 平面坐标），与玻璃幕墙分开保存以便区分导出语义 */
  massingCenterlines: CurtainLine[]
}

/** 幕墙建模参数 */
export interface CurtainWallOptions {
  /** 幕墙高度（米），一般取墙高 */
  height: number
  /** 竖梃目标间距（米），实际按等分取整 */
  mullionSpacing?: number
  /** 竖梃截面宽（沿墙方向，米） */
  mullionWidth?: number
  /** 框料进深（垂直墙面，米） */
  frameDepth?: number
  /** 上下横档高度（米） */
  transomHeight?: number
  /** 单层玻璃厚度（米） */
  glassThickness?: number
  /** 双层玻璃之间的空气层（米） */
  glassGap?: number
  /**
   * 白膜模式：只沿中心线生成一片薄墙，不生成竖梃 / 横档 / 玻璃。
   * 未设置门窗类型的图层走这个口径。
   */
  plain?: boolean
  /** 白膜墙厚度（米），仅 plain 模式生效 */
  massingThickness?: number
  /** 白膜墙起始标高（米），仅 plain 模式生效；用于在门洞上方补过梁等局部墙段 */
  base?: number
}

/** 从图纸中收集某一图层的窗线（忽略块实例与填充面片） */
export function collectLayerLines(drawing: CadDrawing, layerName: string): CurtainLine[] {
  const lines: CurtainLine[] = []
  for (const entity of drawing.entities) {
    if (entity.layer !== layerName) continue
    // 块实例是门窗符号，不是幕墙线；炸开的残留也一并排除
    if (entity.blockName !== undefined) continue
    for (const primitive of entity.primitives) {
      if (primitive.kind === 'fill') continue
      const points = primitive.points
      if (points.length < 2) continue
      const edgeCount = primitive.closed ? points.length : points.length - 1
      for (let i = 0; i < edgeCount; i += 1) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        if (distance(a, b) <= 0) continue
        lines.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } })
      }
    }
  }
  return lines
}

/**
 * 统计一组窗线的几何范围。
 * @param unitScale 1 图纸单位 = unitScale 米
 */
export function measureLayerSpans(lines: readonly CurtainLine[], unitScale: number): CurtainLayerStats {
  let totalLength = 0
  let maxSegmentLength = 0
  // 端点度数：所有端点都恰好出现两次时视为闭合成环
  const tolerance = 0.001 / unitScale
  const degrees = new Map<string, number>()
  const pointKey = (point: CadPoint): string =>
    `${Math.round(point.x / tolerance)},${Math.round(point.y / tolerance)}`
  for (const line of lines) {
    const length = distance(line.a, line.b) * unitScale
    totalLength += length
    if (length > maxSegmentLength) maxSegmentLength = length
    for (const point of [line.a, line.b]) {
      const key = pointKey(point)
      degrees.set(key, (degrees.get(key) ?? 0) + 1)
    }
  }
  let closed = lines.length >= 4
  if (closed) {
    for (const degree of degrees.values()) {
      if (degree !== 2) {
        closed = false
        break
      }
    }
  }
  return {
    segmentCount: lines.length,
    totalLength,
    maxSegmentLength,
    averageLength: lines.length > 0 ? totalLength / lines.length : 0,
    closed,
  }
}

/** 按几何范围判定该图层是否属于幕墙 */
export function isCurtainSpan(stats: CurtainLayerStats): boolean {
  if (stats.segmentCount < CURTAIN_MIN_SEGMENTS) return false
  if (!(stats.totalLength >= CURTAIN_MIN_TOTAL_LENGTH)) return false
  return stats.closed || stats.averageLength >= CURTAIN_MIN_AVERAGE_SEGMENT
}

/**
 * 规划幕墙与白膜墙：
 * - 显式标记为「幕墙」的图层整体生成玻璃外立面；
 * - 未设置门窗类型（内部按 `massing` 传入）的图层按白膜墙生成，
 *   沿用幕墙的沿中心线拉板方式，但不带竖梃 / 横档 / 玻璃与贴图。
 *
 * 标记为「窗」的图层一律按嵌墙窗开洞——哪怕窗线很长或闭合成环，也不自动升级成幕墙；
 * 几何范围只用来生成一条提示，告诉用户可以把该图层改成「幕墙」。
 */
export function planCurtainWalls(
  drawing: CadDrawing,
  layerKinds: Readonly<Record<string, OpeningKind | 'curtain' | 'massing'>>,
  unitScale: number,
): CurtainPlan {
  const layers: string[] = []
  const massingLayers: string[] = []
  const lines: CurtainLine[] = []
  const massingLines: CurtainLine[] = []
  const notes: string[] = []
  if (!(unitScale > 0)) return { layers, massingLayers, lines, massingLines, notes }

  for (const [layerName, kind] of Object.entries(layerKinds)) {
    if (kind !== 'window' && kind !== 'curtain' && kind !== 'massing') continue
    const layerLines = collectLayerLines(drawing, layerName)
    const stats = measureLayerSpans(layerLines, unitScale)
    if (kind === 'window') {
      // 选「窗」就是嵌墙窗：只提示，不改变生成方式
      if (isCurtainSpan(stats)) {
        notes.push(
          `图层「${layerName}」窗线总长 ${Math.round(stats.totalLength)}m` +
            `${stats.closed ? '、闭合成环' : ''}，当前按嵌墙窗生成；` +
            '若要整层玻璃外立面，请把该图层改成「幕墙」。',
        )
      }
      continue
    }
    if (layerLines.length === 0) {
      notes.push(
        kind === 'massing'
          ? `图层「${layerName}」按白膜墙生成，但没有可用的窗线，已跳过。`
          : `图层「${layerName}」标记为玻璃幕墙，但没有可用的窗线，已跳过。`,
      )
      continue
    }
    if (kind === 'massing') {
      massingLayers.push(layerName)
      massingLines.push(...layerLines)
      notes.push(
        `图层「${layerName}」按白膜墙生成：${stats.segmentCount} 段、总长 ` +
          `${Math.round(stats.totalLength)}m${stats.closed ? '、闭合成环' : ''}（沿窗线生成薄墙，不带幕墙材质）。`,
      )
      continue
    }
    layers.push(layerName)
    lines.push(...layerLines)
    notes.push(
      `图层「${layerName}」按玻璃幕墙生成：${stats.segmentCount} 段、总长 ` +
        `${Math.round(stats.totalLength)}m${stats.closed ? '、闭合成环' : ''}。`,
    )
  }
  return { layers, massingLayers, lines, massingLines, notes }
}

/** 定向长方体写入（u 沿墙、v 竖向、w 墙法线，右手基） */
type Vec3 = [number, number, number]

/**
 * 生成幕墙几何。
 *
 * 常规模式：每段中心线等分若干开间，开间之间立竖梃，上下各一道横档，
 * 每个开间两片玻璃沿法线前后分置，形成可见的玻璃厚度与空气层。
 *
 * `plain` 白膜模式：只沿每段中心线拉一片薄墙，没有竖梃 / 横档 / 玻璃，
 * 用于未设置门窗类型图层的白模效果。
 */
export function buildCurtainWallGeometry(
  lines: readonly CurtainLine[],
  unitScale: number,
  options: CurtainWallOptions,
): CurtainWallGeometry | null {
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  const height = options.height
  if (!(height > 0)) throw new Error(`幕墙高度必须为正数：${height}`)

  const plain = options.plain === true
  const massingThickness = options.massingThickness ?? DEFAULT_MASSING_THICKNESS
  const massingBase = options.base ?? 0
  if (!(massingThickness > 0)) {
    throw new Error(`白膜墙厚度必须为正数：${massingThickness}`)
  }
  if (!(massingBase >= 0)) {
    throw new Error(`白膜墙起始标高不能为负：${massingBase}`)
  }
  const spacing = options.mullionSpacing ?? DEFAULT_MULLION_SPACING
  const mullionWidth = options.mullionWidth ?? DEFAULT_MULLION_WIDTH
  const frameDepth = options.frameDepth ?? DEFAULT_FRAME_DEPTH
  const transomHeight = Math.min(options.transomHeight ?? DEFAULT_TRANSOM_HEIGHT, height / 4)
  const glassThickness = options.glassThickness ?? DEFAULT_GLASS_THICKNESS
  const glassGap = options.glassGap ?? DEFAULT_GLASS_GAP
  if (!(spacing > 0) || !(mullionWidth > 0) || !(frameDepth > 0)) {
    throw new Error('幕墙竖梃参数必须为正数')
  }

  const frames: number[] = []
  const glass: number[] = []
  const massing: number[] = []
  const centerlines: CurtainLine[] = []
  const massingCenterlines: CurtainLine[] = []
  let totalLength = 0
  let mullionCount = 0
  let paneCount = 0

  const v: Vec3 = [0, 1, 0]
  for (const line of lines) {
    const ax = line.a.x * unitScale
    const az = line.a.y * unitScale
    const bx = line.b.x * unitScale
    const bz = line.b.y * unitScale
    const length = Math.hypot(bx - ax, bz - az)
    if (length < MIN_CURTAIN_SEGMENT) continue
    const ux = (bx - ax) / length
    const uz = (bz - az) / length
    // 右手基：u × v = w；w 即墙法线
    const u: Vec3 = [ux, 0, uz]
    const w: Vec3 = [-uz, 0, ux]

    if (plain) {
      // 白膜墙：沿中心线一片通高薄板，不做开间划分，也不生成框料与玻璃
      pushBox(
        massing,
        [(ax + bx) / 2, massingBase + height / 2, (az + bz) / 2],
        u,
        v,
        w,
        [length / 2, height / 2, massingThickness / 2],
      )
      totalLength += length
      massingCenterlines.push({ a: { x: ax, y: az }, b: { x: bx, y: bz } })
      continue
    }

    const bays = Math.max(1, Math.min(500, Math.round(length / spacing)))
    const bay = length / bays
    // 竖梃：两端各一根，中间每个开间边界一根
    for (let index = 0; index <= bays; index += 1) {
      const s = index * bay
      pushBox(
        frames,
        [ax + ux * s, height / 2, az + uz * s],
        u,
        v,
        w,
        [mullionWidth / 2, height / 2, frameDepth / 2],
      )
      mullionCount += 1
    }
    // 上下横档：封住整段幕墙的顶边与底边
    const midX = (ax + bx) / 2
    const midZ = (az + bz) / 2
    pushBox(
      frames,
      [midX, transomHeight / 2, midZ],
      u,
      v,
      w,
      [length / 2, transomHeight / 2, frameDepth / 2],
    )
    pushBox(
      frames,
      [midX, height - transomHeight / 2, midZ],
      u,
      v,
      w,
      [length / 2, transomHeight / 2, frameDepth / 2],
    )
    // 玻璃：每个开间两片，位于上下横档之间
    const paneHeight = height - transomHeight * 2
    const paneWidth = bay - mullionWidth
    if (paneHeight > 0.02 && paneWidth > 0.02) {
      const offset = glassGap / 2 + glassThickness / 2
      for (let index = 0; index < bays; index += 1) {
        const s = (index + 0.5) * bay
        const cx = ax + ux * s
        const cz = az + uz * s
        for (const sign of [-1, 1] as const) {
          pushBox(
            glass,
            [cx + w[0] * offset * sign, transomHeight + paneHeight / 2, cz + w[2] * offset * sign],
            u,
            v,
            w,
            [paneWidth / 2, paneHeight / 2, glassThickness / 2],
          )
          paneCount += 1
        }
      }
    }
    totalLength += length
    centerlines.push({ a: { x: ax, y: az }, b: { x: bx, y: bz } })
  }

  if (frames.length === 0 && glass.length === 0 && massing.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const source of [frames, glass, massing]) {
    for (let index = 0; index < source.length; index += 3) {
      const x = source[index]
      const z = source[index + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minY) minY = z
      if (z > maxY) maxY = z
    }
  }

  return {
    frames: new Float32Array(frames),
    glass: new Float32Array(glass),
    massing: new Float32Array(massing),
    bounds: { minX, minY, maxX, maxY },
    segmentCount: centerlines.length + massingCenterlines.length,
    totalLength,
    mullionCount,
    paneCount,
    centerlines,
    massingCenterlines,
  }
}

/**
 * 合并多份幕墙 / 白膜墙几何。
 *
 * 同一楼层可能既有显式「幕墙」图层、又有未设类型图层的白膜墙，
 * 二者都是沿中心线生成，只是构造不同；合并后视图与编辑态按同一份几何处理。
 * 输入全是空时返回 null，不做空几何兜底。
 */
export function mergeCurtainGeometries(
  parts: ReadonlyArray<CurtainWallGeometry | null | undefined>,
): CurtainWallGeometry | null {
  const valid = parts.filter(
    (part): part is CurtainWallGeometry => part !== null && part !== undefined,
  )
  if (valid.length === 0) return null
  if (valid.length === 1) return valid[0]

  /** 拼接同类顶点数组 */
  const concat = (pick: (part: CurtainWallGeometry) => Float32Array): Float32Array => {
    let total = 0
    for (const part of valid) total += pick(part).length
    const merged = new Float32Array(total)
    let cursor = 0
    for (const part of valid) {
      const source = pick(part)
      merged.set(source, cursor)
      cursor += source.length
    }
    return merged
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let segmentCount = 0
  let totalLength = 0
  let mullionCount = 0
  let paneCount = 0
  const centerlines: CurtainLine[] = []
  const massingCenterlines: CurtainLine[] = []
  for (const part of valid) {
    minX = Math.min(minX, part.bounds.minX)
    minY = Math.min(minY, part.bounds.minY)
    maxX = Math.max(maxX, part.bounds.maxX)
    maxY = Math.max(maxY, part.bounds.maxY)
    segmentCount += part.segmentCount
    totalLength += part.totalLength
    mullionCount += part.mullionCount
    paneCount += part.paneCount
    centerlines.push(...part.centerlines)
    massingCenterlines.push(...part.massingCenterlines)
  }

  return {
    frames: concat((part) => part.frames),
    glass: concat((part) => part.glass),
    massing: concat((part) => part.massing),
    bounds: { minX, minY, maxX, maxY },
    segmentCount,
    totalLength,
    mullionCount,
    paneCount,
    centerlines,
    massingCenterlines,
  }
}

/**
 * 幕墙与白膜墙的全部中心线。
 * 编辑态拾取、对象键与高亮共用：两类墙都沿中心线可点选 / 可删除。
 */
export function curtainCenterlines(
  geometry: CurtainWallGeometry | null | undefined,
): CurtainLine[] {
  if (!geometry) return []
  return [...geometry.centerlines, ...geometry.massingCenterlines]
}

/**
 * 按洞口切割白膜墙中心线。
 *
 * `cutsByLine` 与 `lines` 一一对应，每条线只接受自己那组洞口，
 * 避免平行墙线上相同的区间被误切。返回洞口以外的子线段；
 * 没有洞口的线原样返回，坐标仍为图纸坐标。
 */
export function cutCurtainLines(
  lines: readonly CurtainLine[],
  cutsByLine: ReadonlyArray<readonly CurtainLine[]>,
): CurtainLine[] {
  const result: CurtainLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const cuts = cutsByLine[index] ?? []
    const length = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y)
    if (length <= 0) continue
    const ux = (line.b.x - line.a.x) / length
    const uy = (line.b.y - line.a.y) / length
    const intervals: Array<[number, number]> = []
    for (const cut of cuts) {
      const t0 = (cut.a.x - line.a.x) * ux + (cut.a.y - line.a.y) * uy
      const t1 = (cut.b.x - line.a.x) * ux + (cut.b.y - line.a.y) * uy
      const low = Math.min(t0, t1)
      const high = Math.max(t0, t1)
      if (high <= 0 || low >= length) continue
      intervals.push([Math.max(0, low), Math.min(length, high)])
    }
    if (intervals.length === 0) {
      result.push(line)
      continue
    }
    intervals.sort((left, right) => left[0] - right[0])
    const pointAt = (t: number): CadPoint => ({
      x: line.a.x + ux * t,
      y: line.a.y + uy * t,
    })
    let cursor = 0
    for (const [low, high] of intervals) {
      if (low > cursor) result.push({ a: pointAt(cursor), b: pointAt(low) })
      if (high > cursor) cursor = high
    }
    if (cursor < length) result.push({ a: pointAt(cursor), b: pointAt(length) })
  }
  return result
}

/** 幕墙顶点总数（顶点 = 3 个浮点数），含白膜墙 */
export function curtainVertexCount(geometry: CurtainWallGeometry | null | undefined): number {
  if (!geometry) return 0
  return (geometry.frames.length + geometry.glass.length + geometry.massing.length) / 3
}

/** 幕墙 three 几何：铝框在前、玻璃其次、白膜墙最后，按材质组切分 */
export function createCurtainBufferGeometry(curtain: CurtainWallGeometry): THREE.BufferGeometry {
  const positions = new Float32Array(
    curtain.frames.length + curtain.glass.length + curtain.massing.length,
  )
  positions.set(curtain.frames, 0)
  positions.set(curtain.glass, curtain.frames.length)
  positions.set(curtain.massing, curtain.frames.length + curtain.glass.length)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  const frameCount = curtain.frames.length / 3
  const glassCount = curtain.glass.length / 3
  const massingCount = curtain.massing.length / 3
  let offset = 0
  if (frameCount > 0) {
    geometry.addGroup(offset, frameCount, CURTAIN_FRAME_GROUP)
    offset += frameCount
  }
  if (glassCount > 0) {
    geometry.addGroup(offset, glassCount, CURTAIN_GLASS_GROUP)
    offset += glassCount
  }
  if (massingCount > 0) {
    geometry.addGroup(offset, massingCount, CURTAIN_MASSING_GROUP)
  }
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * 幕墙材质：哑光阳极氧化铝 + 高透中空玻璃 + 白膜墙。
 * 基准色写入 userData.baseColor，供楼层展开时统一压暗。
 */
export function createCurtainMaterials(): THREE.MeshStandardMaterial[] {
  const frameColor = new THREE.Color(CURTAIN_FRAME_COLOR)
  const glassColor = new THREE.Color(CURTAIN_GLASS_COLOR)
  const massingColor = new THREE.Color(CURTAIN_MASSING_COLOR)
  const frame = new THREE.MeshStandardMaterial({
    color: frameColor,
    roughness: 0.34,
    metalness: 0.82,
    envMapIntensity: 1.2,
    side: THREE.FrontSide,
  })
  const glass = new THREE.MeshStandardMaterial({
    color: glassColor,
    roughness: 0.05,
    metalness: 0.05,
    envMapIntensity: 1.6,
    transparent: true,
    opacity: 0.28,
    // 双层玻璃两面都要能从室内外看见；不写深度，避免前片把后片与室内一起挡掉
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  // 白膜墙：无贴图哑光白色实体，只保留体量，不要幕墙的金属 / 玻璃质感
  const massing = new THREE.MeshStandardMaterial({
    color: massingColor,
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: 0.6,
    side: THREE.FrontSide,
  })
  frame.userData.baseColor = frameColor.clone()
  glass.userData.baseColor = glassColor.clone()
  massing.userData.baseColor = massingColor.clone()
  return [frame, glass, massing]
}

