/**
 * 程序化立面贴图生成
 *
 * 一个模块 tile 覆盖「一个开间 × 一个层高」，配合平铺参数在整栋建筑上重复，
 * 即可在任意长度的墙面上保持真实比例（窗格不随墙长拉伸）。
 *
 * 输出通道（与 design.md 的通道打包约定一致）：
 * - color：墙板、窗框、玻璃、竖梃投影、楼层腰线与窗台
 * - normal：由高度图 Sobel 梯度得到的窗框凹凸（强度与 revealDepth 联动）
 * - emissive：按 seed 稳定点亮的窗格（仅 emissiveIntensity > 0 时生成）
 * - orm：R = AO（窗洞内凹 / 楼层交界 / 角部）、G = roughness、B = metalness
 *
 * 另生成元素 trimsheet（2×2 atlas：金属框 / 石材带 / 百叶 / 玻璃），
 * 供 facadeRelief 的几何附件按 UV 分区取样，避免为附件额外加载位图资产。
 *
 * 生成逻辑只依赖 Canvas 2D，编辑器与 standalone-engine 共用同一份实现。
 */
import type { FacadeFaceConfig, FacadeStyle } from '../../shared/types'
import {
  FACADE_CACHE_LIMIT,
  FACADE_TEXTURE_SIZE,
  facadeCacheKey,
  normalizeFacadeConfig,
  normalizeFacadeProfile,
} from './facadeTypes'

export interface FacadeCanvases {
  color: HTMLCanvasElement
  normal: HTMLCanvasElement | null
  emissive: HTMLCanvasElement | null
  /** ORM 打包：R=AO、G=roughness、B=metalness */
  orm: HTMLCanvasElement
  /** 元素 trimsheet（几何附件取样） */
  trimsheet: FacadeTrimsheet
}

export interface FacadeTrimsheet {
  color: HTMLCanvasElement
  /** 与主立面同格式的 ORM（R=AO、G=roughness、B=metalness） */
  orm: HTMLCanvasElement
}

/** trimsheet 分区：2×2 atlas，按 UV 坐标（v 向上）声明 */
export type FacadeTrimKey = 'metal' | 'stone' | 'louver' | 'glass'

export interface FacadeTrimRegion {
  u0: number
  v0: number
  size: number
}

export const FACADE_TRIM_REGIONS: Record<FacadeTrimKey, FacadeTrimRegion> = {
  metal: { u0: 0, v0: 0.5, size: 0.5 },
  stone: { u0: 0.5, v0: 0.5, size: 0.5 },
  louver: { u0: 0, v0: 0, size: 0.5 },
  glass: { u0: 0.5, v0: 0, size: 0.5 },
}

interface FacadeStyleShape {
  /** 窗格横向分格数 */
  cols: number
  /** 窗格纵向分格数 */
  rows: number
  /** 窗框厚度（相对窗洞短边） */
  frameRatio: number
  /** 窗顶距本层顶部（真实米） */
  headGap: number
  /** 楼板带高度（相对层高，档案缺省时回退） */
  slabBand: number
  /** 亮窗概率 */
  litChance: number
  /** 玻璃反射条强度 */
  reflect: number
}

const STYLE_SHAPES: Record<FacadeStyle, FacadeStyleShape> = {
  factory: { cols: 3, rows: 2, frameRatio: 0.09, headGap: 0.6, slabBand: 0.08, litChance: 0.35, reflect: 0.05 },
  residential: { cols: 2, rows: 1, frameRatio: 0.1, headGap: 0.5, slabBand: 0.06, litChance: 0.5, reflect: 0.06 },
  office: { cols: 1, rows: 1, frameRatio: 0.045, headGap: 0.35, slabBand: 0.14, litChance: 0.42, reflect: 0.12 },
  hospital: { cols: 2, rows: 2, frameRatio: 0.075, headGap: 0.55, slabBand: 0.05, litChance: 0.4, reflect: 0.05 },
  curtain_wall: { cols: 1, rows: 1, frameRatio: 0.04, headGap: 0.25, slabBand: 0.1, litChance: 0.4, reflect: 0.16 },
  concrete_punched: { cols: 2, rows: 1, frameRatio: 0.08, headGap: 0.6, slabBand: 0.12, litChance: 0.4, reflect: 0.06 },
  brutalist_banded: { cols: 2, rows: 1, frameRatio: 0.06, headGap: 0.5, slabBand: 0.2, litChance: 0.42, reflect: 0.06 },
  brick_apartment: { cols: 2, rows: 1, frameRatio: 0.1, headGap: 0.5, slabBand: 0.06, litChance: 0.5, reflect: 0.05 },
  stone_office: { cols: 2, rows: 1, frameRatio: 0.07, headGap: 0.45, slabBand: 0.12, litChance: 0.42, reflect: 0.08 },
}

