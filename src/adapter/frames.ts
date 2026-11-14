/**
 * 墙面框架构造：把轮廓环的直边映射为门面 / 立面单元坐标系。
 *
 * - 大门使用 `GateFaceFrame`（起止点 + 外法线 + 横向缩放）；
 * - 立面使用 `FacadeWallFrame`（原点 + 方向 + 外法线 + 宽度 + 层高）。
 *
 * `faceFrameXZ` 的外法线约定为 `(dz, -dx)`，与底座 / 屋顶的 `faceIndex` 语义一致，
 * 因此同一条边上的门洞（底座开口）与门体天然对齐。
 */

import * as THREE from 'three'
import { faceFrameXZ, type RingXZ } from '../lib/podium/podiumBuilder'
import type { GateFaceFrame } from '../lib/gate/gateBuilder'
import type { FacadeWallFrame } from '../lib/facade/facadeRelief'

/** CAD 坐标已是真实米，门面横向缩放恒为 1（不需要编辑器里的墨卡托修正） */
export const GATE_HORIZONTAL_SCALE = 1

/** 立面单元最小宽度（米）：低于该值视为退化墙带，不生成几何 */
export const MIN_FACADE_WIDTH_M = 1e-3

/** 由轮廓环的一条边构造门面坐标系；边退化时返回 null */
export function gateFrameFromRing(ring: RingXZ, faceIndex: number): GateFaceFrame | null {
  const face = faceFrameXZ(ring, faceIndex)
  if (!face) return null
  const start = ring[faceIndex]
  const end = ring[(faceIndex + 1) % ring.length]
  return {
    start: new THREE.Vector3(start[0], 0, start[1]),
    end: new THREE.Vector3(end[0], 0, end[1]),
    normal: new THREE.Vector3(face.outward[0], 0, face.outward[1]),
    horizontalScale: GATE_HORIZONTAL_SCALE,
  }
}

/** 立面框架集合：可用单元与因退化被跳过的边序号 */
export interface FacadeFrameSet {
  frames: FacadeWallFrame[]
  skippedEdges: number[]
}

/**
 * 把轮廓环拆成立面单元：每条直边一个单元。
 *
 * 一条闭合墙带链由多条直边组成，每条直边是独立的平面墙段；
 * 单元宽度等于该直边长度，层高取调用方传入的墙高。
 */
export function facadeFramesFromRing(ring: RingXZ, wallHeight: number): FacadeFrameSet {
  const frames: FacadeWallFrame[] = []
  const skippedEdges: number[] = []
  for (let i = 0; i < ring.length; i++) {
    const face = faceFrameXZ(ring, i)
    if (!face || face.width < MIN_FACADE_WIDTH_M) {
      skippedEdges.push(i)
      continue
    }
    const start = ring[i]
    frames.push({
      faceIndex: i,
      origin: new THREE.Vector3(start[0], 0, start[1]),
      dir: new THREE.Vector3(face.dir[0], 0, face.dir[1]),
      outward: new THREE.Vector3(face.outward[0], 0, face.outward[1]),
      width: face.width,
      height: wallHeight,
    })
  }
  return { frames, skippedEdges }
}
