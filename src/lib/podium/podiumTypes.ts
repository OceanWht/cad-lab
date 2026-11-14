/**
 * 程序化建筑底座：类型预设、参数范围与归一化。
 *
 * 一套参数 + 六个预设覆盖 Blender 参考场景里的六种异构底座：
 * 圆形台基 / 柱廊底商 / 石材裙墙 / 多级台基 / 台阶柱廊 / 悬挑雨棚。
 * 编辑器与 standalone-engine 共用本模块。
 */
import type { PartMaterialConfig, PodiumConfig, PodiumPartKey, PodiumType } from '../../shared/types'
import {
  clonePartMaterials,
  makePartMaterial,
  normalizeHexColor,
  normalizePartMaterials,
  partMaterialsSignature,
  PODIUM_PART_KEYS,
  withPartColor,
} from '../building/partMaterial'

export interface PodiumTypeOption {
  value: PodiumType
  label: string
  hint: string
}

export const PODIUM_TYPE_OPTIONS: readonly PodiumTypeOption[] = [
  { value: 'rotunda', label: '圆形台基', hint: '圆形台基 + 密排圆柱 + 内凹深色墙板' },
  { value: 'arcade', label: '柱廊底商', hint: '柱廊 + 横向扶手杆 + 柱后深色玻璃底商' },
  { value: 'stone_plinth', label: '石材裙墙', hint: '石材裙墙 + 横向百叶带 + 凸出门柱' },
  { value: 'stepped', label: '多级台基', hint: '多级台基 + 序列方柱 + 中央入口平台' },
  { value: 'terraced', label: '台阶柱廊', hint: '前场宽台阶 + 柱廊 + 内凹入口' },
  { value: 'canopy', label: '悬挑雨棚', hint: '悬挑雨棚 + 柱廊 + 两侧花池 + 宽台阶' },
] as const

export type PodiumNumericKey =
  | 'tierCount'
  | 'tierHeight'
  | 'tierOffset'
  | 'bandHeight'
  | 'bandOffset'
  | 'columnSpacing'
  | 'columnSize'
  | 'columnInset'
  | 'louverCount'
  | 'railCount'
  | 'canopyDepth'
  | 'canopyThickness'
  | 'canopyHeight'
  | 'stepCount'
  | 'stepOffset'
  | 'entranceProjection'
  | 'planterHeight'
  | 'planterThickness'
  | 'seed'

export interface PodiumParamRange {
  min: number
  max: number
  step: number
  unit?: string
}

export const PODIUM_PARAM_RANGES: Record<PodiumNumericKey, PodiumParamRange> = {
  tierCount: { min: 0, max: 3, step: 1 },
  tierHeight: { min: 0.02, max: 0.6, step: 0.01, unit: 'm' },
  tierOffset: { min: 0, max: 2, step: 0.05, unit: 'm' },
  bandHeight: { min: 0.5, max: 8, step: 0.1, unit: 'm' },
  bandOffset: { min: 0, max: 2, step: 0.05, unit: 'm' },
  columnSpacing: { min: 0, max: 8, step: 0.1, unit: 'm' },
  columnSize: { min: 0.1, max: 1.2, step: 0.02, unit: 'm' },
  columnInset: { min: 0, max: 2.5, step: 0.05, unit: 'm' },
  louverCount: { min: 0, max: 20, step: 1 },
  railCount: { min: 0, max: 4, step: 1 },
  canopyDepth: { min: 0, max: 4, step: 0.1, unit: 'm' },
  canopyThickness: { min: 0.05, max: 1, step: 0.02, unit: 'm' },
  canopyHeight: { min: 1, max: 8, step: 0.1, unit: 'm' },
  stepCount: { min: 0, max: 6, step: 1 },
  stepOffset: { min: 0.1, max: 1.2, step: 0.05, unit: 'm' },
  entranceProjection: { min: 0, max: 4, step: 0.1, unit: 'm' },
  planterHeight: { min: 0, max: 2, step: 0.05, unit: 'm' },
  planterThickness: { min: 0.1, max: 1, step: 0.02, unit: 'm' },
  seed: { min: 0, max: 9999, step: 1 },
}

/** 需要取整的参数 */
export const PODIUM_INTEGER_KEYS: ReadonlySet<PodiumNumericKey> = new Set<PodiumNumericKey>([
  'tierCount',
  'louverCount',
  'railCount',
  'stepCount',
  'seed',
])

const NUMERIC_KEYS = Object.keys(PODIUM_PARAM_RANGES) as PodiumNumericKey[]

function isPodiumType(value: unknown): value is PodiumType {
  return typeof value === 'string' && PODIUM_TYPE_OPTIONS.some((o) => o.value === value)
}

