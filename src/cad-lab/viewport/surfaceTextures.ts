/**
 * 墙体与地面的程序化表面贴图。
 *
 * 参考视频里的墙面本身是纯色块，立体感主要来自光照与接触阴影；墙面贴图只承担
 * 「别让墙面像塑料板」的极小幅度起伏。因此这里不画随机斑点，而是用**同一份多倍频
 * 值噪声**同时派生颜色、粗糙度与法线：看得见明暗变化的地方，法线里一定对应着起伏，
 * 颜色与凹凸同源，才不会出现「有脏点却摸不到凹凸」的廉价感。
 *
 * 噪声是周期性值噪声（格点绕回），因此任意一张贴图都可无缝平铺；
 * 所有随机量都来自固定种子的线性同余发生器，刷新后画面完全一致。
 */

import * as THREE from 'three'

/** 贴图分辨率 */
const TEXTURE_SIZE = 512
/** 随机种子：固定值保证每次生成同一套纹理 */
const GRAIN_SEED = 20261110
/**
 * 石膏的多倍频噪声。
 *
 * 一张贴图覆盖 1 米，`cells` 即整张贴图内的噪声周期数，对应波长：
 * 8 → 12.5cm（抹刀起伏）、16 → 6.2cm、32 → 3.1cm、64 → 1.6cm（涂料颗粒）。
 */
const PLASTER_OCTAVES = [
  { cells: 8, amplitude: 0.42 },
  { cells: 16, amplitude: 0.28 },
  { cells: 32, amplitude: 0.18 },
  { cells: 64, amplitude: 0.12 },
]
/**
 * 石膏法线强度。
 *
 * 取值必须与材质的 normalScale 联调：最终起伏 ≈ 本值 × normalScale。
 * 旧值 8 配合 normalScale 1.0 在 1 米平铺下会把墙面推成「砂纸颗粒」，
 * 掠射角下颗粒闪烁，观感比参考视频里的平整抹灰粗糙得多。
 */
const PLASTER_NORMAL_STRENGTH = 3

/** 表面贴图集合：颜色、粗糙度与法线成组提供，调用方按材质类型取用 */
export interface SurfaceTextures {
  /** 颜色贴图（sRGB），与材质颜色相乘 */
  color: THREE.CanvasTexture
  /** 粗糙度贴图（线性） */
  roughness: THREE.CanvasTexture
  /** 法线贴图（线性） */
  normal: THREE.CanvasTexture
}

/** 石膏贴图集合 */
export type PlasterTextures = SurfaceTextures

/** 线性同余发生器：固定种子，产出 0–1 的确定性序列 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** 创建 2D 画布并返回上下文，缺上下文时直接抛错 */
function createCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建表面贴图的 2D 画布上下文')
  return { canvas, context }
}

/**
 * 周期性值噪声：在 `cells × cells` 的格点上取随机值，双线性 + smoothstep 插值。
 * 格点索引对 `cells` 取模，因此左右、上下边界天然连续，平铺不产生接缝。
 */
function createPeriodicNoise(size: number, cells: number, seed: number): Float32Array {
  const random = createRandom(seed)
  const lattice = new Float32Array(cells * cells)
  for (let index = 0; index < lattice.length; index += 1) {
    lattice[index] = random()
  }

  const scale = cells / size
  const result = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    const gridY = y * scale
    const y0 = Math.floor(gridY)
    const ty = gridY - y0
    // smoothstep：线性插值会在格线处留下可见的菱形纹路
    const sy = ty * ty * (3 - 2 * ty)
    const rowA = (y0 % cells) * cells
    const rowB = ((y0 + 1) % cells) * cells
    for (let x = 0; x < size; x += 1) {
      const gridX = x * scale
      const x0 = Math.floor(gridX)
      const tx = gridX - x0
      const sx = tx * tx * (3 - 2 * tx)
      const colA = x0 % cells
      const colB = (x0 + 1) % cells
      const top = lattice[rowA + colA] + (lattice[rowA + colB] - lattice[rowA + colA]) * sx
      const bottom = lattice[rowB + colA] + (lattice[rowB + colB] - lattice[rowB + colA]) * sx
      result[y * size + x] = top + (bottom - top) * sy
    }
  }
  return result
}

