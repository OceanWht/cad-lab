/**
 * 程序化构件材质：构件键、默认材质、归一化、签名与贴图应用。
 *
 * 底座与屋顶的每个构件独立成网格（一个构件 = 一个 draw call），
 * 材质参数（颜色 / 金属度 / 粗糙度）由构建器在生成时装配，
 * 贴图则在挂载场景后由 `applyPartTextures` 异步补挂（贴图缩放按 1 米平铺）。
 *
 * 编辑器与 standalone-engine 共用本模块，保证两端材质与贴图规则一致。
 */
import * as THREE from 'three'
import type { FacadeReliefPartKey, PartMaterialConfig, PodiumPartKey, RoofPartKey } from '../../shared/types'

export const PODIUM_PART_KEYS: readonly PodiumPartKey[] = [
  'tier',
  'band',
  'recess',
  'louver',
  'rail',
  'column',
  'canopy',
  'steps',
  'planter',
]

export const ROOF_PART_KEYS: readonly RoofPartKey[] = [
  'deck',
  'cornice',
  'parapet',
  'crown',
  'penthouse',
  'skylight',
  'skylightFrame',
  'equipment',
  'solar',
  'zonePad',
  'infrastructure',
]

export const FACADE_PART_KEYS: readonly FacadeReliefPartKey[] = [
  'mullion',
  'reveal',
  'sill',
  'slabBand',
  'cornice',
  'parapet',
  'balconySlab',
  'balconyRail',
]

export interface PartOption<K extends string> {
  key: K
  label: string
}

export const PODIUM_PART_OPTIONS: ReadonlyArray<PartOption<PodiumPartKey>> = [
  { key: 'tier', label: '台基' },
  { key: 'band', label: '裙墙' },
  { key: 'recess', label: '内凹背板' },
  { key: 'louver', label: '横向百叶' },
  { key: 'rail', label: '扶手/横梁' },
  { key: 'column', label: '柱廊' },
  { key: 'canopy', label: '雨棚' },
  { key: 'steps', label: '台阶/入口平台' },
  { key: 'planter', label: '花池' },
]

export const ROOF_PART_OPTIONS: ReadonlyArray<PartOption<RoofPartKey>> = [
  { key: 'deck', label: '屋面板' },
  { key: 'cornice', label: '挑檐线脚' },
  { key: 'parapet', label: '女儿墙' },
  { key: 'crown', label: '架空冠' },
  { key: 'penthouse', label: '屋顶机房' },
  { key: 'skylight', label: '天窗玻璃' },
  { key: 'skylightFrame', label: '天窗压条' },
  { key: 'equipment', label: '屋面设备' },
  { key: 'solar', label: '光伏板' },
  { key: 'zonePad', label: '设备区平台' },
  { key: 'infrastructure', label: '步道/护栏' },
]

export const FACADE_PART_OPTIONS: ReadonlyArray<PartOption<FacadeReliefPartKey>> = [
  { key: 'mullion', label: '竖梃' },
  { key: 'reveal', label: '窗洞内凹框' },
  { key: 'sill', label: '窗台' },
  { key: 'slabBand', label: '楼层腰线' },
  { key: 'cornice', label: '檐口' },
  { key: 'parapet', label: '女儿墙' },
  { key: 'balconySlab', label: '阳台板' },
  { key: 'balconyRail', label: '阳台栏杆' },
]

/** 面板数值范围 */
export const PART_MATERIAL_RANGES = {
  roughness: { min: 0, max: 1, step: 0.01 },
  metalness: { min: 0, max: 1, step: 0.01 },
  textureScale: { min: 0.05, max: 20, step: 0.05 },
} as const

export function makePartMaterial(color: string, roughness: number, metalness: number): PartMaterialConfig {
  return { color, roughness, metalness, textureId: '', textureScale: 1 }
}

/**
 * 立面装饰构件的默认材质。
 * 颜色保持纯白、粗糙度/金属度保持 1：不改变 trimsheet 贴图的原始观感，
 * 面板下调后才叠加逐构件效果。
 */
export function makeFacadePartMaterials(): Record<FacadeReliefPartKey, PartMaterialConfig> {
  const out = {} as Record<FacadeReliefPartKey, PartMaterialConfig>
  for (const key of FACADE_PART_KEYS) out[key] = makePartMaterial('#ffffff', 1, 1)
  return out
}

export function clonePartMaterials<K extends string>(
  parts: Record<K, PartMaterialConfig>,
): Record<K, PartMaterialConfig> {
  const out = {} as Record<K, PartMaterialConfig>
  for (const key of Object.keys(parts) as K[]) out[key] = { ...parts[key] }
  return out
}

export function withPartColor<K extends string>(
  parts: Record<K, PartMaterialConfig>,
  key: K,
  color: string,
): Record<K, PartMaterialConfig> {
  return { ...parts, [key]: { ...parts[key], color } }
}

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim() : fallback
}

function clamp01(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100
}

function clampScale(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const { min, max } = PART_MATERIAL_RANGES.textureScale
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100
}

/**
 * 归一化构件材质表：缺失字段回退到 defaults（预设或旧版配色），
 * 颜色必须是合法 hex，金属度/粗糙度裁剪到 0~1。
 */