export function clampPodiumNumber(key: PodiumNumericKey, value: number): number {
  const range = PODIUM_PARAM_RANGES[key]
  const n = Number(value)
  if (!Number.isFinite(n)) return range.min
  const clamped = Math.min(range.max, Math.max(range.min, n))
  return PODIUM_INTEGER_KEYS.has(key) ? Math.round(clamped) : Math.round(clamped * 100) / 100
}

/** 按旧版配色生成九个构件的默认材质 */
function podiumParts(stone: string, metal: string, recess: string): Record<PodiumPartKey, PartMaterialConfig> {
  return {
    tier: makePartMaterial(stone, 0.78, 0.04),
    band: makePartMaterial(stone, 0.78, 0.04),
    recess: makePartMaterial(recess, 0.58, 0.1),
    louver: makePartMaterial(metal, 0.38, 0.55),
    rail: makePartMaterial(metal, 0.38, 0.55),
    column: makePartMaterial(metal, 0.38, 0.55),
    canopy: makePartMaterial(stone, 0.78, 0.04),
    steps: makePartMaterial(stone, 0.78, 0.04),
    planter: makePartMaterial(stone, 0.78, 0.04),
  }
}

/** 六种底座类型的默认档案（尺寸按 Blender 参考场景估算） */
export const PODIUM_PRESETS: Record<PodiumType, PodiumConfig> = {
  rotunda: {
    enabled: true,
    type: 'rotunda',
    tierCount: 1,
    tierHeight: 0.35,
    tierOffset: 1.2,
    bandHeight: 3.6,
    bandOffset: 0,
    columnShape: 'round',
    columnSpacing: 2.2,
    columnSize: 0.45,
    columnInset: 0.55,
    louverCount: 0,
    railCount: 0,
    canopyDepth: 0,
    canopyThickness: 0.4,
    canopyHeight: 3.6,
    stepCount: 0,
    stepOffset: 0.4,
    entranceProjection: 0,
    planterHeight: 0,
    planterThickness: 0.4,
    frontFace: null,
    parts: podiumParts('#e6e3dc', '#3a3a36', '#5b4634'),
    seed: 11,
  },
  arcade: {
    enabled: true,
    type: 'arcade',
    tierCount: 1,
    tierHeight: 0.12,
    tierOffset: 0.5,
    bandHeight: 3.8,
    bandOffset: 0,
    columnShape: 'square',
    columnSpacing: 2.8,
    columnSize: 0.3,
    columnInset: 0.35,
    louverCount: 0,
    railCount: 2,
    canopyDepth: 0,
    canopyThickness: 0.4,
    canopyHeight: 3.8,
    stepCount: 0,
    stepOffset: 0.4,
    entranceProjection: 0,
    planterHeight: 0,
    planterThickness: 0.4,
    frontFace: null,
    parts: podiumParts('#d8d6d0', '#484846', '#263330'),
    seed: 23,
  },
  stone_plinth: {
    enabled: true,
    type: 'stone_plinth',
    tierCount: 1,
    tierHeight: 0.2,
    tierOffset: 0.5,
    bandHeight: 3.0,
    bandOffset: 0.15,
    columnShape: 'square',
    columnSpacing: 0,
    columnSize: 0.8,
    columnInset: 0.2,
    louverCount: 9,
    railCount: 0,
    canopyDepth: 0,
    canopyThickness: 0.4,
    canopyHeight: 3.0,
    stepCount: 0,
    stepOffset: 0.4,
    entranceProjection: 0.5,
    planterHeight: 0,
    planterThickness: 0.4,
    frontFace: null,
    parts: podiumParts('#d6d0c2', '#b3ada0', '#cfc8ba'),
    seed: 37,
  },
  stepped: {
    enabled: true,
    type: 'stepped',
    tierCount: 2,
    tierHeight: 0.16,
    tierOffset: 0.65,
    bandHeight: 3.6,
    bandOffset: 0,
    columnShape: 'square',
    columnSpacing: 2.6,
    columnSize: 0.6,
    columnInset: 0.35,
    louverCount: 0,
    railCount: 0,
    canopyDepth: 0,
    canopyThickness: 0.4,
    canopyHeight: 3.6,
    stepCount: 2,
    stepOffset: 0.5,
    entranceProjection: 1.5,
    planterHeight: 0,
    planterThickness: 0.4,
    frontFace: null,
    parts: podiumParts('#ecebe7', '#33332f', '#2b3a34'),
    seed: 41,
  },
  terraced: {
    enabled: true,
    type: 'terraced',
    tierCount: 2,
    tierHeight: 0.18,
    tierOffset: 0.9,
    bandHeight: 3.5,
    bandOffset: 0.25,
    columnShape: 'square',
    columnSpacing: 2.6,
    columnSize: 0.5,
    columnInset: 0.3,
    louverCount: 0,
    railCount: 0,
    canopyDepth: 0,
    canopyThickness: 0.4,
    canopyHeight: 3.5,
    stepCount: 3,
    stepOffset: 0.55,
    entranceProjection: 0.8,
    planterHeight: 0,
    planterThickness: 0.4,
    frontFace: null,
    parts: podiumParts('#e3e1da', '#cfcabf', '#4a4741'),
    seed: 53,
  },
  canopy: {
    enabled: true,
    type: 'canopy',
    tierCount: 1,
    tierHeight: 0.2,
    tierOffset: 1.0,
    bandHeight: 3.6,
    bandOffset: 0,
    columnShape: 'square',
    columnSpacing: 2.8,
    columnSize: 0.55,
    columnInset: 0.4,
    louverCount: 0,
    railCount: 0,
    canopyDepth: 1.8,
    canopyThickness: 0.5,
    canopyHeight: 3.6,
    stepCount: 4,
    stepOffset: 0.6,
    entranceProjection: 0.6,
    planterHeight: 0.9,
    planterThickness: 0.4,
    frontFace: null,
    parts: podiumParts('#d7d4cc', '#c9c5bb', '#2a2a28'),
    seed: 67,
  },
}

