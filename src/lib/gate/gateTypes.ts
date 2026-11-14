/**
 * 程序化大门：风格预设与参数归一化
 *
 * 该模块同时被编辑器（src/lib/view3d）与独立引擎（src/standalone-engine）引用，
 * 禁止依赖 UI 层（store / 组件）以保证两端渲染观感一致。
 */
import type { EntranceGateConfig, EntranceGateDoorType, EntranceGateStyle } from '../../shared/types'
import { toMercator } from '../../shared/geo'

export interface GatePreset {
  label: string
  doorType: EntranceGateDoorType
  /** 门洞净宽（真实米） */
  width: number
  /** 门洞净高（真实米） */
  height: number
  /** 雨棚进深（真实米），0 表示无雨棚 */
  canopyDepth: number
  /** 台阶级数 0~3 */
  steps: number
  frameColor: string
  doorColor: string
  glassColor: string
  /** 默认无招牌文字，由用户按需填写 */
  signText: string
  /** 默认不亮灯：避免白天观感突兀 */
  emissiveIntensity: number
  /** 门框金属度 0~1 */
  frameMetalness: number
}

/** 大门可编辑参数（不含面绑定与风格） */
export type GateParams = Pick<
  EntranceGateConfig,
  | 'doorType'
  | 'width'
  | 'height'
  | 'canopyDepth'
  | 'steps'
  | 'frameColor'
  | 'doorColor'
  | 'glassColor'
  | 'signText'
  | 'emissiveIntensity'
  | 'frameMetalness'
>

export const GATE_STYLE_OPTIONS: Array<{ value: EntranceGateStyle; label: string }> = [
  { value: 'office', label: '写字楼' },
  { value: 'residential', label: '居民楼' },
  { value: 'hospital', label: '医院' },
  { value: 'factory', label: '工厂' },
]

export const GATE_DOOR_TYPE_OPTIONS: Array<{ value: EntranceGateDoorType; label: string }> = [
  { value: 'double', label: '双开门' },
  { value: 'sliding', label: '自动平移门' },
  { value: 'roller', label: '卷帘门' },
]

export const GATE_PRESETS: Record<EntranceGateStyle, GatePreset> = {
  office: {
    label: '写字楼',
    doorType: 'double',
    width: 4.2,
    height: 2.8,
    canopyDepth: 1.2,
    steps: 0,
    frameColor: '#8f99a0',
    doorColor: '#2e3d46',
    glassColor: '#7fb4c9',
    signText: '',
    emissiveIntensity: 0,
    frameMetalness: 0.45,
  },
  residential: {
    label: '居民楼',
    doorType: 'double',
    width: 2.4,
    height: 2.2,
    canopyDepth: 0.8,
    steps: 2,
    frameColor: '#6e6258',
    doorColor: '#3f3a36',
    glassColor: '#8fa2ad',
    signText: '',
    emissiveIntensity: 0,
    frameMetalness: 0.2,
  },
  hospital: {
    label: '医院',
    doorType: 'sliding',
    width: 5,
    height: 2.6,
    canopyDepth: 1.5,
    steps: 0,
    frameColor: '#c6d4d1',
    doorColor: '#cfe0e2',
    glassColor: '#86b8c4',
    signText: '',
    emissiveIntensity: 0,
    frameMetalness: 0.35,
  },
  factory: {
    label: '工厂',
    doorType: 'roller',
    width: 6,
    height: 4.5,
    canopyDepth: 1,
    steps: 0,
    frameColor: '#5a5f63',
    doorColor: '#6f7478',
    glassColor: '#74858c',
    signText: '',
    emissiveIntensity: 0,
    frameMetalness: 0.55,
  },
}

const STYLE_ORDER: EntranceGateStyle[] = ['office', 'residential', 'hospital', 'factory']
const DOOR_TYPE_ORDER: EntranceGateDoorType[] = ['double', 'sliding', 'roller']

/** 招牌文字长度上限（字符） */
export const GATE_SIGN_MAX_LENGTH = 24

/** 单栋建筑大门个数上限（缺省值与允许范围） */
export const DEFAULT_GATE_LIMIT = 8
export const GATE_LIMIT_MIN = 1
export const GATE_LIMIT_MAX = 64

/** 门套立柱宽度（场景米，建筑局部）：相邻大门无缝拼接时共用同一根 */
export const GATE_JAMB_WIDTH = 0.18
/** 接缝判定容差（场景米）：中心距与无缝间距相差不超过该值即视作共用门柱 */
export const GATE_SEAM_TOLERANCE = 0.08

/** 一次连续生成的整排大门数量（缺省值与允许范围） */
export const DEFAULT_GATE_RUN_COUNT = 1
export const GATE_RUN_MIN = 1
export const GATE_RUN_MAX = 32

