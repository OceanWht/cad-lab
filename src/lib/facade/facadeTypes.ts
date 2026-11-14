/**
 * 程序化立面：风格预设与参数归一化
 *
 * 该模块同时被编辑器（src/lib/view3d）与独立引擎（src/standalone-engine）引用，
 * 禁止依赖 UI 层（store / 组件）以保证两端渲染观感完全一致。
 */
import type { FacadeFaceConfig, FacadeReliefFlags, FacadeReliefPartKey, FacadeStyle, PartMaterialConfig } from '../../shared/types'
import {
  FACADE_PART_KEYS,
  makeFacadePartMaterials,
  normalizePartMaterials,
  partMaterialsSignature,
} from '../building/partMaterial'

/** 贴图 tile 尺寸（像素）：一个开间 × 一个层高 */
export const FACADE_TEXTURE_SIZE = 512

/** 近景贴图档位（远处建筑降级到 FACADE_TEXTURE_SIZE，控制显存） */
export const FACADE_TEXTURE_SIZE_HIGH = 1024

/** 按建筑与相机的距离选择贴图档位（近景 1024，中远景 512，避免显存膨胀） */
export function resolveFacadeTextureSize(distanceM: number): number {
  return Number(distanceM) <= 80 ? FACADE_TEXTURE_SIZE_HIGH : FACADE_TEXTURE_SIZE
}

/** 贴图缓存上限（组） */
export const FACADE_CACHE_LIMIT = 64

/** 当前立面档案版本（缺省视为 1） */
export const FACADE_PROFILE_VERSION = 2

export interface FacadePreset {
  label: string
  /** 开间（真实米） */
  bayWidth: number
  /** 层高（真实米） */
  floorHeight: number
  /** 窗墙比 0.2~0.8 */
  windowRatio: number
  /** 窗台高（真实米） */
  sillHeight: number
  wallColor: string
  frameColor: string
  glassColor: string
  /** 默认不亮窗：避免白天观感突兀 */
  emissiveIntensity: number
  normalStrength: number
  /** 窗框金属度 0~1 */
  windowFrameMetalness: number
  /** 竖梃 / 窗框可见宽度（米） */
  mullionWidth: number
  /** 窗洞内凹深度提示（米） */
  revealDepth: number
  /** 楼板腰线高度（米） */
  slabBandHeight: number
  /** 角部内缩（米） */
  cornerInset: number
  /** 玻璃粗糙度 0~1 */
  glassRoughness: number
  /** 玻璃金属度 0~1 */
  glassMetalness: number
  /** 环境反射强度 0~2 */
  envMapIntensity: number
  /** AO 强度 0~1 */
  aoStrength: number
  /** 几何附件默认开关 */
  relief: FacadeReliefFlags
}

/** 归一化后的立面档案（新字段全部补齐，供生成器直接消费） */
export interface FacadeProfile {
  mullionWidth: number
  revealDepth: number
  slabBandHeight: number
  cornerInset: number
  glassRoughness: number
  glassMetalness: number
  envMapIntensity: number
  aoStrength: number
  relief: FacadeReliefFlags
  profileVersion: number
}

/** 立面可编辑参数（不含面绑定与风格，档案字段全部补齐） */
export interface FacadeParams {
  bayWidth: number
  floorHeight: number
  windowRatio: number
  sillHeight: number
  wallColor: string
  frameColor: string
  glassColor: string
  seed: number
  emissiveIntensity: number
  normalStrength: number
  windowFrameMetalness: number
  mullionWidth: number
  revealDepth: number
  slabBandHeight: number
  cornerInset: number
  glassRoughness: number
  glassMetalness: number
  envMapIntensity: number
  aoStrength: number
  relief: FacadeReliefFlags
  /** 立面装饰各构件独立材质（颜色 / 金属度 / 粗糙度 / 贴图 / 缩放） */
  parts: Record<FacadeReliefPartKey, PartMaterialConfig>
}

/** 立面四分组：面板折叠分组与「恢复组默认」的最小单位 */
export type FacadeGroupKey = 'basic' | 'glass' | 'relief' | 'advanced'

export interface FacadeParamRange {
  min: number
  max: number
  step: number
  /** 单位标注（`m` / 空表示比例或开关） */
  unit: string
}