/** 取某类型的默认档案（深拷贝，调用方可直接改写） */
export function defaultPodiumConfig(type: PodiumType): PodiumConfig {
  const preset = PODIUM_PRESETS[type]
  return { ...preset, parts: clonePartMaterials(preset.parts) }
}

export function clonePodiumConfig(config: PodiumConfig): PodiumConfig {
  return { ...config, parts: clonePartMaterials(config.parts) }
}

/** 旧版四个颜色字段到构件材质的兼容映射 */
function legacyPartDefaults(
  source: Record<string, unknown>,
  preset: PodiumConfig,
): Record<PodiumPartKey, PartMaterialConfig> {
  let parts = clonePartMaterials(preset.parts)
  const stone = normalizeHexColor(source.stoneColor, parts.tier.color)
  const metal = normalizeHexColor(source.metalColor, parts.louver.color)
  const recess = normalizeHexColor(source.recessColor, parts.recess.color)
  for (const key of ['tier', 'band', 'canopy', 'steps', 'planter'] as PodiumPartKey[]) {
    parts = withPartColor(parts, key, stone)
  }
  for (const key of ['louver', 'rail', 'column'] as PodiumPartKey[]) {
    parts = withPartColor(parts, key, metal)
  }
  return withPartColor<PodiumPartKey>(parts, 'recess', recess)
}

/**
 * 归一化外部写入的底座配置：类型非法回退 arcade，数值按范围裁剪，
 * 颜色必须是合法 hex；`null`/非对象返回 null（表示未配置底座）。
 */
export function normalizePodiumConfig(raw: unknown): PodiumConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const type = isPodiumType(source.type) ? source.type : 'arcade'
  const preset = PODIUM_PRESETS[type]
  const config: PodiumConfig = { ...preset, enabled: source.enabled !== false }

  for (const key of NUMERIC_KEYS) {
    const value = Number(source[key])
    ;(config as any)[key] = Number.isFinite(value) ? clampPodiumNumber(key, value) : preset[key]
  }

  config.columnShape =
    source.columnShape === 'round' || source.columnShape === 'square'
      ? source.columnShape
      : preset.columnShape
  config.parts = normalizePartMaterials(source.parts, legacyPartDefaults(source, preset), PODIUM_PART_KEYS)

  const front = Number(source.frontFace)
  config.frontFace =
    source.frontFace === null || source.frontFace === undefined
      ? null
      : Number.isInteger(front) && front >= 0
        ? front
        : null

  return config
}

/**
 * 底座覆盖的建筑立面高度（米）。
 * 立面附件（窗洞 / 竖梃 / 腰线等）从这个高度以上才开始生成，
 * 避免底座范围内出现不属于底座的装饰构件。
 */
export function podiumCoverHeight(config: PodiumConfig | null | undefined): number {
  if (!config?.enabled) return 0
  const baseTop = Math.round(config.tierCount) * config.tierHeight
  const bandTop = baseTop + config.bandHeight
  const canopyTop = config.canopyDepth > 0.05 ? baseTop + config.canopyHeight + config.canopyThickness : 0
  return Math.round(Math.max(bandTop, canopyTop) * 100) / 100
}

/** 底座几何/材质签名：任何参数变化都会触发重建 */
export function podiumCacheKey(config: PodiumConfig): string {
  const parts: string[] = [
    config.enabled ? '1' : '0',
    config.type,
    config.columnShape,
    partMaterialsSignature(config.parts, PODIUM_PART_KEYS),
    config.frontFace == null ? 'auto' : String(config.frontFace),
  ]
  for (const key of NUMERIC_KEYS) parts.push(String((config as any)[key]))
  return parts.join('|')
}