export function normalizePartMaterials<K extends string>(
  raw: unknown,
  defaults: Record<K, PartMaterialConfig>,
  keys: readonly K[],
): Record<K, PartMaterialConfig> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as Record<K, PartMaterialConfig>
  for (const key of keys) {
    const def = defaults[key]
    const item = source[key]
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const textureId = typeof record.textureId === 'string' ? record.textureId.trim() : ''
    const textureName = typeof record.textureName === 'string' ? record.textureName.trim() : ''
    const textureUrl = typeof record.textureUrl === 'string' ? record.textureUrl.trim() : ''
    out[key] = {
      color: normalizeHexColor(record.color, def.color),
      roughness: clamp01(record.roughness, def.roughness),
      metalness: clamp01(record.metalness, def.metalness),
      textureId,
      textureScale: clampScale(record.textureScale, def.textureScale ?? 1),
      ...(textureName ? { textureName } : {}),
      ...(textureUrl ? { textureUrl } : {}),
    }
  }
  return out
}

/** 构件材质签名：颜色/金属度/粗糙度/贴图任一变化都会触发重建 */
export function partMaterialsSignature<K extends string>(
  parts: Record<K, PartMaterialConfig>,
  keys: readonly K[],
): string {
  return keys
    .map((key) => {
      const part = parts[key]
      return `${key},${part.color},${part.roughness},${part.metalness},${part.textureId ?? ''},${part.textureScale ?? 1}`
    })
    .join(';')
}

/* -------------------------------------------------------------------------- */
/* 贴图应用                                                                     */
/* -------------------------------------------------------------------------- */

export type PartTextureResolver = (textureId: string) => Promise<THREE.Texture | null>

interface PartMeshUserData {
  __buildingPart?: string
  __partBaseMaterial?: THREE.MeshStandardMaterial
  __partOwnedMaterial?: THREE.MeshStandardMaterial
  __partOwnedTexture?: THREE.Texture
  __partTextureKey?: string
  __partTextureToken?: number
}

const TEXTURE_REPEAT_BASE = 1

/**
 * 按构件材质表给组内每个构件网格补挂贴图。
 *
 * - 无贴图：恢复构建器创建的共享基础材质；
 * - 有贴图：克隆基础材质并设置 `map`，repeat = 1 / textureScale（1 米平铺）；
 * - 通过 userData 记录签名与令牌，重复调用不会重复加载，异步返回过期则丢弃。
 */
export function applyPartTextures(
  group: THREE.Object3D,
  parts: Record<string, PartMaterialConfig>,
  resolveTexture: PartTextureResolver,
  options: { mapChannel?: number } = {},
): void {
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
    const data = mesh.userData as PartMeshUserData
    const partKey = data.__buildingPart
    if (!partKey) return
    const spec = parts[partKey]
    const material = Array.isArray(mesh.material) ? null : (mesh.material as THREE.MeshStandardMaterial | null)
    const base = data.__partBaseMaterial ?? material
    if (!spec || !base) return
    data.__partBaseMaterial = base

    const source = (spec.textureUrl || spec.textureId || '').trim()
    const scale = Math.max(0.05, Number(spec.textureScale ?? 1) || 1)
    const signature = source ? `${source}|${scale}` : ''
    if (data.__partTextureKey === signature) return
    data.__partTextureKey = signature
    const token = (data.__partTextureToken ?? 0) + 1
    data.__partTextureToken = token

    const releaseOwned = (): void => {
      data.__partOwnedMaterial?.dispose()
      data.__partOwnedTexture?.dispose()
      data.__partOwnedMaterial = undefined
      data.__partOwnedTexture = undefined
    }

    if (!source) {
      releaseOwned()
      mesh.material = base
      return
    }

    resolveTexture(source)
      .then((texture) => {
        if (!texture) return
        // 网格已重建 / 配置已变化 / 已挂载贴图：丢弃本次结果
        if (data.__partTextureToken !== token || !mesh.parent) {
          texture.dispose()
          return
        }
        releaseOwned()
        const cloned = texture.clone()
        cloned.wrapS = THREE.RepeatWrapping
        cloned.wrapT = THREE.RepeatWrapping
        cloned.colorSpace = THREE.SRGBColorSpace
        cloned.repeat.set(TEXTURE_REPEAT_BASE / scale, TEXTURE_REPEAT_BASE / scale)
        // 立面装饰的 uv 为 trimsheet 分区坐标，自定义贴图改用 uv1（平面米坐标）
        cloned.channel = options.mapChannel ?? 0
        cloned.needsUpdate = true
        const materialWithMap = base.clone()
        materialWithMap.map = cloned
        materialWithMap.color.set('#ffffff')
        materialWithMap.needsUpdate = true
        mesh.material = materialWithMap
        data.__partOwnedMaterial = materialWithMap
        data.__partOwnedTexture = cloned
      })
      .catch(() => {
        // 贴图加载失败时保持基础材质
      })
  })
}

/** 释放构件自己的贴图材质（共享基础材质不释放） */
export function disposePartTextures(group: THREE.Object3D): void {
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
    const data = mesh.userData as PartMeshUserData
    data.__partTextureToken = (data.__partTextureToken ?? 0) + 1
    data.__partOwnedTexture?.dispose()
    data.__partOwnedMaterial?.dispose()
    data.__partOwnedTexture = undefined
    data.__partOwnedMaterial = undefined
    data.__partTextureKey = undefined
  })
}
