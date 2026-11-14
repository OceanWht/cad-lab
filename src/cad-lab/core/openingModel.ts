/**
 * 门窗构件程序化建模与语义解析。
 *
 * 与早期版本相比，这里不再把门窗当成「一个框 + 一块板」，而是按成品门窗的构造拆成
 * 可序列化的语义配置后再生成几何：
 * - 门：门套（门樘 / 上槛 / 双面贴脸）、门槛、门扇（边梃 + 上中下横档 + 面板 / 玻璃分格）、
 *   五金（执手 / 拉手 / 推杠 / 门锁把手、闭门器、踢脚板）、门头亮子；
 * - 窗：外框、竖中梃与横中梃分格、可开启扇内框、双层中空玻璃、窗台板、百叶窗叶片。
 *
 * 语义字段与主工程 webmap 的室内成品门 / 立面窗参数保持同名同义：
 * - `DoorOpeningConfig` 对应 `IndoorDoorConfig`（preset / leafWidth / leafHeight / sillHeight /
 *   frame / leaf / glazing / hardware / transom）；
 * - `WindowOpeningConfig` 对应立面窗档案（sillHeight / mullionWidth / columns / rows /
 *   glassThickness / sillBoard）。
 *
 * 坐标约定与墙体一致：局部 (x, y=高度, z=图纸 y)，洞口底标高即 `sill`。
 * 门窗平面按「沿墙方向 U / 竖向 V / 墙法线 W」构造右手基，因此任意朝向的墙都能贴合。
 */

import * as THREE from 'three'
import type { OpeningWindowPart, WallOpeningPlacement } from './wallModel'

/** 材质组：0 框料 / 1 门扇 / 2 玻璃 / 3 五金 */
export const OPENING_FRAME_GROUP = 0
export const OPENING_LEAF_GROUP = 1
export const OPENING_GLASS_GROUP = 2
export const OPENING_HARDWARE_GROUP = 3

/** 门型预设：与 webmap `IndoorDoorPreset` 完全一致 */
export type DoorPreset =
  | 'wood_single'
  | 'wood_double'
  | 'wood_arch'
  | 'glass_single'
  | 'glass_double'
  | 'glass_sliding'
  | 'steel_fire'
  | 'security_steel'
  | 'louver'

/** 窗型预设：对齐立面窗的常见做法 */
export type WindowPreset = 'casement_single' | 'casement_double' | 'sliding' | 'fixed' | 'louver'

/** 门套截面：与 webmap `IndoorDoorFrameKind` 一致 */
export type DoorFrameKind = 'casing' | 'flush' | 'steel' | 'aluminum'
/** 门扇面板：与 webmap `IndoorDoorPanelKind` 一致 */
export type DoorPanelKind = 'flat' | 'raised' | 'louver' | 'glass' | 'arch'
/** 玻璃分布：与 webmap `IndoorDoorGlazingMode` 一致 */
export type DoorGlazingMode = 'none' | 'upper' | 'full' | 'lites'
/** 五金把手：与 webmap `IndoorDoorHandleKind` 一致 */
export type DoorHandleKind = 'lever' | 'pull' | 'bar' | 'knob'

/** 材质组颜色（与预览、导出共用，避免两处口径） */
export const OPENING_FRAME_COLOR = 0x6b5a4b
export const OPENING_LEAF_COLOR = 0xa9764a
export const OPENING_GLASS_COLOR = 0x9fc4d8
export const OPENING_HARDWARE_COLOR = 0xb9bcc0

/**
 * 框料正面相对墙面的内缩量（米）。
 *
 * 门套 / 窗框必须整体藏在洞口内：一旦框料比墙厚、凸出到墙面以外，
 * 洞口四周就会多出一圈悬空的薄边，斜视时与墙面、贴脸挤在几毫米的深度范围里，
 * 既像「门框穿出墙体」，又会因为近似共面而在屏幕上拉出细条纹。
 */
const FRAME_RECESS = 0.002
/** 门扇与门套的安装缝（米） */
const DOOR_LEAF_GAP = 0.006
/** 贴脸板 / 窗台板总厚度（米），其中一部分埋进墙面 */
const CASING_BOARD = 0.011
/** 贴脸板 / 窗台板埋入墙面的深度（米），使其不再与墙面共面 */
const CASING_EMBED = 0.003
/** 贴脸板向洞口内侧压住的宽度（米），用于盖住框料正面与洞口的接缝 */
const CASING_OVERLAP = 0.003
/** 玻璃四周的安装缝（米） */
const GLASS_GAP = 0.012
/** 门扇面板内嵌深度（米） */
const PANEL_THICKNESS = 0.02
/** 门扇面板外凸装饰（米） */
const PANEL_RAISE = 0.008
/** 分格条宽度（米） */
const MUNTIN_WIDTH = 0.02
/** 门窗常规最大门扇高度（米），超过时自动加门头亮子 */
const MAX_LEAF_HEIGHT = 2.2
/** 门头亮子的最大高度（米） */
const MAX_TRANSOM_HEIGHT = 0.4

type Vec3 = [number, number, number]

/** 把一个定向长方体（中心 + 三个半轴）写入顶点数组；u/v/w 必须是右手基 */
export function pushBox(target: number[], center: Vec3, u: Vec3, v: Vec3, w: Vec3, half: Vec3): void {
  const corner = (a: boolean, b: boolean, c: boolean): Vec3 => {
    const sa = a ? half[0] : -half[0]
    const sb = b ? half[1] : -half[1]
    const sc = c ? half[2] : -half[2]
    return [
      center[0] + u[0] * sa + v[0] * sb + w[0] * sc,
      center[1] + u[1] * sa + v[1] * sb + w[1] * sc,
      center[2] + u[2] * sa + v[2] * sb + w[2] * sc,
    ]
  }
  const quad = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): void => {
    target.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3)
  }
  // 六个面均按外法线绕序（u/v/w 构成右手基：u×v=w、v×w=u、w×u=v）
  quad(corner(true, true, true), corner(true, false, true), corner(true, false, false), corner(true, true, false))
  quad(corner(false, true, true), corner(false, true, false), corner(false, false, false), corner(false, false, true))
  quad(corner(true, true, true), corner(true, true, false), corner(false, true, false), corner(false, true, true))
  quad(corner(true, false, true), corner(false, false, true), corner(false, false, false), corner(true, false, false))
  quad(corner(true, true, true), corner(false, true, true), corner(false, false, true), corner(true, false, true))
  quad(corner(true, true, false), corner(true, false, false), corner(false, false, false), corner(false, true, false))
}

