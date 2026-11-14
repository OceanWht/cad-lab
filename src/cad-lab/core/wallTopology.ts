/**
 * 墙体拓扑：顶点焊接 → 链合并 → miter 成环。
 *
 * 说明：
 * - 全部为纯函数，坐标单位为「米」，不依赖 three.js 与 DOM，便于单元测试；
 * - 入参 `WallSegment` 由 `wallModel.collectWallSegments` 产出，仍是图纸坐标，
 *   调用方需先换算到米再进入本模块；
 * - 顶点度数为 2 时链继续延伸（转角由 miter 处理），度数 ≥ 3 时断链并保留平端；
 * - 退化墙带不做静默兜底，统一计入 `skippedCount` 交给界面提示。
 */

import type { CadPoint } from './types'
import type { WallSegment } from './wallModel'

/** 焊接后的墙体边（引用 vertices 下标） */
export interface WallEdge {
  a: number
  b: number
  layer: string
  thickness: number
  /** 原始中心线线段的稳定几何键；重合边去重时保留首条线段的键 */
  key: string
}

/** 焊接后的墙体图 */
export interface WallGraph {
  vertices: CadPoint[]
  edges: WallEdge[]
  /** adjacency[i] 为顶点 i 关联的边索引 */
  adjacency: number[][]
}

/** 一条连续墙带（仍引用 graph.vertices 下标） */
export interface WallChain {
  /** 按行走顺序的完整顶点下标（不剔除共线中间点）；闭合链不重复首点 */
  vertices: number[]
  /** 与 vertices 对应的图边下标；闭合链长度 = vertices.length，开放链长度 = vertices.length - 1 */
  edges: number[]
  layer: string
  closed: boolean
  /** 链上各边墙厚的最大值（米） */
  thickness: number
}

/** 已按 miter 偏移的墙带边界 */
export interface WallRing {
  /** 左边界（沿中心线行进方向的左侧） */
  left: CadPoint[]
  /** 右边界 */
  right: CadPoint[]
  closed: boolean
  thickness: number
  /** 组成该墙带的中心线边数 */
  edgeCount: number
  /** 中心线总长度（米） */
  length: number
  /** 与边界点对一一对应的图边下标；闭合链长度 = left.length，开放链长度 = left.length - 1 */
  edges: number[]
}

/** 成环结果 */
export interface WallRingResult {
  rings: WallRing[]
  /** 因几何退化被跳过的链数量 */
  skippedCount: number
}

/** 两点距离 */
function lengthOf(a: CadPoint, b: CadPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** 单位方向向量；零长度返回 null */
function direction(a: CadPoint, b: CadPoint): CadPoint | null {
  const length = lengthOf(a, b)
  if (length < 1e-12) return null
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
}

/** 把下标压入映射表 */
function pushIndex(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key)
  if (list) {
    list.push(value)
  } else {
    map.set(key, [value])
  }
}

/**
 * 顶点焊接：以 `tolerance` 为网格边长做哈希，并对 3×3 邻域内距离不超过容差的顶点做并查集合并。
 * 合并后的顶点坐标取该簇中首个出现的坐标，保证结果确定。
 */
