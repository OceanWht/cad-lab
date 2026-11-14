/**
 * 墙面顶点色的环境光遮蔽（伪 AO）。
 *
 * 参考视频里墙面本身没有贴图，立体感主要来自「墙脚压暗、墙顶压暗」这类接触阴影：
 * 建筑不再是悬空贴在背景上的几块平板，而是真的坐在地面上、顶部被楼板压住。
 *
 * 这里用顶点色实现，几何不变、零帧率成本、结果完全确定（不依赖随机数与时间）：
 * - 墙脚：距地面 `CONTACT_HEIGHT` 以内向下线性加深，模拟地面挡住天光；
 * - 墙顶：距墙顶 `SOFFIT_HEIGHT` 以内向上线性加深，模拟上层楼板形成的檐口阴影。
 *
 * 只处理竖直面：墙顶水平面直接朝天，压暗会让顶面变脏；内转角的暗部交给平行光
 * 的投影解决，因为几毫米厚的墙面在平面栅格上无法可靠区分「自身」与「相邻墙」。
 *
 * 纯函数、不依赖 three，便于单测。
 */

/** 墙脚暗化高度（米） */
const CONTACT_HEIGHT = 0.45
/** 墙脚最大暗化比例：最底部压暗 22% */
const CONTACT_DARKENING = 0.22
/** 墙顶暗化高度（米） */
const SOFFIT_HEIGHT = 0.15
/** 墙顶最大暗化比例 */
const SOFFIT_DARKENING = 0.08
/** 顶点色下限：再暗也不能丢掉墙面本色 */
const MIN_SHADE = 0.55
/** 判定水平面的法线 Y 分量阈值 */
const HORIZONTAL_NORMAL_Y = 0.7

/**
 * 计算墙体顶点的灰度遮蔽系数（0.55–1），写成可直接作为 `color` 属性的 RGB 数组。
 *
 * @param positions 无索引三角形顶点，每 9 个数一个三角形
 * @param wallHeight 墙高（米），用于计算墙顶檐口阴影
 */
export function wallVertexShade(positions: Float32Array, wallHeight: number): Float32Array {
  if (!(wallHeight > 0)) throw new Error(`墙高必须为正数：${wallHeight}`)
  if (positions.length % 9 !== 0) {
    throw new Error(`顶点数必须是 3 的整数倍：${positions.length / 3}`)
  }

  const colors = new Float32Array(positions.length)
  if (positions.length === 0) return colors

  const soffitStart = wallHeight - SOFFIT_HEIGHT

  for (let base = 0; base < positions.length; base += 9) {
    const ax = positions[base]
    const ay = positions[base + 1]
    const az = positions[base + 2]
    const e1x = positions[base + 3] - ax
    const e1y = positions[base + 4] - ay
    const e1z = positions[base + 5] - az
    const e2x = positions[base + 6] - ax
    const e2y = positions[base + 7] - ay
    const e2z = positions[base + 8] - az
    // 面法线只用来判断水平/竖直，退化三角形按竖直面处理即可
    const ny = e1z * e2x - e1x * e2z
    const length = Math.hypot(e1y * e2z - e1z * e2y, ny, e1x * e2y - e1y * e2x)
    const horizontal = length > 0 && Math.abs(ny / length) >= HORIZONTAL_NORMAL_Y

    for (let vertex = 0; vertex < 3; vertex += 1) {
      const target = base + vertex * 3
      let shade = 1
      if (!horizontal) {
        const py = positions[target + 1]
        if (py < CONTACT_HEIGHT) {
          shade -= CONTACT_DARKENING * (1 - py / CONTACT_HEIGHT)
        }
        if (py > soffitStart) {
          shade -= SOFFIT_DARKENING * ((py - soffitStart) / SOFFIT_HEIGHT)
        }
      }
      if (shade < MIN_SHADE) shade = MIN_SHADE
      colors[target] = shade
      colors[target + 1] = shade
      colors[target + 2] = shade
    }
  }

  return colors
}