/** 数值控件范围：与 normalizeFacadeProfile / normalizeFacadeConfig 的裁剪区间保持一致 */
export const FACADE_PARAM_RANGES = {
  bayWidth: { min: 1, max: 24, step: 0.1, unit: 'm' },
  floorHeight: { min: 1.8, max: 12, step: 0.1, unit: 'm' },
  windowRatio: { min: 0.2, max: 0.8, step: 0.01, unit: '' },
  sillHeight: { min: 0, max: 11.4, step: 0.1, unit: 'm' },
  emissiveIntensity: { min: 0, max: 1, step: 0.01, unit: '' },
  normalStrength: { min: 0, max: 1, step: 0.01, unit: '' },
  windowFrameMetalness: { min: 0, max: 1, step: 0.01, unit: '' },
  seed: { min: 0, max: 99999, step: 1, unit: '' },
  mullionWidth: { min: 0.02, max: 0.4, step: 0.01, unit: 'm' },
  revealDepth: { min: 0, max: 0.6, step: 0.01, unit: 'm' },
  slabBandHeight: { min: 0, max: 1.2, step: 0.05, unit: 'm' },
  cornerInset: { min: 0, max: 1.5, step: 0.05, unit: 'm' },
  glassRoughness: { min: 0, max: 1, step: 0.01, unit: '' },
  glassMetalness: { min: 0, max: 1, step: 0.01, unit: '' },
  envMapIntensity: { min: 0, max: 2, step: 0.05, unit: '' },
  aoStrength: { min: 0, max: 1, step: 0.01, unit: '' },
} as const satisfies Record<string, FacadeParamRange>

export type FacadeNumericKey = keyof typeof FACADE_PARAM_RANGES

export const FACADE_STYLE_OPTIONS: Array<{ value: FacadeStyle; label: string }> = [
  { value: 'factory', label: '工厂' },
  { value: 'residential', label: '居民楼' },
  { value: 'office', label: '写字楼' },
  { value: 'hospital', label: '医院' },
  { value: 'curtain_wall', label: '玻璃幕墙' },
  { value: 'concrete_punched', label: '混凝土冲孔' },
  { value: 'brutalist_banded', label: '粗野主义横带' },
  { value: 'brick_apartment', label: '砖混住宅' },
  { value: 'stone_office', label: '石材写字楼' },
]

