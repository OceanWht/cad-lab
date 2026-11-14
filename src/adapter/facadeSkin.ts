/**
 * 墙面立面贴图：把所选立面风格的 tile（一个开间 × 一个层高）铺到墙带外表面。
 *
 * 只生成立面附件（竖梃 / 窗台 / 腰线等）时，风格差异仅体现在少量线脚上，
 * 面板里切换风格几乎看不出变化；墙面本身必须同时换装，风格切换才可见。
 *
 * 墙带 UV 由 `boxProjectUvs` 以米为单位生成（SURFACE_TILE_METERS = 1），
 * 因此 repeat 直接取 (1/开间, 1/层高) 就能保证贴图比例与真实尺寸一致。
 */

import * as THREE from 'three'
import type { FacadeFaceConfig } from '../shared/types'
import {
  FACADE_TEXTURE_SIZE,
  facadeTextureRepeat,
  normalizeFacadeConfig,
} from '../lib/facade/facadeTypes'
import { getFacadeCanvases } from '../lib/facade/facadeTexture'

/** 墙面贴图各向异性上限（不依赖渲染器能力查询，取稳妥值） */
const FACADE_WALL_ANISOTROPY = 4

/**
 * 按立面配置创建墙面颜色贴图。
 *
 * 配置非法（缺少合法面序号 / 锚点）时返回 null，由调用方显式处理，
 * 不使用默认风格兜底。
 */
export function createFacadeWallTexture(
  config: FacadeFaceConfig,
  size = FACADE_TEXTURE_SIZE,
): THREE.CanvasTexture | null {
  const normalized = normalizeFacadeConfig(config)
  if (!normalized) return null

  const canvases = getFacadeCanvases(normalized, size)
  const [repeatX, repeatY] = facadeTextureRepeat(normalized)
  const texture = new THREE.CanvasTexture(canvases.color)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(repeatX, repeatY)
  texture.anisotropy = FACADE_WALL_ANISOTROPY
  texture.needsUpdate = true
  return texture
}

/** 释放墙面贴图（材质切换完成后调用） */
export function disposeFacadeWallTexture(texture: THREE.Texture | null): void {
  if (!texture) return
  texture.dispose()
}
