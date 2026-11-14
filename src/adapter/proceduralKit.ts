/**
 * 程序化构件逐层挂载编排。
 *
 * 挂载规则（与规格一致）：
 * - 底座：仅首层，位于该层容器原点（板顶标高 0）；
 * - 屋顶：仅顶层，底面标高 = 该层墙高（墙带顶面）；
 * - 大门：仅首层，贴墙带外侧面，与底座门洞同源配置；
 * - 立面：逐层生成，首层起始高度取底座覆盖高度，其余层为 0。
 *
 * 任何前提不满足（缺轮廓、零宽度墙带、立面超预算）都通过 `warnings` 显式上报，
 * 不生成退化几何，也不静默跳过。
 */

import * as THREE from 'three'
import type { SlabOutline } from '../cad-lab/core/slabOutline'
import type { WallRing } from '../cad-lab/core/wallTopology'
import {
  buildBuildingPodium,
  disposeBuildingPodiumGroup,
  resolveFrontFaceIndex,
  type RingXZ,
} from '../lib/podium/podiumBuilder'
import { podiumCoverHeight } from '../lib/podium/podiumTypes'
import { buildBuildingRoof, disposeBuildingRoofGroup } from '../lib/roof/roofBuilder'
import { buildGateGroup, releaseGateGroupResources, type GateFaceFrame } from '../lib/gate/gateBuilder'
import { buildFacadeReliefFromFrames, disposeFacadeReliefGroup, type FacadeWallFrame } from '../lib/facade/facadeRelief'
import { createFacadeFaceConfig } from '../lib/facade/facadeTypes'
import { collectGateOpenings } from '../lib/building/wallOpenings'
import type { EntranceGateConfig, FacadeStyle, PodiumConfig, RoofConfig } from '../shared/types'
import { resolveBuildingOutline, outerBoundaryRing, type OutlineResolution } from './outline'
import { GATE_HORIZONTAL_SCALE, facadeFramesFromRing, gateFrameFromRing } from './frames'

/**
 * 轮廓顶点上限：底座 / 屋顶在内部按 96 个顶点抽稀（`podiumBuilder` 的 MAX_RING_POINTS），
 * 超过后 faceIndex 会变化，门洞与门体可能错位，因此提前提示。
 */
const MAX_KIT_RING_POINTS = 96

/** 立面单元预算：超过该数量时不生成立面，避免构件数量失控 */
const FACADE_UNIT_BUDGET = 240

/** 构件挂载输入 */
export interface ProceduralKitInput {
  /** 逐层墙带环，下标即楼层（0 为首层） */
  floorRings: ReadonlyArray<readonly WallRing[]>
  /** 已提交的楼板轮廓；null 表示未绘制 */
  slabOutline: SlabOutline | null
  /** 单层墙高（米） */
  wallHeight: number
  podium: PodiumConfig | null
  roof: RoofConfig | null
  gate: EntranceGateConfig | null
  /** 立面风格；null 表示不生成立面 */
  facadeStyle: FacadeStyle | null
}

/** 构件挂载统计 */
export interface ProceduralKitStats {
  podium: boolean
  roof: boolean
  gate: boolean
  facadeFloors: number
  facadeUnits: number
}

/**
 * 单层程序化构件外观配置。
 *
 * 只描述「参数」，不含几何：编辑器拿着同一份配置即可用同源构建器重建构件，
 * 保证建筑包导入后的观感与 cad-lab 预览一致。
 */
export interface ProceduralKitLevelAppearance {
  /** 立面风格；null 表示该层不立立面 */
  facadeStyle: FacadeStyle | null
  /** 底座配置；仅首层且实际生成时非空 */
  podium: PodiumConfig | null
  /** 屋顶配置；仅顶层且实际生成时非空 */
  roof: RoofConfig | null
  /** 大门配置；仅首层且实际生成时非空，faceIndex 已绑定正立面 */
  entranceGates: EntranceGateConfig[]
}

/** 程序化构件外观（随建筑包导出） */
export interface ProceduralKitAppearance {
  /** 建筑外轮廓（图纸坐标，逆时针，无重复闭合点）；null 表示无可用轮廓 */
  outlineRing: RingXZ | null
  /** 正立面边序号（相对 outlineRing 的边序） */
  frontFaceIndex: number | null
  /** 逐层外观，下标即楼层 */
  levels: ProceduralKitLevelAppearance[]
}

