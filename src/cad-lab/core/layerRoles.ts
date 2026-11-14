/**
 * 图层角色解析：把「墙体图层勾选」与「门窗类型下拉」整理成生成阶段使用的角色表。
 *
 * 墙体 / 白膜墙 / 玻璃幕墙 / 嵌墙窗的几何只由勾选的墙体图层产出；
 * 但门图层是个例外：它只画门扇与开启弧线，没有墙厚，通常不会被勾选成墙体图层，
 * 而它又是门构件的唯一来源。若把这类图层的「门」标记丢掉，界面里选了门也不会有
 * 任何门模型，因此显式标记为「门」的非墙体图层需要补进角色表参与洞口识别。
 */

import type { OpeningKind } from './doorWindowModel'

/** 图层在生成阶段扮演的角色：门 / 窗 / 玻璃幕墙 / 白膜墙 */
export type LayerRole = OpeningKind | 'curtain' | 'massing'

/** 解析图层角色所需的配置 */
export interface LayerRoleInput {
  /** 勾选为墙体图层的图层名 */
  wallLayers: readonly string[]
  /** 下拉里显式设置的门窗类型；未设置的图层不出现在表里 */
  openingKinds: Readonly<Record<string, OpeningKind | 'curtain' | 'wall'>>
}

/**
 * 解析参与生成的图层角色。
 *
 * - 勾选的墙体图层：下拉选「门 / 窗 / 幕墙」的原样保留，其余（含「忽略」「墙体」）按白膜墙；
 * - 未勾选墙体、但显式标记为「门」的图层：补成「门」，只参与洞口识别，不建任何墙体；
 * - 未勾选墙体、标记为「窗」「幕墙」的图层不补：这两类的几何仍只由勾选的墙体图层产出，
 *   避免把非墙图层误建成墙。
 */
export function resolveLayerRoles(input: LayerRoleInput): Record<string, LayerRole> {
  const roles: Record<string, LayerRole> = {}
  for (const name of input.wallLayers) {
    const kind = input.openingKinds[name]
    roles[name] = kind === 'door' || kind === 'window' || kind === 'curtain' ? kind : 'massing'
  }
  const checkedWallLayers = new Set(input.wallLayers)
  for (const [name, kind] of Object.entries(input.openingKinds)) {
    if (kind === 'door' && !checkedWallLayers.has(name)) roles[name] = 'door'
  }
  return roles
}
