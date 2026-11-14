/**
 * 程序化门头招牌贴图
 *
 * 仅依赖 Canvas 2D，编辑器与 standalone-engine 共用同一生成逻辑，
 * 保证两端招牌文字与配色一致。
 */
import * as THREE from 'three'
import type { EntranceGateConfig } from '../../shared/types'
import { gateSignCacheKey, GATE_SIGN_MAX_LENGTH } from './gateTypes'

export const GATE_SIGN_TEXTURE_WIDTH = 512
export const GATE_SIGN_TEXTURE_HEIGHT = 128
export const GATE_SIGN_CACHE_LIMIT = 32

const cache = new Map<string, HTMLCanvasElement>()

function darken(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#1f2429'
  const n = parseInt(m[1], 16)
  const r = Math.round(((n >> 16) & 0xff) * factor)
  const g = Math.round(((n >> 8) & 0xff) * factor)
  const b = Math.round((n & 0xff) * factor)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** 生成招牌 Canvas（背景色 + 居中文字），无文字时返回 null */
export function getGateSignCanvas(config: EntranceGateConfig): HTMLCanvasElement | null {
  const text = String(config.signText ?? '').trim().slice(0, GATE_SIGN_MAX_LENGTH)
  if (!text) return null
  const key = gateSignCacheKey(config)
  const hit = cache.get(key)
  if (hit) {
    // LRU：命中后移到队尾
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  const canvas = document.createElement('canvas')
  canvas.width = GATE_SIGN_TEXTURE_WIDTH
  canvas.height = GATE_SIGN_TEXTURE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const bg = darken(config.doorColor, 0.55)
  const bgLight = darken(config.doorColor, 0.85)
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  gradient.addColorStop(0, bgLight)
  gradient.addColorStop(1, bg)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 边框：使用门框色，弱化处理
  ctx.strokeStyle = config.frameColor
  ctx.globalAlpha = 0.75
  ctx.lineWidth = 6
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16)
  ctx.globalAlpha = 1

  // 文字：字号按长度自适应，最多 512px 宽内留 40px 边距
  const fontSize = Math.min(72, Math.floor(420 / Math.max(1, text.length)) + 26)
  ctx.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2)

  cache.set(key, canvas)
  if (cache.size > GATE_SIGN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  return canvas
}

/** 清空招牌贴图缓存（场景重建 / 卸载时调用） */
export function clearGateSignCache(): void {
  cache.clear()
}

/**
 * 招牌 THREE 贴图池：同一「文字 + 配色」只上传一次 GPU 纹理，多座大门共享。
 * 引用计数归零时释放，避免参数频繁调整导致纹理泄漏。
 */
const textureCache = new Map<string, { tex: THREE.CanvasTexture; refs: number }>()

/** 取得（并计数）招牌贴图；无文字时返回 null */
export function acquireGateSignTexture(config: EntranceGateConfig): THREE.CanvasTexture | null {
  const canvas = getGateSignCanvas(config)
  if (!canvas) return null
  const key = gateSignCacheKey(config)
  const hit = textureCache.get(key)
  if (hit) {
    hit.refs++
    return hit.tex
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  textureCache.set(key, { tex, refs: 1 })
  return tex
}

/** 释放一次招牌贴图引用，归零时销毁 GPU 纹理 */
export function releaseGateSignTexture(key: string): void {
  const hit = textureCache.get(key)
  if (!hit) return
  hit.refs--
  if (hit.refs > 0) return
  hit.tex.dispose()
  textureCache.delete(key)
}

