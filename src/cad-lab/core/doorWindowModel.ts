/**
 * CAD 门窗识别：按「图层 + 块名」判定构件类型，再按常规建筑尺寸换算成洞口。
 *
 * 识别规则（顺序固定，不依赖几何启发式猜测类型）：
 * 1. 图层名包含 门 / DOOR 判定为门，包含 窗 / WINDOW / WIN 判定为窗；
 * 2. 图层名没有关键词时，按该图层内 INSERT 块名前缀投票（M / FM / D → 门，C / TC / W → 窗）；
 * 3. 块名带建筑模数后缀时直接取宽高（M0921 → 0.9m × 2.1m，C1515 → 1.5m × 1.5m）。
 *
 * 尺寸规则：
 * - 块名能给出模数时以块名为准；
 * - 否则用块内图元沿墙实测宽度归整到常规宽度系列；
 * - 实测值落在可信区间外时退回该类型的常规宽度（门 0.9m / 窗 1.5m），
 *   这是「按常规模型尺寸生成」的既定行为，不是对解析错误的兜底。
 *
 * 洞口定位：
 * - 以块内图元的包围盒中心吸附最近的墙中心线，吸附超限的构件计入跳过清单；
 * - 洞口沿墙区间被限制在所属墙段内，宽度超过墙段长度时同样计入跳过清单。
 */

import type { CadDrawing, CadPoint } from './types'
import type { WallSegment, OpeningWindowPart } from './wallModel'
import type { DoorPreset, WindowPreset } from './openingModel'

/** 门窗类型 */
export type OpeningKind = 'door' | 'window'

/** 门 / 窗的常规尺寸（米） */
export const DEFAULT_DOOR_WIDTH = 0.9
export const DEFAULT_DOOR_HEIGHT = 2.1
export const DEFAULT_WINDOW_WIDTH = 1.5
export const DEFAULT_WINDOW_HEIGHT = 1.5
/** 窗台高（米） */
export const DEFAULT_WINDOW_SILL = 0.9

/** 门窗吸附到墙中心线的允许距离 = 半墙厚 + 该余量（米） */
const SNAP_MARGIN = 0.6
/** 门块包围盒长宽比达到该值，认为长边方向就是墙向 */
const BLOCK_AXIS_MIN_RATIO = 2
/** 门块长边方向与墙向的允许夹角（度） */
const BLOCK_AXIS_TOLERANCE = 10
/** 双线墙两面各画一个门块时，两块块心距的上限（米），超过它视为两樘门 */
const PAIR_MAX_DISTANCE = 0.35
/** 两块块心距的下限（米）：完全重合的是重复图元，不是两面标记 */
const PAIR_MIN_DISTANCE = 0.05
/** 判定「两块心连线垂直于门块长边」的允许夹角（度） */
const PAIR_PERPENDICULAR_TOLERANCE = 20

/** 两个洞口的中心距小于该值时视为同一构件（米），用于块内多图元重复识别去重 */
const DUPLICATE_DISTANCE = 0.2

/** 常规门宽系列（米），用于把实测宽度归整到建筑模数 */
const DOOR_WIDTH_SERIES = [0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 1.8, 2.1]
/** 常规窗宽系列（米） */
const WINDOW_WIDTH_SERIES = [0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 3.0]

/** 块名模数允许的宽高范围（米） */
const MIN_WIDTH = 0.4
const MAX_WIDTH = 6
const MIN_HEIGHT = 0.4
const MAX_HEIGHT = 4

/** 图层名关键词 */
const DOOR_LAYER_PATTERN = /门|door/i
// 窗类图层：含「幕墙 / 玻璃 / curtain / glazing」的图层同样按窗处理，
// 最终是嵌墙窗还是整层幕墙由 curtainModel 按几何范围再判定
const WINDOW_LAYER_PATTERN = /窗|幕墙|玻璃|window|win|curtain|glazing/i
/** 块名前缀：门 */
const DOOR_BLOCK_PATTERN = /^(M|FM|TLM|D|门)/i
/** 块名前缀：窗 */
const WINDOW_BLOCK_PATTERN = /^(C|TC|W|WIN|窗)/i
/** 块名中的四位模数（前两位宽、后两位高，单位分米） */
const MODULAR_PATTERN = /(\d{2})(\d{2})/