/** 多倍频叠加：低频给大起伏，高频给颗粒感；结果归一化到 0–1 */
function createFbm(size: number, seed: number): Float32Array {
  const result = new Float32Array(size * size)
  let totalAmplitude = 0
  for (const octave of PLASTER_OCTAVES) {
    const layer = createPeriodicNoise(size, octave.cells, seed + octave.cells)
    for (let index = 0; index < result.length; index += 1) {
      result[index] += layer[index] * octave.amplitude
    }
    totalAmplitude += octave.amplitude
  }
  for (let index = 0; index < result.length; index += 1) {
    result[index] /= totalAmplitude
  }
  return result
}

/**
 * 把高度场转换成法线贴图。
 * 用中心差分（左右、上下各跨一个像素）求梯度，采样越界时按周期绕回，保证平铺无缝。
 */
function createNormalCanvas(heights: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const { canvas, context } = createCanvas(size)
  const image = context.createImageData(size, size)
  const data = image.data

  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size
    const down = ((y + 1) % size) * size
    const row = y * size
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size
      const right = (x + 1) % size
      const nx = -(heights[row + right] - heights[row + left]) * strength
      const ny = -(heights[down + x] - heights[up + x]) * strength
      const length = Math.hypot(nx, ny, 1)
      const offset = (row + x) * 4
      data[offset] = ((nx / length) * 0.5 + 0.5) * 255
      data[offset + 1] = ((ny / length) * 0.5 + 0.5) * 255
      data[offset + 2] = ((1 / length) * 0.5 + 0.5) * 255
      data[offset + 3] = 255
    }
  }

  context.putImageData(image, 0, 0)
  return canvas
}

/** 统一设置平铺与各向异性过滤 */
function applyTextureSettings(texture: THREE.CanvasTexture, anisotropy: number): void {
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = anisotropy
  texture.needsUpdate = true
}

/** 组装成组贴图：颜色贴图按 sRGB 解释，粗糙度与法线保持线性 */
function assembleTextures(
  color: HTMLCanvasElement,
  roughness: HTMLCanvasElement,
  normal: HTMLCanvasElement,
  anisotropy: number,
): SurfaceTextures {
  const colorTexture = new THREE.CanvasTexture(color)
  colorTexture.colorSpace = THREE.SRGBColorSpace
  applyTextureSettings(colorTexture, anisotropy)

  const roughnessTexture = new THREE.CanvasTexture(roughness)
  applyTextureSettings(roughnessTexture, anisotropy)

  const normalTexture = new THREE.CanvasTexture(normal)
  applyTextureSettings(normalTexture, anisotropy)

  return { color: colorTexture, roughness: roughnessTexture, normal: normalTexture }
}

/**
 * 创建墙体石膏质感贴图。
 * @param anisotropy 各向异性过滤级数，取渲染器能力上限可减少斜视时的颗粒闪烁
 */
export function createPlasterTextures(anisotropy = 4): PlasterTextures {
  const size = TEXTURE_SIZE
  const heights = createFbm(size, GRAIN_SEED)

  const colorTexture = createCanvas(size)
  const colorImage = colorTexture.context.createImageData(size, size)
  const roughnessTexture = createCanvas(size)
  const roughnessImage = roughnessTexture.context.createImageData(size, size)

  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index]
    // 颜色贴图接近白色，只保留 5% 的明度起伏：墙面颜色仍由材质面板决定
    const value = 0.945 + 0.055 * height
    const offset = index * 4
    colorImage.data[offset] = value * 255
    colorImage.data[offset + 1] = value * 253
    colorImage.data[offset + 2] = value * 249
    colorImage.data[offset + 3] = 255
    // 粗糙度 0.86–1.0：抹灰是均匀哑光面，只留极弱的凹凸差异；
    // 旧值 0.6–0.96 会让墙面出现斑驳的强弱高光，看起来像没打磨的水泥
    const rough = (0.86 + 0.14 * height) * 255
    roughnessImage.data[offset] = rough
    roughnessImage.data[offset + 1] = rough
    roughnessImage.data[offset + 2] = rough
    roughnessImage.data[offset + 3] = 255
  }

  colorTexture.context.putImageData(colorImage, 0, 0)
  roughnessTexture.context.putImageData(roughnessImage, 0, 0)

  return assembleTextures(
    colorTexture.canvas,
    roughnessTexture.canvas,
    createNormalCanvas(heights, size, PLASTER_NORMAL_STRENGTH),
    anisotropy,
  )
}