/** 洞口局部基：U 沿墙、V 竖向、W 墙法线 */
interface OpeningBasis {
  u: Vec3
  v: Vec3
  w: Vec3
  /** 洞口中心（底标高为 0，高度由 y 单独叠加） */
  origin: Vec3
  /** 墙厚（米） */
  thickness: number
  /** 洞口底标高（米） */
  sill: number
}

/** 由洞口位置构造局部基 */
function basisOf(placement: WallOpeningPlacement): OpeningBasis {
  return {
    u: [placement.direction.x, 0, placement.direction.y],
    v: [0, 1, 0],
    // W = U × V，保证右手基
    w: [placement.direction.y, 0, -placement.direction.x],
    origin: [placement.center.x, placement.sill, placement.center.y],
    thickness: placement.thickness,
    sill: placement.sill,
  }
}

/** 局部坐标 (s 沿墙, y 竖向, d 墙法线) → 世界局部坐标 */
function pointAt(basis: OpeningBasis, s: number, y: number, d: number): Vec3 {
  return [
    basis.origin[0] + basis.u[0] * s + basis.w[0] * d,
    basis.origin[1] + y,
    basis.origin[2] + basis.u[2] * s + basis.w[2] * d,
  ]
}

/**
 * 在洞口局部坐标里放一个长方体。
 * @param s 沿墙方向中心（以洞口中心为 0）
 * @param y 竖向中心（以洞口底为 0）
 * @param d 墙法线方向中心（以墙中心为 0）
 */
function pushLocalBox(
  target: number[],
  basis: OpeningBasis,
  s: number,
  y: number,
  d: number,
  halfS: number,
  halfY: number,
  halfD: number,
): void {
  pushBox(target, pointAt(basis, s, y, d), basis.u, basis.v, basis.w, [halfS, halfY, halfD])
}

/** 门构件配置：字段与 webmap `IndoorDoorConfig` 同名同义 */
export interface DoorOpeningConfig {
  preset: DoorPreset
  /** 洞口总宽（米，派生只读） */
  width: number
  /** 洞口总高（米，派生只读） */
  height: number
  /** 门扇净宽（米，权威值） */
  leafWidth: number
  /** 门扇净高（米，权威值） */
  leafHeight: number
  /** 门槛高（米） */
  sillHeight: number
  frame: {
    kind: DoorFrameKind
    /** 门套正面宽（米） */
    width: number
    /** 门套进深（米，随墙厚） */
    depth: number
    /** 贴脸外挑宽（米） */
    casingWidth: number
  }
  leaf: {
    kind: 'single' | 'double'
    panel: DoorPanelKind
    thickness: number
    stileWidth: number
    railWidth: number
  }
  glazing: {
    mode: DoorGlazingMode
    cols: number
    rows: number
    inset: number
  }
  hardware: {
    handle: DoorHandleKind
    closer: boolean
    kickPlate: boolean
  }
  /** 门头亮子高（米），0 表示无亮子 */
  transomHeight: number
  /** 门扇在洞口内的占位（相对洞口中心，米）：门连窗时门扇只占一侧 */
  doorSpan: { start: number; end: number }
  /** 门连窗中的窗部分；缺省表示整个洞口都是门 */
  windowPart?: OpeningWindowPart
  /** 确定性种子 */
  seed: number
}

/** 窗构件配置：字段与 webmap 立面窗档案同名同义 */
export interface WindowOpeningConfig {
  preset: WindowPreset
  width: number
  height: number
  /** 窗台高（米，洞口底标高） */
  sillHeight: number
  frame: {
    /** 边框正面宽（米） */
    width: number
    /** 边框进深（米，随墙厚） */
    depth: number
  }
  /** 中梃正面宽（米） */
  mullionWidth: number
  /** 竖向分格数 */
  columns: number
  /** 横向分格数 */
  rows: number
  /** 是否带可开启扇 */
  operable: boolean
  glazing: {
    /** 单层玻璃厚度（米） */
    thickness: number
    /** 玻璃层数：1 单玻 / 2 中空双玻 */
    layers: 1 | 2
  }
  /** 窗台板外挑（米），0 表示无窗台板 */
  sillBoardDepth: number
  /** 确定性种子 */
  seed: number
}

/** 洞口顶点分桶：每个桶对应一种材质 */
export interface OpeningVertexBuckets {
  frame: number[]
  leaf: number[]
  glass: number[]
  hardware: number[]
}

/** 数值钳制：在 normalize 阶段显式完成，不用于掩盖非法输入 */
function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/** 由预设与洞口尺寸确定门套截面宽 */
function doorFrameWidth(preset: DoorPreset): number {
  if (preset === 'steel_fire' || preset === 'security_steel') return 0.09
  if (preset === 'wood_arch') return 0.07
  if (preset === 'glass_single' || preset === 'glass_double' || preset === 'glass_sliding') return 0.05
  return 0.06
}

/** 由预设确定门套截面类型 */
function doorFrameKind(preset: DoorPreset): DoorFrameKind {
  if (preset === 'steel_fire' || preset === 'security_steel') return 'steel'
  if (preset === 'glass_single' || preset === 'glass_double' || preset === 'glass_sliding') return 'aluminum'
  if (preset === 'louver') return 'flush'
  return 'casing'
}