/** 构件挂载结果 */
export interface ProceduralKitResult {
  /** 逐层构件容器，下标与楼层对齐；null 表示该层无构件 */
  floorDecor: Array<THREE.Group | null>
  outline: OutlineResolution
  /** 正立面边序号（大门与屋顶 / 底座共用） */
  frontFaceIndex: number | null
  /** 构件外观配置：供建筑包导出复用 */
  appearance: ProceduralKitAppearance
  warnings: string[]
  stats: ProceduralKitStats
}

/** 构件种类标记，供释放时选择对应的 dispose 函数 */
type KitKind = 'podium' | 'roof' | 'gate' | 'facade'

/** 把构件组挂到指定楼层容器 */
function attachToFloor(
  floorDecor: Array<THREE.Group | null>,
  floorIndex: number,
  group: THREE.Object3D,
  kind: KitKind,
): void {
  group.userData.__kitKind = kind
  let container = floorDecor[floorIndex]
  if (!container) {
    container = new THREE.Group()
    container.name = `procedural-kit:floor:${floorIndex}`
    floorDecor[floorIndex] = container
  }
  container.add(group)
}

/**
 * 立面单元的起始高度：首层抬到底座顶面，其余层从本层墙带底面（板顶 0）起算。
 */
export function facadeBaseHeight(floorIndex: number, podium: PodiumConfig | null): number {
  return floorIndex === 0 ? podiumCoverHeight(podium) : 0
}

/** 一层楼的全部闭合墙环 → 立面单元 */
function floorFacadeFrames(
  rings: readonly WallRing[],
  wallHeight: number,
): { frames: FacadeWallFrame[]; skippedEdges: number; openRings: number } {
  const frames: FacadeWallFrame[] = []
  let skippedEdges = 0
  let openRings = 0
  for (const ring of rings) {
    const boundary = outerBoundaryRing(ring)
    if (!boundary) {
      openRings++
      continue
    }
    const set = facadeFramesFromRing(boundary, wallHeight)
    frames.push(...set.frames)
    skippedEdges += set.skippedEdges.length
  }
  return { frames, skippedEdges, openRings }
}

