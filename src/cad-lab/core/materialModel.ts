/**
 * 墙体 PBR 材质的纯参数模型。
 *
 * 默认值对齐参考视频里的哑光涂料墙面：近白暖灰、非金属、高粗糙度。
 * 金属度 1 / 粗糙度 0.5 在纯色平墙上看起来像抛光金属板，因此改为可选预设。
 * 所有校验都在这里完成，非法输入直接抛错，不做静默钳制 —— 输入范围由设置面板约束。
 */

/** 墙体 PBR 材质参数 */
export interface WallMaterialParams {
  /** 十六进制颜色，形如 `#8c8c8c` */
  color: string
  /** 金属度 0–1 */
  metalness: number
  /** 粗糙度 0–1 */
  roughness: number
}

/** 材质预设 */
export interface WallMaterialPreset {
  /** 预设标识 */
  id: 'plaster' | 'concrete' | 'metal'
  /** 面板显示名 */
  label: string
  /** 预设参数 */
  params: WallMaterialParams
}

/** 默认墙体材质：哑光石膏涂料，最接近参考视频的墙面观感 */
export const DEFAULT_WALL_MATERIAL: WallMaterialParams = {
  color: '#d8d4cc',
  metalness: 0,
  roughness: 0.85,
}

/** 材质预设：按质感从哑光到金属排列 */
export const WALL_MATERIAL_PRESETS: WallMaterialPreset[] = [
  {
    id: 'plaster',
    label: '哑光涂料',
    params: { ...DEFAULT_WALL_MATERIAL },
  },
  {
    id: 'concrete',
    label: '清水混凝土',
    params: { color: '#a9a8a3', metalness: 0.05, roughness: 0.92 },
  },
  {
    id: 'metal',
    label: '金属板',
    params: { color: '#8c8c8c', metalness: 1, roughness: 0.5 },
  },
]

/** 十六进制颜色格式 */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** 校验并返回规范化材质参数；任一项非法时抛出具名字段的中文错误 */
export function normalizeWallMaterial(raw: WallMaterialParams): WallMaterialParams {
  if (!HEX_COLOR_PATTERN.test(raw.color)) {
    throw new Error(`墙体颜色必须是 #RRGGBB 格式：${raw.color}`)
  }
  if (!Number.isFinite(raw.metalness) || raw.metalness < 0 || raw.metalness > 1) {
    throw new Error(`金属度必须在 0–1 之间：${raw.metalness}`)
  }
  if (!Number.isFinite(raw.roughness) || raw.roughness < 0 || raw.roughness > 1) {
    throw new Error(`粗糙度必须在 0–1 之间：${raw.roughness}`)
  }
  return {
    color: raw.color.toLowerCase(),
    metalness: raw.metalness,
    roughness: raw.roughness,
  }
}