/** 由预设确定门扇面板做法 */
function doorPanelKind(preset: DoorPreset): DoorPanelKind {
  if (preset === 'louver') return 'louver'
  if (preset === 'wood_arch') return 'arch'
  if (preset === 'glass_single' || preset === 'glass_double' || preset === 'glass_sliding') return 'glass'
  if (preset === 'steel_fire' || preset === 'security_steel') return 'flat'
  return 'raised'
}

/** 由预设确定玻璃分布 */
function doorGlazingMode(preset: DoorPreset): DoorGlazingMode {
  if (preset === 'glass_single' || preset === 'glass_double' || preset === 'glass_sliding') return 'full'
  if (preset === 'wood_arch') return 'upper'
  return 'none'
}

/** 由预设确定五金把手 */
function doorHandleKind(preset: DoorPreset): DoorHandleKind {
  if (preset === 'glass_single' || preset === 'glass_double' || preset === 'glass_sliding') return 'pull'
  if (preset === 'steel_fire') return 'bar'
  return 'lever'
}

/** 把用户/界面传入的预设字符串收敛到合法门型 */
function normalizeDoorPreset(preset: string | undefined, width: number): DoorPreset {
  const allowed: DoorPreset[] = [
    'wood_single',
    'wood_double',
    'wood_arch',
    'glass_single',
    'glass_double',
    'glass_sliding',
    'steel_fire',
    'security_steel',
    'louver',
  ]
  if (preset && (allowed as string[]).includes(preset)) return preset as DoorPreset
  return width >= 1.5 ? 'wood_double' : 'wood_single'
}

/** 把用户/界面传入的预设字符串收敛到合法窗型 */
function normalizeWindowPreset(preset: string | undefined, width: number): WindowPreset {
  const allowed: WindowPreset[] = ['casement_single', 'casement_double', 'sliding', 'fixed', 'louver']
  if (preset && (allowed as string[]).includes(preset)) return preset as WindowPreset
  return width >= 2.4 ? 'casement_double' : 'casement_single'
}

/**
 * 由洞口宽度与窗段位置界定门扇占位。
 *
 * 门连窗时门与窗沿墙并排，门扇占用洞口里较宽的一侧，较窄的一侧留给窗；
 * 没有窗段时门占整个洞口。窗段落在洞口之外属于识别阶段的数据错误，直接报错。
 */
function resolveDoorSpan(
  width: number,
  windowPart: OpeningWindowPart | undefined,
): { start: number; end: number } {
  const left = -width / 2
  const right = width / 2
  if (!windowPart) return { start: left, end: right }
  if (windowPart.start < left - 1e-6 || windowPart.end > right + 1e-6) {
    throw new Error(
      `门连窗的窗段 [${windowPart.start.toFixed(3)}, ${windowPart.end.toFixed(3)}] 超出洞口 [${left.toFixed(3)}, ${right.toFixed(3)}]`,
    )
  }
  const leftWidth = windowPart.start - left
  const rightWidth = right - windowPart.end
  if (!(leftWidth > 0) && !(rightWidth > 0)) throw new Error('门连窗没有可用的门扇区段')
  return leftWidth >= rightWidth
    ? { start: left, end: windowPart.start }
    : { start: windowPart.end, end: right }
}

/**
 * 解析门构件配置。
 *
 * 洞口总宽 / 总高是墙体开洞的权威值；门扇净尺寸由门扇区段减去门套、安装缝与亮子派生，
 * 因此不会出现「门扇比洞口大」的非法组合。门连窗时门扇只占一侧，另一侧由窗构件填充。
 */
export function resolveDoorConfig(placement: WallOpeningPlacement): DoorOpeningConfig {
  const windowPart = placement.windowPart
  const doorSpan = resolveDoorSpan(placement.width, windowPart)
  const doorWidth = doorSpan.end - doorSpan.start
  const preset = normalizeDoorPreset(placement.preset, doorWidth)
  const frameWidth = doorFrameWidth(preset)
  const frameKind = doorFrameKind(preset)
  const isDouble = preset === 'wood_double' || preset === 'glass_double' || doorWidth >= 1.5
  const leafThickness =
    preset === 'security_steel' ? 0.065 : preset === 'steel_fire' ? 0.055 : preset === 'glass_single' || preset === 'glass_double' || preset === 'glass_sliding' ? 0.05 : 0.045
  const innerHeight = placement.height - frameWidth * 2
  const transomHeight = placement.transom
    ? clampNumber(placement.height - frameWidth * 2 - placement.transom.sill, 0, innerHeight)
    : innerHeight - MAX_LEAF_HEIGHT > MAX_TRANSOM_HEIGHT
      ? MAX_TRANSOM_HEIGHT
      : innerHeight - MAX_LEAF_HEIGHT > 0
        ? clampNumber(innerHeight - MAX_LEAF_HEIGHT, 0, MAX_TRANSOM_HEIGHT)
        : 0
  // 有亮子时门扇高度再扣掉一道亮子横档；门槛抬高部分同样要从门扇净高里扣掉
  const leafHeight =
    innerHeight - transomHeight - (transomHeight > 0 ? frameWidth : 0) - placement.sill - DOOR_LEAF_GAP * 2
  const innerWidth = doorWidth - frameWidth * 2
  const leafWidth = isDouble ? (innerWidth - DOOR_LEAF_GAP * 3) / 2 : innerWidth - DOOR_LEAF_GAP * 2
  const seed =
    Math.round(placement.width * 1000) * 131 + Math.round(placement.height * 1000) * 17 + preset.length * 7

  return {
    preset,
    width: placement.width,
    height: placement.height,
    leafWidth,
    leafHeight,
    sillHeight: placement.sill,
    frame: {
      kind: frameKind,
      width: frameWidth,
      depth: placement.thickness,
      casingWidth: frameKind === 'steel' ? 0.04 : frameKind === 'aluminum' ? 0.02 : 0.05,
    },
    leaf: {
      kind: isDouble ? 'double' : 'single',
      panel: doorPanelKind(preset),
      thickness: leafThickness,
      stileWidth: preset === 'security_steel' ? 0.12 : 0.1,
      railWidth: preset === 'steel_fire' || preset === 'security_steel' ? 0.12 : 0.14,
    },
    glazing: {
      mode: doorGlazingMode(preset),
      cols: 1,
      rows: 1,
      inset: 0.012,
    },
    hardware: {
      handle: doorHandleKind(preset),
      closer: preset === 'steel_fire' || preset === 'security_steel',
      kickPlate: preset === 'steel_fire' || preset === 'security_steel',
    },
    transomHeight,
    doorSpan,
    ...(windowPart ? { windowPart } : {}),
    seed,
  }
}

