/**
 * 程序化建筑屋顶：类型预设、参数范围与归一化。
 *
 * 一套参数 + 六个预设覆盖 Blender 参考场景里的六种异构屋顶：
 * 平屋面女儿墙 / 架空格栅冠 / 弧形塔顶檐圈 / 偏置屋顶机房 / 分格天窗带 / 悬挑薄檐口。
 * 编辑器与 standalone-engine 共用本模块。
 */
import type {
  PartMaterialConfig,
  RoofConfig,
  RoofEquipmentKind,
  RoofEquipmentPlacement,
  RoofPartKey,
  RoofType,
} from '../../shared/types'
import {
  clonePartMaterials,
  makePartMaterial,
  normalizeHexColor,
  normalizePartMaterials,
  partMaterialsSignature,
  ROOF_PART_KEYS,
  withPartColor,
} from '../building/partMaterial'

export interface RoofTypeOption {
  value: RoofType
  label: string
  hint: string
}

export const ROOF_TYPE_OPTIONS: readonly RoofTypeOption[] = [
  { value: 'parapet', label: '平屋面女儿墙', hint: '平屋面 + 女儿墙 + 挑檐线脚 + 屋面设备箱' },
  { value: 'lattice', label: '架空格栅冠', hint: '沿轮廓的外圈梁 + 折点立柱 + 轮廓内井字梁（自动裁剪）' },
  { value: 'oval_rim', label: '环形塔顶檐圈', hint: '贴合轮廓的环形压顶 + 同心内檐圈（弧形塔楼观感最佳）' },
  { value: 'penthouse', label: '偏置屋顶机房', hint: '偏置机房/楼梯间 + 局部女儿墙' },
  { value: 'skylight', label: '分格天窗带', hint: '屋面等距天窗条带，逐条裁剪到轮廓内部' },
  { value: 'eave', label: '悬挑薄檐口', hint: '悬挑压顶板 + 檐下阴影线（低层适用）' },
] as const

/** 屋面设备类别选项（手动点击放置） */
export const ROOF_EQUIPMENT_OPTIONS: ReadonlyArray<{ value: RoofEquipmentKind; label: string }> = [
  { value: 'ahu', label: '空调机组' },
  { value: 'tower', label: '冷却塔' },
  { value: 'fan', label: '屋面风机' },
  { value: 'duct', label: '管道' },
  { value: 'solar', label: '光伏板' },
  { value: 'tank', label: '水箱' },
  { value: 'mast', label: '天线杆' },
] as const

export function normalizeRoofEquipmentKind(value: unknown): RoofEquipmentKind {
  const s = String(value ?? '') as RoofEquipmentKind
  return ROOF_EQUIPMENT_OPTIONS.some((o) => o.value === s) ? s : 'ahu'
}

/** 归一化手动放置的设备列表：校验类别与坐标，丢弃非法项 */
export function normalizeRoofEquipment(raw: unknown): RoofEquipmentPlacement[] {
  if (!Array.isArray(raw)) return []
  const out: RoofEquipmentPlacement[] = []
  let index = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const x = Number(source.x)
    const z = Number(source.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue
    const id = String(source.id ?? '').trim()
    out.push({
      id: id || `eq${index}`,
      kind: normalizeRoofEquipmentKind(source.kind),
      x: Math.round(x * 1000) / 1000,
      z: Math.round(z * 1000) / 1000,
    })
    index++
  }
  return out
}

export type RoofNumericKey =
  | 'parapetHeight'
  | 'parapetThickness'
  | 'corniceOffset'
  | 'corniceThickness'
  | 'crownCount'
  | 'crownHeight'
  | 'crownThickness'
  | 'penthouseWidthRatio'
  | 'penthouseDepthRatio'
  | 'penthouseHeight'
  | 'penthouseInset'
  | 'skylightCount'
  | 'skylightWidth'
  | 'skylightHeight'
  | 'eaveOffset'
  | 'eaveThickness'
  | 'equipmentCount'
  | 'equipmentHeight'
  | 'equipmentSize'
  | 'mechZoneRatio'
  | 'solarZoneQuota'
  | 'seed'

export interface RoofParamRange {
  min: number
  max: number
  step: number
  unit?: string
}

