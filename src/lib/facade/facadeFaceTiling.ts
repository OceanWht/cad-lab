import * as THREE from 'three'
import type { FacadeFaceConfig } from '../../shared/types'

export interface FacadeFaceTiling {
  repeatX: number
  repeatY: number
  offsetX: number
  offsetY: number
}

/** 单面模块网格：贴图分区与几何附件共用的唯一取整结果 */
export interface FacadeModuleGrid {
  bays: number
  floors: number
  /** 取整后的实际开间（米） */
  bayWidth: number
  /** 取整后的实际层高（米） */
  floorHeight: number
}

/**
 * 统一开间 / 层数取整：纹理平铺与几何附件都消费这一份结果，
 * 避免两处各自 `round` 造成窗洞与竖梃错位。
 */
export function resolveFacadeModuleGrid(
  width: number,
  height: number,
  config: FacadeFaceConfig,
): FacadeModuleGrid {
  const spanW = Math.max(0.4, width)
  const spanH = Math.max(0.4, height)
  const bayWidth = Math.max(0.4, Number(config.bayWidth) || 3)
  const floorHeight = Math.max(0.4, Number(config.floorHeight) || 3)
  const bays = Math.max(1, Math.round(spanW / bayWidth))
  const floors = Math.max(1, Math.round(spanH / floorHeight))
  return {
    bays,
    floors,
    bayWidth: spanW / bays,
    floorHeight: spanH / floors,
  }
}

/**
 * 复制主 UV 到 `uv1`，供 aoMap 取样（three 的 `uv1` 通道）。
 * 返回 false 表示几何没有 uv，aoMap 将退化为常量采样。
 */
export function ensureFacadeUv1(geometry: THREE.BufferGeometry): boolean {
  const uv = geometry.getAttribute('uv')
  if (!uv) return false
  if (geometry.getAttribute('uv1')) return true
  geometry.setAttribute('uv1', uv.clone())
  return true
}

/**
 * 按单个墙面实际 UV 跨度计算平铺参数：
 * 开间数 / 层数取整后重新铺满整个面，避免墙两端出现被截断的半扇窗。
 *
 * ExtrudeGeometry 的侧面 UV 直接取自局部坐标（米），因此每个面的 UV 跨度即该面
 * 的真实长度；用整数开间重算 repeat，并把 UV 起点对齐到面起点，
 * 就能保证每个面从第一扇窗到最后一扇窗都是完整的。
 */
export function computeFacadeFaceTiling(
  geometry: THREE.BufferGeometry | null | undefined,
  faceIndex: number,
  config: FacadeFaceConfig,
): FacadeFaceTiling | null {
  const uv = geometry?.attributes?.uv
  const groups = geometry?.groups
  if (!uv || !groups?.length) return null
  // group.materialIndex 0 为屋顶，墙面从 1 开始，对应 faceIndex
  const target = groups.find((g) => (Number(g.materialIndex ?? 0)) === faceIndex + 1)
  if (!target || !target.count) return null

  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (let i = target.start; i < target.start + target.count; i++) {
    const u = uv.getX(i)
    const v = uv.getY(i)
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }

  const spanU = maxU - minU
  const spanV = maxV - minV
  if (!Number.isFinite(spanU) || !Number.isFinite(spanV)) return null
  if (spanU <= 1e-3 || spanV <= 1e-3) return null

  const bayWidth = Math.max(0.4, Number(config.bayWidth) || 3)
  const floorHeight = Math.max(0.4, Number(config.floorHeight) || 3)
  const bays = Math.max(1, Math.round(spanU / bayWidth))
  const floors = Math.max(1, Math.round(spanV / floorHeight))
  const repeatX = bays / spanU
  const repeatY = floors / spanV

  return {
    repeatX,
    repeatY,
    offsetX: -minU * repeatX,
    offsetY: -minV * repeatY,
  }
}