export const FACADE_PROFILE_PRESETS: Record<FacadeStyle, FacadePreset> = {
  factory: {
    label: '工厂',
    bayWidth: 6,
    floorHeight: 5.4,
    windowRatio: 0.72,
    sillHeight: 1.2,
    wallColor: '#8f8b82',
    frameColor: '#4a4f55',
    glassColor: '#74858c',
    emissiveIntensity: 0,
    normalStrength: 0.7,
    windowFrameMetalness: 0.55,
    mullionWidth: 0.1,
    revealDepth: 0.08,
    slabBandHeight: 0.3,
    cornerInset: 0.3,
    glassRoughness: 0.3,
    glassMetalness: 0.2,
    envMapIntensity: 0.5,
    aoStrength: 0.45,
    relief: { mullion: false, sill: false, cornice: true, parapet: true, balcony: false },
  },
  residential: {
    label: '居民楼',
    bayWidth: 3,
    floorHeight: 3,
    windowRatio: 0.42,
    sillHeight: 0.9,
    wallColor: '#d9cdb8',
    frameColor: '#f2ece2',
    glassColor: '#7f97a8',
    emissiveIntensity: 0,
    normalStrength: 0.45,
    windowFrameMetalness: 0.15,
    mullionWidth: 0.08,
    revealDepth: 0.06,
    slabBandHeight: 0.15,
    cornerInset: 0.25,
    glassRoughness: 0.15,
    glassMetalness: 0.1,
    envMapIntensity: 0.6,
    aoStrength: 0.4,
    relief: { mullion: false, sill: true, cornice: false, parapet: false, balcony: false },
  },
  office: {
    label: '写字楼',
    bayWidth: 1.6,
    floorHeight: 3.9,
    windowRatio: 0.78,
    sillHeight: 0.35,
    wallColor: '#5c6a73',
    frameColor: '#8f99a0',
    glassColor: '#4e7c94',
    emissiveIntensity: 0,
    normalStrength: 0.3,
    windowFrameMetalness: 0.45,
    mullionWidth: 0.1,
    revealDepth: 0.05,
    slabBandHeight: 0.2,
    cornerInset: 0.3,
    glassRoughness: 0.08,
    glassMetalness: 0.5,
    envMapIntensity: 1,
    aoStrength: 0.35,
    relief: { mullion: true, sill: false, cornice: true, parapet: true, balcony: false },
  },
  hospital: {
    label: '医院',
    bayWidth: 3.6,
    floorHeight: 3.6,
    windowRatio: 0.5,
    sillHeight: 1,
    wallColor: '#eef1ee',
    frameColor: '#c6d4d1',
    glassColor: '#6fa3ad',
    emissiveIntensity: 0,
    normalStrength: 0.4,
    windowFrameMetalness: 0.25,
    mullionWidth: 0.09,
    revealDepth: 0.05,
    slabBandHeight: 0.2,
    cornerInset: 0.3,
    glassRoughness: 0.15,
    glassMetalness: 0.1,
    envMapIntensity: 0.6,
    aoStrength: 0.35,
    relief: { mullion: false, sill: true, cornice: false, parapet: false, balcony: false },
  },
  curtain_wall: {
    label: '玻璃幕墙',
    bayWidth: 1.5,
    floorHeight: 3.9,
    windowRatio: 0.92,
    sillHeight: 0.15,
    wallColor: '#2b2f33',
    frameColor: '#3a4045',
    glassColor: '#1f2a33',
    emissiveIntensity: 0,
    normalStrength: 0.15,
    windowFrameMetalness: 0.7,
    mullionWidth: 0.09,
    revealDepth: 0.04,
    slabBandHeight: 0.25,
    cornerInset: 0.3,
    glassRoughness: 0.05,
    glassMetalness: 0.9,
    envMapIntensity: 1.2,
    aoStrength: 0.35,
    relief: { mullion: true, sill: false, cornice: true, parapet: true, balcony: false },
  },
  concrete_punched: {
    label: '混凝土冲孔',
    bayWidth: 3,
    floorHeight: 3.6,
    windowRatio: 0.38,
    sillHeight: 0.95,
    wallColor: '#cfcfc9',
    frameColor: '#b8b8b2',
    glassColor: '#5b6a70',
    emissiveIntensity: 0,
    normalStrength: 0.55,
    windowFrameMetalness: 0.2,
    mullionWidth: 0.06,
    revealDepth: 0.18,
    slabBandHeight: 0.3,
    cornerInset: 0.4,
    glassRoughness: 0.12,
    glassMetalness: 0.2,
    envMapIntensity: 0.7,
    aoStrength: 0.6,
    relief: { mullion: false, sill: true, cornice: true, parapet: false, balcony: false },
  },
  brutalist_banded: {
    label: '粗野主义横带',
    bayWidth: 3,
    floorHeight: 3.2,
    windowRatio: 0.55,
    sillHeight: 0.8,
    wallColor: '#b9b5ab',
    frameColor: '#a4a096',
    glassColor: '#4d5a5f',
    emissiveIntensity: 0,
    normalStrength: 0.5,
    windowFrameMetalness: 0.15,
    mullionWidth: 0.05,
    revealDepth: 0.12,
    slabBandHeight: 0.55,
    cornerInset: 0.5,
    glassRoughness: 0.2,
    glassMetalness: 0.15,
    envMapIntensity: 0.6,
    aoStrength: 0.65,
    relief: { mullion: false, sill: true, cornice: true, parapet: true, balcony: false },
  },
  brick_apartment: {
    label: '砖混住宅',
    bayWidth: 3,
    floorHeight: 2.9,
    windowRatio: 0.32,
    sillHeight: 0.9,
    wallColor: '#9a5a44',
    frameColor: '#e7ded2',
    glassColor: '#6d7f8a',
    emissiveIntensity: 0,
    normalStrength: 0.55,
    windowFrameMetalness: 0.1,
    mullionWidth: 0.07,
    revealDepth: 0.14,
    slabBandHeight: 0.18,
    cornerInset: 0.3,
    glassRoughness: 0.2,
    glassMetalness: 0.05,
    envMapIntensity: 0.5,
    aoStrength: 0.5,
    relief: { mullion: false, sill: true, cornice: false, parapet: false, balcony: false },
  },
  stone_office: {
    label: '石材写字楼',
    bayWidth: 3,
    floorHeight: 3.6,
    windowRatio: 0.45,
    sillHeight: 0.7,
    wallColor: '#8e8b84',
    frameColor: '#b3aea4',
    glassColor: '#57636a',
    emissiveIntensity: 0,
    normalStrength: 0.45,
    windowFrameMetalness: 0.3,
    mullionWidth: 0.1,
    revealDepth: 0.2,
    slabBandHeight: 0.4,
    cornerInset: 0.45,
    glassRoughness: 0.1,
    glassMetalness: 0.3,
    envMapIntensity: 0.9,
    aoStrength: 0.55,
    relief: { mullion: true, sill: true, cornice: true, parapet: true, balcony: false },
  },
}