export const ROOF_PARAM_RANGES: Record<RoofNumericKey, RoofParamRange> = {
  parapetHeight: { min: 0, max: 4, step: 0.1, unit: 'm' },
  parapetThickness: { min: 0.1, max: 1.2, step: 0.05, unit: 'm' },
  corniceOffset: { min: 0, max: 2.5, step: 0.05, unit: 'm' },
  corniceThickness: { min: 0.05, max: 0.8, step: 0.02, unit: 'm' },
  crownCount: { min: 1, max: 6, step: 1 },
  crownHeight: { min: 0.5, max: 10, step: 0.1, unit: 'm' },
  crownThickness: { min: 0.1, max: 1, step: 0.02, unit: 'm' },
  penthouseWidthRatio: { min: 0.15, max: 0.9, step: 0.05 },
  penthouseDepthRatio: { min: 0.15, max: 0.9, step: 0.05 },
  penthouseHeight: { min: 1, max: 10, step: 0.1, unit: 'm' },
  penthouseInset: { min: 0, max: 5, step: 0.1, unit: 'm' },
  skylightCount: { min: 0, max: 6, step: 1 },
  skylightWidth: { min: 0.5, max: 8, step: 0.1, unit: 'm' },
  skylightHeight: { min: 0.05, max: 1.2, step: 0.02, unit: 'm' },
  eaveOffset: { min: 0, max: 4, step: 0.05, unit: 'm' },
  eaveThickness: { min: 0.05, max: 1, step: 0.02, unit: 'm' },
  equipmentCount: { min: 0, max: 8, step: 1 },
  equipmentHeight: { min: 0.5, max: 5, step: 0.1, unit: 'm' },
  equipmentSize: { min: 0.5, max: 6, step: 0.1, unit: 'm' },
  mechZoneRatio: { min: 0.3, max: 0.85, step: 0.05 },
  solarZoneQuota: { min: 0, max: 0.8, step: 0.05 },
  seed: { min: 0, max: 9999, step: 1 },
}

/** 需要取整的参数 */
export const ROOF_INTEGER_KEYS: ReadonlySet<RoofNumericKey> = new Set<RoofNumericKey>([
  'crownCount',
  'skylightCount',
  'equipmentCount',
  'seed',
])

const NUMERIC_KEYS = Object.keys(ROOF_PARAM_RANGES) as RoofNumericKey[]

function isRoofType(value: unknown): value is RoofType {
  return typeof value === 'string' && ROOF_TYPE_OPTIONS.some((o) => o.value === value)
}

export function clampRoofNumber(key: RoofNumericKey, value: number): number {
  const range = ROOF_PARAM_RANGES[key]
  const n = Number(value)
  if (!Number.isFinite(n)) return range.min
  const clamped = Math.min(range.max, Math.max(range.min, n))
  return ROOF_INTEGER_KEYS.has(key) ? Math.round(clamped) : Math.round(clamped * 100) / 100
}

/** 按旧版配色生成十一个构件的默认材质 */
function roofParts(deck: string, wall: string, metal: string, glass: string): Record<RoofPartKey, PartMaterialConfig> {
  return {
    deck: makePartMaterial(deck, 0.86, 0.05),
    cornice: makePartMaterial(wall, 0.72, 0.06),
    parapet: makePartMaterial(wall, 0.72, 0.06),
    crown: makePartMaterial(metal, 0.4, 0.55),
    penthouse: makePartMaterial(wall, 0.72, 0.06),
    skylight: makePartMaterial(glass, 0.16, 0.4),
    skylightFrame: makePartMaterial(metal, 0.4, 0.55),
    equipment: makePartMaterial(metal, 0.4, 0.55),
    solar: makePartMaterial(glass, 0.16, 0.4),
    zonePad: makePartMaterial(wall, 0.72, 0.06),
    infrastructure: makePartMaterial(metal, 0.4, 0.55),
  }
}

