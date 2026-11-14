/**
 * 蓝天白云背景纹理。
 *
 * 用 2:1 的等距柱状投影画布画一张「天顶深蓝 → 地平线浅白 → 地面灰」的渐变，
 * 再叠上确定性云团，交给 three.js 作为 `scene.background` 与 `scene.environment`。
 * 同一张纹理既当背景又当环境光照，金属 / 粗糙材质都能拿到天空的反射色。
 */

import * as THREE from 'three'
import { cloudPuffs } from '../core/skyModel'

/** 画布宽高比固定 2:1，符合等距柱状投影要求 */
const SKY_WIDTH = 2048
const SKY_HEIGHT = 1024
/** 云团种子与数量：固定值，保证每次打开页面看到同一片天空 */
const CLOUD_SEED = 20261110
const CLOUD_CLUSTERS = 26
/** 地平线颜色，同时用作雾色，让远处建筑与天空自然衔接 */
export const HORIZON_COLOR = 0xd7e7f6
/** 地面半球颜色，避免背景下半球突兀 */
export const SKY_GROUND_COLOR = 0x9aa0a0

/** 画天空渐变：v = 0 天顶、v = 0.5 地平线、v = 1 正下方地面 */
function paintGradient(context: CanvasRenderingContext2D): void {
  const gradient = context.createLinearGradient(0, 0, 0, SKY_HEIGHT)
  gradient.addColorStop(0, '#2f6fc4')
  gradient.addColorStop(0.28, '#63a0dd')
  gradient.addColorStop(0.46, '#b9d7f0')
  gradient.addColorStop(0.5, '#d7e7f6')
  gradient.addColorStop(0.52, '#b9bdb6')
  gradient.addColorStop(1, '#8f938f')
  context.fillStyle = gradient
  context.fillRect(0, 0, SKY_WIDTH, SKY_HEIGHT)
}

/** 用径向渐变堆出蓬松的白云 */
function paintClouds(context: CanvasRenderingContext2D): void {
  for (const puff of cloudPuffs(CLOUD_SEED, CLOUD_CLUSTERS)) {
    const x = puff.u * SKY_WIDTH
    const y = puff.v * SKY_HEIGHT
    const radius = puff.radius * SKY_WIDTH
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, `rgba(255, 255, 255, ${puff.alpha})`)
    gradient.addColorStop(0.55, `rgba(255, 255, 255, ${puff.alpha * 0.55})`)
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
    context.fillStyle = gradient
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }
}

/**
 * 创建天空纹理。
 * 调用方负责把它同时挂到 `scene.background` 与 `scene.environment`，并在销毁时 dispose。
 */
export function createSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = SKY_WIDTH
  canvas.height = SKY_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建天空纹理的 2D 画布上下文')

  paintGradient(context)
  paintClouds(context)

  const texture = new THREE.CanvasTexture(canvas)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}