/** 归一化「一次生成个数」 */
export function normalizeGateRunCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_GATE_RUN_COUNT
  return Math.round(Math.min(GATE_RUN_MAX, Math.max(GATE_RUN_MIN, n)))
}

/** 大门实例键：与 `normalizeEntranceGateConfig` 派生 id 的规则一致 */
export function gateInstanceKey(config: EntranceGateConfig): string {
  const raw = String(config.id ?? '').trim()
  if (raw) return raw
  return `g${Math.round(config.faceIndex)}-${Math.round((Number(config.offsetT) || 0.5) * 1000)}-${config.style}`
}

/**
 * 保存 / 导出前的列表归一化：逐项净化，按实例键去重（同一面允许多扇连续大门），
 * 并按面索引、面内位置排序。返回 undefined 表示该数组不可用。
 */
export function normalizeEntranceGateList(list: unknown): EntranceGateConfig[] | undefined {
  if (!Array.isArray(list)) return undefined
  const byKey = new Map<string, EntranceGateConfig>()
  for (const entry of list) {
    const next = normalizeEntranceGateConfig(entry as Partial<EntranceGateConfig>)
    if (next) byKey.set(gateInstanceKey(next), next)
  }
  const out = [...byKey.values()].sort((a, b) => a.faceIndex - b.faceIndex || a.offsetT - b.offsetT)
  return out.length ? out : undefined
}

/**
 * 门洞净宽（场景米）：与 `buildGateGroup` 的换算完全一致
 * （真实米 → 场景米 × 水平系数，并按面长留 0.4m 余量截断）。
 */
export function gateEffectiveWidthScene(width: number, faceLenScene: number, horizontalScale = 1): number {
  const scale = Number.isFinite(horizontalScale) && horizontalScale > 0 ? horizontalScale : 1
  const faceLenTrue = faceLenScene / scale
  const widthTrue = Math.max(1, Math.min(Number(width) || 1, Math.max(1, faceLenTrue - 0.4)))
  return widthTrue * scale
}

/** 单侧接缝：共享门柱中心相对本门中心的距离（场景米，左负右正）；null 表示该侧不相邻 */
export interface GateSeamFlags {
  left: number | null
  right: number | null
}

/**
 * 推导同一面上各扇大门的左右接缝。
 *
 * 「无缝间距」= 两门净宽各一半 + 共用门柱宽度；中心距落在容差内即视为相邻，
 * 由右侧门绘制共享门柱、左侧门省略自己的门柱。
 */
export function deriveGateSeams(
  gates: EntranceGateConfig[],
  faceLenAt: (faceIndex: number) => number | null,
  horizontalScale = 1,
  jambWidth = GATE_JAMB_WIDTH,
): Map<string, GateSeamFlags> {
  const result = new Map<string, GateSeamFlags>()
  const byFace = new Map<number, EntranceGateConfig[]>()
  for (const gate of gates) {
    if (!gate || !Number.isFinite(gate.faceIndex) || gate.faceIndex < 0) continue
    const list = byFace.get(gate.faceIndex) ?? []
    list.push(gate)
    byFace.set(gate.faceIndex, list)
  }
  for (const [faceIndex, list] of byFace) {
    const faceLen = Number(faceLenAt(faceIndex))
    if (!Number.isFinite(faceLen) || faceLen <= 1e-4) continue
    const sorted = [...list].sort((a, b) => a.offsetT - b.offsetT)
    const widths = new Map<string, number>()
    for (const gate of sorted) {
      widths.set(gateInstanceKey(gate), gateEffectiveWidthScene(gate.width, faceLen, horizontalScale))
      result.set(gateInstanceKey(gate), { left: null, right: null })
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]
      const b = sorted[i + 1]
      const dist = (b.offsetT - a.offsetT) * faceLen
      if (!(dist > 0.01)) continue
      const wA = widths.get(gateInstanceKey(a)) ?? 0
      const wB = widths.get(gateInstanceKey(b)) ?? 0
      const seamlessPitch = (wA + wB) / 2 + jambWidth
      if (Math.abs(dist - seamlessPitch) > GATE_SEAM_TOLERANCE) continue
      const flagsA = result.get(gateInstanceKey(a))
      const flagsB = result.get(gateInstanceKey(b))
      if (!flagsA || !flagsB) continue
      flagsA.right = dist - wB / 2 - jambWidth / 2
      flagsB.left = -(dist - wA / 2 - jambWidth / 2)
    }
  }
  return result
}

export interface GateRunLayout {
  /** 每扇门的归一化落点（升序） */
  offsets: number[]
  /** 实际生成数量（面长不足时会小于请求值） */
  count: number
}