/** 识别参数 */
export interface DoorWindowOptions {
  /** 图层名 → 门窗类型；只有列出的图层参与识别 */
  layerKinds: Record<string, OpeningKind>
  /** 墙体中心线（图纸坐标，墙厚为米） */
  walls: readonly WallSegment[]
  unitScale: number
  /** 单层墙高（米），用于校验洞口是否超出墙高 */
  wallHeight: number
  doorWidth?: number
  doorHeight?: number
  windowWidth?: number
  windowHeight?: number
  windowSill?: number
  /**
   * 触碰吸附容差（米），默认 0 表示只用块心距离判定。
   *
   * 门大样里的门扇常常垂直展开，块心离墙中心线可能超过「半墙厚 + 余量」，
   * 但门扇根部一定落在墙线上。大于 0 时，只要块内任一图元点到墙线的距离
   * 不超过该容差，也视为吸附成功（位置仍取块心在墙上的投影）。
   */
  touchTolerance?: number
  /**
   * 跳过放不下洞口的短墙段（默认 false，只取距离最近的一道墙）。
   *
   * 白膜墙由窗线逐点拆段得到，门块旁边常有 0.1~0.2m 的墙端碎段；
   * 只按最近距离吸附会选中碎段，再因「洞口宽超过墙段长」被跳过。
   * 打开后按距离升序逐道尝试，选第一道能容纳洞口的墙段。
   */
  avoidShortHosts?: boolean
  /**
   * 严格按构件图元定位洞口（默认 false）。
   *
   * 施工图把墙体在门窗洞口处断开，门块就画在洞口里，此时若把洞口中心夹进
   * 两侧墙垛的任意一段，门会被推到墙垛上。打开后：
   * - 方向与宽度只取门块自身几何：包围盒长边方向即洞口方向，长边跨度即洞口宽；
   *   双线墙两面各画一个门块时，两块心连线是墙法向、两心距是墙厚，两块合并成一樘；
   * - 洞口中心沿墙方向取块心投影，不再夹进墙段；
   * - 洞口宽度超过墙段长度时不再跳过（洞口本来就跨在两段墙之间）；
   * - 判定吸附用「块心到墙线所在直线的垂距」，墙体在洞口处断开、墙垛离得远也算同一条墙线。
   *
   * 仅白膜墙门使用；窗与实体墙上的门仍按墙段夹取，行为不变。
   */
  exactPlacement?: boolean
}

/** 一个门窗洞口（米，CAD 平面坐标） */
export interface OpeningSpec {
  kind: OpeningKind
  /** 所属墙段的稳定几何键，与 `WallPiece.key` 一致 */
  wallKey: string
  /** 洞口中心，落在墙中心线上 */
  center: CadPoint
  /** 沿墙方向的单位向量 */
  direction: CadPoint
  /** 洞口宽度（米，沿墙方向） */
  width: number
  /** 洞口高度（米） */
  height: number
  /** 洞口底标高（米）：门为 0，窗为窗台高 */
  sill: number
  /** 洞口沿墙起点与终点（米，落在墙中心线上） */
  start: CadPoint
  end: CadPoint
  /** 由块名 / 图层 / 洞口宽度推断的做法预设，与 webmap 门窗语义同名 */
  preset: DoorPreset | WindowPreset
  /** 来源块名，供界面提示 */
  blockName?: string
  /** 门连窗中窗所占的区段；存在时表示门窗已合成一个洞口 */
  windowPart?: OpeningWindowPart
  /** 门连窗上亮的高度覆盖（相对洞口底，米） */
  transom?: { sill: number; height: number }
  /**
   * 洞口中心沿宿主墙段的原始投影偏移（米，未夹在墙段内）。
   *
   * 施工图常把墙体在洞口处断开，块心投影会落在墙段端点之外；
   * 白膜墙门据此找回「图纸已有的洞口」，避免把门夹到墙垛上。
   */
  hostAlong?: number
  /**
   * 构件来源的稳定标识：图层 + 块名 + 块心（米）。
   *
   * 同一个门块可能同时被实体墙分支和白膜墙分支识别到不同的墙上，
   * 跨分支去重必须先认出「这是同一个块」，仅靠洞口中心距离会漏。
   */
  blockKey?: string
  /**
   * 双线墙两面各画一个门块时，两块块心距（米），也就是这道墙的墙厚。
   *
   * 两块合并成一樘门后，洞口中心落在两面中点上；渲染时用它把门套
   * 撑满整个墙厚带，否则门只占一片板厚，另一面会露缝。
   */
  markSpan?: number
}

/** 被跳过的门窗构件 */
export interface SkippedOpening {
  kind: OpeningKind
  layer: string
  blockName?: string
  reason: string
}

/** 识别结果 */
export interface OpeningRecognitionResult {
  openings: OpeningSpec[]
  skipped: SkippedOpening[]
  /** 直接展示给用户的中文说明 */
  notes: string[]
}

/** 块内聚合后的一个门窗候选 */
interface OpeningCandidate {
  kind: OpeningKind
  layer: string
  blockName?: string
  /** 已换算为米的图元点 */
  points: CadPoint[]
}

/** 图层名 → 门窗类型；无关键词返回 null */
function classifyLayerName(layerName: string): OpeningKind | null {
  if (DOOR_LAYER_PATTERN.test(layerName)) return 'door'
  if (WINDOW_LAYER_PATTERN.test(layerName)) return 'window'
  return null
}

/** 块名前缀 → 门窗类型；无法判定返回 null */
function classifyBlockName(blockName: string): OpeningKind | null {
  if (DOOR_BLOCK_PATTERN.test(blockName)) return 'door'
  if (WINDOW_BLOCK_PATTERN.test(blockName)) return 'window'
  return null
}

/** 对一组块名投票；票数相同或无票返回 null */
function classifyBlockNames(blockNames: readonly string[] | undefined): OpeningKind | null {
  if (!blockNames) return null
  let door = 0
  let window = 0
  for (const name of blockNames) {
    const kind = classifyBlockName(name)
    if (kind === 'door') door += 1
    else if (kind === 'window') window += 1
  }
  if (door > window) return 'door'
  if (window > door) return 'window'
  return null
}

