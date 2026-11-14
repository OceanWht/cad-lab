/**
 * 白膜墙上的门识别。
 *
 * 「墙体」与「忽略」图层按白膜墙生成：沿窗线拉一片薄板，没有墙体拓扑，
 * 也就没有 WallPiece 可以挖洞。而施工图里的门块通常正好画在这些墙线上，
 * 主识别（只吸附显式「窗」图层的实体墙）吸附不到它们，界面里就会出现
 * 「选了门却没有门模型」。
 *
 * 这里把白膜墙中心线包装成合成墙段，单独识别一次门：
 * - 命中结果换算成独立的门窗构件，直接交给 buildOpeningGeometry 渲染；
 * - 同时给出白膜墙在各面墙线上的断开区间，以及门顶到墙顶的过梁，
 *   使门洞在白膜墙上真实贯通（双线墙的两片板都要切，否则门会被另一面挡住）；
 * - 只处理显式标记为「门」的图层，实体墙上的门窗分支不受影响。
 */

import type { CadDrawing, CadPoint } from './types'
import {
  recognizeOpenings,
  type OpeningSpec,
} from './doorWindowModel'
import { DEFAULT_MASSING_THICKNESS, type CurtainLine } from './curtainModel'
import {
  collectWallSegmentsLoose,
  openingObjectKey,
  type WallOpeningPlacement,
  type WallSegment,
} from './wallModel'

/** 合成白膜墙段的键前缀：与墙段键、门窗键、幕墙键区分 */
export const MASSING_HOST_PREFIX = '@massing:'

/** 已通过去重判定的中心距（米）：小于它视为同一樘门 */
const DEDUPE_CENTER_DISTANCE = 0.6
/** 去重时允许的宽度差（米） */
const DEDUPE_WIDTH_TOLERANCE = 0.05
/** 门大样的触碰吸附容差（米）：门扇根部落在墙线上就算吸附成功 */
const TOUCH_TOLERANCE = 0.15
/** 门图层里同时画墙线时的最小墙线长度（米）：门扇 / 弧线 / 索引线都短于它 */
const DOOR_LAYER_MIN_WALL_LENGTH = 2.4
/** 门图层里墙线的正交容差（度）：斜向长线多为索引线，不当墙 */
const DOOR_LAYER_MAX_ANGLE = 5
/** 同一道墙两面之间的最大垂距（米）：超过它视为另一道墙 */
const FACE_MAX_GAP = 0.35
/** 墙线平行判定容差（度） */
const FACE_PARALLEL_ANGLE = 10
/**
 * 门构件与洞壁之间的安装缝（米）。
 *
 * 门套外沿与切开的墙垛端面、门套上槛与过梁底面如果正好共面，
 * 两块面片的深度值相同，渲染时就会交替胜出，表现为泛白闪烁。
 * 门构件四周统一内缩该值，留出可见缝隙即可彻底消除。
 */
const DOOR_CLEARANCE = 0.005

/** 一条白膜墙中心线及其对象键（图纸坐标） */
export interface MassingHostLine {
  /** 白膜墙中心线（图纸坐标） */
  line: CurtainLine
  /** 该中心线的对象键（`@curtain:` 前缀），也是删除集合里记录的键 */
  key: string
}

/** 一樘门在一条白膜墙线上断开的区间 */
export interface MassingDoorCut {
  /** 该白膜墙线的对象键，也是删除集合里记录的键 */
  hostKey: string
  /** 断开区间（图纸坐标，落在该墙线上） */
  line: CurtainLine
  /** 该墙线相对门洞中心的法向有向距离（米），用于门构件的墙厚带定位 */
  offset: number
}

/** 门顶过梁：门洞上方补回的白膜墙 */
export interface MassingDoorLintel {
  hostKey: string
  line: CurtainLine
  base: number
  height: number
}

/** 落在白膜墙上的门 */
export interface MassingDoor {
  /** 主宿主白膜墙对象键：删除该白膜墙段时门一并消失 */
  hostKey: string
  /** 门洞口（米，落在白膜中心线上） */
  spec: OpeningSpec
  /** 可直接交给 buildOpeningGeometry 渲染的门构件 */
  placement: WallOpeningPlacement
  /**
   * 同一道墙需要断开的全部白膜线。
   *
   * 施工图的双线墙会沿两面各生成一片白膜板；只切门块最近的一面，
   * 另一面仍完整挡在门口，看起来就是「门生成了却看不见」。
   */
  cuts: MassingDoorCut[]
  /** 门顶过梁，与 cuts 一一对应；门顶已到墙顶时为空数组 */
  lintels: MassingDoorLintel[]
}