/**
 * 解析窗构件配置。
 *
 * 分格数由洞口尺寸按「单格不超过 1.2m 宽、1.8m 高」推导，
 * 与立面窗按开间自动分格的既有做法一致。
 */
export function resolveWindowConfig(placement: WallOpeningPlacement): WindowOpeningConfig {
  const preset = normalizeWindowPreset(placement.preset, placement.width)
  // 双扇 / 推拉窗至少两格，其余按单格不超过 1.2m 宽推导
  const autoColumns = clampNumber(Math.round(placement.width / 1.2), 1, 4)
  const columns =
    preset === 'casement_double' || preset === 'sliding' ? Math.max(2, autoColumns) : autoColumns
  const rows = clampNumber(Math.round(placement.height / 1.8), 1, 3)
  const operable = preset !== 'fixed' && preset !== 'louver'
  const seed =
    Math.round(placement.width * 1000) * 137 + Math.round(placement.height * 1000) * 19 + preset.length * 5

  return {
    preset,
    width: placement.width,
    height: placement.height,
    sillHeight: placement.sill,
    frame: {
      width: preset === 'sliding' ? 0.05 : 0.06,
      depth: placement.thickness,
    },
    mullionWidth: preset === 'sliding' ? 0.045 : 0.05,
    columns,
    rows,
    operable,
    glazing: {
      // 中空双玻总厚约 20mm（4 + 12 + 4），单玻 6mm
      thickness: 0.006,
      layers: preset === 'sliding' ? 2 : 2,
    },
    sillBoardDepth: placement.sill > 0.05 ? 0.06 : 0,
    seed,
  }
}

/** 玻璃分格：在每个格子里铺玻璃，并补分格条 */
function pushGlazingGrid(
  buckets: OpeningVertexBuckets,
  basis: OpeningBasis,
  options: {
    /** 区域中心（沿墙） */
    s: number
    /** 区域宽（米） */
    width: number
    /** 区域底 / 顶（相对洞口底） */
    y0: number
    y1: number
    cols: number
    rows: number
    /** 单层玻璃厚度 */
    thickness: number
    layers: 1 | 2
    /** 分格条宽（米） */
    muntin: number
    /** 分格条进深（米） */
    barDepth: number
    /** 是否生成分格条 */
    bars: boolean
  },
): void {
  const cols = options.cols
  const rows = options.rows
  const cellWidth = options.width / cols
  const cellHeight = (options.y1 - options.y0) / rows
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const cellS = options.s - options.width / 2 + cellWidth * (col + 0.5)
      const cellY = options.y0 + cellHeight * (row + 0.5)
      const halfS = cellWidth / 2 - GLASS_GAP
      const halfY = cellHeight / 2 - GLASS_GAP
      if (!(halfS > 0) || !(halfY > 0)) continue
      if (options.layers === 1) {
        pushLocalBox(buckets.glass, basis, cellS, cellY, 0, halfS, halfY, options.thickness / 2)
      } else {
        const offset = options.thickness / 2 + 0.006
        pushLocalBox(buckets.glass, basis, cellS, cellY, offset, halfS, halfY, options.thickness / 2)
        pushLocalBox(buckets.glass, basis, cellS, cellY, -offset, halfS, halfY, options.thickness / 2)
      }
    }
  }
  if (!options.bars) return
  // 竖分格条
  for (let col = 1; col < cols; col += 1) {
    const s = options.s - options.width / 2 + cellWidth * col
    pushLocalBox(
      buckets.frame,
      basis,
      s,
      (options.y0 + options.y1) / 2,
      0,
      options.muntin / 2,
      (options.y1 - options.y0) / 2,
      options.barDepth,
    )
  }
  // 横分格条
  for (let row = 1; row < rows; row += 1) {
    const y = options.y0 + cellHeight * row
    pushLocalBox(
      buckets.frame,
      basis,
      options.s,
      y,
      0,
      options.width / 2,
      options.muntin / 2,
      options.barDepth,
    )
  }
}