/**
 * 由块名 + 图层 + 洞口宽度推断门型预设。
 *
 * 预设只描述做法语义（门套材质、门扇分格、五金），几何尺寸仍以洞口为准；
 * 名称与主工程 webmap 的 `IndoorDoorPreset` 一一对应，导出后可直接复用。
 */
function inferDoorPreset(blockName: string | undefined, layer: string, width: number): DoorPreset {
  const text = `${blockName ?? ''} ${layer}`
  if (/防火|消防|FM|fire/i.test(text)) return 'steel_fire'
  if (/防盗|安全|入户|security|guard/i.test(text)) return 'security_steel'
  if (/百叶|louver/i.test(text)) return 'louver'
  if (/推拉|sliding|TLM/i.test(text)) return 'glass_sliding'
  if (/玻璃|glass|GL/i.test(text)) return width >= 1.5 ? 'glass_double' : 'glass_single'
  if (/拱|arch/i.test(text)) return 'wood_arch'
  return width >= 1.5 ? 'wood_double' : 'wood_single'
}

/** 由块名 + 图层 + 洞口宽度推断窗型预设，字段对齐立面窗做法 */
function inferWindowPreset(blockName: string | undefined, layer: string, width: number): WindowPreset {
  const text = `${blockName ?? ''} ${layer}`
  if (/百叶|louver/i.test(text)) return 'louver'
  if (/推拉|sliding|TL/i.test(text)) return 'sliding'
  if (/固定|fixed|幕墙|curtain/i.test(text)) return 'fixed'
  return width >= 2.4 ? 'casement_double' : 'casement_single'
}

/**
 * 一次性给出每个图层的门窗类型建议（图层名优先，其次按块名前缀投票）。
 * 只返回能判定的图层，其余图层不出现在结果中（界面默认「忽略」）。
 */
export function recommendOpeningKinds(drawing: CadDrawing): Record<string, OpeningKind> {
  const blockNamesByLayer = new Map<string, Set<string>>()
  for (const entity of drawing.entities) {
    if (!entity.blockName) continue
    let set = blockNamesByLayer.get(entity.layer)
    if (!set) {
      set = new Set<string>()
      blockNamesByLayer.set(entity.layer, set)
    }
    set.add(entity.blockName)
  }

  const result: Record<string, OpeningKind> = {}
  for (const layer of drawing.layers) {
    const names = blockNamesByLayer.get(layer.name)
    const kind = classifyLayerName(layer.name) ?? classifyBlockNames(names ? [...names] : undefined)
    if (kind) result[layer.name] = kind
  }
  return result
}

/**
 * 解析块名中的建筑模数：M0921 → 0.9m 宽 × 2.1m 高，C1515 → 1.5m × 1.5m。
 * 没有四位数字或超出合理范围时返回 null（由常规尺寸接管）。
 */
export function parseModularSize(blockName: string | undefined): { width: number; height: number } | null {
  if (!blockName) return null
  const normalized = blockName.replace(/[\s_-]/g, '')
  const match = normalized.match(MODULAR_PATTERN)
  if (!match) return null
  const width = Number(match[1]) / 10
  const height = Number(match[2]) / 10
  if (!(width >= MIN_WIDTH && width <= MAX_WIDTH)) return null
  if (!(height >= MIN_HEIGHT && height <= MAX_HEIGHT)) return null
  return { width, height }
}

/** 归整到最近的常规宽度；超出常规系列范围时返回 null */
function snapWidth(measured: number, series: readonly number[]): number | null {
  let best: number | null = null
  let bestDelta = Infinity
  for (const value of series) {
    const delta = Math.abs(value - measured)
    if (delta < bestDelta) {
      bestDelta = delta
      best = value
    }
  }
  // 偏差超过一个模数档（0.3m）说明实测宽度不是常规构件，交给常规默认值
  if (best === null || bestDelta > 0.3) return null
  return best
}

/** 点到线段的投影结果 */
interface SegmentProjection {
  /** 投影点在 [a, b] 上的参数，0 为 a、1 为 b */
  t: number
  /** 投影点 */
  point: CadPoint
  /** 点到线段的距离（米） */
  distance: number
  /** 线段长度 */
  length: number
}

/** 把点投影到线段上，参数被限制在 [0, 1] */
function projectOnSegment(point: CadPoint, a: CadPoint, b: CadPoint): SegmentProjection {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (!(lengthSq > 0)) throw new Error('墙段长度为零，无法投影门窗位置')
  const raw = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
  const px = a.x + dx * t
  const py = a.y + dy * t
  return {
    t,
    point: { x: px, y: py },
    distance: Math.hypot(point.x - px, point.y - py),
    length: Math.sqrt(lengthSq),
  }
}