/** 白膜墙门识别参数 */
export interface MassingDoorOptions {
  /** 显式标记为「门」的图层 */
  doorLayers: readonly string[]
  /** 参与承接门的白膜墙中心线 */
  hostLines: readonly MassingHostLine[]
  /** 主识别已经落地的门（米），用于去重，避免同一樘门生成两次 */
  existingDoors: readonly OpeningSpec[]
  unitScale: number
  /** 单层墙高（米） */
  wallHeight: number
  doorWidth?: number
  doorHeight?: number
}

/** 白膜墙门识别结果 */
export interface MassingDoorResult {
  doors: MassingDoor[]
  /** 被跳过的门构件数（吸附失败 / 尺寸超出），用于界面统计 */
  skipped: number
  /** 直接展示给用户的中文说明 */
  notes: string[]
}

/** 一条墙线在米制下的起点、单位方向与长度 */
interface MetricHostLine {
  a: CadPoint
  u: CadPoint
  length: number
}

/** 把白膜中心线换算成米制；零长度线返回 null（没有几何意义，不参与判定） */
function metricHostLine(line: CurtainLine, unitScale: number): MetricHostLine | null {
  const ax = line.a.x * unitScale
  const ay = line.a.y * unitScale
  const bx = line.b.x * unitScale
  const by = line.b.y * unitScale
  const length = Math.hypot(bx - ax, by - ay)
  if (!(length > 0)) return null
  return { a: { x: ax, y: ay }, u: { x: (bx - ax) / length, y: (by - ay) / length }, length }
}

/** 与门洞同属一道墙的一片白膜墙线 */
interface MassingFace {
  /** 该白膜墙线的对象键 */
  hostKey: string
  /** 墙线相对门洞中心的法向有向距离（米），主宿主为 0 */
  offset: number
  /** 该墙线的完整中心线（图纸坐标） */
  line: CurtainLine
}

/** 把门洞起止点投影到一条墙线上，得到该线自己的断开区间（图纸坐标） */
function intervalOnLine(
  line: CurtainLine,
  start: CadPoint,
  end: CadPoint,
  unitScale: number,
): CurtainLine {
  const metric = metricHostLine(line, unitScale)
  if (metric === null) throw new Error('白膜墙线长度为零，无法投影门洞区间')
  const { a, u } = metric
  const t0 = (start.x - a.x) * u.x + (start.y - a.y) * u.y
  const t1 = (end.x - a.x) * u.x + (end.y - a.y) * u.y
  const low = Math.min(t0, t1)
  const high = Math.max(t0, t1)
  return {
    a: { x: line.a.x + (u.x * low) / unitScale, y: line.a.y + (u.y * low) / unitScale },
    b: { x: line.a.x + (u.x * high) / unitScale, y: line.a.y + (u.y * high) / unitScale },
  }
}

/**
 * 找出与门洞同属一道墙的全部白膜线。
 *
 * 判定条件同时满足才算同一道墙：
 * - 与门洞方向平行（夹角 ≤ FACE_PARALLEL_ANGLE）；
 * - 门洞中心到墙线的法向距离 ≤ FACE_MAX_GAP，超过它属于另一道墙；
 * - 门洞区间与该墙线区间有重叠（墙线是穿过洞口的那片板，才需要切断）。
 *
 * 墙线可以短于洞口宽度：墙体在洞口处断开时，两侧墙垛各只有一小段，
 * 只要洞口与它相交就要切，否则门会被墙垛挡住。
 *
 * `offset` 是墙线相对门洞中心的法向有向距离，主宿主恒为 0，
 * 双线墙的另一面约为 ±(墙厚 - 板厚)，用来把门构件放到墙厚带中间。
 */