/** 模块尺寸（真实米）：纹理分区与几何附件共用同一套计算，避免各自取整 */
export interface FacadeModuleMetrics {
  bayWidth: number
  floorHeight: number
  windowWidth: number
  windowHeight: number
  windowBottom: number
  windowTop: number
  headGap: number
  cols: number
  rows: number
}

export function facadeModuleMetrics(config: FacadeFaceConfig): FacadeModuleMetrics {
  const shape = STYLE_SHAPES[config.style] ?? STYLE_SHAPES.office
  const bayWidth = Math.max(0.4, Number(config.bayWidth) || 3)
  const floorHeight = Math.max(0.4, Number(config.floorHeight) || 3)
  const windowWidth = Math.min(bayWidth * 0.92, Math.max(0.3, (Number(config.windowRatio) || 0.5) * bayWidth))
  const windowBottom = Math.max(0, Math.min(Number(config.sillHeight) || 0, floorHeight - 0.4))
  const windowHeight = Math.max(0.3, floorHeight - windowBottom - shape.headGap)
  return {
    bayWidth,
    floorHeight,
    windowWidth,
    windowHeight,
    windowBottom,
    windowTop: windowBottom + windowHeight,
    headGap: shape.headGap,
    cols: shape.cols,
    rows: shape.rows,
  }
}