/** 取图元点的包围盒中心 */
function centerOfPoints(points: readonly CadPoint[]): CadPoint {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/**
 * 洞口去重键。
 *
 * 必须带上门窗类型：门连窗在图上常常是一樘门 + 一樘窗画在同一位置，
 * 只按位置去重会把窗当作重复构件丢掉，后面就没法合成门连窗了。
 */
function openingKey(wallKey: string, center: CadPoint, kind: OpeningKind): string {
  return `${kind}|${wallKey}|${Math.round(center.x / DUPLICATE_DISTANCE)},${Math.round(center.y / DUPLICATE_DISTANCE)}`
}

/** 门连窗允许的门窗缝隙（米）：并集洞口里的缝隙由分隔竖梃填补，再宽就补不上了 */
const SIDE_WINDOW_GAP_MAX = 0.05

/** 门窗合并方案 */
interface MergePlan {
  /** true 表示窗整个在门上方（门带亮窗），false 表示门与窗沿墙并排（门带侧窗） */
  transom: boolean
  /** 窗沿墙区段（相对门中心，米） */
  interval: { start: number; end: number }
  /** 合并后的洞口顶标高（相对洞口底，米） */
  top: number
  /** 合并后洞口沿墙并集（相对门中心，米） */
  union: { start: number; end: number }
  /** 合并前门洞口自己的顶标高（米），用于给门连窗上方补亮窗 */
  doorTop: number
}

/** 计算门窗相对位置的沿墙区间（相对参照洞口中心，米） */
function alongInterval(reference: OpeningSpec, other: OpeningSpec): { start: number; end: number } {
  const offset =
    (other.center.x - reference.center.x) * reference.direction.x +
    (other.center.y - reference.center.y) * reference.direction.y
  return { start: offset - other.width / 2, end: offset + other.width / 2 }
}

/** 由中心与宽度重算洞口起点 / 终点，保证两者始终一致 */
function resetOpeningEnds(opening: OpeningSpec): void {
  const half = opening.width / 2
  opening.start = {
    x: opening.center.x - opening.direction.x * half,
    y: opening.center.y - opening.direction.y * half,
  }
  opening.end = {
    x: opening.center.x + opening.direction.x * half,
    y: opening.center.y + opening.direction.y * half,
  }
}

/**
 * 判断一樘门与一樘窗能否合成门连窗，并给出合并方案。
 *
 * - 窗整个落在门顶以上且沿墙基本对齐 → 门带亮窗（transom）；
 * - 窗与门沿墙重叠（竖向范围也有重叠）→ 门带侧窗（windowPart）；
 * 两种情况都要求合并后的洞口顶不超过墙高。
 */
function planMerge(door: OpeningSpec, window: OpeningSpec, wallHeight: number): MergePlan | null {
  const interval = alongInterval(door, window)
  const doorStart = -door.width / 2
  const doorEnd = door.width / 2
  const windowTop = window.sill + window.height
  const overlap = Math.min(doorEnd, interval.end) - Math.max(doorStart, interval.start)
  const union = {
    start: Math.min(doorStart, interval.start),
    end: Math.max(doorEnd, interval.end),
  }
  // 上亮：沿墙重叠率够高，窗底高于门顶，窗不比门宽
  if (
    overlap >= 0.6 * Math.min(door.width, window.width) &&
    window.sill >= door.height - 0.05 &&
    window.width <= door.width + 0.05 &&
    windowTop <= wallHeight + 1e-6
  ) {
    return { transom: true, interval, top: windowTop, union, doorTop: door.height }
  }
  // 侧窗：沿墙相邻或轻微重叠。并集洞口里允许留一点缝隙（由分隔竖梃填补），
  // 缝隙再宽就补不上、会露出墙洞，因此仍按两个独立洞口处理。
  const verticalOverlap = Math.min(door.height, windowTop) - Math.max(0, window.sill)
  if (
    -overlap > SIDE_WINDOW_GAP_MAX ||
    verticalOverlap <= 0.3 ||
    Math.max(door.height, windowTop) > wallHeight + 1e-6
  ) {
    return null
  }
  return { transom: false, interval, top: Math.max(door.height, windowTop), union, doorTop: door.height }
}

/**
 * 把同一墙段上位置重叠的门与窗合成一樘门连窗。
 *
 * 门窗画在同一位置时，如果各自开洞，同一条墙上两个洞口会互相覆盖，
 * 其中一个必然被丢弃（只留下门或只留下窗）。合并后只有一个洞口：
 * - 门带亮窗：洞口加高到窗顶，亮窗高度写进 `transom`；
 * - 门带侧窗：洞口取两者并集，门扇只占门那一段，窗段写进 `windowPart`。
 */
export function mergeDoorWindowOpenings(
  openings: readonly OpeningSpec[],
  wallHeight: number,
): { openings: OpeningSpec[]; merged: number } {
  const doors = openings.filter((opening) => opening.kind === 'door')
  const windows = openings.filter((opening) => opening.kind === 'window')
  const consumed = new Set<OpeningSpec>()
  let merged = 0

  for (const door of doors) {
    // 一樘门最多带一樘窗：取沿墙重叠面积最大的一樘，保证结果与顺序无关且确定
    let partner: OpeningSpec | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const window of windows) {
      if (consumed.has(window) || window.wallKey !== door.wallKey) continue
      const plan = planMerge(door, window, wallHeight)
      if (!plan) continue
      const score = (plan.union.end - plan.union.start) * plan.top
      if (score > bestScore) {
        bestScore = score
        partner = window
      }
    }
    if (!partner) continue
    const plan = planMerge(door, partner, wallHeight)
    if (!plan) continue

    if (plan.transom) {
      door.height = plan.top
      door.transom = { sill: partner.sill, height: partner.height }
      resetOpeningEnds(door)
    } else {
      const mid = (plan.union.start + plan.union.end) / 2
      // 洞口中心沿墙移到并集中点，门段 / 窗段都相对新中心换算
      door.center = {
        x: door.center.x + door.direction.x * mid,
        y: door.center.y + door.direction.y * mid,
      }
      door.width = plan.union.end - plan.union.start
      door.height = plan.top
      door.windowPart = {
        start: plan.interval.start - mid,
        end: plan.interval.end - mid,
        sill: partner.sill,
        height: partner.height,
      }
      // 窗顶高于门顶时，门扇不能跟着并集洞口一起加高，要在门上方补一段亮窗
      if (plan.top > plan.doorTop + 1e-6) {
        door.transom = { sill: plan.doorTop, height: plan.top - plan.doorTop }
      }
      resetOpeningEnds(door)
    }
    consumed.add(partner)
    merged += 1
  }

  const kept = openings.filter((opening) => !consumed.has(opening))
  return { openings: kept, merged }
}

