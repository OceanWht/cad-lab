/**
 * 把 libredwg-web 的 DwgDatabase 转成模块自己的 CadDrawing IR。
 *
 * 处理范围：
 * - LINE / LWPOLYLINE / POLYLINE2D / POLYLINE3D / ARC / CIRCLE / ELLIPSE；
 * - SPLINE 采样为折线，HATCH 输出实心填充或边界轮廓，MLINE 展开为元素线；
 * - INSERT 递归展开（含块基点、旋转、缩放、阵列）；
 * - DIMENSION / TEXT 等暂不渲染，只计入跳过数量；
 * - 所有曲线离散为折线，颜色按 实体真彩色 → 实体 ACI → 图层颜色 的顺序解析。
 */

import type {
  DwgArcEntity,
  DwgBlockRecordTableEntry,
  DwgCircleEntity,
  DwgDatabase,
  DwgEllipseEntity,
  DwgEntity,
  DwgHatchEntity,
  DwgInsertEntity,
  DwgLineEntity,
  DwgLWPolylineEntity,
  DwgMLineEntity,
  DwgPolyline2dEntity,
  DwgSplineEntity,
} from '@mlightcad/libredwg-web'
import { aciToRgb, layerColorFromName } from './aciColors'
import {
  applyMatrix,
  boundsOfPoints,
  buildInsertMatrix,
  buildPolylinePoints,
  composeMatrix,
  IDENTITY_MATRIX,
  robustBoundsOfPoints,
  sampleArc,
  sampleCircle,
  sampleEllipse,
  type AffineMatrix,
} from './geometry'
import { hatchToPrimitives } from './hatch'
import { buildMLinePolylines } from './mline'
import { isSplineValid, sampleSpline } from './spline'
import type {
  CadBounds,
  CadDrawing,
  CadEntity,
  CadLayerInfo,
  CadPoint,
  CadPrimitive,
} from './types'

/** 渲染曲线允许的弦高误差（米）：2mm，对建筑图纸足够平滑 */
const CURVE_TOLERANCE_M = 0.002

/** INSERT 最大展开深度，避免异常图纸造成无限递归 */
const MAX_INSERT_DEPTH = 8

/** 构建图纸的附加信息 */
export interface BuildDrawingOptions {
  fileName: string
  fileType: 'DXF' | 'DWG'
  parseMs: number
  /** 输入归一化阶段产生的说明 */
  notes: string[]
}

/** 图层解析结果 */
interface LayerStyle {
  color: number
  colorSource: 'aci' | 'palette'
  off: boolean
  frozen: boolean
}

/** 根据 $INSUNITS 解析「1 图纸单位 = 多少米」 */
export function resolveUnitScale(insUnits: number): { unitScale: number; note: string } {
  switch (insUnits) {
    case 1:
      return { unitScale: 0.0254, note: '图纸单位为英寸，已换算为米。' }
    case 2:
      return { unitScale: 0.3048, note: '图纸单位为英尺，已换算为米。' }
    case 4:
      return { unitScale: 0.001, note: '' }
    case 5:
      return { unitScale: 0.01, note: '' }
    case 6:
      return { unitScale: 1, note: '' }
    case 14:
      return { unitScale: 0.1, note: '' }
    default:
      return {
        unitScale: 0.001,
        note: `图纸未声明可用单位（$INSUNITS=${insUnits}），按毫米读取。`,
      }
  }
}

/** 类型收窄工具 */
function isType<T extends DwgEntity>(entity: DwgEntity, type: string): entity is T {
  return entity.type === type
}

/** 判断是否为有效 ACI 索引（1..255） */
function validAci(index: number | undefined): index is number {
  if (typeof index !== 'number') return false
  return Number.isInteger(index) && index >= 1 && index <= 255
}

/**
 * 主转换入口。
 * 结果中的坐标仍为图纸单位，渲染层再乘以 unitScale。
 */