/** 门扇：边梃 + 上下横档 + 面板 / 玻璃 + 五金 */
function pushDoorLeaf(
  buckets: OpeningVertexBuckets,
  basis: OpeningBasis,
  config: DoorOpeningConfig,
  centerS: number,
  width: number,
  yBottom: number,
  yTop: number,
  withHardware: boolean,
): void {
  const halfS = width / 2
  const halfY = (yTop - yBottom) / 2
  const centerY = (yBottom + yTop) / 2
  const leafHalfD = config.leaf.thickness / 2
  const stile = config.leaf.stileWidth
  const rail = config.leaf.railWidth
  // 边梃
  pushLocalBox(buckets.leaf, basis, centerS - halfS + stile / 2, centerY, 0, stile / 2, halfY, leafHalfD)
  pushLocalBox(buckets.leaf, basis, centerS + halfS - stile / 2, centerY, 0, stile / 2, halfY, leafHalfD)
  // 上下横档
  pushLocalBox(buckets.leaf, basis, centerS, yTop - rail / 2, 0, halfS - stile, rail / 2, leafHalfD)
  pushLocalBox(buckets.leaf, basis, centerS, yBottom + rail / 2, 0, halfS - stile, rail / 2, leafHalfD)

  // 内区：面板 / 玻璃
  const panelS = centerS
  const panelWidth = (halfS - stile) * 2
  const panelBottom = yBottom + rail
  const panelTop = yTop - rail
  const panelHalfS = panelWidth / 2
  const panelHalfY = (panelTop - panelBottom) / 2
  const panelCenterY = (panelBottom + panelTop) / 2
  if (panelHalfS > 0 && panelHalfY > 0) {
    if (config.glazing.mode === 'full') {
      pushGlazingGrid(buckets, basis, {
        s: panelS,
        width: panelWidth,
        y0: panelBottom,
        y1: panelTop,
        cols: config.glazing.cols,
        rows: config.glazing.rows,
        thickness: 0.008,
        layers: 1,
        muntin: MUNTIN_WIDTH,
        barDepth: leafHalfD,
        bars: config.glazing.cols > 1 || config.glazing.rows > 1,
      })
    } else if (config.glazing.mode === 'upper') {
      // 上部 45% 为亮窗，下部为面板
      const split = panelBottom + panelHalfY * 2 * 0.55
      pushGlazingGrid(buckets, basis, {
        s: panelS,
        width: panelWidth,
        y0: split,
        y1: panelTop,
        cols: config.glazing.cols,
        rows: config.glazing.rows,
        thickness: 0.008,
        layers: 1,
        muntin: MUNTIN_WIDTH,
        barDepth: leafHalfD,
        bars: false,
      })
      pushLocalBox(
        buckets.leaf,
        basis,
        panelS,
        (panelBottom + split) / 2,
        0,
        panelHalfS,
        (split - panelBottom) / 2,
        PANEL_THICKNESS / 2,
      )
    } else if (config.glazing.mode === 'lites') {
      pushGlazingGrid(buckets, basis, {
        s: panelS,
        width: panelWidth,
        y0: panelBottom,
        y1: panelTop,
        cols: config.glazing.cols,
        rows: config.glazing.rows,
        thickness: 0.008,
        layers: 1,
        muntin: MUNTIN_WIDTH,
        barDepth: leafHalfD,
        bars: true,
      })
    } else if (config.leaf.panel === 'louver') {
      // 百叶：固定条数的水平叶片
      const slatCount = 7
      const slatHeight = (panelHalfY * 2) / (slatCount * 1.6)
      for (let index = 0; index < slatCount; index += 1) {
        const y = panelBottom + ((index + 0.5) * (panelTop - panelBottom)) / slatCount
        pushLocalBox(buckets.leaf, basis, panelS, y, 0, panelHalfS, slatHeight, leafHalfD * 0.6)
      }
    } else if (config.leaf.panel === 'glass') {
      pushLocalBox(buckets.glass, basis, panelS, panelCenterY, 0, panelHalfS, panelHalfY, 0.004)
    } else {
      // 平板 / 凸板：凸板在两侧各外挑一层装饰面
      pushLocalBox(buckets.leaf, basis, panelS, panelCenterY, 0, panelHalfS, panelHalfY, PANEL_THICKNESS / 2)
      if (config.leaf.panel === 'raised' || config.leaf.panel === 'arch') {
        const inset = 0.035
        if (panelHalfS > inset && panelHalfY > inset) {
          pushLocalBox(
            buckets.leaf,
            basis,
            panelS,
            panelCenterY,
            0,
            panelHalfS - inset,
            panelHalfY - inset,
            leafHalfD + PANEL_RAISE,
          )
        }
      }
    }
  }

  if (!withHardware) return
  // 五金：把手在开启侧（右侧边梃内侧），双面安装
  const handleS = centerS + halfS - stile * 0.8
  const handleY = config.sillHeight + Math.min(1.05, (yTop - yBottom) * 0.5)
  for (const sign of [1, -1] as const) {
    const d = sign * (leafHalfD + 0.022)
    if (config.hardware.handle === 'lever') {
      pushLocalBox(buckets.hardware, basis, handleS - 0.055, handleY, d, 0.06, 0.011, 0.011)
      pushLocalBox(buckets.hardware, basis, handleS, handleY, sign * (leafHalfD + 0.006), 0.014, 0.03, 0.008)
    } else if (config.hardware.handle === 'pull') {
      pushLocalBox(buckets.hardware, basis, handleS, handleY, d, 0.012, 0.15, 0.012)
    } else if (config.hardware.handle === 'bar') {
      pushLocalBox(buckets.hardware, basis, centerS, handleY, d, Math.max(0.12, halfS - stile), 0.018, 0.014)
    } else {
      pushLocalBox(buckets.hardware, basis, handleS, handleY, d, 0.022, 0.022, 0.022)
    }
  }
  // 踢脚板：只在门扇外侧
  if (config.hardware.kickPlate) {
    pushLocalBox(
      buckets.hardware,
      basis,
      centerS,
      yBottom + 0.14,
      leafHalfD + 0.004,
      halfS - stile,
      0.12,
      0.004,
    )
  }
  // 闭门器：门扇上方的内侧
  if (config.hardware.closer) {
    pushLocalBox(
      buckets.hardware,
      basis,
      centerS - halfS * 0.2,
      yTop - 0.08,
      -(leafHalfD + 0.03),
      halfS * 0.55,
      0.045,
      0.03,
    )
  }
}

