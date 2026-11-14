/**
 * B 样条采样：de Boor 递推 + 按弦高容差自适应加密。
 *
 * 说明：
 * - 支持有理样条（控制点带 weight），内部以齐次坐标 (w·x, w·y, w) 计算；
 * - 参数域取 [knots[degree], knots[控制点数]]，即标准 clamped 样条的定义域；
 * - 同时服务顶层 SPLINE 实体与 HATCH 的样条边界，避免两份实现；
 * - 输入来自外部解析库，结构不合法时直接抛错，由调用方计入未渲染实体；
 * - 采样点数上限 512，与圆弧分段上限保持一致，避免异常数据拖垮渲染。
 */

import { distance } from './geometry'
import type { CadPoint } from './types'

/** 样条控制点（weight 缺省表示 1） */
export interface SplineControlPoint {
  x: number
  y: number
  weight?: number
}

/** 采样点数上限 */
const MAX_SAMPLE_POINTS = 512

/** 自适应细分最大深度（每层把参数区间二等分） */
const MAX_SUBDIVISION_DEPTH = 10

/**
 * 判断样条数据是否可采样：次数、控制点数与节点数必须自洽。
 * 供调用方在解析阶段提前判定，避免用异常数据触发采样异常。
 */
export function isSplineValid(
  degree: number,
  knotCount: number,
  controlPointCount: number,
): boolean {
  if (!Number.isInteger(degree) || degree < 1) return false
  if (controlPointCount < degree + 1) return false
  return knotCount >= controlPointCount + degree + 1
}

/** 齐次坐标点 */
interface HomogeneousPoint {
  x: number
  y: number
  w: number
}

/** 控制点转齐次坐标；权重非法时抛错，不做兜底 */
function toHomogeneous(point: SplineControlPoint): HomogeneousPoint {
  const weight = typeof point.weight === 'number' ? point.weight : 1
  if (!(weight > 0)) {
    throw new Error(`样条控制点权重必须为正数：${weight}`)
  }
  return { x: point.x * weight, y: point.y * weight, w: weight }
}

/**
 * 查找参数 u 所在的节点区间下标 span，满足 knots[span] <= u < knots[span + 1]。
 * u 等于参数域右端点时退化到最后一个非空区间。
 */
function findSpan(degree: number, knots: number[], u: number, lastIndex: number): number {
  if (u <= knots[degree]) return degree
  if (u >= knots[lastIndex + 1]) return lastIndex
  let low = degree
  let high = lastIndex + 1
  let mid = Math.floor((low + high) / 2)
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) {
      high = mid
    } else {
      low = mid
    }
    mid = Math.floor((low + high) / 2)
  }
  return mid
}

/**
 * 用 de Boor 递推求参数 u 处的曲线点（齐次坐标结果再做透视除法）。
 */
function evaluateSplinePoint(
  degree: number,
  knots: number[],
  controlPoints: HomogeneousPoint[],
  lastIndex: number,
  u: number,
): CadPoint {
  const span = findSpan(degree, knots, u, lastIndex)
  const d: HomogeneousPoint[] = []
  for (let j = 0; j <= degree; j += 1) {
    const source = controlPoints[span - degree + j]
    d[j] = { x: source.x, y: source.y, w: source.w }
  }
  for (let r = 1; r <= degree; r += 1) {
    for (let j = degree; j >= r; j -= 1) {
      const i = span - degree + j
      const denominator = knots[i + degree + 1 - r] - knots[i]
      // 重复节点会形成零长度区间，此时取 alpha = 0（de Boor 的标准约定）
      const alpha = denominator === 0 ? 0 : (u - knots[i]) / denominator
      const previous = d[j - 1]
      const current = d[j]
      d[j] = {
        x: previous.x + alpha * (current.x - previous.x),
        y: previous.y + alpha * (current.y - previous.y),
        w: previous.w + alpha * (current.w - previous.w),
      }
    }
  }
  const result = d[degree]
  return { x: result.x / result.w, y: result.y / result.w }
}

/** 点到线段的偏离距离（投影落在段外时取到最近端点的距离） */
function deviationFromChord(point: CadPoint, a: CadPoint, b: CadPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < 1e-24) return distance(point, a)
  const raw = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
  if (raw <= 0) return distance(point, a)
  if (raw >= 1) return distance(point, b)
  return Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / Math.sqrt(lengthSquared)
}

/**
 * 采样样条曲线。
 * @param degree 曲线次数（1 为折线，2 为二次，3 为三次）
 * @param knots 节点向量（长度需 >= 控制点数 + 次数 + 1）
 * @param controlPoints 控制点（可带 weight）
 * @param tolerance 弦高误差上限（图纸单位）
 * @param closed 闭合曲线是否在末尾补回起点（避免与 closed 标志重复绘制）
 */
export function sampleSpline(
  degree: number,
  knots: number[],
  controlPoints: SplineControlPoint[],
  tolerance: number,
  closed: boolean,
): CadPoint[] {
  if (!isSplineValid(degree, knots.length, controlPoints.length)) {
    throw new Error(
      `样条结构非法：degree=${degree}，knots=${knots.length}，controlPoints=${controlPoints.length}`,
    )
  }
  if (!(tolerance > 0)) throw new Error(`样条采样容差必须为正数：${tolerance}`)
  for (let i = 1; i < knots.length; i += 1) {
    if (knots[i] < knots[i - 1]) throw new Error(`样条节点向量必须非递减（下标 ${i}）`)
  }

  const lastIndex = controlPoints.length - 1
  const domainStart = knots[degree]
  const domainEnd = knots[lastIndex + 1]
  if (!(domainEnd > domainStart)) throw new Error('样条参数域为空')

  const homogeneous = controlPoints.map(toHomogeneous)
  const evaluate = (u: number): CadPoint =>
    evaluateSplinePoint(degree, knots, homogeneous, lastIndex, u)

  const points: CadPoint[] = [evaluate(domainStart)]

  /**
   * 判断当前参数区间能否用直线段近似：同时检查 1/4、1/2、3/4 三个探针点，
   * 避免对称 S 形曲线因中点恰好落在弦上而提前收敛。
   */
  const appendSpan = (
    startPoint: CadPoint,
    parameterStart: number,
    endPoint: CadPoint,
    parameterEnd: number,
    depth: number,
  ): void => {
    if (points.length >= MAX_SAMPLE_POINTS) {
      points.push(endPoint)
      return
    }
    const span = parameterEnd - parameterStart
    const quarter = evaluate(parameterStart + span * 0.25)
    const middle = evaluate(parameterStart + span * 0.5)
    const threeQuarter = evaluate(parameterStart + span * 0.75)
    const deviation = Math.max(
      deviationFromChord(quarter, startPoint, endPoint),
      deviationFromChord(middle, startPoint, endPoint),
      deviationFromChord(threeQuarter, startPoint, endPoint),
    )
    if (depth <= 0 || deviation <= tolerance) {
      points.push(endPoint)
      return
    }
    const parameterMiddle = parameterStart + span * 0.5
    appendSpan(startPoint, parameterStart, middle, parameterMiddle, depth - 1)
    appendSpan(middle, parameterMiddle, endPoint, parameterEnd, depth - 1)
  }

  appendSpan(points[0], domainStart, evaluate(domainEnd), domainEnd, MAX_SUBDIVISION_DEPTH)

  if (closed) {
    const first = points[0]
    const last = points[points.length - 1]
    if (distance(first, last) > 1e-12) points.push({ x: first.x, y: first.y })
  }
  return points
}
