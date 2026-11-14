import { describe, expect, it } from 'vitest'
import { buildClosureSegments, planWallClosure } from '@/cad-lab/core/wallClosure'
import type { WallSegment } from '@/cad-lab/core/wallModel'
import { buildWallGeometry } from '@/cad-lab/core/wallModel'
import { resolveBuildingOutline } from '@/adapter/outline'

/**
 * 构造图纸单位的墙体中心线。
 * @param scale 图纸单位/米（unitScale 的倒数），默认 1 表示图纸单位就是米
 */
function segment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  layer = 'WALL',
  thickness = 0.2,
  scale = 1,
): WallSegment {
  return {
    a: { x: ax * scale, y: ay * scale },
    b: { x: bx * scale, y: by * scale },
    layer,
    thickness,
    key: `${layer}|${ax},${ay}|${bx},${by}`,
  }
}

/** 缺一条边的方形开口墙（10m × 10m），开放端点为 (0,0) 与 (0,10) */
function openSquare(layer = 'WALL', scale = 1): WallSegment[] {
  return [
    segment(0, 0, 10, 0, layer, 0.2, scale),
    segment(10, 0, 10, 10, layer, 0.2, scale),
    segment(10, 10, 0, 10, layer, 0.2, scale),
  ]
}

const fallback = { layer: 'WALL', thickness: 0.2 }

describe('墙体闭合', () => {
  it('连接两段开放端点后生成闭合墙环，并可被构件轮廓识别', () => {
    const existing = openSquare()
    const result = planWallClosure(existing, [{ x: 0, y: 10 }, { x: 0, y: 0 }], 1, fallback)
    expect(result.error).toBe('')
    expect(result.plan).not.toBeNull()

    const plan = result.plan!
    expect(plan.path.profiles[0]).toEqual({ layer: 'WALL', thickness: 0.2 })
    expect(plan.segments).toHaveLength(1)

    const walls = buildWallGeometry([...existing, ...plan.segments], { height: 3, miterLimit: 4 }, 1)
    expect(walls.rings.some((ring) => ring.closed)).toBe(true)

    // 闭合墙环才能作为建筑外轮廓使用（内 / 外墙面由此区分）
    const resolution = resolveBuildingOutline(null, walls.rings)
    expect(resolution.ring).not.toBeNull()
    expect(resolution.source).toBe('wall-ring')
  })

  it('起点不在墙段端点上时仍然生成墙体，规格退回默认值', () => {
    const existing = openSquare()
    const result = planWallClosure(existing, [{ x: 3, y: 15 }, { x: 0, y: 15 }], 1, fallback)
    expect(result.plan).not.toBeNull()
    expect(result.plan!.segments).toHaveLength(1)
    expect(result.plan!.path.profiles[0]).toEqual({ layer: 'WALL', thickness: 0.2 })
    // 没有可吸附的墙段端点，折点保持绘制位置
    expect(result.plan!.path.points[0]).toEqual({ x: 3, y: 15 })
  })

  it('每段连接线分别匹配所连墙体的图层与墙厚', () => {
    const existing = [
      segment(0, 0, 10, 0, 'OUTER', 0.3),
      segment(20, 5, 20, 15, 'INNER', 0.12),
    ]
    // 起点落在 OUTER 端点 (10,0)，终点落在 INNER 端点 (20,5)，中间折点悬空
    const result = planWallClosure(
      existing,
      [{ x: 10, y: 0 }, { x: 15, y: 2 }, { x: 20, y: 5 }],
      1,
      { layer: 'DEFAULT', thickness: 0.2 },
    )
    expect(result.plan).not.toBeNull()
    const plan = result.plan!
    expect(plan.path.profiles).toEqual([
      { layer: 'OUTER', thickness: 0.3 },
      { layer: 'INNER', thickness: 0.12 },
    ])
    expect(plan.segments.map((item) => item.layer)).toEqual(['OUTER', 'INNER'])
  })

  it('中间折点落在墙段端点 0.3m 内时同样吸附', () => {
    const result = planWallClosure(
      openSquare(),
      [{ x: 0, y: 10 }, { x: 0.1, y: 0.1 }, { x: 5, y: 5 }],
      1,
      fallback,
    )
    expect(result.plan!.path.points[1]).toEqual({ x: 0, y: 0 })
  })

  it('首尾折点在 0.3m 内时对齐到墙段端点，抵消半墙厚的视觉偏差', () => {
    const existing = openSquare()
    // 视觉上点在墙带端部（离中心线端点半个墙厚），应吸附到精确端点
    const result = planWallClosure(
      existing,
      [{ x: 0.1, y: 10.1 }, { x: 0, y: 0 }],
      1,
      fallback,
    )
    expect(result.plan!.path.points[0]).toEqual({ x: 0, y: 10 })
    expect(result.plan!.path.points[1]).toEqual({ x: 0, y: 0 })
  })

  it('没有既有墙段时使用调用方给定的默认图层与墙厚', () => {
    const result = planWallClosure(
      [],
      [{ x: 0, y: 0 }, { x: 4, y: 0 }],
      1,
      { layer: 'NEW_WALL', thickness: 0.35 },
    )
    expect(result.plan!.path.profiles[0]).toEqual({ layer: 'NEW_WALL', thickness: 0.35 })
    expect(result.plan!.segments).toHaveLength(1)
  })

  it('图纸单位为毫米时按比例换算，折点吸附后仍能成环', () => {
    const scale = 1000
    const existing = openSquare('WALL', scale)
    const result = planWallClosure(existing, [{ x: 0.0005, y: 10 }, { x: 0, y: 0 }], 0.001, fallback)
    expect(result.plan).not.toBeNull()
    const plan = result.plan!
    expect(plan.path.points[0]).toEqual({ x: 0, y: 10 })
    // 图纸单位下的连接线端点应为 10000（毫米）
    expect(plan.segments[0].a).toEqual({ x: 0, y: 10000 })
  })

  it('同一路径重复生成的分段键保持稳定', () => {
    const existing = openSquare()
    const first = planWallClosure(existing, [{ x: 0, y: 10 }, { x: 0, y: 0 }], 1, fallback).plan!
    const second = buildClosureSegments(first.path, 1)
    expect(second.map((item) => item.key)).toEqual(first.segments.map((item) => item.key))
  })

  it('折点不足两条时给出中文提示，而不是生成空几何', () => {
    const result = planWallClosure(openSquare(), [{ x: 0, y: 10 }], 1, fallback)
    expect(result.plan).toBeNull()
    expect(result.error).toContain('至少需要一条直线段')
  })
})