export function weldVertices(segments: WallSegment[], tolerance: number): WallGraph {
  if (!(tolerance > 0)) throw new Error('顶点焊接容差必须为正数')

  const parent: number[] = []
  const rawPoints: CadPoint[] = []
  const buckets = new Map<string, number[]>()

  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let current = index
    while (parent[current] !== current) {
      const next = parent[current]
      parent[current] = root
      current = next
    }
    return root
  }

  const union = (left: number, right: number): void => {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft !== rootRight) parent[rootRight] = rootLeft
  }

  const register = (point: CadPoint): number => {
    const index = rawPoints.length
    parent.push(index)
    rawPoints.push({ x: point.x, y: point.y })
    const cellX = Math.floor(point.x / tolerance)
    const cellY = Math.floor(point.y / tolerance)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = buckets.get(`${cellX + dx},${cellY + dy}`)
        if (!bucket) continue
        for (const other of bucket) {
          if (Math.hypot(rawPoints[other].x - point.x, rawPoints[other].y - point.y) <= tolerance) {
            union(index, other)
          }
        }
      }
    }
    const key = `${cellX},${cellY}`
    const own = buckets.get(key)
    if (own) {
      own.push(index)
    } else {
      buckets.set(key, [index])
    }
    return index
  }

  const rawIndices = segments.map((segment) => ({ a: register(segment.a), b: register(segment.b) }))

  const clusterToVertex = new Map<number, number>()
  const vertices: CadPoint[] = []
  const resolve = (raw: number): number => {
    const root = find(raw)
    const existing = clusterToVertex.get(root)
    if (existing !== undefined) return existing
    const index = vertices.length
    vertices.push({ x: rawPoints[root].x, y: rawPoints[root].y })
    clusterToVertex.set(root, index)
    return index
  }

  const edges: WallEdge[] = []
  const seen = new Set<string>()
  segments.forEach((segment, index) => {
    const a = resolve(rawIndices[index].a)
    const b = resolve(rawIndices[index].b)
    if (a === b) return
    const low = a < b ? a : b
    const high = a < b ? b : a
    const key = `${low}:${high}:${segment.layer}`
    const existing = seen.has(key)
    if (existing) {
      // 同一图层内完全重合的边只保留一条，墙厚取较大值
      const edge = edges.find((item) => item.a === low && item.b === high && item.layer === segment.layer)
      if (edge && segment.thickness > edge.thickness) edge.thickness = segment.thickness
      return
    }
    seen.add(key)
    edges.push({ a, b, layer: segment.layer, thickness: segment.thickness, key: segment.key })
  })

  const adjacency: number[][] = vertices.map(() => [])
  edges.forEach((edge, index) => {
    adjacency[edge.a].push(index)
    adjacency[edge.b].push(index)
  })

  return { vertices, edges, adjacency }
}

/** 顶点处的另一条同图层边（链延伸用）；不存在或不唯一时返回 -1 */
function chainNext(
  vertex: number,
  currentEdge: number,
  incident: Map<number, number[]>,
  used: boolean[],
  startEdge: number,
): number {
  const candidates = incident.get(vertex)
  if (!candidates || candidates.length !== 2) return -1
  const other = candidates[0] === currentEdge ? candidates[1] : candidates[0]
  if (other === currentEdge) return -1
  if (other !== startEdge && used[other]) return -1
  return other
}

/**
 * 把焊接图合并为连续墙带。
 *
 * 链沿顶点度数恰为 2 的路径延伸（转角处继续），度数 ≥ 3 的 T 型 / 十字路口断链并保留平端。
 * 共线中间点不再剔除：每条原始边都要保留独立身份供墙段删除使用，
 * 共线点的 miter 会退化为直偏移，视觉上与剪枝结果一致。
 */