function massingDoorFaces(
  spec: OpeningSpec,
  hostLines: readonly MassingHostLine[],
  unitScale: number,
): MassingFace[] {
  const sinParallel = Math.sin((FACE_PARALLEL_ANGLE * Math.PI) / 180)
  // 法线取门洞方向左转 90°，与墙线自身 a→b 的方向无关，保证 offset 符号一致
  const nx = -spec.direction.y
  const ny = spec.direction.x
  const half = spec.width / 2
  const faces: MassingFace[] = []
  const seen = new Set<string>()
  for (const host of hostLines) {
    if (seen.has(host.key)) continue
    const metric = metricHostLine(host.line, unitScale)
    if (metric === null) continue
    const { a, u, length } = metric
    if (Math.abs(u.x * spec.direction.y - u.y * spec.direction.x) > sinParallel) continue
    const offset = (a.x - spec.center.x) * nx + (a.y - spec.center.y) * ny
    if (Math.abs(offset) > FACE_MAX_GAP) continue
    // 门洞区间在墙线轴上的投影：与墙线区间不相交则不参与切墙
    const along = (spec.center.x - a.x) * u.x + (spec.center.y - a.y) * u.y
    if (along + half <= 1e-6 || along - half >= length - 1e-6) continue
    seen.add(host.key)
    faces.push({ hostKey: host.key, offset, line: host.line })
  }
  return faces
}

/**
 * 识别落在白膜墙上的门。
 *
 * 门的位置严格取门图层里构件图元的位置：识别阶段打开 exactPlacement，
 * 洞口中心不再被夹进墙段，宽度也不因墙段短而跳过。
 * 施工图把墙体在洞口处断开时，门块正落在洞口里，直接照图定位即可，
 * 不需要（也不能）再用墙段空隙去猜洞口。
 *
 * 白膜墙按 `DEFAULT_MASSING_THICKNESS` 作为合成墙厚参与吸附判定：
 * 门块中心到白膜中心线的距离超过「半墙厚 + 吸附余量」时计入跳过，
 * 与实体墙上的门使用同一套判定标准。
 */