/**
 * 计算「一次生成整排」的落点：以点击位置为中心，按「净宽 + 共用门柱」无缝排列，
 * 整排夹取到面长范围内；面长不足时减少扇数。
 */
export function resolveGateRunPlacements(options: {
  clickT: number
  faceLen: number
  width: number
  count: number
  jambWidth?: number
}): GateRunLayout {
  const clickT = Math.min(1, Math.max(0, Number(options.clickT) || 0.5))
  const faceLen = Number(options.faceLen)
  const width = Math.max(0.5, Number(options.width) || 0.5)
  const jamb = Math.max(0, Number(options.jambWidth ?? GATE_JAMB_WIDTH) || 0)
  if (!Number.isFinite(faceLen) || faceLen <= 1e-4) return { offsets: [clickT], count: 1 }
  const module = width + jamb
  const maxCount = Math.max(1, Math.floor((faceLen - jamb) / module))
  const count = Math.max(1, Math.min(maxCount, Math.round(Number(options.count) || 1)))
  const total = count * module + jamb
  const center = total >= faceLen
    ? faceLen / 2
    : Math.min(faceLen - total / 2, Math.max(total / 2, clickT * faceLen))
  const first = center - ((count - 1) * module) / 2
  const offsets: number[] = []
  for (let i = 0; i < count; i++) {
    offsets.push(Math.min(1, Math.max(0, (first + i * module) / faceLen)))
  }
  return { offsets, count }
}

/** 归一化大门个数上限 */
export function normalizeGateLimit(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_GATE_LIMIT
  return Math.round(Math.min(GATE_LIMIT_MAX, Math.max(GATE_LIMIT_MIN, n)))
}

/** 大门实例序号：与时间戳组合保证唯一，替代 Math.random 以保持可预期 */
let gateIdSeq = 0