/**
 * 精确模式下的一个定位工作项：单个门块，或双线墙两面合并后的同一樘门。
 *
 * 位置、方向、宽度全部来自门图层图元自身，宿主墙线只提供法向坐标与开洞归属。
 */
interface PlacementWork {
  /** 主块：块名 / 图层等语义取自它，也是跨分支去重的身份来源 */
  candidate: OpeningCandidate
  /** 定位用的块心；两块合并时取两面中点（即墙中心线） */
  center: CadPoint
  /** 主块的包围盒中心：写进 blockKey，保证与实体墙分支认出同一个块 */
  markCenter: CadPoint
  /** 门块自身给出的洞口方向；null 表示没有可用的方向信息，只能沿用宿主墙线方向 */
  axis: CadPoint | null
  /** 门块自身量得的洞口宽度（沿 axis 的包围盒跨度，米）；axis 为 null 时为 null */
  span: number | null
  /** 两块合并时的块心距（米），等于这道墙的墙厚 */
  markSpan?: number
}

/** 一组点沿给定向的跨度（米） */
function spanAlong(points: readonly CadPoint[], direction: CadPoint): number {
  let min = Infinity
  let max = -Infinity
  for (const point of points) {
    const along = point.x * direction.x + point.y * direction.y
    if (along < min) min = along
    if (along > max) max = along
  }
  return max - min
}

/**
 * 把候选块整理成定位工作项。
 *
 * 非精确模式与以前完全一致：一个块一项，方向交给宿主墙线。
 *
 * 精确模式（白膜墙上的门）必须严格照图解析，只用图元自身的几何：
 * 1. 门洞标记是沿墙的细长条：包围盒长边方向即洞口方向，长边跨度即洞口宽；
 * 2. 双线墙在两个面上各画一个门块：两块心连线是墙法向，洞口方向与之垂直，
 *    两心距就是一个墙厚；两块合并成一樘，否则同一个门洞会生成两樘门。
 * 其余画法（门扇垂直展开的大样等）没有可用的方向信息，仍沿用宿主墙线方向，
 * 位置也仍由投影决定，与改造前一致。
 */
function planPlacementWorks(
  candidates: ReadonlyMap<string, OpeningCandidate>,
  exactPlacement: boolean,
): PlacementWork[] {
  const works: PlacementWork[] = []
  if (!exactPlacement) {
    for (const candidate of candidates.values()) {
      const center = centerOfPoints(candidate.points)
      works.push({ candidate, center, markCenter: center, axis: null, span: null })
    }
    return works
  }

  /** 一个块的包围盒与长边方向 */
  interface BlockBox {
    candidate: OpeningCandidate
    center: CadPoint
    axis: CadPoint | null
  }
  const boxes: BlockBox[] = []
  for (const candidate of candidates.values()) {
    // 空图元不参与配对，但保留成独立工作项，交给主循环报「图元为空」
    if (candidate.points.length === 0) {
      const origin = { x: 0, y: 0 }
      works.push({ candidate, center: origin, markCenter: origin, axis: null, span: null })
      continue
    }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const point of candidate.points) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
    const spanX = maxX - minX
    const spanY = maxY - minY
    const longSpan = spanX >= spanY ? spanX : spanY
    const shortSpan = spanX >= spanY ? spanY : spanX
    let axis: CadPoint | null = null
    if (shortSpan > 1e-6 && longSpan / shortSpan >= BLOCK_AXIS_MIN_RATIO) {
      axis = spanX >= spanY ? { x: 1, y: 0 } : { x: 0, y: 1 }
    }
    boxes.push({ candidate, center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, axis })
  }

  const used = new Set<number>()
  for (let index = 0; index < boxes.length; index += 1) {
    if (used.has(index)) continue
    const self = boxes[index]
    used.add(index)
    let mate = -1
    for (let other = index + 1; other < boxes.length; other += 1) {
      if (used.has(other)) continue
      const candidate = boxes[other]
      if (candidate.candidate.kind !== self.candidate.kind) continue
      const dx = candidate.center.x - self.center.x
      const dy = candidate.center.y - self.center.y
      const distance = Math.hypot(dx, dy)
      if (distance < PAIR_MIN_DISTANCE || distance > PAIR_MAX_DISTANCE) continue
      // 只有「连线垂直于块长边」才可能是双线墙的两面标记；
      // 沿长边并排 0.2m 的两个块是另一扇门，不能合并
      if (self.axis !== null) {
        const alongAxis = Math.abs((dx * self.axis.x + dy * self.axis.y) / distance)
        if (alongAxis > Math.cos((PAIR_PERPENDICULAR_TOLERANCE * Math.PI) / 180)) continue
      }
      mate = other
      used.add(other)
      break
    }

    if (mate < 0) {
      works.push({
        candidate: self.candidate,
        center: self.center,
        markCenter: self.center,
        axis: self.axis,
        span: self.axis === null ? null : spanAlong(self.candidate.points, self.axis),
      })
      continue
    }

    const other = boxes[mate]
    const dx = other.center.x - self.center.x
    const dy = other.center.y - self.center.y
    const distance = Math.hypot(dx, dy)
    // 两块心连线就是墙法向，洞口方向沿墙
    const axis = { x: -dy / distance, y: dx / distance }
    // 两块的宽度取较小值：两面标记里较大的那块多含门套外包线，
    // 洞口按较小值开，墙垛不会被吃掉
    const span = Math.min(
      spanAlong(self.candidate.points, axis),
      spanAlong(other.candidate.points, axis),
    )
    works.push({
      candidate: self.candidate,
      center: { x: (self.center.x + other.center.x) / 2, y: (self.center.y + other.center.y) / 2 },
      markCenter: self.center,
      axis,
      span,
      markSpan: distance,
    })
  }
  return works
}