export function recognizeMassingDoors(
  drawing: CadDrawing,
  options: MassingDoorOptions,
): MassingDoorResult {
  const doors: MassingDoor[] = []
  const notes: string[] = []
  const doorLayers = [...new Set(options.doorLayers)]
  if (doorLayers.length === 0) return { doors, skipped: 0, notes }
  if (!(options.unitScale > 0)) throw new Error('单位换算比例必须为正数')
  if (!(options.wallHeight > 0)) throw new Error('墙高必须为正数')
  if (options.hostLines.length === 0) {
    notes.push('标记为「门」的图层没有可吸附的白膜墙：请勾选承载门的墙体图层后再生成。')
    return { doors, skipped: 0, notes }
  }

  const layerKinds: Record<string, 'door'> = {}
  for (const layer of doorLayers) layerKinds[layer] = 'door'

  // 合成墙段沿用图纸坐标（recognizeOpenings 内部统一乘 unitScale），
  // 键由宿主对象键派生，重建后保持稳定
  const hosts: WallSegment[] = options.hostLines.map((host) => ({
    a: { x: host.line.a.x, y: host.line.a.y },
    b: { x: host.line.b.x, y: host.line.b.y },
    layer: '白膜墙',
    thickness: DEFAULT_MASSING_THICKNESS,
    key: `${MASSING_HOST_PREFIX}${host.key}`,
  }))

  const recognition = recognizeOpenings(drawing, {
    layerKinds,
    walls: hosts,
    unitScale: options.unitScale,
    wallHeight: options.wallHeight,
    doorWidth: options.doorWidth,
    doorHeight: options.doorHeight,
    // 门扇垂直展开的大样块心会偏离墙线，只要图元碰到白膜墙线就允许吸附
    touchTolerance: TOUCH_TOLERANCE,
    // 白膜墙按窗线逐点拆段，门块旁常有一条 0.1~0.2m 的墙端碎段：
    // 只取最近墙会被碎段吸住并因「洞口宽超过墙段长」跳过，这里按距离依次尝试
    avoidShortHosts: true,
    // 严格按门块图元所在位置开洞：洞口中心不夹进墙段，也不因墙段短而跳过
    exactPlacement: true,
  })

  for (const recognized of recognition.openings) {
    if (!recognized.wallKey.startsWith(MASSING_HOST_PREFIX)) continue
    const hostKey = recognized.wallKey.slice(MASSING_HOST_PREFIX.length)
    // 门的位置就是门块在图纸上的位置，这里不再改写洞口
    const spec = recognized

    // 主识别已经落地的同一樘门直接跳过，避免重复建模：
    // 同一个门块可能同时被实体墙分支和白膜墙分支吸到不同的墙上，
    // 两樘门叠在一起就会看起来像门套从墙里折出来，所以优先按块来源判定
    const duplicated = options.existingDoors.some(
      (door) =>
        (door.blockKey !== undefined &&
          spec.blockKey !== undefined &&
          door.blockKey === spec.blockKey) ||
        (Math.hypot(door.center.x - spec.center.x, door.center.y - spec.center.y) <
          DEDUPE_CENTER_DISTANCE &&
          Math.abs(door.width - spec.width) < DEDUPE_WIDTH_TOLERANCE),
    )
    if (duplicated) continue

    // 主宿主墙线始终参与开洞：洞口区间由米换算回图纸坐标
    const primary: MassingDoorCut = {
      hostKey,
      offset: 0,
      line: {
        a: { x: spec.start.x / options.unitScale, y: spec.start.y / options.unitScale },
        b: { x: spec.end.x / options.unitScale, y: spec.end.y / options.unitScale },
      },
    }
    // 同一道墙的另一面（双线墙）同步开洞，否则门会被另一片白膜板挡住
    const faces = massingDoorFaces(spec, options.hostLines, options.unitScale)
    const cuts: MassingDoorCut[] = [
      primary,
      ...faces
        .filter((face) => face.hostKey !== hostKey)
        .map((face) => ({
          hostKey: face.hostKey,
          offset: face.offset,
          line: intervalOnLine(face.line, spec.start, spec.end, options.unitScale),
        })),
    ]
    // 门构件放在墙厚带中间：只有一面墙时仍在原中心线上，厚度不小于默认白膜墙厚
    let minOffset = 0
    let maxOffset = 0
    for (const face of faces) {
      if (face.offset < minOffset) minOffset = face.offset
      if (face.offset > maxOffset) maxOffset = face.offset
    }
    const bandCenter =
      spec.markSpan !== undefined
        ? // 双面标记合并后，洞口中心本来就是这道墙的中心线：faces 只找到一面墙线时
          // 再按 (minOffset+maxOffset)/2 偏移，会把门套推到贴着那一面、另一面穿出墙外，
          // 看起来就是门和墙体重合。此时固定居中。
          0
        : (minOffset + maxOffset) / 2
    // 白膜板各自沿中心线拉 DEFAULT_MASSING_THICKNESS 厚，双线墙的两块板外表面间距
    // 是「中心线间距 + 一个板厚」。门套必须盖满这个间距，否则会陷进板缝里，
    // 或者反过来顶穿墙面，看起来像门套从墙里折出来。
    // 墙体在洞口处断开时两面墙线可能都没落在洞口区间里，此时用两个门块的块心距当墙厚。
    const faceSpan = maxOffset - minOffset
    const wallSpan =
      spec.markSpan !== undefined && spec.markSpan > faceSpan ? spec.markSpan : faceSpan
    const bandThickness = wallSpan + DEFAULT_MASSING_THICKNESS
    const nx = -spec.direction.y
    const ny = spec.direction.x
    const lintelHeight = options.wallHeight - spec.height
    doors.push({
      hostKey,
      spec,
      placement: {
        key: openingObjectKey(spec),
        // 宿主是合成白膜墙段：渲染不依赖 WallPiece，只用于语义归属
        wallKey: spec.wallKey,
        kind: 'door',
        center: {
          x: spec.center.x + nx * bandCenter,
          y: spec.center.y + ny * bandCenter,
        },
        direction: spec.direction,
        // 门套四周内缩安装缝，避免与洞壁、过梁底面共面闪烁
        width: spec.width - DOOR_CLEARANCE * 2,
        height: spec.height - DOOR_CLEARANCE,
        sill: spec.sill,
        thickness: bandThickness,
        preset: spec.preset,
      },
      cuts,
      // 门顶正好到墙顶时没有可补的过梁
      lintels:
        lintelHeight > 1e-6
          ? cuts.map((cut) => ({
              hostKey: cut.hostKey,
              line: cut.line,
              base: spec.height,
              height: lintelHeight,
            }))
          : [],
    })
  }

  if (doors.length > 0) {
    notes.push(
      `门图层在白膜墙上生成 ${doors.length} 樘门：位置按门图层图元解析，白膜墙沿门洞断开、门顶按过梁补墙。`,
    )
    // 双线墙在两个面上各画一个门块是常见画法，两块合并成一樘，数量才对得上图纸
    const merged = doors.filter((door) => door.spec.markSpan !== undefined).length
    if (merged > 0) {
      notes.push(`其中 ${merged} 樘门在双线墙两面各标一次，已按两面中点合并为一樘。`)
    }
  } else if (recognition.openings.length === 0 && recognition.skipped.length === 0) {
    // 图层标了「门」却一个构件都没找到：多半是门块不在这些图层上，或图层里只有块定义
    notes.push('标记为「门」的图层里没有识别到门窗图元：请确认门块画在这些图层上。')
  }
  if (recognition.skipped.length > 0) {
    // 把跳过原因直接写进提示，避免「选了门却没有门模型」无从排查
    const reasons = [...new Set(recognition.skipped.map((item) => item.reason))].slice(0, 3)
    notes.push(
      `另有 ${recognition.skipped.length} 个门构件未吸附到白膜墙，已跳过（${reasons.join('；')}）。`,
    )
  }
  return { doors, skipped: recognition.skipped.length, notes }
}