/** 生成大门实例 id */
export function createGateId(): string {
  gateIdSeq += 1
  return `gate-${Date.now().toString(36)}-${gateIdSeq.toString(36)}`
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeColor(value: unknown, fallback: string): string {
  const s = String(value ?? '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return fallback
}

export function normalizeGateStyle(value: unknown): EntranceGateStyle {
  const s = String(value ?? '').trim() as EntranceGateStyle
  return STYLE_ORDER.includes(s) ? s : 'office'
}

export function normalizeGateDoorType(value: unknown, fallback: EntranceGateDoorType = 'double'): EntranceGateDoorType {
  const s = String(value ?? '').trim() as EntranceGateDoorType
  return DOOR_TYPE_ORDER.includes(s) ? s : fallback
}

export function normalizeGateSignText(value: unknown): string {
  return String(value ?? '').trim().slice(0, GATE_SIGN_MAX_LENGTH)
}

/** 按风格预设生成一份可编辑参数 */
export function gateParamsFromStyle(style: EntranceGateStyle): GateParams {
  const p = GATE_PRESETS[style]
  return {
    doorType: p.doorType,
    width: p.width,
    height: p.height,
    canopyDepth: p.canopyDepth,
    steps: p.steps,
    frameColor: p.frameColor,
    doorColor: p.doorColor,
    glassColor: p.glassColor,
    signText: p.signText,
    emissiveIntensity: p.emissiveIntensity,
    frameMetalness: p.frameMetalness,
  }
}

/**
 * 参数归一化：裁剪越界数值、补齐缺省字段、剥离非法面索引与锚点。
 * 返回 null 表示该配置不可用（应被丢弃）。
 */
export function normalizeEntranceGateConfig(
  input: Partial<EntranceGateConfig> | null | undefined,
): EntranceGateConfig | null {
  if (!input) return null
  const faceIndex = Number(input.faceIndex)
  if (!Number.isFinite(faceIndex) || faceIndex < 0) return null
  const anchorRaw = input.anchor
  if (!Array.isArray(anchorRaw) || anchorRaw.length < 2) return null
  const lon = Number(anchorRaw[0])
  const lat = Number(anchorRaw[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null

  const style = normalizeGateStyle(input.style)
  const preset = GATE_PRESETS[style]
  const seedRaw = Number(input.seed)
  const offsetT = clampNumber(input.offsetT, 0, 1, 0.5)
  const rawId = String(input.id ?? '').trim()
  const id = rawId || `g${Math.round(faceIndex)}-${Math.round(offsetT * 1000)}-${style}`

  return {
    id,
    faceIndex: Math.round(faceIndex),
    anchor: [lon, lat],
    offsetT,
    style,
    doorType: normalizeGateDoorType(input.doorType, preset.doorType),
    width: clampNumber(input.width, 1, 12, preset.width),
    height: clampNumber(input.height, 1.5, 8, preset.height),
    canopyDepth: clampNumber(input.canopyDepth, 0, 4, preset.canopyDepth),
    steps: Math.round(clampNumber(input.steps, 0, 3, preset.steps)),
    frameColor: normalizeColor(input.frameColor, preset.frameColor),
    doorColor: normalizeColor(input.doorColor, preset.doorColor),
    glassColor: normalizeColor(input.glassColor, preset.glassColor),
    signText: normalizeGateSignText(input.signText ?? preset.signText),
    emissiveIntensity: clampNumber(input.emissiveIntensity, 0, 1, preset.emissiveIntensity),
    frameMetalness: clampNumber(input.frameMetalness, 0, 1, preset.frameMetalness),
    seed: Number.isFinite(seedRaw) ? Math.abs(Math.round(seedRaw)) % 100000 : 1,
  }
}

/** 按风格预设生成一面全新大门配置 */
export function createEntranceGateConfig(
  style: EntranceGateStyle,
  faceIndex: number,
  anchor: [number, number],
  offsetT: number,
  overrides?: Partial<EntranceGateConfig>,
): EntranceGateConfig {
  const preset = GATE_PRESETS[style]
  const base: EntranceGateConfig = {
    id: overrides?.id || createGateId(),
    faceIndex,
    anchor: [anchor[0], anchor[1]],
    offsetT,
    style,
    doorType: preset.doorType,
    width: preset.width,
    height: preset.height,
    canopyDepth: preset.canopyDepth,
    steps: preset.steps,
    frameColor: preset.frameColor,
    doorColor: preset.doorColor,
    glassColor: preset.glassColor,
    signText: preset.signText,
    emissiveIntensity: preset.emissiveIntensity,
    frameMetalness: preset.frameMetalness,
    seed: (faceIndex * 37 + STYLE_ORDER.indexOf(style) * 101 + 7) % 100000,
  }
  return normalizeEntranceGateConfig({ ...base, ...(overrides ?? {}) }) ?? base
}

/** 材质 / 招牌贴图缓存键：风格 + 门型 + 取整到 3 位小数的尺寸 + 颜色 + 招牌文字 */
export function gateCacheKey(config: EntranceGateConfig): string {
  const round = (n: number) => Math.round(Number(n) * 1000) / 1000
  return [
    config.style,
    config.doorType,
    round(config.width),
    round(config.height),
    round(config.canopyDepth),
    config.steps,
    round(config.emissiveIntensity),
    round(config.frameMetalness),
    config.frameColor,
    config.doorColor,
    config.glassColor,
    config.signText,
  ].join('|')
}

/** 招牌贴图缓存键：只与文字和配色有关 */
export function gateSignCacheKey(config: EntranceGateConfig): string {
  return [config.signText, config.doorColor, config.frameColor, config.emissiveIntensity > 0 ? 1 : 0].join('|')
}

/**
 * 计算建筑第 faceIndex 个墙面的真实长度（米），用于面板提示「门宽超出面长」。
 *
 * 与 `outdoorFaceAnchors` 使用同一套面序号规则：ExtrudeGeometry 会在轮廓非顺时针时
 * 反转顶点，因此这里先用墨卡托坐标判断环向，再按统一顺序取边。
 * 仅在 UI 侧做提示，实际渲染由 gateBuilder 按几何体顶点自行截断。
 */
export function gateFaceTrueLengthMeters(
  ring: Array<[number, number]>,
  faceIndex: number,
): number | null {
  if (!Number.isFinite(faceIndex) || faceIndex < 0) return null
  if (!Array.isArray(ring) || ring.length < 4) return null
  const isClosed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
  const pts = isClosed ? ring.slice(0, -1) : ring
  if (pts.length < 3) return null
  const merc = pts.map((p) => toMercator(Number(p[0]), Number(p[1])))
  // 与 THREE.ShapeUtils.isClockWise 等价：有符号面积 < 0 视为顺时针
  let area = 0
  for (let p = merc.length - 1, q = 0; q < merc.length; p = q++) {
    area += merc[p][0] * merc[q][1] - merc[q][0] * merc[p][1]
  }
  area *= 0.5
  const ordered = area < 0 ? pts : [...pts].reverse()
  const idx = Math.round(faceIndex) % ordered.length
  const a = ordered[idx]
  const b = ordered[(idx + 1) % ordered.length]
  const [ax, ay] = toMercator(Number(a[0]), Number(a[1]))
  const [bx, by] = toMercator(Number(b[0]), Number(b[1]))
  const cosLat = Math.cos((((Number(a[1]) + Number(b[1])) / 2) * Math.PI) / 180) || 1
  const length = Math.hypot(ax - bx, ay - by) * cosLat
  return Number.isFinite(length) && length > 0 ? length : null
}