/** 按楼层挂载四类程序化构件 */
export function buildProceduralKit(input: ProceduralKitInput): ProceduralKitResult {
  const warnings: string[] = []
  const stats: ProceduralKitStats = {
    podium: false,
    roof: false,
    gate: false,
    facadeFloors: 0,
    facadeUnits: 0,
  }
  const floorCount = input.floorRings.length
  const floorDecor: Array<THREE.Group | null> = new Array(floorCount).fill(null)

  if (floorCount === 0) {
    return {
      floorDecor,
      outline: { ring: null, source: null, label: '', reason: '尚未生成楼层几何' },
      frontFaceIndex: null,
      appearance: { outlineRing: null, frontFaceIndex: null, levels: [] },
      warnings: ['程序化构件未生成：尚未生成楼层几何'],
      stats,
    }
  }

  const outline = resolveBuildingOutline(input.slabOutline, input.floorRings[0])
  const ring = outline.ring
  const frontFaceIndex = ring ? resolveFrontFaceIndex(ring, null) : null

  if (!ring) {
    warnings.push(`屋顶 / 底座 / 大门未生成：${outline.reason}`)
  } else {
    if (outline.source === 'wall-ring') warnings.push(`轮廓来源：${outline.label}`)
    if (ring.length > MAX_KIT_RING_POINTS) {
      warnings.push(
        `轮廓顶点 ${ring.length} 个超过 ${MAX_KIT_RING_POINTS}，底座 / 屋顶会抽稀顶点，大门门洞可能偏移`,
      )
    }
  }

  // 大门：把配置绑定到正立面，同一次配置同时驱动门体与底座门洞
  let gateConfig: EntranceGateConfig | null = null
  let gateFrame: GateFaceFrame | null = null
  if (input.gate) {
    if (!ring || frontFaceIndex == null) {
      warnings.push(`大门未生成：${outline.reason || '缺少可用轮廓'}`)
    } else {
      const candidate: EntranceGateConfig = { ...input.gate, faceIndex: frontFaceIndex, anchor: [0, 0] }
      const frame = gateFrameFromRing(ring, frontFaceIndex)
      if (!frame) {
        warnings.push('大门未生成：所选墙面的宽度为零')
      } else {
        gateConfig = candidate
        gateFrame = frame
      }
    }
  }

  const openings =
    gateConfig && gateFrame
      ? collectGateOpenings(
          [gateConfig],
          (faceIndex) =>
            faceIndex === frontFaceIndex && gateFrame
              ? { start: gateFrame.start, end: gateFrame.end }
              : null,
          GATE_HORIZONTAL_SCALE,
        )
      : []

  if (input.podium?.enabled && ring) {
    const result = buildBuildingPodium(ring, input.podium, { frontFaceIndex, openings })
    if (result) {
      attachToFloor(floorDecor, 0, result.group, 'podium')
      stats.podium = true
    } else {
      warnings.push('底座未生成：轮廓或配置不满足生成条件')
    }
  }

  if (input.roof?.enabled && ring) {
    const result = buildBuildingRoof(ring, input.roof, { frontFaceIndex })
    if (result) {
      // 屋顶底面贴合顶层墙带顶面
      result.group.position.y = input.wallHeight
      attachToFloor(floorDecor, floorCount - 1, result.group, 'roof')
      stats.roof = true
    } else {
      warnings.push('屋顶未生成：轮廓或配置不满足生成条件')
    }
  }

  if (gateConfig && gateFrame) {
    const group = buildGateGroup(gateConfig, gateFrame)
    if (group) {
      attachToFloor(floorDecor, 0, group, 'gate')
      stats.gate = true
    } else {
      warnings.push('大门未生成：门宽或门面法线不合法')
    }
  }

  if (input.facadeStyle) {
    const style = input.facadeStyle
    const perFloor = input.floorRings.map((rings) => floorFacadeFrames(rings, input.wallHeight))
    const totalUnits = perFloor.reduce((sum, item) => sum + item.frames.length, 0)
    const skippedEdges = perFloor.reduce((sum, item) => sum + item.skippedEdges, 0)
    const openRings = perFloor.reduce((sum, item) => sum + item.openRings, 0)

    if (totalUnits > FACADE_UNIT_BUDGET) {
      warnings.push(`立面未生成：单元 ${totalUnits} 个超过预算 ${FACADE_UNIT_BUDGET} 个`)
    } else if (totalUnits === 0) {
      warnings.push('立面未生成：没有可用的闭合墙环')
    } else {
      let generatedFloors = 0
      for (let floor = 0; floor < perFloor.length; floor++) {
        const frames = perFloor[floor].frames
        if (frames.length === 0) continue
        const faceIndexes = Array.from(new Set(frames.map((frame) => frame.faceIndex)))
        const faceConfigs = faceIndexes.map((faceIndex) =>
          createFacadeFaceConfig(style, faceIndex, [0, 0], {
            floorHeight: input.wallHeight,
          }),
        )
        const relief = buildFacadeReliefFromFrames(frames, faceConfigs, {
          baseHeight: facadeBaseHeight(floor, input.podium),
          openings: floor === 0 ? openings : [],
        })
        if (!relief) {
          warnings.push(`第 ${floor + 1} 层立面未生成：三角面预算或配置不满足生成条件`)
          continue
        }
        attachToFloor(floorDecor, floor, relief.group, 'facade')
        generatedFloors++
        stats.facadeUnits += frames.length
      }
      stats.facadeFloors = generatedFloors
      if (generatedFloors > 0) {
        warnings.push(`立面已生成：${generatedFloors} 层 / ${stats.facadeUnits} 个单元`)
      }
    }

    if (skippedEdges > 0) {
      warnings.push(`立面跳过 ${skippedEdges} 条零宽度墙带边`)
    }
    if (openRings > 0) {
      warnings.push(`立面跳过 ${openRings} 条开放墙带链（未闭合，无法构成立面单元）`)
    }
  }

  // 外观配置：只导出「实际生成成功」的构件，避免编辑器重建出预览里没有的东西
  const appearance: ProceduralKitAppearance = {
    outlineRing: ring,
    frontFaceIndex,
    levels: new Array(floorCount).fill(null).map((_, floor) => ({
      facadeStyle: input.facadeStyle,
      podium: floor === 0 && stats.podium ? input.podium : null,
      roof: floor === floorCount - 1 && stats.roof ? input.roof : null,
      entranceGates: floor === 0 && stats.gate && gateConfig ? [gateConfig] : [],
    })),
  }

  return { floorDecor, outline, frontFaceIndex, appearance, warnings, stats }
}

/** 释放构件容器内的全部构件资源 */
export function disposeProceduralKit(containers: ReadonlyArray<THREE.Object3D | null>): void {
  for (const container of containers) {
    if (!container) continue
    for (const child of [...container.children]) {
      const kind = child.userData.__kitKind as KitKind | undefined
      if (kind === 'podium') disposeBuildingPodiumGroup(child)
      else if (kind === 'roof') disposeBuildingRoofGroup(child)
      else if (kind === 'gate') releaseGateGroupResources(child)
      else if (kind === 'facade') disposeFacadeReliefGroup(child)
      else child.removeFromParent()
    }
    container.removeFromParent()
  }
}
