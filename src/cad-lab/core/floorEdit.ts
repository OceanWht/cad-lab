/**
 * 逐层删除对象的参数模型。
 *
 * 键是对象键：墙段键、门窗键（`@opening:`）与幕墙键（`@curtain:`）共用同一套集合。
 * 删除分两级作用范围：
 * - `global`：未选中楼层时删除的对象，作用于每一层，保持「标准层」语义；
 * - `floors[i]`：选中 F(i+1) 时删除的对象，只写这一层，其他楼层保持原样。
 *
 * 某一层实际删除的对象 = `global ∪ floors[i]`。全部为纯函数，便于单测；
 * 不读写 DOM、three 与原因，只处理键集合。
 */

/** 删除作用范围：全局删除集 + 逐层追加删除集（下标即楼层） */
export interface RemovalScope {
  /** 全局删除集：作用于每一层 */
  global: Set<string>
  /** 逐层追加删除集：只在选中楼层时写入 */
  floors: Set<string>[]
}

/** 复制作用范围，供撤销快照使用；入参保持不变 */
export function cloneRemovalScope(scope: RemovalScope): RemovalScope {
  return {
    global: new Set(scope.global),
    floors: scope.floors.map((keys) => new Set(keys)),
  }
}

/** 楼层下标校验：必须是大于等于 0 的整数 */
function assertFloorIndex(floorIndex: number): void {
  if (!Number.isInteger(floorIndex) || floorIndex < 0) {
    throw new Error(`楼层下标超出范围：${floorIndex}`)
  }
}

/** 某一层实际删除的墙段键：全局删除集 ∪ 该层追加删除集 */
export function removedKeysForFloor(scope: RemovalScope, floorIndex: number): Set<string> {
  assertFloorIndex(floorIndex)
  const extra = scope.floors[floorIndex]
  if (extra === undefined || extra.size === 0) return new Set(scope.global)
  const merged = new Set(scope.global)
  for (const key of extra) merged.add(key)
  return merged
}

/**
 * 删除集签名：相同签名表示两层需要生成完全一致的几何，可共享同一份。
 * 空集签名固定为空字符串，对应「未做任何逐层删除」的基准楼层。
 */
export function removalSignature(keys: ReadonlySet<string>): string {
  if (keys.size === 0) return ''
  return [...keys].sort().join('\n')
}

/**
 * 把删除键写入指定作用范围，返回新对象，不修改入参。
 *
 * @param floorIndex `null` 写全局（作用于全部楼层）；否则只写该层的追加删除集
 */
export function addRemovedKeys(
  scope: RemovalScope,
  floorIndex: number | null,
  keys: Iterable<string>,
): RemovalScope {
  const next = cloneRemovalScope(scope)
  if (floorIndex === null) {
    for (const key of keys) next.global.add(key)
    return next
  }
  assertFloorIndex(floorIndex)
  // 楼层数增加后数组可能还没补齐：按需扩到该下标，中间楼层保持空集
  while (next.floors.length <= floorIndex) next.floors.push(new Set())
  for (const key of keys) next.floors[floorIndex].add(key)
  return next
}

/** 已删除的墙段总数（全局 ∪ 所有逐层追加），用于工具栏统计 */
export function removedKeyCount(scope: RemovalScope): number {
  const union = new Set(scope.global)
  for (const keys of scope.floors) {
    for (const key of keys) union.add(key)
  }
  return union.size
}