/**
 * 门图层里同时画墙线时的墙体中心线。
 *
 * 有些图纸把门块直接插在墙线上（甚至整个平面只有一个图层），用户把这个图层标成「门」后，
 * 整层都会从墙体图层里排除，墙和门一起消失。这里把该图层里**够长且接近正交**的线
 * 当作墙线补成白膜墙：门扇（0.7~1.8m）、开启弧线、索引线都短于最小长度或斜向，不会误当墙。
 */
export function doorLayerWallLines(
  drawing: CadDrawing,
  layerNames: readonly string[],
  unitScale: number,
): { lines: CurtainLine[]; skipped: number } {
  const lines: CurtainLine[] = []
  if (layerNames.length === 0) return { lines, skipped: 0 }
  if (!(unitScale > 0)) throw new Error('单位换算比例必须为正数')
  const sinAngle = Math.sin((DOOR_LAYER_MAX_ANGLE * Math.PI) / 180)
  let skipped = 0
  for (const segment of collectWallSegmentsLoose(drawing, [...layerNames])) {
    const dx = (segment.b.x - segment.a.x) * unitScale
    const dy = (segment.b.y - segment.a.y) * unitScale
    const length = Math.hypot(dx, dy)
    const axisAligned = length > 0 && Math.min(Math.abs(dx), Math.abs(dy)) / length <= sinAngle
    if (length < DOOR_LAYER_MIN_WALL_LENGTH || !axisAligned) {
      skipped += 1
      continue
    }
    lines.push({ a: { x: segment.a.x, y: segment.a.y }, b: { x: segment.b.x, y: segment.b.y } })
  }
  return { lines, skipped }
}

/** 判断一樘白膜墙上的门在当前删除集下是否仍然保留 */
export function keepMassingDoor(
  door: MassingDoor,
  removed: ReadonlySet<string>,
): boolean {
  if (removed.has(door.hostKey)) return false
  if (door.placement.key !== undefined && removed.has(door.placement.key)) return false
  return true
}

/**
 * 当前删除集下的白膜墙门洞切割区间，按宿主对象键归组。
 * 每条白膜中心线只接受自己的洞口，避免平行墙线上相同区间被误切。
 */
export function massingDoorCuts(
  doors: readonly MassingDoor[],
  removed: ReadonlySet<string>,
): Map<string, CurtainLine[]> {
  const cuts = new Map<string, CurtainLine[]>()
  for (const door of doors) {
    if (!keepMassingDoor(door, removed)) continue
    for (const cut of door.cuts) {
      const list = cuts.get(cut.hostKey)
      if (list) list.push(cut.line)
      else cuts.set(cut.hostKey, [cut.line])
    }
  }
  return cuts
}

/**
 * 当前删除集下的门顶过梁，按「起始标高 + 高度」归组。
 * 同组过梁可以一次建成一份几何，避免每樘门单独建一份。
 */
export function massingDoorLintels(
  doors: readonly MassingDoor[],
  removed: ReadonlySet<string>,
): Array<{ base: number; height: number; lines: CurtainLine[] }> {
  const groups = new Map<string, { base: number; height: number; lines: CurtainLine[] }>()
  for (const door of doors) {
    if (!keepMassingDoor(door, removed)) continue
    for (const lintel of door.lintels) {
      const groupKey = `${lintel.base}|${lintel.height}`
      const group = groups.get(groupKey)
      if (group) group.lines.push(lintel.line)
      else groups.set(groupKey, { base: lintel.base, height: lintel.height, lines: [lintel.line] })
    }
  }
  return [...groups.values()]
}