/** 兼容旧名：与 FACADE_PROFILE_PRESETS 指向同一份数据 */
export const FACADE_PRESETS = FACADE_PROFILE_PRESETS

const STYLE_ORDER: FacadeStyle[] = FACADE_STYLE_OPTIONS.map((o) => o.value)

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

export function normalizeFacadeStyle(value: unknown): FacadeStyle {
  const s = String(value ?? '').trim() as FacadeStyle
  return STYLE_ORDER.includes(s) ? s : 'office'
}

function readReliefFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 数值精度压缩：保留 3 位小数，避免保存时出现浮点尾差 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 立面档案归一化：按风格预设补齐缺失字段、裁剪越界数值、写入当前 `profileVersion`。
 *
 * 迁移策略：只有缺失或非法字段才取预设值，已有合法值一律保留，因此对同一份配置
 * 连续调用结果完全一致（幂等），也不会覆盖用户在面板里改过的值。
 */
export function normalizeFacadeProfile(input: Partial<FacadeFaceConfig> | null | undefined, style: FacadeStyle): FacadeProfile {
  const preset = FACADE_PRESETS[style]
  const reliefRaw = input?.relief
  return {
    mullionWidth: round3(clampNumber(input?.mullionWidth, 0.02, 0.4, preset.mullionWidth)),
    revealDepth: round3(clampNumber(input?.revealDepth, 0, 0.6, preset.revealDepth)),
    slabBandHeight: round3(clampNumber(input?.slabBandHeight, 0, 1.2, preset.slabBandHeight)),
    cornerInset: round3(clampNumber(input?.cornerInset, 0, 1.5, preset.cornerInset)),
    glassRoughness: round3(clampNumber(input?.glassRoughness, 0, 1, preset.glassRoughness)),
    glassMetalness: round3(clampNumber(input?.glassMetalness, 0, 1, preset.glassMetalness)),
    envMapIntensity: round3(clampNumber(input?.envMapIntensity, 0, 2, preset.envMapIntensity)),
    aoStrength: round3(clampNumber(input?.aoStrength, 0, 1, preset.aoStrength)),
    relief: {
      mullion: readReliefFlag(reliefRaw?.mullion, preset.relief.mullion),
      sill: readReliefFlag(reliefRaw?.sill, preset.relief.sill),
      cornice: readReliefFlag(reliefRaw?.cornice, preset.relief.cornice),
      parapet: readReliefFlag(reliefRaw?.parapet, preset.relief.parapet),
      balcony: readReliefFlag(reliefRaw?.balcony, preset.relief.balcony),
    },
    profileVersion: FACADE_PROFILE_VERSION,
  }
}

/** 按风格预设生成一份可编辑参数 */
export function facadeParamsFromStyle(style: FacadeStyle): FacadeParams {
  const p = FACADE_PRESETS[style]
  return {
    bayWidth: p.bayWidth,
    floorHeight: p.floorHeight,
    windowRatio: p.windowRatio,
    sillHeight: p.sillHeight,
    wallColor: p.wallColor,
    frameColor: p.frameColor,
    glassColor: p.glassColor,
    seed: 1,
    emissiveIntensity: p.emissiveIntensity,
    normalStrength: p.normalStrength,
    windowFrameMetalness: p.windowFrameMetalness,
    mullionWidth: p.mullionWidth,
    revealDepth: p.revealDepth,
    slabBandHeight: p.slabBandHeight,
    cornerInset: p.cornerInset,
    glassRoughness: p.glassRoughness,
    glassMetalness: p.glassMetalness,
    envMapIntensity: p.envMapIntensity,
    aoStrength: p.aoStrength,
    relief: { ...p.relief },
    parts: makeFacadePartMaterials(),
  }
}

