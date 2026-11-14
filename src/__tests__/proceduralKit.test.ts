/**
 * 适配层单元测试：轮廓来源优先级、底座门洞与大门的联动、逐层挂载标高。
 *
 * 全部使用确定性数值断言（顶点坐标、标高、构件数量），不做快照盲比。
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { SlabOutline } from '../cad-lab/core/slabOutline'
import type { WallRing } from '../cad-lab/core/wallTopology'
import { resolveFrontFaceIndex, type RingXZ } from '../lib/podium/podiumBuilder'
import { defaultPodiumConfig, podiumCoverHeight } from '../lib/podium/podiumTypes'
import { defaultRoofConfig } from '../lib/roof/roofTypes'
import { createEntranceGateConfig } from '../lib/gate/gateTypes'
import { collectGateOpenings, holeRangesForFace } from '../lib/building/wallOpenings'
import { outerBoundaryRing, resolveBuildingOutline } from '../adapter/outline'
import { facadeFramesFromRing } from '../adapter/frames'
import {
  buildProceduralKit,
  disposeProceduralKit,
  facadeBaseHeight,
} from '../adapter/proceduralKit'

const WIDTH = 20
const DEPTH = 10
const THICKNESS = 0.2
const WALL_HEIGHT = 3

/** 轴对齐矩形墙环：右边界在外，左边界在内，中心线逆时针 */
function rectWallRing(closed = true): WallRing {
  const half = THICKNESS / 2
  const outer = [
    { x: -half, y: -half },
    { x: WIDTH + half, y: -half },
    { x: WIDTH + half, y: DEPTH + half },
    { x: -half, y: DEPTH + half },
  ]
  const inner = [
    { x: half, y: half },
    { x: WIDTH - half, y: half },
    { x: WIDTH - half, y: DEPTH - half },
    { x: half, y: DEPTH - half },
  ]
  return {
    left: inner,
    right: outer,
    closed,
    thickness: THICKNESS,
    edgeCount: 4,
    length: 2 * (WIDTH + DEPTH),
    edges: [0, 1, 2, 3],
  }
}

/** 同样尺寸的楼板轮廓（逆时针，首段起点在原点） */
function rectSlab(width = WIDTH, depth = DEPTH): SlabOutline {
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ]
  return {
    segments: corners.map((start, index) => ({
      kind: 'line' as const,
      start,
      end: corners[(index + 1) % corners.length],
    })),
  }
}

/** 取某个构件容器里的指定构件 */
function findKit(container: THREE.Object3D | null, kind: string): THREE.Object3D {
  const found = container?.children.find((child) => child.userData.__kitKind === kind)
  if (!found) throw new Error(`未找到构件：${kind}`)
  return found
}

describe('轮廓来源优先级', () => {
  it('有楼板轮廓时直接使用楼板轮廓', () => {
    const resolution = resolveBuildingOutline(rectSlab(), [rectWallRing()])
    expect(resolution.source).toBe('slab')
    expect(resolution.ring).not.toBeNull()
    // 楼板轮廓面积即 20 × 10
    expect(Math.abs(signedArea(resolution.ring as RingXZ))).toBeCloseTo(WIDTH * DEPTH, 6)
  })

  it('没有楼板轮廓时回退到面积最大的闭合墙环外边界', () => {
    const small = rectWallRing()
    const large: WallRing = {
      ...rectWallRing(),
      left: rectWallRing().left.map((point) => ({ x: point.x, y: point.y })),
      right: [
        { x: -0.1, y: -0.1 },
        { x: 40.1, y: -0.1 },
        { x: 40.1, y: 30.1 },
        { x: -0.1, y: 30.1 },
      ],
    }
    const resolution = resolveBuildingOutline(null, [small, large])
    expect(resolution.source).toBe('wall-ring')
    expect(resolution.label).toContain('闭合墙环')
    expect(Math.abs(signedArea(resolution.ring as RingXZ))).toBeGreaterThan(WIDTH * DEPTH)
    // 外边界取墙环较外侧的边界，而非内边界
    expect(outerBoundaryRing(rectWallRing())).not.toBeNull()
    expect(Math.abs(signedArea(outerBoundaryRing(rectWallRing()) as RingXZ))).toBeGreaterThan(
      WIDTH * DEPTH,
    )
  })

  it('只有开放墙环时显式禁用并给出原因', () => {
    const resolution = resolveBuildingOutline(null, [rectWallRing(false)])
    expect(resolution.ring).toBeNull()
    expect(resolution.source).toBeNull()
    expect(resolution.reason).toContain('闭合环')
  })

  it('缺少轮廓时四类构件都不生成', () => {
    const result = buildProceduralKit({
      floorRings: [[rectWallRing(false)]],
      slabOutline: null,
      wallHeight: WALL_HEIGHT,
      podium: defaultPodiumConfig('stone_plinth'),
      roof: defaultRoofConfig('parapet'),
      gate: createEntranceGateConfig('office', 0, [0, 0], 0.5, { signText: '' }),
      facadeStyle: null,
    })
    expect(result.stats.podium).toBe(false)
    expect(result.stats.roof).toBe(false)
    expect(result.stats.gate).toBe(false)
    expect(result.warnings.join('\n')).toContain('未生成')
    disposeProceduralKit(result.floorDecor)
  })
})