/** 门：门套 + 门槛 + 门扇 + 门头亮子 */
function pushDoor(
  buckets: OpeningVertexBuckets,
  basis: OpeningBasis,
  config: DoorOpeningConfig,
): void {
  const width = config.width
  const height = config.height
  // 门套整体缩在洞口内，正面比墙面退 2mm，不出现凸出墙外的薄边
  const halfDepth = basis.thickness / 2 - FRAME_RECESS
  const frameWidth = config.frame.width

  // 左右门樘 + 上槛
  pushLocalBox(buckets.frame, basis, -width / 2 + frameWidth / 2, height / 2, 0, frameWidth / 2, height / 2, halfDepth)
  pushLocalBox(buckets.frame, basis, width / 2 - frameWidth / 2, height / 2, 0, frameWidth / 2, height / 2, halfDepth)
  pushLocalBox(buckets.frame, basis, 0, height - frameWidth / 2, 0, width / 2, frameWidth / 2, halfDepth)

  // 双面贴脸：整圈压盖在墙面与门套的接缝上。
  // 三个方向都要「埋进墙面 3mm」且「向洞口内侧压 3mm」：
  // 贴墙而不埋入会与墙面共面、贴洞口而不压边会与洞壁 / 门套外侧面共面，两种共面都会闪烁。
  const casing = config.frame.casingWidth
  if (casing > 0) {
    const boardHalfD = CASING_BOARD / 2
    // 侧板只到上板下沿，避免两块板的正面在转角处重叠共面
    const sideTop = height - CASING_OVERLAP
    for (const sign of [1, -1] as const) {
      const d = sign * (basis.thickness / 2 - CASING_EMBED + boardHalfD)
      pushLocalBox(
        buckets.frame,
        basis,
        -width / 2 + CASING_OVERLAP - casing / 2,
        sideTop / 2,
        d,
        casing / 2,
        sideTop / 2,
        boardHalfD,
      )
      pushLocalBox(
        buckets.frame,
        basis,
        width / 2 - CASING_OVERLAP + casing / 2,
        sideTop / 2,
        d,
        casing / 2,
        sideTop / 2,
        boardHalfD,
      )
      // 上板：横跨整樘门，两边各伸出 casing，自身也不再与洞口顶面、门套上槛正面共面
      pushLocalBox(
        buckets.frame,
        basis,
        0,
        sideTop + casing / 2,
        d,
        width / 2 + casing - CASING_OVERLAP,
        casing / 2,
        boardHalfD,
      )
    }
  }

  // 门槛：只有门槛高大于 0 时才生成，避免普通木门凭空多一块石头
  if (config.sillHeight > 0.005) {
    pushLocalBox(
      buckets.frame,
      basis,
      0,
      config.sillHeight / 2,
      0,
      width / 2 - frameWidth,
      config.sillHeight / 2,
      halfDepth,
    )
  }

  // 门扇净区：门扇区段两端各让出收口构件。靠洞口边缘的一端是门樘（宽 = 门套），
  // 门连窗靠窗的一端是分隔竖梃（更窄），因此两侧内缩量并不相同
  const doorSpan = config.doorSpan
  const layout = resolveSideWindowLayout(config)
  const leafStart = doorSpan.start + (layout && layout.windowIsLeft ? layout.dividerHalf : frameWidth)
  const leafEnd = doorSpan.end - (layout && !layout.windowIsLeft ? layout.dividerHalf : frameWidth)
  const leafArea = leafEnd - leafStart
  const leafAreaCenter = (leafStart + leafEnd) / 2
  const leafTop = height - frameWidth - (config.transomHeight > 0 ? config.transomHeight + frameWidth : 0)
  const leafBottom = config.sillHeight
  const double = config.leaf.kind === 'double'
  const leafWidth = double ? (leafArea - DOOR_LEAF_GAP * 3) / 2 : leafArea - DOOR_LEAF_GAP * 2
  if (leafWidth > 0 && leafTop - leafBottom > 0) {
    for (let index = 0; index < (double ? 2 : 1); index += 1) {
      const centerS =
        leafAreaCenter +
        (double ? -leafArea / 2 + DOOR_LEAF_GAP + leafWidth / 2 + index * (leafWidth + DOOR_LEAF_GAP) : 0)
      pushDoorLeaf(
        buckets,
        basis,
        config,
        centerS,
        leafWidth,
        leafBottom + DOOR_LEAF_GAP,
        leafTop - DOOR_LEAF_GAP,
        // 双开时只在右侧活动扇上装把手
        !double || index === 1,
      )
    }
  }

  // 门头亮子：玻璃 + 一道下横档，宽度跟随门扇区段（门连窗时不会压到窗上）
  if (config.transomHeight > 0) {
    const transomBottom = leafTop
    const transomTop = height - frameWidth
    if (transomTop - transomBottom > 0 && leafArea > 0) {
      pushLocalBox(
        buckets.glass,
        basis,
        leafAreaCenter,
        (transomBottom + transomTop) / 2,
        0,
        leafArea / 2 - GLASS_GAP,
        (transomTop - transomBottom) / 2 - GLASS_GAP,
        0.004,
      )
      pushLocalBox(
        buckets.frame,
        basis,
        leafAreaCenter,
        transomBottom - frameWidth / 2,
        0,
        leafArea / 2,
        frameWidth / 2,
        halfDepth,
      )
    }
  }

  // 门连窗：门扇一侧之外的那一段由固定窗填充
  if (config.windowPart) pushDoorSideWindow(buckets, basis, config, halfDepth)
}

/** 门连窗的分隔竖梃布局 */
interface SideWindowLayout {
  /** 窗段是否在门的左侧 */
  windowIsLeft: boolean
  /** 分隔竖梃中心（沿墙，相对洞口中心） */
  dividerS: number
  /** 分隔竖梃半宽：至少半个门套宽，门窗间有缝隙时加宽到盖住缝隙 */
  dividerHalf: number
}

/** 计算门连窗分隔竖梃的位置；没有窗段时返回 null */
function resolveSideWindowLayout(config: DoorOpeningConfig): SideWindowLayout | null {
  const part = config.windowPart
  if (!part) return null
  const windowIsLeft = part.end <= config.doorSpan.start + 1e-6
  const doorEdge = windowIsLeft ? config.doorSpan.start : config.doorSpan.end
  const windowEdge = windowIsLeft ? part.end : part.start
  // 门窗之间可能有一条与图元精度相当的缝隙，竖梃要一并向它加宽，避免露出墙洞
  const gap = windowIsLeft ? doorEdge - windowEdge : windowEdge - doorEdge
  return {
    windowIsLeft,
    dividerS: (doorEdge + windowEdge) / 2,
    dividerHalf: Math.max(config.frame.width, gap) / 2,
  }
}

