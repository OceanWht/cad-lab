/**
 * 多层建筑的纯参数模型：参数校验、楼层标高、抽屉位移与动画插值。
 *
 * 本模块不依赖 three.js 与 DOM，便于单元测试；所有非法输入都直接抛错，
 * 不做钳制兜底 —— 输入范围由界面表单约束，语义错误必须显式暴露。
 */

/** 楼层数下限 */
export const MIN_FLOOR_COUNT = 1
/** 楼层数上限 */
export const MAX_FLOOR_COUNT = 100
/** 抽屉拉开时上方楼层抬升量相对层间距的比例 */
export const DRAWER_PULL_RATIO = 0.8
/** 抽屉滑出后与被抽楼层之间留出的间隙，相对层间距 */
export const DRAWER_SLIDE_GAP_RATIO = 0.3
/** 墙高与层间距比较时的浮点容差（米） */
const LENGTH_EPSILON = 1e-9

/** 平面包围盒（米），用于计算抽屉滑出方向 */
export interface PlanBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 抽屉滑出结果 */
export interface DrawerSlide {
  /** X 方向位移（米） */
  x: number
  /** Z 方向位移（米） */
  z: number
  /** 滑出方向上的整层跨度（米） */
  span: number
}

/** 楼层堆叠参数（用户输入，未校验） */
export interface BuildingParams {
  /** 楼层数，1–100 的整数 */
  floorCount: number
  /** 层间距（米），相邻两层板顶之间的高差 */
  floorSpacing: number
  /** 墙高（米），墙高与板厚之和不得超过层间距 */
  wallHeight: number
  /** 楼板厚度（米），默认 0.2，沿竖直方向向下占用层间距 */
  slabThickness: number
}

/** 校验通过的楼层参数；字段语义与输入一致，可直接用于生成几何 */
export type NormalizedBuildingParams = BuildingParams

/** 把米制长度按毫米取整，避免 `3 - 0.15` 之类的浮点残差显示成 2.8499999999999996 */
export function roundMillimeter(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 由层间距、墙高与板厚算出楼层之间的空隙，用于面板提示与错误文案 */
export function floorGap(floorSpacing: number, wallHeight: number, slabThickness: number): number {
  return roundMillimeter(floorSpacing - wallHeight - slabThickness)
}

/**
 * 校验楼层参数并返回规范化结果。
 * 任一条件不满足时抛出带字段名的中文错误，调用方负责展示，不生成任何几何。
 */
export function normalizeBuildingParams(raw: BuildingParams): NormalizedBuildingParams {
  const { floorCount, floorSpacing, wallHeight, slabThickness } = raw

  if (!Number.isInteger(floorCount) || floorCount < MIN_FLOOR_COUNT || floorCount > MAX_FLOOR_COUNT) {
    throw new Error(`楼层数必须是 ${MIN_FLOOR_COUNT}–${MAX_FLOOR_COUNT} 之间的整数：${floorCount}`)
  }
  if (!(floorSpacing > 0)) {
    throw new Error(`层间距必须为正数：${floorSpacing}`)
  }
  if (!(wallHeight > 0)) {
    throw new Error(`墙高必须为正数：${wallHeight}`)
  }
  if (!(slabThickness > 0)) {
    throw new Error(`板厚必须为正数：${slabThickness}`)
  }
  // 每层墙高 + 板厚必须落在层间距内，否则楼板会穿到上一层墙里
  if (wallHeight + slabThickness > floorSpacing + LENGTH_EPSILON) {
    throw new Error(
      `墙高与板厚之和必须不超过层间距（${roundMillimeter(floorSpacing)} m）：` +
        `${roundMillimeter(wallHeight)} + ${roundMillimeter(slabThickness)} = ` +
        `${roundMillimeter(wallHeight + slabThickness)} m`,
    )
  }

  return {
    floorCount,
    floorSpacing,
    wallHeight: roundMillimeter(wallHeight),
    slabThickness: roundMillimeter(slabThickness),
  }
}

/** 第 index 层（从 0 起）墙脚的标高（米） */
export function floorElevation(index: number, params: NormalizedBuildingParams): number {
  return index * params.floorSpacing
}

/** 整栋建筑的总高度（米）：最高层墙顶到地面 */
export function buildingHeight(params: NormalizedBuildingParams): number {
  return (params.floorCount - 1) * params.floorSpacing + params.wallHeight
}

/** 上方楼层抬升量（米）：固定为 0.8 个层距，不随楼层数增长 */
export function drawerPullDistance(params: NormalizedBuildingParams): number {
  return params.floorSpacing * DRAWER_PULL_RATIO
}

/**
 * 抽屉滑出量：沿平面较短的一侧把整层水平推出去。
 *
 * 位移 = 该方向整层跨度 + 0.3 个层距的间隙，整层刚好完全离开原位置。
 * 选短边是为了让被抽出的楼层离建筑本体更近，相机聚焦后主体不至于跑出画面。
 */
export function drawerSlide(
  bounds: PlanBounds,
  params: NormalizedBuildingParams,
  pullProgress: number,
): DrawerSlide {
  const spanX = bounds.maxX - bounds.minX
  const spanZ = bounds.maxY - bounds.minY
  const alongX = spanX <= spanZ
  const span = alongX ? spanX : spanZ
  const distance = (span + params.floorSpacing * DRAWER_SLIDE_GAP_RATIO) * clamp01(pullProgress)
  return { x: alongX ? distance : 0, z: alongX ? 0 : distance, span }
}

/**
 * 计算每层的竖向位移（米）。
 *
 * 展开第 k 层时：第 k 层水平滑出、自身不改高度；其**上方**楼层整体上移 `pullDistance`，
 * 在空出的位置拉开 1.8 个层距的净空；其下楼层保持不动，最低层始终贴在地面网格上。
 *
 * @param expandedIndex 展开层下标；null 表示整栋贴合
 * @param pullProgress 动画进度 0–1
 */
export function instanceOffsets(
  params: NormalizedBuildingParams,
  expandedIndex: number | null,
  pullProgress: number,
): Float32Array {
  const offsets = new Float32Array(params.floorCount)
  if (expandedIndex === null) return offsets

  const pull = drawerPullDistance(params) * clamp01(pullProgress)
  for (let index = expandedIndex + 1; index < params.floorCount; index += 1) {
    offsets[index] = pull
  }
  return offsets
}

/** 把进度限制在 0–1；显式分支而非 Math.max 兜底，便于阅读动画边界 */
function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 指数插值：按帧间隔逼近目标值。
 * `dt × rate` 钳在 1 以内，保证大帧间隔时也不会越过目标。
 * 纯函数，动画循环与单测共用同一份实现。
 */
export function smoothTowards(current: number, target: number, dt: number, rate = 6): number {
  return current + (target - current) * Math.min(1, dt * rate)
}

/**
 * 线性逼近：每帧最多移动 `maxDelta`，用于有明确总时长的动画段。
 * 到达目标后精确停在目标值，调用方可以直接用相等判断结束动画。
 * 纯函数，动画循环与单测共用同一份实现。
 */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  if (maxDelta <= 0) return current
  if (current < target) return Math.min(target, current + maxDelta)
  return Math.max(target, current - maxDelta)
}