describe('底座门洞与大门联动', () => {
  it('门体落在底座开口内，且与开口共用同一墙面', () => {
    const gate = createEntranceGateConfig('office', 0, [0, 0], 0.5, {
      width: 8,
      height: 4.2,
      canopyDepth: 0,
      steps: 0,
      signText: '',
    })
    const result = buildProceduralKit({
      floorRings: [[rectWallRing()]],
      slabOutline: rectSlab(),
      wallHeight: WALL_HEIGHT,
      podium: defaultPodiumConfig('stone_plinth'),
      roof: null,
      gate,
      facadeStyle: null,
    })

    expect(result.stats.podium).toBe(true)
    expect(result.stats.gate).toBe(true)

    const ring = result.outline.ring as RingXZ
    const front = resolveFrontFaceIndex(ring, null)
    expect(front).not.toBeNull()
    expect(result.frontFaceIndex).toBe(front)
    if (front === null) throw new Error('正立面边序号缺失')

    const start = ring[front]
    const end = ring[(front + 1) % ring.length]
    const openings = collectGateOpenings(
      [{ ...gate, faceIndex: front }],
      (faceIndex) =>
        faceIndex === front
          ? {
              start: new THREE.Vector3(start[0], 0, start[1]),
              end: new THREE.Vector3(end[0], 0, end[1]),
            }
          : null,
      1,
    )
    expect(openings).toHaveLength(1)
    expect(openings[0].width).toBeCloseTo(8, 6)

    const gateGroup = findKit(result.floorDecor[0], 'gate')
    expect(gateGroup.position.x).toBeCloseTo(openings[0].center.x, 6)
    expect(gateGroup.position.z).toBeCloseTo(openings[0].center.z, 6)
    expect(gateGroup.userData.gateFaceIndex).toBe(front)

    // 开口区间必须覆盖门体中心，才不会被底座 / 立面挡住
    const dir = new THREE.Vector3(end[0] - start[0], 0, end[1] - start[1])
    const faceLength = dir.length()
    dir.normalize()
    const holes = holeRangesForFace(
      openings,
      front,
      { x: start[0], z: start[1] },
      { x: dir.x, z: dir.z },
      faceLength,
    )
    expect(holes).toHaveLength(1)
    const centerU = faceLength * 0.5
    expect(holes[0].u0).toBeLessThan(centerU)
    expect(holes[0].u1).toBeGreaterThan(centerU)

    disposeProceduralKit(result.floorDecor)
  })
})

describe('逐层挂载标高', () => {
  it('首层立面从底座顶面起算，上层从本层板顶起算', () => {
    const podium = defaultPodiumConfig('stone_plinth')
    const cover = podiumCoverHeight(podium)
    expect(cover).toBeGreaterThan(0)
    expect(facadeBaseHeight(0, podium)).toBeCloseTo(cover, 9)
    expect(facadeBaseHeight(1, podium)).toBe(0)
    expect(facadeBaseHeight(2, podium)).toBe(0)
    expect(facadeBaseHeight(0, null)).toBe(0)
  })

  it('每层立面单元的高度等于本层墙高，宽度等于对应墙带边长', () => {
    const ring = outerBoundaryRing(rectWallRing()) as RingXZ
    const set = facadeFramesFromRing(ring, WALL_HEIGHT)
    expect(set.frames).toHaveLength(4)
    expect(set.skippedEdges).toHaveLength(0)
    for (const frame of set.frames) {
      expect(frame.height).toBeCloseTo(WALL_HEIGHT, 9)
    }
    const widths = set.frames.map((frame) => frame.width).sort((a, b) => a - b)
    expect(widths[0]).toBeCloseTo(DEPTH + THICKNESS, 6)
    expect(widths[3]).toBeCloseTo(WIDTH + THICKNESS, 6)
  })

  it('屋顶只挂在顶层，底面贴合顶层墙带顶面', () => {
    const ring = rectWallRing()
    const result = buildProceduralKit({
      floorRings: [[ring], [ring], [ring]],
      slabOutline: rectSlab(),
      wallHeight: WALL_HEIGHT,
      podium: null,
      roof: defaultRoofConfig('parapet'),
      gate: null,
      facadeStyle: null,
    })

    expect(result.stats.roof).toBe(true)
    expect(result.floorDecor[0]).toBeNull()
    expect(result.floorDecor[1]).toBeNull()
    const roof = findKit(result.floorDecor[2], 'roof')
    expect(roof.position.y).toBeCloseTo(WALL_HEIGHT, 6)

    disposeProceduralKit(result.floorDecor)
  })
})

/** 闭合环的有向面积（与 podiumBuilder 的约定一致） */
function signedArea(ring: RingXZ): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i]
    const next = ring[(i + 1) % ring.length]
    sum += current[0] * next[1] - next[0] * current[1]
  }
  return sum / 2
}