/**
 * 门连窗中的固定窗扇。
 *
 * 窗段与门共用洞口外框：靠外框的一端由门樘收口，靠门的一端补一道分隔竖梃；
 * 窗台以下补裙板、窗顶低于洞口顶时补上方墙板，保证整段洞口都被构件填满、不留空洞。
 */
function pushDoorSideWindow(
  buckets: OpeningVertexBuckets,
  basis: OpeningBasis,
  config: DoorOpeningConfig,
  halfDepth: number,
): void {
  const part = config.windowPart
  const layout = resolveSideWindowLayout(config)
  if (!part || !layout) return
  const frameWidth = config.frame.width
  const span = part.end - part.start
  if (!(span > frameWidth * 2) || !(part.height > 0)) {
    throw new Error(`门连窗的窗段尺寸非法：宽 ${span.toFixed(3)}m / 高 ${part.height.toFixed(3)}m`)
  }
  const { windowIsLeft, dividerS, dividerHalf } = layout
  const centerS = (part.start + part.end) / 2

  // 分隔竖梃：从洞口底到顶槛，把门扇与固定窗隔开
  pushLocalBox(buckets.frame, basis, dividerS, config.height / 2, 0, dividerHalf, config.height / 2, halfDepth)

  // 窗台以下裙板：避免窗下出现通高的空洞
  if (part.sill > 0) {
    pushLocalBox(buckets.frame, basis, centerS, part.sill / 2, 0, span / 2, part.sill / 2, halfDepth)
  }

  // 窗框下槛：压在裙板顶面之上，厚度与门套一致
  pushLocalBox(
    buckets.frame,
    basis,
    centerS,
    part.sill + frameWidth / 2,
    0,
    span / 2,
    frameWidth / 2,
    halfDepth,
  )

  // 玻璃：外端让出整个框宽，门侧让出半个分隔竖梃，与两侧收口构件对齐
  const glassStart = windowIsLeft ? part.start + frameWidth : part.start + dividerHalf
  const glassEnd = windowIsLeft ? part.end - dividerHalf : part.end - frameWidth
  const glassBottom = part.sill + frameWidth
  const glassTop = part.sill + part.height
  if (!(glassEnd > glassStart) || !(glassTop > glassBottom)) {
    throw new Error(`门连窗的玻璃区尺寸非法：宽 ${(glassEnd - glassStart).toFixed(3)}m / 高 ${(glassTop - glassBottom).toFixed(3)}m`)
  }
  pushGlazingGrid(buckets, basis, {
    s: (glassStart + glassEnd) / 2,
    width: glassEnd - glassStart,
    y0: glassBottom,
    y1: glassTop,
    cols: 1,
    rows: 1,
    thickness: 0.006,
    layers: 2,
    muntin: MUNTIN_WIDTH,
    barDepth: halfDepth * 0.8,
    bars: false,
  })

  // 窗顶低于洞口顶时补上方墙板，避免窗上留洞
  const topEdge = config.height - frameWidth
  if (topEdge - glassTop > 1e-6) {
    pushLocalBox(
      buckets.frame,
      basis,
      centerS,
      (glassTop + topEdge) / 2,
      0,
      span / 2,
      (topEdge - glassTop) / 2,
      halfDepth,
    )
  }
}

/** 窗：外框 + 分格 + 玻璃 + 开启扇 + 窗台板 */
function pushWindow(
  buckets: OpeningVertexBuckets,
  basis: OpeningBasis,
  config: WindowOpeningConfig,
): void {
  const width = config.width
  const height = config.height
  // 与门套一致：窗框整体缩在洞口内，不凸出墙面
  const halfDepth = basis.thickness / 2 - FRAME_RECESS
  const frameWidth = config.frame.width
  const innerWidth = width - frameWidth * 2
  const innerBottom = frameWidth
  const innerTop = height - frameWidth

  // 四周边框
  pushLocalBox(buckets.frame, basis, -width / 2 + frameWidth / 2, height / 2, 0, frameWidth / 2, height / 2, halfDepth)
  pushLocalBox(buckets.frame, basis, width / 2 - frameWidth / 2, height / 2, 0, frameWidth / 2, height / 2, halfDepth)
  pushLocalBox(buckets.frame, basis, 0, height - frameWidth / 2, 0, width / 2, frameWidth / 2, halfDepth)
  pushLocalBox(buckets.frame, basis, 0, frameWidth / 2, 0, width / 2, frameWidth / 2, halfDepth)
  if (!(innerWidth > 0) || !(innerTop - innerBottom > 0)) return

  // 中梃
  const mullionHalf = config.mullionWidth / 2
  const cellWidth = innerWidth / config.columns
  const cellHeight = (innerTop - innerBottom) / config.rows
  for (let col = 1; col < config.columns; col += 1) {
    pushLocalBox(
      buckets.frame,
      basis,
      -innerWidth / 2 + cellWidth * col,
      (innerBottom + innerTop) / 2,
      0,
      mullionHalf,
      (innerTop - innerBottom) / 2,
      halfDepth,
    )
  }
  for (let row = 1; row < config.rows; row += 1) {
    pushLocalBox(
      buckets.frame,
      basis,
      0,
      innerBottom + cellHeight * row,
      0,
      innerWidth / 2,
      mullionHalf,
      halfDepth,
    )
  }

  // 可开启扇：每个格子内再嵌一圈细扇框
  if (config.operable) {
    const sash = 0.03
    for (let col = 0; col < config.columns; col += 1) {
      for (let row = 0; row < config.rows; row += 1) {
        const centerS = -innerWidth / 2 + cellWidth * (col + 0.5)
        const centerY = innerBottom + cellHeight * (row + 0.5)
        const halfS = cellWidth / 2 - mullionHalf * 0.5
        const halfY = cellHeight / 2 - mullionHalf * 0.5
        if (!(halfS > sash) || !(halfY > sash)) continue
        pushLocalBox(buckets.frame, basis, centerS - halfS + sash / 2, centerY, 0, sash / 2, halfY, halfDepth * 0.9)
        pushLocalBox(buckets.frame, basis, centerS + halfS - sash / 2, centerY, 0, sash / 2, halfY, halfDepth * 0.9)
        pushLocalBox(buckets.frame, basis, centerS, centerY + halfY - sash / 2, 0, halfS, sash / 2, halfDepth * 0.9)
        pushLocalBox(buckets.frame, basis, centerS, centerY - halfY + sash / 2, 0, halfS, sash / 2, halfDepth * 0.9)
      }
    }
  }

  // 玻璃 / 百叶
  if (config.preset === 'louver') {
    const slatCount = 10
    for (let index = 0; index < slatCount; index += 1) {
      const y = innerBottom + ((index + 0.5) * (innerTop - innerBottom)) / slatCount
      pushLocalBox(
        buckets.frame,
        basis,
        0,
        y,
        0,
        innerWidth / 2 - GLASS_GAP,
        (innerTop - innerBottom) / (slatCount * 2.4),
        halfDepth * 0.6,
      )
    }
  } else {
    pushGlazingGrid(buckets, basis, {
      s: 0,
      width: innerWidth,
      y0: innerBottom,
      y1: innerTop,
      cols: config.columns,
      rows: config.rows,
      thickness: config.glazing.thickness,
      layers: config.glazing.layers,
      muntin: MUNTIN_WIDTH,
      barDepth: halfDepth * 0.8,
      // 中梃已经分格，玻璃格内不再重复加分格条
      bars: false,
    })
  }

  // 窗台板：室内外各一块，背面埋进墙面、顶面略低于洞口底
  if (config.sillBoardDepth > 0) {
    const boardThickness = 0.03
    for (const sign of [1, -1] as const) {
      // 背面埋入墙面 3mm：贴墙摆放会与墙面共面；
      // 顶面比洞口底低 3mm：与洞口底面法线同为 +Y，齐平时同样共面闪烁
      const d = sign * (basis.thickness / 2 - CASING_EMBED + config.sillBoardDepth / 2)
      pushLocalBox(
        buckets.frame,
        basis,
        0,
        -CASING_EMBED - boardThickness / 2,
        d,
        width / 2 + 0.06,
        boardThickness / 2,
        config.sillBoardDepth / 2,
      )
    }
  }
}