/**
 * 识别门窗并换算成墙体洞口。
 *
 * 只处理 `options.layerKinds` 中列出的图层；其余图层一律不参与，
 * 避免把家具、标注等无关图层误判成门窗。
 */
export function recognizeOpenings(
  drawing: CadDrawing,
  options: DoorWindowOptions,
): OpeningRecognitionResult {
  const skipped: SkippedOpening[] = []
  const openings: OpeningSpec[] = []
  const layerEntries = Object.entries(options.layerKinds)
  if (layerEntries.length === 0) return { openings, skipped, notes: [] }
  if (options.walls.length === 0) {
    // 门窗必须落在实体墙上才能开洞；静默返回会让「选了门却没有门模型」无从排查
    return {
      openings,
      skipped,
      notes: ['没有可用的实体墙：请把承载门窗的墙体图层勾选并标记为「窗」后再生成'],
    }
  }
  if (!(options.unitScale > 0)) throw new Error('单位换算比例必须为正数')
  if (!(options.wallHeight > 0)) throw new Error('墙高必须为正数')

  const doorWidth = options.doorWidth ?? DEFAULT_DOOR_WIDTH
  const doorHeight = options.doorHeight ?? DEFAULT_DOOR_HEIGHT
  const windowWidth = options.windowWidth ?? DEFAULT_WINDOW_WIDTH
  const windowHeight = options.windowHeight ?? DEFAULT_WINDOW_HEIGHT
  const windowSill = options.windowSill ?? DEFAULT_WINDOW_SILL
  const scale = options.unitScale

  // 墙段换成米，并预先算好单位方向，供吸附与洞口定位复用
  const metricWalls = options.walls.map((wall) => {
    const a = { x: wall.a.x * scale, y: wall.a.y * scale }
    const b = { x: wall.b.x * scale, y: wall.b.y * scale }
    return { wall, a, b }
  })

  // 1) 按块实例聚合图元；顶层散图元按实体各自成组
  const candidates = new Map<string, OpeningCandidate>()
  for (const entity of drawing.entities) {
    const kind = options.layerKinds[entity.layer]
    if (!kind) continue
    const groupKey =
      entity.blockInstance !== undefined ? `block:${entity.blockInstance}` : `entity:${entity.id}`
    let candidate = candidates.get(groupKey)
    if (!candidate) {
      candidate = { kind, layer: entity.layer, blockName: entity.blockName, points: [] }
      candidates.set(groupKey, candidate)
    }
    for (const primitive of entity.primitives) {
      if (primitive.kind === 'polyline') {
        for (const point of primitive.points) {
          candidate.points.push({ x: point.x * scale, y: point.y * scale })
        }
        continue
      }
      for (const loop of primitive.loops) {
        for (const point of loop) {
          candidate.points.push({ x: point.x * scale, y: point.y * scale })
        }
      }
    }
  }

  // 2) 逐个构件吸附到墙段并换算洞口
  const seen = new Set<string>()
  const avoidShortHosts = options.avoidShortHosts === true
  const exactPlacement = options.exactPlacement === true
  const touchTolerance = options.touchTolerance ?? 0
  // 精确模式先把门图层图元整理成一樘门一个工作项（双线墙两面合并）
  const works = planPlacementWorks(candidates, exactPlacement)
  for (const work of works) {
    const candidate = work.candidate
    if (candidate.points.length === 0) {
      skipped.push({ kind: candidate.kind, layer: candidate.layer, blockName: candidate.blockName, reason: '图元为空' })
      continue
    }
    const center = work.center

    // 候选墙段按吸附距离升序；没有触碰容差时吸附距离就是块心距离（窗与实体墙门口径不变），
    // 有触碰容差时取块内图元到墙线的最小距离，门大样不会再被远处的墙抢走
    const ranked: Array<
      SegmentProjection & {
        wall: WallSegment
        direction: CadPoint
        axis: { a: CadPoint; b: CadPoint }
        /** 吸附距离：块心距离，或块内图元到墙线的最小距离 */
        contact: number
        /** 块心到墙线所在直线的垂距：墙体在洞口处断开时用它判定「同一条墙线」 */
        lineDistance: number
      }
    > = []
    for (const metric of metricWalls) {
      const projection = projectOnSegment(center, metric.a, metric.b)
      const length = projection.length
      const direction: CadPoint = {
        x: (metric.b.x - metric.a.x) / length,
        y: (metric.b.y - metric.a.y) / length,
      }
      let contact = projection.distance
      if (touchTolerance > 0) {
        for (const point of candidate.points) {
          const distanceToAxis = projectOnSegment(point, metric.a, metric.b).distance
          if (distanceToAxis < contact) contact = distanceToAxis
        }
      }
      // 垂距只看块心到直线的距离，不受墙段端点夹取影响
      const offsetX = center.x - metric.a.x
      const offsetY = center.y - metric.a.y
      const lineDistance = Math.abs(offsetX * direction.y - offsetY * direction.x)
      ranked.push({
        ...projection,
        wall: metric.wall,
        direction,
        axis: metric,
        contact,
        lineDistance,
      })
    }
    if (ranked.length === 0) {
      skipped.push({ kind: candidate.kind, layer: candidate.layer, blockName: candidate.blockName, reason: '未吸附到任何墙体' })
      continue
    }

    // 精确模式下方向只认门块自身几何（包围盒长边，或双线墙两面连线的法向）：
    // 门洞旁常有垂直墙、斜向索引线，允许它们兜底会让整樘门转 90°、落到墙外
    const blockAxis = work.axis
    const blockAxisCos = Math.cos((BLOCK_AXIS_TOLERANCE * Math.PI) / 180)
    const alongBlockAxis = (direction: CadPoint): boolean =>
      blockAxis === null ||
      Math.abs(direction.x * blockAxis.x + direction.y * blockAxis.y) >= blockAxisCos
    ranked.sort((left, right) => {
      const leftAligned = alongBlockAxis(left.direction) ? 0 : 1
      const rightAligned = alongBlockAxis(right.direction) ? 0 : 1
      if (leftAligned !== rightAligned) return leftAligned - rightAligned
      return left.contact - right.contact
    })
    // 精确模式只在与门块同向的墙线里找宿主；同向墙线按「块心到墙线的垂距」排序，
    // 墙体在洞口处断开时墙垛可以离门块很远，但门仍属于这条墙线的延长线
    const alignedWalls = blockAxis === null ? [] : ranked.filter((item) => alongBlockAxis(item.direction))
    if (blockAxis !== null) alignedWalls.sort((left, right) => left.lineDistance - right.lineDistance)
    // 门块自身给出方向、且找得到同向墙线时，位置与尺寸才按图元严取；
    // 没有同向墙线说明这块图元的方向信息与墙无关（斜的索引线、专门的开启弧线大样），
    // 此时退回原来的投影定位并保留全量墙段兜底，宁可位置按墙投影，也不能把门丢掉
    const exactMode = exactPlacement && blockAxis !== null && alignedWalls.length > 0
    const search = exactMode
      ? alignedWalls
      : avoidShortHosts
        ? alignedWalls.length > 0
          ? alignedWalls
          : ranked
        : ranked.slice(0, 1)

    let chosen: (typeof ranked)[number] | null = null
    let width = 0
    let height = 0
    let sill = 0
    let failure = exactMode && search.length === 0 ? '门块方向附近没有同向的白膜墙线' : ''
    for (const item of search) {
      const maxDistance = item.wall.thickness / 2 + SNAP_MARGIN
      // 精确模式用垂距判定「同一条墙线」：洞口处墙体断开是施工图的常态，墙垛离得远也算；
      // 其余模式仍用吸附距离（块心距离 / 图元到墙线的最小距离）
      const placementDistance = exactMode ? item.lineDistance : item.contact
      // 触碰容差内也算吸附成功，否则门扇垂直展开的大样会因为块心偏离被误判成「离墙太远」
      if (placementDistance > maxDistance && !(touchTolerance > 0 && item.contact <= touchTolerance)) {
        if (failure === '') {
          failure = `离墙 ${placementDistance.toFixed(2)}m，超过吸附距离 ${maxDistance.toFixed(2)}m`
        }
        continue
      }

      const modular = parseModularSize(candidate.blockName)
      const series = candidate.kind === 'door' ? DOOR_WIDTH_SERIES : WINDOW_WIDTH_SERIES
      const fallbackWidth = candidate.kind === 'door' ? doorWidth : windowWidth
      let candidateWidth: number
      if (modular) {
        candidateWidth = modular.width
      } else if (exactMode && work.span !== null) {
        // 严格按图元：门块包围盒沿洞口方向的跨度就是洞口宽度
        candidateWidth = snapWidth(work.span, series) ?? fallbackWidth
      } else {
        // 块内图元沿墙方向的实测跨度，用于推断常规宽度
        let minAlong = Infinity
        let maxAlong = -Infinity
        for (const point of candidate.points) {
          const along = (point.x - item.point.x) * item.direction.x + (point.y - item.point.y) * item.direction.y
          if (along < minAlong) minAlong = along
          if (along > maxAlong) maxAlong = along
        }
        const measured = maxAlong - minAlong
        const snapped = measured >= MIN_WIDTH && measured <= MAX_WIDTH ? snapWidth(measured, series) : null
        candidateWidth = snapped ?? fallbackWidth
      }
      const candidateHeight = modular ? modular.height : candidate.kind === 'door' ? doorHeight : windowHeight
      const candidateSill = candidate.kind === 'door' ? 0 : windowSill

      if (!(candidateWidth > 0) || !(candidateHeight > 0)) {
        if (failure === '') {
          failure = `尺寸非法：宽 ${candidateWidth}m / 高 ${candidateHeight}m`
        }
        continue
      }
      if (candidateSill + candidateHeight > options.wallHeight + 1e-6) {
        if (failure === '') {
          failure = `洞口顶 ${(candidateSill + candidateHeight).toFixed(2)}m 超过墙高 ${options.wallHeight.toFixed(2)}m`
        }
        continue
      }
      if (!exactPlacement && candidateWidth > item.length + 1e-6) {
        // 短碎段承载不了洞口，记下原因后换下一道墙（avoidShortHosts 关闭时这里就是最终原因）
        // 精确模式不跳过：墙体在洞口处断开时，洞口本就是一跨在两段墙之间
        if (failure === '') {
          failure = `洞口宽 ${candidateWidth.toFixed(2)}m 超过墙段长 ${item.length.toFixed(2)}m`
        }
        continue
      }
      chosen = item
      width = candidateWidth
      height = candidateHeight
      sill = candidateSill
      break
    }
    if (chosen === null) {
      skipped.push({
        kind: candidate.kind,
        layer: candidate.layer,
        blockName: candidate.blockName,
        reason: failure === '' ? '未吸附到任何墙体' : failure,
      })
      continue
    }

    // 洞口中心沿墙偏移：以吸附点为准，并把区间限制在墙段内部；
    // 精确模式直接用原始投影，让洞口停在构件图元所在的位置（可能跨在两段墙之间）
    const segmentLength = chosen.length
    const half = width / 2
    const axisStart = {
      x: chosen.wall.a.x * scale,
      y: chosen.wall.a.y * scale,
    }
    // 原始投影（未夹在墙段内）：墙体在洞口处断开时它就是洞口里的坐标
    const rawAlong = (center.x - axisStart.x) * chosen.direction.x + (center.y - axisStart.y) * chosen.direction.y
    const rawCenter = chosen.t * segmentLength
    // 精确模要用未夹取的原始投影：投影落点被 projectOnSegment 夹到墙段端点时，
    // 洞口会被拖到墙垛上，这正是「门不在门洞里」的直接原因
    let centerAlong = rawAlong
    if (!exactPlacement) {
      centerAlong = rawCenter < half ? half : rawCenter > segmentLength - half ? segmentLength - half : rawCenter
    }
    // 双线墙两面各标一次时，合并后的块心就是墙中心线：位置直接取它，
    // 不能再往任意一片白膜板上投影，否则门口会贴着其中一面
    const centerPoint =
      work.markSpan !== undefined
        ? { x: center.x, y: center.y }
        : {
            x: axisStart.x + chosen.direction.x * centerAlong,
            y: axisStart.y + chosen.direction.y * centerAlong,
          }
    const start = {
      x: centerPoint.x - chosen.direction.x * half,
      y: centerPoint.y - chosen.direction.y * half,
    }
    const end = {
      x: centerPoint.x + chosen.direction.x * half,
      y: centerPoint.y + chosen.direction.y * half,
    }

    const dedupeKey = openingKey(chosen.wall.key, centerPoint, candidate.kind)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    openings.push({
      kind: candidate.kind,
      wallKey: chosen.wall.key,
      center: centerPoint,
      direction: chosen.direction,
      width,
      height,
      sill,
      start,
      end,
      preset:
        candidate.kind === 'door'
          ? inferDoorPreset(candidate.blockName, candidate.layer, width)
          : inferWindowPreset(candidate.blockName, candidate.layer, width),
      blockName: candidate.blockName,
      hostAlong: rawAlong,
      blockKey: `${candidate.layer}|${candidate.blockName ?? ''}|${Math.round(work.markCenter.x * 1000)},${Math.round(work.markCenter.y * 1000)}`,
      markSpan: work.markSpan,
    })
  }

  // 输出顺序按墙段键与洞口中心排序，保证同一图纸每次重建结果一致
  const compare = (left: OpeningSpec, right: OpeningSpec): number => {
    if (left.wallKey !== right.wallKey) return left.wallKey < right.wallKey ? -1 : 1
    if (left.center.x !== right.center.x) return left.center.x - right.center.x
    return left.center.y - right.center.y
  }
  openings.sort(compare)
  // 门窗同位置时合成门连窗：必须在排序之后做，结果才与图元顺序无关
  const mergedResult = mergeDoorWindowOpenings(openings, options.wallHeight)
  mergedResult.openings.sort(compare)

  const notes: string[] = []
  if (skipped.length > 0) notes.push(`跳过 ${skipped.length} 个门窗构件，首个原因：${skipped[0].reason}`)
  if (mergedResult.merged > 0) {
    notes.push(`识别到 ${mergedResult.merged} 处门窗同位置，已合成门连窗`)
  }

  return { openings: mergedResult.openings, skipped, notes }
}