export function mergeCollinearChains(graph: WallGraph, angleTolerance: number): WallChain[] {
  if (!(angleTolerance > 0)) throw new Error('共线合并角度容差必须为正数')

  const byLayer = new Map<string, number[]>()
  graph.edges.forEach((edge, index) => {
    const list = byLayer.get(edge.layer)
    if (list) {
      list.push(index)
    } else {
      byLayer.set(edge.layer, [index])
    }
  })

  const used = new Array<boolean>(graph.edges.length).fill(false)
  const chains: WallChain[] = []

  for (const [layer, edgeIndices] of byLayer) {
    const incident = new Map<number, number[]>()
    for (const index of edgeIndices) {
      const edge = graph.edges[index]
      pushIndex(incident, edge.a, index)
      pushIndex(incident, edge.b, index)
    }

    for (const startEdge of edgeIndices) {
      if (used[startEdge]) continue
      used[startEdge] = true
      const start = graph.edges[startEdge]

      const forward: number[] = [start.b]
      const forwardEdges: number[] = []
      let currentVertex = start.b
      let currentEdge = startEdge
      let closed = false
      for (;;) {
        const next = chainNext(currentVertex, currentEdge, incident, used, startEdge)
        if (next === -1) break
        if (next === startEdge) {
          closed = true
          break
        }
        used[next] = true
        const edge = graph.edges[next]
        currentVertex = edge.a === currentVertex ? edge.b : edge.a
        currentEdge = next
        forward.push(currentVertex)
        forwardEdges.push(next)
      }

      let indices: number[]
      let edgeOrder: number[]
      if (closed) {
        // 闭合链的顶点从 start.b 起算，边序列需左移一位，
        // 保证 edges[i] 恰好连接 vertices[i] 与 vertices[i+1]
        indices = forward
        edgeOrder = [...forwardEdges, startEdge]
      } else {
        const backward: number[] = []
        const backwardEdges: number[] = []
        currentVertex = start.a
        currentEdge = startEdge
        for (;;) {
          const next = chainNext(currentVertex, currentEdge, incident, used, startEdge)
          if (next === -1 || next === startEdge) break
          used[next] = true
          const edge = graph.edges[next]
          currentVertex = edge.a === currentVertex ? edge.b : edge.a
          currentEdge = next
          backward.push(currentVertex)
          backwardEdges.push(next)
        }
        backward.reverse()
        backwardEdges.reverse()
        indices = [...backward, start.a, ...forward]
        edgeOrder = [...backwardEdges, startEdge, ...forwardEdges]
      }

      // 墙厚取链上各原始边的最大值
      let thickness = 0
      for (const index of edgeOrder) {
        const value = graph.edges[index].thickness
        if (value > thickness) thickness = value
      }

      chains.push({
        vertices: indices,
        edges: edgeOrder,
        layer,
        closed,
        thickness,
      })
    }
  }

  return chains
}

/** 计算左右边界：有符号偏移 + miter，超限或 180° 折返退化为方端 */
function buildOffsets(
  points: CadPoint[],
  half: number,
  closed: boolean,
  miterLimit: number,
): { left: CadPoint[]; right: CadPoint[]; origin: number[] } | null {
  const count = points.length
  if (count < 2) return null
  const left: CadPoint[] = []
  const right: CadPoint[] = []
  /** 每个边界点由哪个中心线顶点生成；退化方端会在同一顶点处产生两个点 */
  const origin: number[] = []
  const cosLimit = 1 / miterLimit

  const push = (index: number, point: CadPoint, nx: number, ny: number, scale: number): void => {
    left.push({ x: point.x + nx * scale, y: point.y + ny * scale })
    right.push({ x: point.x - nx * scale, y: point.y - ny * scale })
    origin.push(index)
  }

  for (let i = 0; i < count; i += 1) {
    const point = points[i]
    const isFirst = i === 0
    const isLast = i === count - 1
    const hasPrev = closed || !isFirst
    const hasNext = closed || !isLast

    const prev = hasPrev ? points[(i - 1 + count) % count] : null
    const next = hasNext ? points[(i + 1) % count] : null
    const incoming = prev ? direction(prev, point) : null
    const outgoing = next ? direction(point, next) : null

    if ((hasPrev && !incoming) || (hasNext && !outgoing)) return null

    if (!hasPrev || !hasNext) {
      const dir = (incoming ?? outgoing) as CadPoint
      push(i, point, -dir.y, dir.x, half)
      continue
    }

    const dirIn = incoming as CadPoint
    const dirOut = outgoing as CadPoint
    const nxIn = -dirIn.y
    const nyIn = dirIn.x
    const nxOut = -dirOut.y
    const nyOut = dirOut.x
    const mx = nxIn + nxOut
    const my = nyIn + nyOut
    const miterLength = Math.hypot(mx, my)

    if (miterLength < 1e-9) {
      // 原路折返，无有限 miter，直接方端
      push(i, point, nxIn, nyIn, half)
      push(i, point, nxOut, nyOut, half)
      continue
    }

    const cosHalf = (mx * nxOut + my * nyOut) / miterLength
    if (cosHalf <= cosLimit) {
      push(i, point, nxIn, nyIn, half)
      push(i, point, nxOut, nyOut, half)
      continue
    }

    const scale = half / cosHalf
    push(i, point, mx / miterLength, my / miterLength, scale)
  }

  return { left, right, origin }
}