/** 六种屋顶类型的默认档案（尺寸按 Blender 参考场景估算） */
export const ROOF_PRESETS: Record<RoofType, RoofConfig> = {
  parapet: {
    enabled: true,
    type: 'parapet',
    parapetHeight: 1.2,
    parapetThickness: 0.35,
    corniceOffset: 0.6,
    corniceThickness: 0.25,
    crownCount: 4,
    crownHeight: 3,
    crownThickness: 0.3,
    penthouseWidthRatio: 0.5,
    penthouseDepthRatio: 0.5,
    penthouseHeight: 3.6,
    penthouseInset: 0.6,
    skylightCount: 0,
    skylightWidth: 3,
    skylightHeight: 0.35,
    eaveOffset: 0,
    eaveThickness: 0.3,
    // 屋面设备改由 3D 中逐个点击放置，新屋顶默认不自动布置
    equipmentCount: 0,
    equipmentHeight: 2.2,
    equipmentSize: 2.6,
    mechZoneRatio: 0.56,
    solarZoneQuota: 0.3,
    frontFace: null,
    parts: roofParts('#4a4d50', '#c9c6bf', '#3b3d3e', '#31423d'),
    seed: 13,
  },
  lattice: {
    enabled: true,
    type: 'lattice',
    parapetHeight: 0.4,
    parapetThickness: 0.3,
    corniceOffset: 0.45,
    corniceThickness: 0.22,
    crownCount: 4,
    crownHeight: 3.2,
    crownThickness: 0.3,
    penthouseWidthRatio: 0.5,
    penthouseDepthRatio: 0.5,
    penthouseHeight: 3.6,
    penthouseInset: 0.6,
    skylightCount: 0,
    skylightWidth: 3,
    skylightHeight: 0.35,
    eaveOffset: 0,
    eaveThickness: 0.3,
    equipmentCount: 0,
    equipmentHeight: 2,
    equipmentSize: 2.4,
    mechZoneRatio: 0.56,
    solarZoneQuota: 0.3,
    frontFace: null,
    parts: roofParts('#3f4245', '#cac7c0', '#33353a', '#2e3f3a'),
    seed: 29,
  },
  oval_rim: {
    enabled: true,
    type: 'oval_rim',
    parapetHeight: 0.9,
    parapetThickness: 0.4,
    corniceOffset: 0.8,
    corniceThickness: 0.35,
    crownCount: 4,
    crownHeight: 3,
    crownThickness: 0.3,
    penthouseWidthRatio: 0.5,
    penthouseDepthRatio: 0.5,
    penthouseHeight: 3.6,
    penthouseInset: 0.6,
    skylightCount: 0,
    skylightWidth: 3,
    skylightHeight: 0.35,
    eaveOffset: 0,
    eaveThickness: 0.3,
    equipmentCount: 0,
    equipmentHeight: 2,
    equipmentSize: 2.4,
    mechZoneRatio: 0.56,
    solarZoneQuota: 0.3,
    frontFace: null,
    parts: roofParts('#42464a', '#d5d2cb', '#3a3c40', '#334740'),
    seed: 43,
  },
  penthouse: {
    enabled: true,
    type: 'penthouse',
    parapetHeight: 1,
    parapetThickness: 0.3,
    corniceOffset: 0.5,
    corniceThickness: 0.2,
    crownCount: 4,
    crownHeight: 3,
    crownThickness: 0.3,
    penthouseWidthRatio: 0.55,
    penthouseDepthRatio: 0.5,
    penthouseHeight: 3.6,
    penthouseInset: 0.6,
    skylightCount: 0,
    skylightWidth: 3,
    skylightHeight: 0.35,
    eaveOffset: 0,
    eaveThickness: 0.3,
    // 屋面设备改由 3D 中逐个点击放置，新屋顶默认不自动布置
    equipmentCount: 0,
    equipmentHeight: 1.6,
    equipmentSize: 1.8,
    mechZoneRatio: 0.56,
    solarZoneQuota: 0.3,
    frontFace: null,
    parts: roofParts('#494b4e', '#cfccc4', '#3f4144', '#2c3d38'),
    seed: 59,
  },
  skylight: {
    enabled: true,
    type: 'skylight',
    parapetHeight: 0.8,
    parapetThickness: 0.3,
    corniceOffset: 0.4,
    corniceThickness: 0.2,
    crownCount: 4,
    crownHeight: 3,
    crownThickness: 0.3,
    penthouseWidthRatio: 0.5,
    penthouseDepthRatio: 0.5,
    penthouseHeight: 3.6,
    penthouseInset: 0.6,
    skylightCount: 3,
    skylightWidth: 3.5,
    skylightHeight: 0.4,
    eaveOffset: 0,
    eaveThickness: 0.3,
    // 屋面设备改由 3D 中逐个点击放置，新屋顶默认不自动布置
    equipmentCount: 0,
    equipmentHeight: 1.8,
    equipmentSize: 2,
    mechZoneRatio: 0.56,
    solarZoneQuota: 0.3,
    frontFace: null,
    parts: roofParts('#43464a', '#ccc9c2', '#3d3f42', '#2e4a43'),
    seed: 71,
  },
  eave: {
    enabled: true,
    type: 'eave',
    parapetHeight: 0.5,
    parapetThickness: 0.4,
    corniceOffset: 0,
    corniceThickness: 0.2,
    crownCount: 4,
    crownHeight: 3,
    crownThickness: 0.3,
    penthouseWidthRatio: 0.5,
    penthouseDepthRatio: 0.5,
    penthouseHeight: 3.6,
    penthouseInset: 0.6,
    skylightCount: 0,
    skylightWidth: 3,
    skylightHeight: 0.35,
    eaveOffset: 1.2,
    eaveThickness: 0.35,
    equipmentCount: 0,
    equipmentHeight: 1.6,
    equipmentSize: 2,
    mechZoneRatio: 0.56,
    solarZoneQuota: 0.3,
    frontFace: null,
    parts: roofParts('#3d4043', '#d0cdc6', '#3a3c3f', '#31433e'),
    seed: 83,
  },
}

