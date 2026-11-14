/**
 * MLINE（多线）解析：把每条元素线展开成一条折线。
 *
 * 字段语义已由 P0 探针实测确认（见 design.md 决策 4.1）：
 * - `miterDirection` 是单位向量，且恒为 `vertexDirection` 的左法线；
 * - `lines[j].segmentParams[0]` 是沿 `miterDirection` 的带符号偏移，
 *   **已包含 scale 与 justification 修正**，不能再乘 `scale`、也不能二次对齐；
 * - `segmentParams[1]` 在二维图纸中恒为 0，不参与计算；
 * - 元素数量以实际 `lines` 数组长度为准，不信任 `numberOfLines`。
 *
 * 闭合标志按 DXF 组码 71 的定义取第 2 位（`flags & 2`）：
 * 1 = 至少有一个顶点，2 = 闭合，4 = 抑制起点端帽，8 = 抑制终点端帽。
 */

import type { DwgMLineEntity } from '@mlightcad/libredwg-web'
import { distance } from './geometry'
import type { CadPoint, CadPolylinePrimitive } from './types'

/** 去重时使用的相对容差（相对弦高容差） */
const DUPLICATE_RATIO = 1e-3

/**
 * 把一条 MLINE 展开成若干折线（每条元素线一条）。
 * 数据不完整（顶点不足、元素不足、元素偏移缺失）时返回空数组，
 * 由调用方计入未渲染实体。
 */
export function buildMLinePolylines(
  entity: DwgMLineEntity,
  tolerance: number,
): CadPolylinePrimitive[] {
  const vertices = entity.vertices ? entity.vertices : []
  if (vertices.length < 2) return []

  const elementCount = vertices[0].lines ? vertices[0].lines.length : 0
  if (elementCount < 2) return []

  const closed = (entity.flags & 2) === 2
  const epsilon = tolerance * DUPLICATE_RATIO
  const result: CadPolylinePrimitive[] = []

  for (let element = 0; element < elementCount; element += 1) {
    const points: CadPoint[] = []
    for (const vertex of vertices) {
      const line = vertex.lines ? vertex.lines[element] : undefined
      const miter = vertex.miterDirection
      if (!line || !miter) return []
      const params = line.segmentParams ? line.segmentParams : []
      if (params.length === 0) return []
      const offset = params[0]
      if (!Number.isFinite(offset)) return []
      points.push({
        x: vertex.vertex.x + miter.x * offset,
        y: vertex.vertex.y + miter.y * offset,
      })
    }

    // 去掉元素自身重合的相邻点，退化元素直接丢弃
    const cleaned: CadPoint[] = []
    for (const point of points) {
      const last = cleaned[cleaned.length - 1]
      if (last && distance(last, point) <= epsilon) continue
      cleaned.push(point)
    }
    while (cleaned.length >= 2 && distance(cleaned[0], cleaned[cleaned.length - 1]) <= epsilon) {
      cleaned.pop()
    }
    if (cleaned.length < 2) continue
    result.push({ kind: 'polyline', points: cleaned, closed })
  }

  return result
}
