/**
 * 轮廓来源解析：把图纸数据映射为程序化构件需要的闭合外轮廓 `RingXZ`。
 *
 * 优先级（与规格一致）：
 * 1. 已绘制楼板轮廓；
 * 2. 闭合墙环的外边界（多环时取面积最大者，并记录所选环标识）；
 * 3. 两者都不可用 → 返回 `ring: null` 与明确原因，由调用方禁用构件。
 *
 * 不做最小包围矩形等任何兜底，避免生成与真实结构不符的几何。
 */

import type { SlabOutline } from '../cad-lab/core/slabOutline'
import { flattenOutline, validateOutline } from '../cad-lab/core/slabOutline'
import type { WallRing } from '../cad-lab/core/wallTopology'
import { normalizeRingXZ, signedAreaXZ, type RingXZ } from '../lib/podium/podiumBuilder'

/** 轮廓来源 */
export type OutlineSource = 'slab' | 'wall-ring'

/** 轮廓解析结果 */
export interface OutlineResolution {
  /** 可用的闭合外轮廓；null 表示不可用 */
  ring: RingXZ | null
  /** 轮廓来源；null 表示不可用 */
  source: OutlineSource | null
  /** 来源标识（用于界面提示，如「闭合墙环第 2 个（共 3 个，取面积最大）」） */
  label: string
  /** 不可用原因；`ring` 非空时为空串 */
  reason: string
}

/** 轮廓环最小面积（平方米）：小于该值视为退化，不作为轮廓使用 */
const MIN_OUTLINE_AREA = 1e-6

/**
 * 楼板轮廓 → 闭合环。
 *
 * 扁平化按 2mm 弦高，与墙体曲线采样一致；返回的环已去重并统一为逆时针。
 */
export function ringFromSlabOutline(outline: SlabOutline | null): { ring: RingXZ | null; reason: string } {
  if (!outline || outline.segments.length === 0) {
    return { ring: null, reason: '未绘制楼板轮廓' }
  }
  const validation = validateOutline(outline)
  if (!validation.valid) {
    return { ring: null, reason: `楼板轮廓无效：${validation.message}` }
  }
  const flat = flattenOutline(outline)
  const ring = normalizeRingXZ(flat.points.map((point) => [point.x, point.y] as [number, number]))
  if (ring.length < 3) {
    return { ring: null, reason: '楼板轮廓扁平化后不足 3 个顶点' }
  }
  if (Math.abs(signedAreaXZ(ring)) < MIN_OUTLINE_AREA) {
    return { ring: null, reason: '楼板轮廓面积为零' }
  }
  return { ring, reason: '' }
}

/**
 * 闭合墙环 → 外边界环。
 *
 * 墙环带厚度，左右边界分别位于中心线两侧；取有向面积（绝对值）较大的一侧作为外边界，
 * 再统一为逆时针。开放墙环一律返回 null。
 */
export function outerBoundaryRing(ring: WallRing): RingXZ | null {
  if (!ring.closed) return null
  if (ring.left.length < 3 || ring.right.length < 3) return null
  const left = ring.left.map((point) => [point.x, point.y] as [number, number])
  const right = ring.right.map((point) => [point.x, point.y] as [number, number])
  const leftArea = Math.abs(signedAreaXZ(left))
  const rightArea = Math.abs(signedAreaXZ(right))
  const outer = leftArea >= rightArea ? left : right
  const normalized = normalizeRingXZ(outer)
  if (normalized.length < 3) return null
  if (Math.abs(signedAreaXZ(normalized)) < MIN_OUTLINE_AREA) return null
  return normalized
}

/** 按优先级解析建筑外轮廓 */
export function resolveBuildingOutline(
  slab: SlabOutline | null,
  rings: readonly WallRing[],
): OutlineResolution {
  const fromSlab = ringFromSlabOutline(slab)
  if (fromSlab.ring) {
    return { ring: fromSlab.ring, source: 'slab', label: '已绘制楼板轮廓', reason: '' }
  }

  const closed = rings.filter((ring) => ring.closed)
  if (closed.length === 0) {
    return {
      ring: null,
      source: null,
      label: '',
      reason: `${fromSlab.reason}，且墙带中没有闭合环`,
    }
  }

  let bestRing: RingXZ | null = null
  let bestIndex = -1
  let bestArea = 0
  for (let i = 0; i < closed.length; i++) {
    const candidate = outerBoundaryRing(closed[i])
    if (!candidate) continue
    const area = Math.abs(signedAreaXZ(candidate))
    if (bestRing === null || area > bestArea) {
      bestRing = candidate
      bestIndex = i
      bestArea = area
    }
  }

  if (!bestRing) {
    return {
      ring: null,
      source: null,
      label: '',
      reason: `${fromSlab.reason}，且闭合墙环边界退化（面积为零或顶点不足）`,
    }
  }

  return {
    ring: bestRing,
    source: 'wall-ring',
    label: `闭合墙环第 ${bestIndex + 1} 个（共 ${closed.length} 个，取面积最大）`,
    reason: '',
  }
}