function createCanvas(size = FACADE_TEXTURE_SIZE): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return [255, 255, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToCss(r: number, g: number, b: number, alpha = 1): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return alpha >= 1 ? `rgb(${c(r)}, ${c(g)}, ${c(b)})` : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${alpha})`
}

/** ratio > 0 提亮，< 0 压暗 */
function shade(hex: string, ratio: number): string {
  const [r, g, b] = hexToRgb(hex)
  if (ratio >= 0) {
    return rgbToCss(r + (255 - r) * ratio, g + (255 - g) * ratio, b + (255 - b) * ratio)
  }
  const k = 1 + ratio
  return rgbToCss(r * k, g * k, b * k)
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

interface FacadeLayout {
  size: number
  pxPerMeterX: number
  pxPerMeterY: number
  slabPx: number
  mullionPx: number
  windowX: number
  windowY: number
  windowW: number
  windowH: number
  framePx: number
  glassX: number
  glassY: number
  glassW: number
  glassH: number
  sillPx: number
}

function computeLayout(config: FacadeFaceConfig, size = FACADE_TEXTURE_SIZE): FacadeLayout {
  const metrics = facadeModuleMetrics(config)
  const pxPerMeterX = size / metrics.bayWidth
  const pxPerMeterY = size / metrics.floorHeight

  const windowW = Math.max(4, metrics.windowWidth * pxPerMeterX)
  const windowH = Math.max(4, metrics.windowHeight * pxPerMeterY)
  const windowX = (size - windowW) / 2
  // 以层底为基准：窗底 = sillHeight，窗顶 = 层高 - headGap
  const windowY = Math.max(1, size - metrics.windowTop * pxPerMeterY)

  const framePx = Math.max(1.5, STYLE_SHAPES[config.style].frameRatio * Math.min(windowW, windowH))
  const profile = normalizeFacadeProfile(config, config.style)
  return {
    size,
    pxPerMeterX,
    pxPerMeterY,
    slabPx: Math.max(2, Math.min(size * 0.36, profile.slabBandHeight * pxPerMeterY)),
    mullionPx: Math.max(1, Math.min(size * 0.2, profile.mullionWidth * pxPerMeterX)),
    windowX,
    windowY,
    windowW,
    windowH,
    framePx,
    glassX: windowX + framePx,
    glassY: windowY + framePx,
    glassW: Math.max(1, windowW - framePx * 2),
    glassH: Math.max(1, windowH - framePx * 2),
    sillPx: Math.max(2, Math.min(pxPerMeterY * 0.14, windowY + windowH)),
  }
}

/** 玻璃分格（mullion）线位置，供颜色图 / 高度图 / ORM 共用 */
function mullionPositions(start: number, length: number, count: number): number[] {
  const out: number[] = []
  for (let i = 1; i < count; i++) out.push(start + (length * i) / count)
  return out
}

function drawColorCanvas(config: FacadeFaceConfig, layout: FacadeLayout): HTMLCanvasElement {
  const canvas = createCanvas(layout.size)
  const ctx = canvas.getContext('2d')!
  const shape = STYLE_SHAPES[config.style]
  const { size } = layout

  // 墙板底色
  ctx.fillStyle = config.wallColor
  ctx.fillRect(0, 0, size, size)

  // 楼层腰线（层与层之间的分隔）
  ctx.fillStyle = shade(config.wallColor, -0.16)
  ctx.fillRect(0, 0, size, layout.slabPx)

  // 竖梃投影：跨 tile 接缝，左右各画一半，相邻 tile 拼接成完整竖梃
  const halfMullion = layout.mullionPx / 2
  ctx.fillStyle = shade(config.wallColor, -0.1)
  ctx.fillRect(0, 0, halfMullion, size)
  ctx.fillRect(size - halfMullion, 0, halfMullion, size)

  // 工厂：底部踢脚线，增强工业感
  if (config.style === 'factory') {
    ctx.fillStyle = shade(config.wallColor, -0.1)
    ctx.fillRect(0, size - Math.max(2, size * 0.03), size, Math.max(2, size * 0.03))
  }
  // 居民楼 / 医院：底部踢脚线
  if (config.style === 'residential' || config.style === 'hospital') {
    ctx.fillStyle = shade(config.wallColor, -0.1)
    ctx.fillRect(0, size - Math.max(2, size * 0.03), size, Math.max(2, size * 0.03))
  }

  // 窗洞（窗框）
  ctx.fillStyle = config.frameColor
  ctx.fillRect(layout.windowX, layout.windowY, layout.windowW, layout.windowH)

  // 玻璃
  const gradient = ctx.createLinearGradient(0, layout.glassY, 0, layout.glassY + layout.glassH)
  gradient.addColorStop(0, shade(config.glassColor, 0.24))
  gradient.addColorStop(0.55, config.glassColor)
  gradient.addColorStop(1, shade(config.glassColor, -0.2))
  ctx.fillStyle = gradient
  ctx.fillRect(layout.glassX, layout.glassY, layout.glassW, layout.glassH)

  // 玻璃斜向反射
  ctx.save()
  ctx.beginPath()
  ctx.rect(layout.glassX, layout.glassY, layout.glassW, layout.glassH)
  ctx.clip()
  ctx.fillStyle = rgbToCss(255, 255, 255, shape.reflect)
  ctx.beginPath()
  ctx.moveTo(layout.glassX, layout.glassY + layout.glassH)
  ctx.lineTo(layout.glassX + layout.glassW * 0.55, layout.glassY)
  ctx.lineTo(layout.glassX + layout.glassW * 0.78, layout.glassY)
  ctx.lineTo(layout.glassX, layout.glassY + layout.glassH * 0.72)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  // 分格（mullion）：按档案的竖梃宽度绘制
  ctx.fillStyle = config.frameColor
  const lineW = Math.max(1, layout.mullionPx)
  for (const x of mullionPositions(layout.glassX, layout.glassW, shape.cols)) {
    ctx.fillRect(x - lineW / 2, layout.glassY, lineW, layout.glassH)
  }
  for (const y of mullionPositions(layout.glassY, layout.glassH, shape.rows)) {
    ctx.fillRect(layout.glassX, y - lineW / 2, layout.glassW, lineW)
  }

  // 窗台（下方浅色压边）
  ctx.fillStyle = shade(config.frameColor, 0.35)
  ctx.fillRect(layout.windowX - layout.framePx, layout.windowY + layout.windowH, layout.windowW + layout.framePx * 2, layout.sillPx)

  // 窗洞内凹阴影（顶部与两侧）
  ctx.fillStyle = rgbToCss(...hexToRgb(config.wallColor), 0.22)
  ctx.fillRect(layout.windowX, layout.windowY, layout.windowW, Math.max(1, layout.framePx * 0.8))
  ctx.fillRect(layout.windowX, layout.windowY, Math.max(1, layout.framePx * 0.6), layout.windowH)

  // 顶部阴影，强调层间凹槽
  ctx.fillStyle = rgbToCss(...hexToRgb(config.wallColor), 0.18)
  ctx.fillRect(0, layout.slabPx, size, Math.max(1, layout.slabPx * 0.5))

  return canvas
}

function drawHeightCanvas(config: FacadeFaceConfig, layout: FacadeLayout): HTMLCanvasElement {
  const canvas = createCanvas(layout.size)
  const ctx = canvas.getContext('2d')!
  const shape = STYLE_SHAPES[config.style]
  const { size } = layout

  // 墙板：高值
  ctx.fillStyle = 'rgb(200, 200, 200)'
  ctx.fillRect(0, 0, size, size)
  // 楼层腰线：略低，形成层间凹槽
  ctx.fillStyle = 'rgb(150, 150, 150)'
  ctx.fillRect(0, 0, size, layout.slabPx)

  // 竖梃投影：略高
  const halfMullion = layout.mullionPx / 2
  ctx.fillStyle = 'rgb(215, 215, 215)'
  ctx.fillRect(0, 0, halfMullion, size)
  ctx.fillRect(size - halfMullion, 0, halfMullion, size)

  // 窗框：略高于墙面
  ctx.fillStyle = 'rgb(170, 170, 170)'
  ctx.fillRect(layout.windowX, layout.windowY, layout.windowW, layout.windowH)
  // 玻璃：低值（凹陷）
  ctx.fillStyle = 'rgb(28, 28, 28)'
  ctx.fillRect(layout.glassX, layout.glassY, layout.glassW, layout.glassH)

  // 分格线：凸起
  ctx.fillStyle = 'rgb(190, 190, 190)'
  const lineW = Math.max(1, layout.mullionPx)
  for (const x of mullionPositions(layout.glassX, layout.glassW, shape.cols)) {
    ctx.fillRect(x - lineW / 2, layout.glassY, lineW, layout.glassH)
  }
  for (const y of mullionPositions(layout.glassY, layout.glassH, shape.rows)) {
    ctx.fillRect(layout.glassX, y - lineW / 2, layout.glassW, lineW)
  }

  // 窗台：最高
  ctx.fillStyle = 'rgb(232, 232, 232)'
  ctx.fillRect(layout.windowX - layout.framePx, layout.windowY + layout.windowH, layout.windowW + layout.framePx * 2, layout.sillPx)
  return canvas
}

/** 高度图 → 切线空间法线（Sobel 梯度，环绕采样避免平铺接缝） */
function heightToNormalCanvas(height: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const size = height.width
  const srcCtx = height.getContext('2d')!
  const src = srcCtx.getImageData(0, 0, size, size).data
  const canvas = createCanvas(size)
  const ctx = canvas.getContext('2d')!
  const out = ctx.createImageData(size, size)
  const k = 1 + Math.max(0, Math.min(1, strength)) * 5

  const at = (x: number, y: number) => {
    const xi = ((x % size) + size) % size
    const yi = ((y % size) + size) % size
    return src[(yi * size + xi) * 4] / 255
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * k
      const dy = (at(x, y - 1) - at(x, y + 1)) * k
      let nx = -dx
      let ny = dy
      let nz = 1
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
      const i = (y * size + x) * 4
      out.data[i] = (nx * 0.5 + 0.5) * 255
      out.data[i + 1] = (ny * 0.5 + 0.5) * 255
      out.data[i + 2] = (nz * 0.5 + 0.5) * 255
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  return canvas
}

function drawEmissiveCanvas(config: FacadeFaceConfig, layout: FacadeLayout): HTMLCanvasElement {
  const canvas = createCanvas(layout.size)
  const ctx = canvas.getContext('2d')!
  const shape = STYLE_SHAPES[config.style]
  const rng = mulberry32(config.seed * 977 + 13)

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, layout.size, layout.size)

  const cellW = layout.glassW / shape.cols
  const cellH = layout.glassH / shape.rows
  const inset = Math.max(1, layout.framePx * 0.6)

  for (let row = 0; row < shape.rows; row++) {
    for (let col = 0; col < shape.cols; col++) {
      if (rng() > shape.litChance) continue
      const brightness = 0.72 + rng() * 0.28
      ctx.fillStyle = rgbToCss(255, 243, 214, brightness)
      ctx.fillRect(
        layout.glassX + col * cellW + inset,
        layout.glassY + row * cellH + inset,
        Math.max(1, cellW - inset * 2),
        Math.max(1, cellH - inset * 2),
      )
    }
  }
  return canvas
}

/** 点到矩形内部边界的距离（在矩形外返回负值） */
function innerEdgeDistance(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
  return Math.min(px - rx, rx + rw - px, py - ry, ry + rh - py)
}

/**
 * ORM 打包（R=AO / G=roughness / B=metalness）。
 *
 * AO：窗洞内凹边缘、楼层腰线交界与 tile 角部；强度由档案 `aoStrength` 控制。
 * roughness / metalness 按材质区域填充，材质标量固定为 1，由贴图决定最终值。
 */
function drawOrmCanvas(config: FacadeFaceConfig, layout: FacadeLayout): HTMLCanvasElement {
  const profile = normalizeFacadeProfile(config, config.style)
  const shape = STYLE_SHAPES[config.style]
  const size = layout.size
  const canvas = createCanvas(size)
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)
  const data = image.data

  const aoK = Math.max(0, Math.min(1, profile.aoStrength))
  const pxY = Math.max(1, layout.pxPerMeterY)
  const falloffReveal = 0.12 * pxY
  const falloffBand = Math.max(2, 0.08 * pxY)
  const falloffCorner = Math.max(2, 0.06 * pxY)

  const lineW = Math.max(1, layout.mullionPx)
  const mullionsX = mullionPositions(layout.glassX, layout.glassW, shape.cols)
  const mullionsY = mullionPositions(layout.glassY, layout.glassH, shape.rows)
  const sillY = layout.windowY + layout.windowH

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inGlass = x >= layout.glassX && x < layout.glassX + layout.glassW && y >= layout.glassY && y < layout.glassY + layout.glassH
      const inWindow = x >= layout.windowX && x < layout.windowX + layout.windowW && y >= layout.windowY && y < layout.windowY + layout.windowH
      const inSill = x >= layout.windowX - layout.framePx && x < layout.windowX + layout.windowW + layout.framePx && y >= sillY && y < sillY + layout.sillPx
      let onGrid = false
      if (inGlass) {
        for (const gx of mullionsX) if (Math.abs(x - gx) <= lineW / 2) { onGrid = true; break }
        if (!onGrid) for (const gy of mullionsY) if (Math.abs(y - gy) <= lineW / 2) { onGrid = true; break }
      }

      let roughness = 0.92
      let metalness = 0
      if (inGlass) {
        roughness = profile.glassRoughness
        metalness = profile.glassMetalness
      } else if (inWindow) {
        roughness = 0.42
        metalness = config.windowFrameMetalness
      }
      if (onGrid) {
        roughness = 0.38
        metalness = config.windowFrameMetalness
      }
      if (inSill) {
        roughness = 0.55
        metalness = config.windowFrameMetalness * 0.45
      }
      if (y < layout.slabPx) {
        roughness = Math.min(roughness, 0.82)
        metalness = 0
      }

      // AO：窗洞内凹（玻璃边缘）
      let ao = 1
      const glassEdge = innerEdgeDistance(x, y, layout.glassX, layout.glassY, layout.glassW, layout.glassH)
      if (inGlass) {
        ao *= 1 - aoK * 0.4 * Math.exp(-Math.max(0, glassEdge) / falloffReveal)
      } else if (inWindow) {
        ao *= 1 - aoK * 0.3 * Math.exp(-Math.max(0, glassEdge) / falloffReveal)
      } else {
        // 窗洞外围的接触阴影
        const dy = Math.max(0, layout.windowY - y, y - sillY)
        const dx = Math.max(0, layout.windowX - x, x - (layout.windowX + layout.windowW))
        const d = Math.max(dx, dy)
        if (d < falloffReveal * 3) ao *= 1 - aoK * 0.3 * Math.exp(-d / (falloffReveal * 1.5))
      }
      // AO：楼层腰线交界
      const bandDist = Math.abs(y - layout.slabPx)
      ao *= 1 - aoK * 0.35 * Math.exp(-bandDist / falloffBand)
      // AO：tile 左右角部（随平铺周期重复，形成竖向转角阴影）
      const cornerDist = Math.min(x, size - 1 - x)
      ao *= 1 - aoK * 0.28 * Math.exp(-cornerDist / falloffCorner)

      const i = (y * size + x) * 4
      const r = Math.max(0, Math.min(255, ao * 255))
      data[i] = r
      data[i + 1] = Math.max(0, Math.min(255, roughness * 255))
      data[i + 2] = Math.max(0, Math.min(255, metalness * 255))
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

/** 元素 trimsheet：2×2 atlas，四个分区分别对应金属框 / 石材带 / 百叶 / 玻璃 */
function drawTrimsheetColor(config: FacadeFaceConfig, size: number): HTMLCanvasElement {
  const canvas = createCanvas(size)
  const ctx = canvas.getContext('2d')!
  const half = size / 2

  // metal：顶左
  ctx.fillStyle = '#8f979e'
  ctx.fillRect(0, 0, half, half)
  for (let i = 0; i < 24; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'
    ctx.fillRect((i * half) / 24, 0, Math.max(1, half / 48), half)
  }
  // stone：顶右
  ctx.fillStyle = '#cfc8bb'
  ctx.fillRect(half, 0, half, half)
  const rng = mulberry32(config.seed * 131 + 7)
  for (let i = 0; i < 12; i++) {
    ctx.strokeStyle = `rgba(90, 84, 74, ${0.05 + rng() * 0.06})`
    ctx.lineWidth = Math.max(1, half / 96)
    ctx.beginPath()
    const y = (i * half) / 12
    ctx.moveTo(half, y)
    ctx.lineTo(size, y + (rng() - 0.5) * half * 0.06)
    ctx.stroke()
  }
  // louver：底左
  ctx.fillStyle = '#464e54'
  ctx.fillRect(0, half, half, half)
  const slat = Math.max(2, half / 18)
  for (let y = half + slat; y < size; y += slat * 2) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(0, y, half, Math.max(1, slat * 0.4))
  }
  // glass：底右
  const grad = ctx.createLinearGradient(half, half, size, size)
  grad.addColorStop(0, shade(config.glassColor, 0.3))
  grad.addColorStop(0.6, config.glassColor)
  grad.addColorStop(1, shade(config.glassColor, -0.3))
  ctx.fillStyle = grad
  ctx.fillRect(half, half, half, half)
  ctx.fillStyle = 'rgba(255,255,255,0.16)'
  ctx.beginPath()
  ctx.moveTo(half, size)
  ctx.lineTo(half + half * 0.5, half)
  ctx.lineTo(half + half * 0.75, half)
  ctx.lineTo(half, size - half * 0.55)
  ctx.closePath()
  ctx.fill()

  return canvas
}

function drawTrimsheetOrm(config: FacadeFaceConfig, size: number): HTMLCanvasElement {
  const profile = normalizeFacadeProfile(config, config.style)
  const half = size / 2
  const canvas = createCanvas(size)
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)
  const data = image.data

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const top = y < half
      const left = x < half
      let roughness = 0.7
      let metalness = 0
      if (top && left) {
        roughness = 0.38
        metalness = 0.92
      } else if (top && !left) {
        roughness = 0.72
        metalness = 0.04
      } else if (!top && left) {
        roughness = 0.55
        metalness = 0.65
      } else {
        roughness = profile.glassRoughness
        metalness = profile.glassMetalness
      }
      const i = (y * size + x) * 4
      data[i] = 255
      data[i + 1] = Math.max(0, Math.min(255, roughness * 255))
      data[i + 2] = Math.max(0, Math.min(255, metalness * 255))
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

function buildFacadeTrimsheet(config: FacadeFaceConfig, size: number): FacadeTrimsheet {
  return {
    color: drawTrimsheetColor(config, size),
    orm: drawTrimsheetOrm(config, size),
  }
}

export function buildFacadeCanvases(config: FacadeFaceConfig, size = FACADE_TEXTURE_SIZE): FacadeCanvases {
  const layout = computeLayout(config, size)
  const profile = normalizeFacadeProfile(config, config.style)
  const color = drawColorCanvas(config, layout)
  const height = drawHeightCanvas(config, layout)
  // ★ 法线强度与 revealDepth 联动：内凹越深，窗洞边缘的明暗过渡越明显
  const effectiveNormal = Math.min(1, Math.max(0, config.normalStrength) * (0.75 + profile.revealDepth * 1.5))
  const normal = effectiveNormal > 0 ? heightToNormalCanvas(height, effectiveNormal) : null
  const emissive = config.emissiveIntensity > 0 ? drawEmissiveCanvas(config, layout) : null
  const orm = drawOrmCanvas(config, layout)
  return { color, normal, emissive, orm, trimsheet: buildFacadeTrimsheet(config, size) }
}

const canvasCache = new Map<string, FacadeCanvases>()

/**
 * 获取立面整套贴图 Canvas（按参数签名 + 尺寸档位 LRU 缓存）。
 * 相同风格与参数的面复用同一组 Canvas，由调用方各自包装为 THREE.CanvasTexture。
 */
export function getFacadeCanvases(input: FacadeFaceConfig, size = FACADE_TEXTURE_SIZE): FacadeCanvases {
  const config = normalizeFacadeConfig(input) ?? input
  const key = `${facadeCacheKey(config)}|${size}`
  const hit = canvasCache.get(key)
  if (hit) {
    // LRU：命中后移到队尾
    canvasCache.delete(key)
    canvasCache.set(key, hit)
    return hit
  }
  const built = buildFacadeCanvases(config, size)
  canvasCache.set(key, built)
  // 1024 档位的单组 Canvas 显存约为 512 的 4 倍，缓存上限同步收紧
  const limit = size >= 1024 ? Math.max(4, Math.floor(FACADE_CACHE_LIMIT / 8)) : FACADE_CACHE_LIMIT
  if (canvasCache.size > limit) {
    const oldest = canvasCache.keys().next().value
    if (oldest !== undefined) canvasCache.delete(oldest)
  }
  return built
}

/** 获取元素 trimsheet（与主立面同签名共享） */
export function getFacadeTrimsheet(input: FacadeFaceConfig, size = FACADE_TEXTURE_SIZE): FacadeTrimsheet {
  const canvases = getFacadeCanvases(input, size)
  return canvases.trimsheet
}

/** 清空贴图缓存（场景切换 / 卸载时调用，Canvas 由 GC 回收） */
export function clearFacadeCanvasCache(): void {
  canvasCache.clear()
}