/** 墙带四边形的有符号面积之和（CAD 平面）；接近 0 说明墙带被压扁或完全折返 */
function bandSignedArea(left: CadPoint[], right: CadPoint[], closed: boolean): number {
  const count = left.length < right.length ? left.length : right.length
  if (count < 2) return 0
  const cross = (p: CadPoint, q: CadPoint): number => p.x * q.y - p.y * q.x
  const pairCount = closed ? count : count - 1
  let sum = 0
  for (let i = 0; i < pairCount; i += 1) {
    const j = (i + 1) % count
    sum += cross(left[i], right[i]) + cross(right[i], right[j]) + cross(right[j], left[j]) + cross(left[j], left[i])
  }
  return sum / 2
}

/** 墙带中心线长度 */
function chainLength(points: CadPoint[], closed: boolean): number {
  const edgeCount = closed ? points.length : points.length - 1
  let total = 0
  for (let i = 0; i < edgeCount; i += 1) total += lengthOf(points[i], points[(i + 1) % points.length])
  return total
}

/** 左右边界的最小间距 */
function minWidth(left: CadPoint[], right: CadPoint[]): number {
  let min = Infinity
  const count = left.length < right.length ? left.length : right.length
  for (let i = 0; i < count; i += 1) {
    const width = lengthOf(left[i], right[i])
    if (width < min) min = width
  }
  return min
}

/**
 * 把墙带转为左右边界环。
 * 退化（点数不足、零宽度、零长度、自交）的链被跳过并计数，不做几何兜底。
 */
export function buildWallRings(graph: WallGraph, chains: WallChain[], miterLimit: number): WallRingResult {
  if (!(miterLimit >= 1)) throw new Error('miter 上限必须不小于 1')

  const rings: WallRing[] = []
  let skippedCount = 0

  for (const chain of chains) {
    const points = chain.vertices.map((index) => graph.vertices[index])
    if (points.length < 2 || !(chain.thickness > 0)) {
      skippedCount += 1
      continue
    }

    const offsets = buildOffsets(points, chain.thickness / 2, chain.closed, miterLimit)
    if (!offsets) {
      skippedCount += 1
      continue
    }

    const length = chainLength(points, chain.closed)
    const width = minWidth(offsets.left, offsets.right)
    if (!(length > 1e-6) || !(width > 1e-9)) {
      skippedCount += 1
      continue
    }

    // 零面积环：完全折返或压扁的墙带不生成几何，交给界面提示
    if (!(Math.abs(bandSignedArea(offsets.left, offsets.right, chain.closed)) > 1e-9)) {
      skippedCount += 1
      continue
    }

    // 边界点对 → 原始边：方端在同一顶点生成两个边界点时，
    // 该补丁归属进入该角的那条边，保证每段几何仍能回溯到唯一原始边
    const count = offsets.left.length
    const pairCount = chain.closed ? count : count - 1
    const vertexCount = chain.vertices.length
    const edges: number[] = []
    for (let i = 0; i < pairCount; i += 1) {
      const from = offsets.origin[i]
      const to = offsets.origin[(i + 1) % count]
      const local = from === to ? (chain.closed ? (from - 1 + vertexCount) % vertexCount : from - 1) : from
      edges.push(chain.edges[local])
    }

    rings.push({
      left: offsets.left,
      right: offsets.right,
      closed: chain.closed,
      thickness: chain.thickness,
      edgeCount: chain.edges.length,
      length,
      edges,
    })
  }

  return { rings, skippedCount }
}
