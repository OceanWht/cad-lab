/**
 * 天空背景的纯数据模型：确定性云团分布。
 *
 * 不使用 Math.random —— 云团位置由固定种子的线性同余发生器推导，
 * 保证每次打开页面天空完全一致，也便于单元测试。
 */

/** 单团云朵斑块（等距柱状投影坐标，u/v 取值 0–1） */
export interface CloudPuff {
  /** 水平位置 0–1，0 与 1 是同一经度 */
  u: number
  /** 垂直位置 0–1，0 为天顶、0.5 为地平线 */
  v: number
  /** 半径，相对画布宽度 */
  radius: number
  /** 不透明度 0–1 */
  alpha: number
}

/** 云只出现在地平线以上的这层区间里，避免云飘到地面下半球 */
const CLOUD_BAND_MIN = 0.08
const CLOUD_BAND_MAX = 0.42
/** 每团云由若干个重叠圆斑叠出蓬松轮廓 */
const PUFFS_PER_CLUSTER = 6
/** 半径下限与浮动范围，相对画布宽度 */
const PUFF_RADIUS_MIN = 0.012
const PUFF_RADIUS_RANGE = 0.026

/**
 * 确定性伪随机序列（线性同余发生器）。
 * 同一个种子永远产出同一串 0–1 的数，替代被项目规范禁止的 Math.random。
 */
function* seededSequence(seed: number): Generator<number> {
  let state = seed >>> 0
  for (;;) {
    state = (state * 1664525 + 1013904223) >>> 0
    yield state / 4294967296
  }
}

/** 把经度折算回 0–1，云团跨过接缝时不至于被裁掉 */
function wrapLongitude(value: number): number {
  const wrapped = value % 1
  return wrapped < 0 ? wrapped + 1 : wrapped
}

/**
 * 生成云团斑块列表。
 *
 * 每团云先在云带内取一个中心，再用若干圆斑在其周围抖动叠出体积感；
 * 所有参数都来自种子序列，输出对同一组入参完全可复现。
 *
 * @param seed 种子，同一 seed 结果一致
 * @param clusters 云团数量，必须是正整数
 */
export function cloudPuffs(seed: number, clusters: number): CloudPuff[] {
  if (!Number.isInteger(clusters) || clusters < 1) {
    throw new Error(`云团数量必须是正整数：${clusters}`)
  }

  const sequence = seededSequence(seed)
  const next = (): number => sequence.next().value as number
  const puffs: CloudPuff[] = []

  for (let cluster = 0; cluster < clusters; cluster += 1) {
    const centerU = next()
    const centerV = CLOUD_BAND_MIN + (CLOUD_BAND_MAX - CLOUD_BAND_MIN) * next()
    const spread = PUFF_RADIUS_MIN + PUFF_RADIUS_RANGE * next()

    for (let puff = 0; puff < PUFFS_PER_CLUSTER; puff += 1) {
      const offsetU = (next() - 0.5) * spread * 3.2
      const offsetV = (next() - 0.5) * spread * 1.1
      const radius = PUFF_RADIUS_MIN + PUFF_RADIUS_RANGE * next()
      const alpha = 0.16 + 0.24 * next()
      puffs.push({
        u: wrapLongitude(centerU + offsetU),
        v: centerV + offsetV,
        radius,
        alpha,
      })
    }
  }

  return puffs
}
