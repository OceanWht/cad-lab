/**
 * 墙面表面的盒式（box）投影 UV 生成。
 *
 * 墙体只由顶点拉伸得到，没有建模阶段的 UV。这里按三角形主法线方向选两个
 * 世界轴作为 u / v，再除以贴图覆盖尺寸，得到「按米平铺、不随墙面朝向拉伸」的坐标。
 * 纯函数、不依赖 three，便于单测。
 */

/**
 * 一张石膏贴图覆盖的物理尺寸（米）。
 *
 * 取 1 米：贴图里最高频的噪声周期约 1.5 厘米，落在真实涂料颗粒的尺度上；
 * 覆盖尺寸再大，颗粒就会被拉伸成「水波纹」式的低频起伏。
 */
export const SURFACE_TILE_METERS = 1

/**
 * 为无索引三角形顶点生成 UV。
 *
 * @param positions 顶点数组，每 9 个数为一个三角形（x, y, z × 3）
 * @param tileMeters 一张贴图覆盖的米数
 * @returns 与顶点一一对应的 uv 数组（每 2 个数一组）
 */
export function boxProjectUvs(
  positions: Float32Array,
  tileMeters: number = SURFACE_TILE_METERS,
): Float32Array {
  if (!(tileMeters > 0)) throw new Error(`贴图覆盖尺寸必须为正数：${tileMeters}`)
  if (positions.length % 9 !== 0) {
    throw new Error(`顶点数必须是 3 的整数倍：${positions.length / 3}`)
  }

  const uv = new Float32Array((positions.length / 3) * 2)
  for (let base = 0; base < positions.length; base += 9) {
    const ax = positions[base]
    const ay = positions[base + 1]
    const az = positions[base + 2]
    const bx = positions[base + 3]
    const by = positions[base + 4]
    const bz = positions[base + 5]
    const cx = positions[base + 6]
    const cy = positions[base + 7]
    const cz = positions[base + 8]

    // 面法线决定投影轴：法线最长的分量对应该面的朝向
    const e1x = bx - ax
    const e1y = by - ay
    const e1z = bz - az
    const e2x = cx - ax
    const e2y = cy - ay
    const e2z = cz - az
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const absX = Math.abs(nx)
    const absY = Math.abs(ny)
    const absZ = Math.abs(nz)

    let axis: 'x' | 'y' | 'z'
    let sign: number
    if (absX >= absY && absX >= absZ) {
      axis = 'x'
      sign = nx >= 0 ? 1 : -1
    } else if (absY >= absZ) {
      axis = 'y'
      sign = ny >= 0 ? 1 : -1
    } else {
      axis = 'z'
      sign = nz >= 0 ? 1 : -1
    }

    for (let vertex = 0; vertex < 3; vertex += 1) {
      const px = positions[base + vertex * 3]
      const py = positions[base + vertex * 3 + 1]
      const pz = positions[base + vertex * 3 + 2]
      let u: number
      let v: number
      if (axis === 'x') {
        // 朝向 ±X 的墙面：u 取 Z，v 取高度 Y
        u = sign > 0 ? -pz : pz
        v = py
      } else if (axis === 'y') {
        // 水平面（地面 / 墙顶）：u 取 X，v 取 Z
        u = px
        v = sign > 0 ? -pz : pz
      } else {
        // 朝向 ±Z 的墙面：u 取 X，v 取高度 Y
        u = sign > 0 ? px : -px
        v = py
      }
      const target = base / 3 + vertex
      // 取负号可能得到 -0，统一成 0，避免与 0 做严格比较时出现差异
      const uu = u / tileMeters
      const vv = v / tileMeters
      uv[target * 2] = uu === 0 ? 0 : uu
      uv[target * 2 + 1] = vv === 0 ? 0 : vv
    }
  }
  return uv
}