export function buildDrawing(db: DwgDatabase, options: BuildDrawingOptions): CadDrawing {
  const insUnits = typeof db.header?.INSUNITS === 'number' ? db.header.INSUNITS : 0
  const { unitScale, note: unitNote } = resolveUnitScale(insUnits)
  const notes = [...options.notes]
  if (unitNote) notes.push(unitNote)
  const tolerance = CURVE_TOLERANCE_M / unitScale

  const layerStyles = new Map<string, LayerStyle>()
  for (const entry of db.tables.LAYER.entries) {
    if (layerStyles.has(entry.name)) continue
    const useAci = validAci(entry.colorIndex)
    layerStyles.set(entry.name, {
      color: useAci ? aciToRgb(entry.colorIndex) : layerColorFromName(entry.name),
      colorSource: useAci ? 'aci' : 'palette',
      off: entry.off === true,
      frozen: entry.frozen === true,
    })
  }

  const blocks = new Map<string, DwgBlockRecordTableEntry>()
  for (const block of db.tables.BLOCK_RECORD.entries) {
    if (!blocks.has(block.name)) blocks.set(block.name, block)
  }

  const entities: CadEntity[] = []
  const layerCounts = new Map<string, number>()
  const allPoints: CadPoint[] = []
  const counters = { expanded: 0, skipped: 0 }
  let entitySequence = 0

  const ensureLayer = (name: string): LayerStyle => {
    const existing = layerStyles.get(name)
    if (existing) return existing
    const created: LayerStyle = {
      color: layerColorFromName(name),
      colorSource: 'palette',
      off: false,
      frozen: false,
    }
    layerStyles.set(name, created)
    return created
  }

  const resolveColor = (entity: DwgEntity, layer: string): number => {
    if (typeof entity.color === 'number') return entity.color & 0xffffff
    if (validAci(entity.colorIndex)) return aciToRgb(entity.colorIndex)
    return ensureLayer(layer).color
  }

  /**
   * 当前正在展开的 INSERT 块名（顶层实体为 undefined）。
   * 门窗构件通常以标准块插入，块名是最可靠的类型与尺寸来源，
   * 因此这里跟随 INSERT 递归逐层覆盖，由 pushEntity 写入实体。
   */
  let currentBlockName: string | undefined
  /** 当前展开的块实例编号；同一次 INSERT 展开出的图元共享该编号，用于聚合门窗 */
  let currentBlockInstance: number | undefined
  /** 块实例编号自增序号 */
  let blockInstanceSequence = 0

  const pushEntity = (
    source: DwgEntity,
    type: string,
    layer: string,
    matrix: AffineMatrix,
    primitives: CadPrimitive[],
  ): void => {
    if (primitives.length === 0) return
    const transformed: CadPrimitive[] = []
    for (const primitive of primitives) {
      if (primitive.kind === 'polyline') {
        const points = primitive.points.map((point) => applyMatrix(matrix, point))
        if (points.length < 2) continue
        transformed.push({ kind: 'polyline', points, closed: primitive.closed })
        for (const point of points) allPoints.push(point)
        continue
      }
      // 填充：每个环独立变换，少于 3 个点的环无法成面，直接丢弃该环
      const loops = primitive.loops
        .map((loop) => loop.map((point) => applyMatrix(matrix, point)))
        .filter((loop) => loop.length >= 3)
      if (loops.length === 0) continue
      transformed.push({ kind: 'fill', loops })
      for (const loop of loops) {
        for (const point of loop) allPoints.push(point)
      }
    }
    if (transformed.length === 0) return
    entitySequence += 1
    const id = source.handle ? `${source.handle}#${entitySequence}` : `${type}-${entitySequence}`
    entities.push({
      id,
      type,
      layer,
      color: resolveColor(source, layer),
      blockName: currentBlockName,
      blockInstance: currentBlockInstance,
      primitives: transformed,
    })
    layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1)
  }

  const convertEntity = (
    entity: DwgEntity,
    matrix: AffineMatrix,
    inheritedLayer: string | null,
    depth: number,
  ): void => {
    const rawLayer = entity.layer ? entity.layer : '0'
    const layer = rawLayer === '0' && inheritedLayer ? inheritedLayer : rawLayer

    if (isType<DwgInsertEntity>(entity, 'INSERT')) {
      if (depth >= MAX_INSERT_DEPTH) {
        counters.skipped += 1
        return
      }
      const block = blocks.get(entity.name)
      if (!block) {
        counters.skipped += 1
        return
      }
      const base = block.basePoint ? block.basePoint : { x: 0, y: 0 }
      const insertion = entity.insertionPoint ? entity.insertionPoint : { x: 0, y: 0 }
      const local = buildInsertMatrix(
        { x: insertion.x, y: insertion.y },
        entity.rotation,
        entity.xScale,
        entity.yScale,
        { x: base.x, y: base.y },
      )
      const columns = entity.columnCount > 1 ? entity.columnCount : 1
      const rows = entity.rowCount > 1 ? entity.rowCount : 1
      const outerBlockName = currentBlockName
      const outerBlockInstance = currentBlockInstance
      // 子实体的「最近块名」即当前 INSERT；嵌套块展开时由更深一层覆盖
      currentBlockName = entity.name
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const offset: AffineMatrix = {
            ...IDENTITY_MATRIX,
            e: column * entity.columnSpacing,
            f: row * entity.rowSpacing,
          }
          const blockMatrix = composeMatrix(composeMatrix(matrix, local), offset)
          // 阵列中的每个单元都是独立的门窗实例
          blockInstanceSequence += 1
          currentBlockInstance = blockInstanceSequence
          for (const child of block.entities) {
            convertEntity(child, blockMatrix, layer, depth + 1)
            counters.expanded += 1
          }
        }
      }
      currentBlockName = outerBlockName
      currentBlockInstance = outerBlockInstance
      return
    }

    if (isType<DwgLineEntity>(entity, 'LINE')) {
      const start = entity.startPoint
      const end = entity.endPoint
      if (!start || !end) {
        counters.skipped += 1
        return
      }
      pushEntity(entity, 'LINE', layer, matrix, [
        { kind: 'polyline', points: [{ x: start.x, y: start.y }, { x: end.x, y: end.y }], closed: false },
      ])
      return
    }

    if (isType<DwgLWPolylineEntity>(entity, 'LWPOLYLINE')) {
      const vertices = entity.vertices ? entity.vertices : []
      if (vertices.length < 2) {
        counters.skipped += 1
        return
      }
      const closed = (entity.flag & 1) === 1
      const points = buildPolylinePoints(vertices, closed, tolerance)
      pushEntity(entity, 'LWPOLYLINE', layer, matrix, [{ kind: 'polyline', points, closed }])
      return
    }

    if (isType<DwgPolyline2dEntity>(entity, 'POLYLINE2D') || isType<DwgPolyline2dEntity>(entity, 'POLYLINE3D')) {
      const vertices = entity.vertices ? entity.vertices : []
      if (vertices.length < 2) {
        counters.skipped += 1
        return
      }
      const closed = (entity.flag & 1) === 1
      const points = buildPolylinePoints(vertices, closed, tolerance)
      pushEntity(entity, entity.type, layer, matrix, [{ kind: 'polyline', points, closed }])
      return
    }

    if (isType<DwgArcEntity>(entity, 'ARC')) {
      const center = { x: entity.center.x, y: entity.center.y }
      let sweep = entity.endAngle - entity.startAngle
      while (sweep <= 0) sweep += Math.PI * 2
      const points = sampleArc(center, entity.radius, entity.startAngle, sweep, tolerance)
      const endPoint = {
        x: center.x + entity.radius * Math.cos(entity.startAngle + sweep),
        y: center.y + entity.radius * Math.sin(entity.startAngle + sweep),
      }
      points.push(endPoint)
      pushEntity(entity, 'ARC', layer, matrix, [{ kind: 'polyline', points, closed: false }])
      return
    }

    if (isType<DwgCircleEntity>(entity, 'CIRCLE')) {
      const points = sampleCircle({ x: entity.center.x, y: entity.center.y }, entity.radius, tolerance)
      pushEntity(entity, 'CIRCLE', layer, matrix, [{ kind: 'polyline', points, closed: true }])
      return
    }

    if (isType<DwgEllipseEntity>(entity, 'ELLIPSE')) {
      const center = { x: entity.center.x, y: entity.center.y }
      const majorAxis = { x: entity.majorAxisEndPoint.x, y: entity.majorAxisEndPoint.y }
      const points = sampleEllipse(
        center,
        majorAxis,
        entity.axisRatio,
        entity.startAngle,
        entity.endAngle,
        tolerance,
      )
      const isFull = Math.abs(entity.endAngle - entity.startAngle) >= Math.PI * 2 - 1e-6
      if (!isFull) {
        points.push({
          x: center.x + majorAxis.x * Math.cos(entity.endAngle) - majorAxis.y * entity.axisRatio * Math.sin(entity.endAngle),
          y: center.y + majorAxis.y * Math.cos(entity.endAngle) + majorAxis.x * entity.axisRatio * Math.sin(entity.endAngle),
        })
      }
      pushEntity(entity, 'ELLIPSE', layer, matrix, [{ kind: 'polyline', points, closed: isFull }])
      return
    }

    if (isType<DwgHatchEntity>(entity, 'HATCH')) {
      const primitives = hatchToPrimitives(entity, tolerance)
      if (primitives.length === 0) {
        counters.skipped += 1
        return
      }
      pushEntity(entity, 'HATCH', layer, matrix, primitives)
      return
    }

    if (isType<DwgSplineEntity>(entity, 'SPLINE')) {
      const controlPoints = entity.controlPoints ? entity.controlPoints : []
      const knots = entity.knots ? entity.knots : []
      if (!isSplineValid(entity.degree, knots.length, controlPoints.length)) {
        counters.skipped += 1
        return
      }
      const weights = entity.weights
      const splineControlPoints = controlPoints.map((point, index) => ({
        x: point.x,
        y: point.y,
        weight: weights && typeof weights[index] === 'number' ? weights[index] : undefined,
      }))
      // DXF 组码 70：1 = 闭合，2 = 周期，4 = 有理；闭合样条在末尾补回起点
      const closed = (entity.flag & 1) === 1
      const points = sampleSpline(entity.degree, knots, splineControlPoints, tolerance, closed)
      if (points.length < 2) {
        counters.skipped += 1
        return
      }
      pushEntity(entity, 'SPLINE', layer, matrix, [{ kind: 'polyline', points, closed: false }])
      return
    }

    if (isType<DwgMLineEntity>(entity, 'MLINE')) {
      const primitives = buildMLinePolylines(entity, tolerance)
      if (primitives.length === 0) {
        counters.skipped += 1
        return
      }
      pushEntity(entity, 'MLINE', layer, matrix, primitives)
      return
    }

    counters.skipped += 1
  }

  for (const entity of db.entities) convertEntity(entity, IDENTITY_MATRIX, null, 0)

  const bounds = boundsOfPoints(allPoints)
  const focusBounds = robustBoundsOfPoints(allPoints)

  const layers: CadLayerInfo[] = []
  for (const [name, style] of layerStyles) {
    layers.push({
      name,
      color: style.color,
      colorSource: style.colorSource,
      entityCount: layerCounts.get(name) ?? 0,
      off: style.off,
      frozen: style.frozen,
    })
  }

  const emptyBounds: CadBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const finalBounds = bounds ? bounds : emptyBounds
  const finalFocus = focusBounds ? focusBounds : finalBounds

  return {
    fileName: options.fileName,
    fileType: options.fileType,
    unitScale,
    insUnits,
    bounds: finalBounds,
    focusBounds: finalFocus,
    layers,
    entities,
    stats: {
      topLevelCount: db.entities.length,
      renderableCount: entities.length,
      expandedCount: counters.expanded,
      skippedCount: counters.skipped,
      parseMs: options.parseMs,
    },
    notes,
  }
}