/**
 * 收集一层的门窗顶点，按材质分桶。
 *
 * 返回纯数字数组而不是 three 几何，导出侧（GLB）与预览侧共用同一份顶点，
 * 避免两处各算一遍导致预览与导出的构件不一致。
 */
export function collectOpeningVertices(
  placements: readonly WallOpeningPlacement[],
): OpeningVertexBuckets {
  const buckets: OpeningVertexBuckets = { frame: [], leaf: [], glass: [], hardware: [] }
  for (const placement of placements) {
    const basis = basisOf(placement)
    if (placement.kind === 'door') {
      pushDoor(buckets, basis, resolveDoorConfig(placement))
    } else {
      pushWindow(buckets, basis, resolveWindowConfig(placement))
    }
  }
  return buckets
}

/**
 * 生成一层的门窗几何。
 * 返回 null 表示没有可用洞口（调用方不生成门窗网格）。
 */
export function buildOpeningGeometry(
  placements: readonly WallOpeningPlacement[],
): THREE.BufferGeometry | null {
  if (placements.length === 0) return null
  const buckets = collectOpeningVertices(placements)
  const groups: Array<{ positions: number[]; material: number }> = [
    { positions: buckets.frame, material: OPENING_FRAME_GROUP },
    { positions: buckets.leaf, material: OPENING_LEAF_GROUP },
    { positions: buckets.glass, material: OPENING_GLASS_GROUP },
    { positions: buckets.hardware, material: OPENING_HARDWARE_GROUP },
  ]
  const positions: number[] = []
  const layout: Array<{ start: number; count: number; material: number }> = []
  for (const group of groups) {
    const count = group.positions.length / 3
    if (count === 0) continue
    layout.push({ start: positions.length / 3, count, material: group.material })
    positions.push(...group.positions)
  }
  if (positions.length === 0) return null

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  for (const group of layout) geometry.addGroup(group.start, group.count, group.material)
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * 门窗材质数组：下标与材质组一一对应（框 / 门扇 / 玻璃 / 五金）。
 * 基准色写入 userData.baseColor，供楼层展开时统一压暗使用。
 */
export function createOpeningMaterials(): THREE.MeshStandardMaterial[] {
  const frameColor = new THREE.Color(OPENING_FRAME_COLOR)
  const leafColor = new THREE.Color(OPENING_LEAF_COLOR)
  const glassColor = new THREE.Color(OPENING_GLASS_COLOR)
  const hardwareColor = new THREE.Color(OPENING_HARDWARE_COLOR)

  const frame = new THREE.MeshStandardMaterial({
    color: frameColor,
    roughness: 0.7,
    metalness: 0.05,
    envMapIntensity: 0.6,
    side: THREE.FrontSide,
  })
  const leaf = new THREE.MeshStandardMaterial({
    color: leafColor,
    roughness: 0.62,
    metalness: 0,
    envMapIntensity: 0.5,
    side: THREE.FrontSide,
  })
  const glass = new THREE.MeshStandardMaterial({
    color: glassColor,
    roughness: 0.08,
    metalness: 0,
    envMapIntensity: 1.4,
    transparent: true,
    opacity: 0.36,
    side: THREE.FrontSide,
  })
  const hardware = new THREE.MeshStandardMaterial({
    color: hardwareColor,
    roughness: 0.28,
    metalness: 0.85,
    envMapIntensity: 1.1,
    side: THREE.FrontSide,
  })

  frame.userData.baseColor = frameColor.clone()
  leaf.userData.baseColor = leafColor.clone()
  glass.userData.baseColor = glassColor.clone()
  hardware.userData.baseColor = hardwareColor.clone()
  return [frame, leaf, glass, hardware]
}

/** 释放门窗材质 */
export function disposeOpeningMaterials(materials: readonly THREE.MeshStandardMaterial[]): void {
  for (const material of materials) material.dispose()
}
