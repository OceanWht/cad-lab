/**
 * 墙面开口（门洞）避让工具
 *
 * 大门贴在建筑墙面上，底座 / 立面装饰若继续覆盖门洞范围会挡住大门。
 * 这里把大门的落点换算成「面局部 u 区间 + 高度」的孔洞，供底座与立面
 * 附件构建器裁剪几何；编辑器与 standalone-engine 共用同一套数学。
 *
 * 坐标约定：
 * - 大门中心与面方向均为建筑局部坐标（y = 0 的底边）；
 * - 宽度为场景米（真实米 × 水平换算系数），与 gateBuilder 的渲染宽度一致；
 * - 孔洞高度为场景米（Y 方向 1:1）。
 */
import * as THREE from 'three'
import type { EntranceGateConfig } from '../../shared/types'
import { gateEffectiveWidthScene } from '../gate/gateTypes'

/** 相邻门洞间隙不超过该值（场景米）时合并为一整段，避免接缝处残留装饰 / 底座细条 */
export const GATE_SEAM_MERGE_GAP = 0.25

/** 墙面开口：某一大门在建筑局部空间中的门洞范围 */
export interface WallOpening {
  faceIndex: number
  /** 门洞中心（建筑局部坐标，y = 0） */
  center: THREE.Vector3
  /** 面方向单位向量（建筑局部水平） */
  dir: THREE.Vector3
  /** 门洞净宽（场景米） */
  width: number
  /** 门洞净高（场景米） */
  height: number
}

/** 面局部坐标下的孔洞区间（u 从面起点沿边，y 为高度） */
export interface WallHoleRange {
  u0: number
  u1: number
  /** 孔洞高度上限（从 y = 0 起） */
  height: number
}

/** 面局部矩形（沿边 u、高度 y） */
export interface WallRect {
  u0: number
  u1: number
  y0: number
  y1: number
}

export interface GateFaceEndpoints {
  start: THREE.Vector3
  end: THREE.Vector3
}

/**
 * 由大门配置与面端点计算开口列表。
 *
 * 宽度换算与 `buildGateGroup` 完全一致：真实米 → 场景米乘水平系数，
 * 并按面长（真实米）截断留 0.4m 余量。
 */
export function collectGateOpenings(
  gates: EntranceGateConfig[],
  frameAt: (faceIndex: number) => GateFaceEndpoints | null,
  horizontalScale: number,
): WallOpening[] {
  const hScale =
    Number.isFinite(horizontalScale) && horizontalScale > 0 ? horizontalScale : 1
  const result: WallOpening[] = []
  for (const gate of gates) {
    if (!gate || !Number.isFinite(gate.faceIndex) || gate.faceIndex < 0) continue
    const frame = frameAt(gate.faceIndex)
    if (!frame) continue
    const dir = new THREE.Vector3().subVectors(frame.end, frame.start)
    dir.y = 0
    const faceLen = dir.length()
    if (!Number.isFinite(faceLen) || faceLen < 1e-4) continue
    dir.normalize()
    const t = Math.max(0, Math.min(1, Number.isFinite(gate.offsetT) ? gate.offsetT : 0.5))
    const center = new THREE.Vector3().copy(frame.start).addScaledVector(dir, faceLen * t)
    center.y = 0
    result.push({
      faceIndex: gate.faceIndex,
      center,
      dir,
      width: gateEffectiveWidthScene(gate.width, faceLen, hScale),
      height: Math.max(1.5, gate.height),
    })
  }
  return result
}

/** 取某一面上的孔洞区间（u 已裁剪到面宽范围内） */
export function holeRangesForFace(
  openings: WallOpening[],
  faceIndex: number,
  origin: { x: number; z: number },
  dir: { x: number; z: number },
  faceWidth: number,
): WallHoleRange[] {
  if (!openings.length) return []
  const result: WallHoleRange[] = []
  const dx = dir.x
  const dz = dir.z
  for (const opening of openings) {
    if (opening.faceIndex !== faceIndex) continue
    if (!Number.isFinite(opening.height) || opening.height <= 0.01) continue
    const centerU =
      (opening.center.x - origin.x) * dx + (opening.center.z - origin.z) * dz
    const half = Math.max(0.05, opening.width / 2)
    const u0 = Math.max(0, centerU - half)
    const u1 = Math.min(faceWidth, centerU + half)
    if (u1 - u0 <= 0.01) continue
    result.push({ u0, u1, height: opening.height })
  }
  if (result.length < 2) return result
  // 相邻门洞（间隙 ≤ GATE_SEAM_MERGE_GAP）合并为一整段，使底座 / 立面按整排裁切
  result.sort((a, b) => a.u0 - b.u0)
  const merged: WallHoleRange[] = []
  for (const hole of result) {
    const last = merged[merged.length - 1]
    if (last && hole.u0 - last.u1 <= GATE_SEAM_MERGE_GAP) {
      last.u1 = Math.max(last.u1, hole.u1)
      last.height = Math.max(last.height, hole.height)
    } else {
      merged.push({ ...hole })
    }
  }
  return merged
}

/**
 * 用若干孔洞裁剪矩形，返回保留的子矩形。
 *
 * 孔洞从 y = 0 起算，因此只可能在「左侧 / 右侧 / 上方」残留几何。
 */
export function subtractHoleRects(rect: WallRect, holes: WallHoleRange[]): WallRect[] {
  if (!holes.length) return [rect]
  let current: WallRect[] = [rect]
  for (const hole of holes) {
    if (hole.height <= 0.01) continue
    const next: WallRect[] = []
    for (const r of current) {
      const uOverlap = Math.min(r.u1, hole.u1) - Math.max(r.u0, hole.u0)
      const yOverlap = Math.min(r.y1, hole.height) - Math.max(r.y0, 0)
      if (uOverlap <= 0.002 || yOverlap <= 0.002) {
        next.push(r)
        continue
      }
      // 左侧残留
      if (hole.u0 > r.u0 + 0.002) {
        next.push({ u0: r.u0, u1: Math.min(r.u1, hole.u0), y0: r.y0, y1: r.y1 })
      }
      // 右侧残留
      if (hole.u1 < r.u1 - 0.002) {
        next.push({ u0: Math.max(r.u0, hole.u1), u1: r.u1, y0: r.y0, y1: r.y1 })
      }
      // 上方残留（孔洞只到 hole.height）
      if (hole.height < r.y1 - 0.002) {
        const uh = Math.max(r.u0, hole.u0)
        const ue = Math.min(r.u1, hole.u1)
        if (ue - uh > 0.002) {
          next.push({ u0: uh, u1: ue, y0: Math.max(r.y0, hole.height), y1: r.y1 })
        }
      }
    }
    current = next
  }
  return current
}

/** u 区间是否与任意孔洞相交且位于孔洞高度以内（用于跳过柱 / 盒等实体构件） */
export function intersectsHole(
  holes: WallHoleRange[],
  u0: number,
  u1: number,
  y0: number,
  y1: number,
): boolean {
  for (const hole of holes) {
    if (Math.min(u1, hole.u1) - Math.max(u0, hole.u0) <= 0.002) continue
    if (Math.min(y1, hole.height) - Math.max(y0, 0) <= 0.002) continue
    return true
  }
  return false
}