/** 取某类型的默认档案（深拷贝，调用方可直接改写） */
export function defaultRoofConfig(type: RoofType): RoofConfig {
  const preset = ROOF_PRESETS[type]
  return { ...preset, parts: clonePartMaterials(preset.parts), equipment: [] }
}

export function cloneRoofConfig(config: RoofConfig): RoofConfig {
  return {
    ...config,
    parts: clonePartMaterials(config.parts),
    equipment: (config.equipment ?? []).map((item) => ({ ...item })),
  }
}

/** 旧版四个颜色字段到构件材质的兼容映射 */
function legacyPartDefaults(source: Record<string, unknown>, preset: RoofConfig): Record<RoofPartKey, PartMaterialConfig> {
  let parts = clonePartMaterials(preset.parts)
  const deck = normalizeHexColor(source.deckColor, parts.deck.color)
  const wall = normalizeHexColor(source.wallColor, parts.cornice.color)
  const metal = normalizeHexColor(source.metalColor, parts.crown.color)
  const glass = normalizeHexColor(source.glassColor, parts.skylight.color)
  parts = withPartColor<RoofPartKey>(parts, 'deck', deck)
  for (const key of ['cornice', 'parapet', 'penthouse', 'zonePad'] as RoofPartKey[]) {
    parts = withPartColor(parts, key, wall)
  }
  for (const key of ['crown', 'skylightFrame', 'equipment', 'infrastructure'] as RoofPartKey[]) {
    parts = withPartColor(parts, key, metal)
  }
  for (const key of ['skylight', 'solar'] as RoofPartKey[]) {
    parts = withPartColor(parts, key, glass)
  }
  return parts
}

/**
 * 归一化外部写入的屋顶配置：类型非法回退 parapet，数值按范围裁剪，
 * 颜色必须是合法 hex；`null`/非对象返回 null（表示未配置屋顶）。
 */
export function normalizeRoofConfig(raw: unknown): RoofConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const type = isRoofType(source.type) ? source.type : 'parapet'
  const preset = ROOF_PRESETS[type]
  const config: RoofConfig = { ...preset, enabled: source.enabled !== false }

  for (const key of NUMERIC_KEYS) {
    const value = Number(source[key])
    ;(config as any)[key] = Number.isFinite(value) ? clampRoofNumber(key, value) : preset[key]
  }

  config.parts = normalizePartMaterials(source.parts, legacyPartDefaults(source, preset), ROOF_PART_KEYS)
  config.equipment = normalizeRoofEquipment(source.equipment)

  const front = Number(source.frontFace)
  config.frontFace =
    source.frontFace === null || source.frontFace === undefined
      ? null
      : Number.isInteger(front) && front >= 0
        ? front
        : null

  return config
}

/** 屋顶几何/材质签名：任何参数变化都会触发重建 */
export function roofCacheKey(config: RoofConfig): string {
  const parts: string[] = [
    config.enabled ? '1' : '0',
    config.type,
    partMaterialsSignature(config.parts, ROOF_PART_KEYS),
    config.frontFace == null ? 'auto' : String(config.frontFace),
  ]
  for (const key of NUMERIC_KEYS) parts.push(String((config as any)[key]))
  // 手动放置设备：位置或类别变化都要重建
  parts.push(
    (config.equipment ?? [])
      .map((item) => `${item.id}:${item.kind}:${item.x},${item.z}`)
      .join(';'),
  )
  return parts.join('|')
}