/** 从已归一化的单面配置提取可编辑参数（缺省字段按风格预设补齐） */
export function facadeParamsFromConfig(config: FacadeFaceConfig): FacadeParams {
  const style = normalizeFacadeStyle(config.style)
  const preset = FACADE_PRESETS[style]
  const profile = normalizeFacadeProfile(config, style)
  return {
    bayWidth: Number.isFinite(config.bayWidth) ? config.bayWidth : preset.bayWidth,
    floorHeight: Number.isFinite(config.floorHeight) ? config.floorHeight : preset.floorHeight,
    windowRatio: Number.isFinite(config.windowRatio) ? config.windowRatio : preset.windowRatio,
    sillHeight: Number.isFinite(config.sillHeight) ? config.sillHeight : preset.sillHeight,
    wallColor: config.wallColor || preset.wallColor,
    frameColor: config.frameColor || preset.frameColor,
    glassColor: config.glassColor || preset.glassColor,
    seed: Number.isFinite(config.seed) ? config.seed : 1,
    emissiveIntensity: Number.isFinite(config.emissiveIntensity) ? config.emissiveIntensity : preset.emissiveIntensity,
    normalStrength: Number.isFinite(config.normalStrength) ? config.normalStrength : preset.normalStrength,
    windowFrameMetalness: Number.isFinite(config.windowFrameMetalness) ? config.windowFrameMetalness : preset.windowFrameMetalness,
    mullionWidth: profile.mullionWidth,
    revealDepth: profile.revealDepth,
    slabBandHeight: profile.slabBandHeight,
    cornerInset: profile.cornerInset,
    glassRoughness: profile.glassRoughness,
    glassMetalness: profile.glassMetalness,
    envMapIntensity: profile.envMapIntensity,
    aoStrength: profile.aoStrength,
    relief: { ...profile.relief },
    parts: normalizePartMaterials(config.parts, makeFacadePartMaterials(), FACADE_PART_KEYS),
  }
}

/** 某分组的预设默认值（「恢复组默认」用，种子等无预设字段不重置） */
export function facadeGroupDefaults(style: FacadeStyle, group: FacadeGroupKey): Partial<FacadeParams> {
  const p = facadeParamsFromStyle(style)
  if (group === 'basic') {
    return {
      bayWidth: p.bayWidth,
      floorHeight: p.floorHeight,
      windowRatio: p.windowRatio,
      sillHeight: p.sillHeight,
      wallColor: p.wallColor,
      frameColor: p.frameColor,
      glassColor: p.glassColor,
    }
  }
  if (group === 'glass') {
    return {
      glassRoughness: p.glassRoughness,
      glassMetalness: p.glassMetalness,
      envMapIntensity: p.envMapIntensity,
      windowFrameMetalness: p.windowFrameMetalness,
    }
  }
  if (group === 'relief') {
    return {
      mullionWidth: p.mullionWidth,
      revealDepth: p.revealDepth,
      slabBandHeight: p.slabBandHeight,
      cornerInset: p.cornerInset,
      relief: { ...p.relief },
    }
  }
  return {
    emissiveIntensity: p.emissiveIntensity,
    normalStrength: p.normalStrength,
    aoStrength: p.aoStrength,
  }
}

/**
 * 参数归一化：裁剪越界数值、补齐缺省字段与立面档案、剥离非法面索引与锚点。
 * 返回 null 表示该配置不可用（应被丢弃）。
 */
export function normalizeFacadeConfig(input: Partial<FacadeFaceConfig> | null | undefined): FacadeFaceConfig | null {
  if (!input) return null
  const faceIndex = Number(input.faceIndex)
  if (!Number.isFinite(faceIndex) || faceIndex < 0) return null
  const anchorRaw = input.anchor
  if (!Array.isArray(anchorRaw) || anchorRaw.length < 2) return null
  const lon = Number(anchorRaw[0])
  const lat = Number(anchorRaw[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null

  const style = normalizeFacadeStyle(input.style)
  const preset = FACADE_PRESETS[style]

  const bayWidth = clampNumber(input.bayWidth, 1, 24, preset.bayWidth)
  const floorHeight = clampNumber(input.floorHeight, 1.8, 12, preset.floorHeight)
  const sillHeight = clampNumber(input.sillHeight, 0, floorHeight - 0.6, preset.sillHeight)
  const seedRaw = Number(input.seed)

  return {
    faceIndex: Math.round(faceIndex),
    anchor: [lon, lat],
    style,
    bayWidth,
    floorHeight,
    windowRatio: clampNumber(input.windowRatio, 0.2, 0.8, preset.windowRatio),
    sillHeight,
    wallColor: normalizeColor(input.wallColor, preset.wallColor),
    frameColor: normalizeColor(input.frameColor, preset.frameColor),
    glassColor: normalizeColor(input.glassColor, preset.glassColor),
    seed: Number.isFinite(seedRaw) ? Math.abs(Math.round(seedRaw)) % 100000 : 1,
    emissiveIntensity: clampNumber(input.emissiveIntensity, 0, 1, preset.emissiveIntensity),
    normalStrength: clampNumber(input.normalStrength, 0, 1, preset.normalStrength),
    windowFrameMetalness: clampNumber(input.windowFrameMetalness, 0, 1, preset.windowFrameMetalness),
    ...normalizeFacadeProfile(input, style),
    parts: normalizePartMaterials(input.parts, makeFacadePartMaterials(), FACADE_PART_KEYS),
  }
}

/** 按风格预设生成一面全新配置（seed 由面序号决定，保证同面同风格图案稳定） */
export function createFacadeFaceConfig(
  style: FacadeStyle,
  faceIndex: number,
  anchor: [number, number],
  overrides?: Partial<FacadeFaceConfig>,
): FacadeFaceConfig {
  const preset = FACADE_PRESETS[style]
  const base: FacadeFaceConfig = {
    faceIndex,
    anchor: [anchor[0], anchor[1]],
    style,
    bayWidth: preset.bayWidth,
    floorHeight: preset.floorHeight,
    windowRatio: preset.windowRatio,
    sillHeight: preset.sillHeight,
    wallColor: preset.wallColor,
    frameColor: preset.frameColor,
    glassColor: preset.glassColor,
    seed: (faceIndex * 37 + STYLE_ORDER.indexOf(style) * 101 + 7) % 100000,
    emissiveIntensity: preset.emissiveIntensity,
    normalStrength: preset.normalStrength,
    windowFrameMetalness: preset.windowFrameMetalness,
  }
  return normalizeFacadeConfig({ ...base, ...(overrides ?? {}) }) ?? base
}

/**
 * 贴图 / 材质缓存键：风格 + 档案版本 + 模块尺寸 + 全部通道参数 + 颜色。
 * 档案字段（竖梃 / 内凹 / 腰线 / 玻璃 / AO / relief）全部纳入，避免不同档案复用同一张贴图。
 */
export function facadeCacheKey(config: FacadeFaceConfig): string {
  const round = (n: number) => Math.round(Number(n) * 1000) / 1000
  const profile = normalizeFacadeProfile(config, normalizeFacadeStyle(config.style))
  const relief = profile.relief
  return [
    config.style,
    profile.profileVersion,
    round(config.bayWidth),
    round(config.floorHeight),
    round(config.windowRatio),
    round(config.sillHeight),
    round(config.normalStrength),
    round(config.emissiveIntensity),
    round(config.windowFrameMetalness),
    config.seed,
    config.wallColor,
    config.frameColor,
    config.glassColor,
    round(profile.mullionWidth),
    round(profile.revealDepth),
    round(profile.slabBandHeight),
    round(profile.cornerInset),
    round(profile.glassRoughness),
    round(profile.glassMetalness),
    round(profile.envMapIntensity),
    round(profile.aoStrength),
    `${relief.mullion ? 1 : 0}${relief.sill ? 1 : 0}${relief.cornice ? 1 : 0}${relief.parapet ? 1 : 0}${relief.balcony ? 1 : 0}`,
  ].join('|')
}

/**
 * 立面装饰缓存键：立面签名 + 各构件材质签名。
 * 任一构件的颜色 / 金属度 / 粗糙度 / 贴图 / 缩放变化都会触发附件重建。
 */
export function facadeReliefKey(config: FacadeFaceConfig): string {
  const parts = normalizePartMaterials(config.parts, makeFacadePartMaterials(), FACADE_PART_KEYS)
  return `${facadeCacheKey(config)}|${partMaterialsSignature(parts, FACADE_PART_KEYS)}`
}

/**
 * 立面贴图 repeat：(1/开间, 1/层高)
 * ExtrudeGeometry 侧面 UV 以场景米为单位，故该 repeat 可在任意长度墙面上保持真实比例。
 */
export function facadeTextureRepeat(config: FacadeFaceConfig): [number, number] {
  return [1 / Math.max(0.1, config.bayWidth), 1 / Math.max(0.1, config.floorHeight)]
}
