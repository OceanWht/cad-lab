import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type {
  DwgBoundaryPath,
  DwgDatabase,
  DwgHatchEntity,
  DwgMLineEntity,
} from '@mlightcad/libredwg-web'
import { aciToRgb, CAD_WHITE } from '@/cad-lab/core/aciColors'
import { buildDrawing } from '@/cad-lab/core/buildDrawing'
import {
  applyMatrix,
  buildInsertMatrix,
  buildPolylinePoints,
  robustBoundsOfPoints,
  sampleArc,
  sampleBulgeSegment,
  sampleEllipse,
} from '@/cad-lab/core/geometry'
import {
  bytesToBinaryString,
  isValidUtf8,
  normalizeDxfBytes,
} from '@/cad-lab/core/dxfNormalize'
import { hatchToPrimitives } from '@/cad-lab/core/hatch'
import { buildExportScene, buildBuildingExportScene, exportGlb } from '@/cad-lab/core/exportGlb'
import {
  addRemovedKeys,
  cloneRemovalScope,
  removedKeyCount,
  removedKeysForFloor,
  removalSignature,
  type RemovalScope,
} from '@/cad-lab/core/floorEdit'
import {
  buildingHeight,
  drawerSlide,
  floorElevation,
  floorGap,
  instanceOffsets,
  moveTowards,
  normalizeBuildingParams,
  smoothTowards,
  type NormalizedBuildingParams,
} from '@/cad-lab/core/buildingModel'
import { cloudPuffs } from '@/cad-lab/core/skyModel'
import {
  DEFAULT_WALL_MATERIAL,
  normalizeWallMaterial,
  WALL_MATERIAL_PRESETS,
} from '@/cad-lab/core/materialModel'
import { boxProjectUvs, SURFACE_TILE_METERS } from '@/cad-lab/core/surfaceUv'
import { wallVertexShade } from '@/cad-lab/core/surfaceShade'
import { buildMLinePolylines } from '@/cad-lab/core/mline'
import { sampleSpline } from '@/cad-lab/core/spline'
import {
  buildWallGeometry,
  collectWallSegments,
  collectWallSegmentsLoose,
  inferWallThicknesses,
  openingObjectKey,
  resolveLayerThicknessFromName,
  snapWallEndpoints,
  type WallPiece,
  type WallSegment,
} from '@/cad-lab/core/wallModel'
import {
  appendOutlineHole,
  appendOutlineSegment,
  arcParameters,
  buildSlabGeometry,
  clearOutlineHoles,
  createArcSegment,
  createLineSegment,
  flattenOutline,
  flattenOutlineRings,
  isOutlineClosed,
  outlineLength,
  removeLastOutlineSegment,
  validateOutline,
  type SlabOutline,
} from '@/cad-lab/core/slabOutline'
import {
  distanceToSegment,
  pickLineAt,
  projectPoint,
  selectLinesInRect,
  segmentIntersectsRect,
  type PickLine,
  type ScreenPoint,
} from '@/cad-lab/core/wallSelection'
import {
  buildWallRings,
  mergeCollinearChains,
  weldVertices,
} from '@/cad-lab/core/wallTopology'
import type { CadDrawing, CadEntity, CadPoint } from '@/cad-lab/core/types'
import {
  mergeDoorWindowOpenings,
  parseModularSize,
  recognizeOpenings,
  recommendOpeningKinds,
  type OpeningSpec,
} from '@/cad-lab/core/doorWindowModel'
import { buildOpeningGeometry, resolveDoorConfig, resolveWindowConfig } from '@/cad-lab/core/openingModel'
import { pairDoubleLineWalls, type WallOpening } from '@/cad-lab/core/wallModel'
import {
  buildCurtainWallGeometry,
  createCurtainBufferGeometry,
  curtainCenterlines,
  curtainObjectKey,
  cutCurtainLines,
  isCurtainSpan,
  measureLayerSpans,
  mergeCurtainGeometries,
  planCurtainWalls,
} from '@/cad-lab/core/curtainModel'
import { resolveLayerRoles } from '@/cad-lab/core/layerRoles'
import {
  doorLayerWallLines,
  massingDoorCuts,
  massingDoorLintels,
  recognizeMassingDoors,
} from '@/cad-lab/core/massingDoors'

/** 生成一份仅包含必要字段的图纸夹具 */
function makeDrawing(entities: CadEntity[], unitScale = 0.001): CadDrawing {
  return {
    fileName: 'fixture.dxf',
    fileType: 'DXF',
    unitScale,
    insUnits: 4,
    bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    focusBounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    layers: [],
    entities,
    stats: { topLevelCount: entities.length, renderableCount: entities.length, expandedCount: 0, skippedCount: 0, parseMs: 0 },
    notes: [],
  }
}

describe('geometry 曲线离散', () => {
  it('bulge=1 的半圆落在半径 0.5 的圆上，且逆时针向下凸', () => {
    const points = sampleBulgeSegment({ x: 0, y: 0 }, { x: 1, y: 0 }, 1, 0.001)
    // 端点由三角函数回推，存在~1e-17 级浮点残差，按坐标近似断言
    expect(points[0].x).toBeCloseTo(0, 9)
    expect(points[0].y).toBeCloseTo(0, 9)
    expect(points[points.length - 1].x).toBeCloseTo(1, 9)
    expect(points[points.length - 1].y).toBeCloseTo(0, 9)
    for (const point of points) {
      expect(Math.abs(Math.hypot(point.x - 0.5, point.y) - 0.5)).toBeLessThan(1e-9)
    }
    // 正 bulge 表示逆时针，从 (0,0) 到 (1,0) 应经过下半圆
    expect(points[Math.floor(points.length / 2)].y).toBeLessThan(0)
  })

  it('闭合多段线展开后首尾点重合', () => {
    const vertices = [
      { x: 0, y: 0, bulge: 0 },
      { x: 10, y: 0, bulge: 0 },
      { x: 10, y: 10, bulge: 0 },
    ]
    const points = buildPolylinePoints(vertices, true, 0.01)
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points[points.length - 1]).toEqual({ x: 0, y: 0 })
  })

  it('整圆弧采样点均落在圆周上且首尾不重复', () => {
    const points = sampleArc({ x: 0, y: 0 }, 5, 0, Math.PI * 2, 0.001)
    expect(points.length).toBeGreaterThan(8)
    for (const point of points) {
      expect(Math.abs(Math.hypot(point.x, point.y) - 5)).toBeLessThan(1e-9)
    }
  })

  it('椭圆长轴端点与中心距离等于长轴半径', () => {
    const points = sampleEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5, 0, Math.PI * 2, 0.001)
    expect(points[0].x).toBeCloseTo(10, 6)
    const top = points.reduce((best, point) => (point.y > best.y ? point : best))
    // 离散点不一定正好落在参数角 90°，允许一个采样步长的误差
    expect(top.y).toBeCloseTo(5, 2)
  })

  it('robustBounds 会剔除远离主体的离群点', () => {
    const points: Array<{ x: number; y: number }> = []
    for (let i = 0; i < 200; i += 1) points.push({ x: (i % 20) * 0.5, y: Math.floor(i / 20) * 0.5 })
    points.push({ x: 9000, y: 9000 })
    const bounds = robustBoundsOfPoints(points)
    expect(bounds?.maxX).toBeLessThan(9000)
  })
})

describe('ACI 颜色', () => {
  it('索引 1 为红色，索引 7 映射为深色画布上的白色', () => {
    expect(aciToRgb(1)).toBe(0xff0000)
    expect(aciToRgb(7)).toBe(CAD_WHITE)
  })

  it('非法索引返回白色而不是抛错', () => {
    expect(aciToRgb(0)).toBe(CAD_WHITE)
    expect(aciToRgb(999)).toBe(CAD_WHITE)
  })
})

describe('DXF 归一化', () => {
  const chinese = '墙体'
  const suffix = '\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n'
  const encode = (text: string) => new TextEncoder().encode(text)

  it('UTF-8 中文图纸：降级 AC1032 并把 codepage 改写为 UTF-8', () => {
    const text =
      '0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$ACADVER\r\n  1\r\nAC1032\r\n' +
      '9\r\n$DWGCODEPAGE\r\n  3\r\nANSI_936\r\n0\r\nENDSEC\r\n' +
      `0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nTEXT\r\n1\r\n${chinese}\r\n` +
      suffix
    const result = normalizeDxfBytes(encode(text))
    const patched = bytesToBinaryString(result.bytes)
    expect(patched).toContain('AC1015')
    expect(patched).toContain('$DWGCODEPAGE\r\n  3\r\nUTF-8')
    expect(new TextDecoder('utf-8').decode(result.bytes)).toContain(chinese)
    expect(result.notes.length).toBe(2)
  })

  it('纯 ASCII 图纸只改版本，不改 codepage', () => {
    const text = '0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$ACADVER\r\n  1\r\nAC1032\r\n' + suffix
    const result = normalizeDxfBytes(encode(text))
    const patched = bytesToBinaryString(result.bytes)
    expect(patched).toContain('AC1015')
    expect(patched).not.toContain('UTF-8')
    expect(result.notes.length).toBe(1)
  })

  it('GBK 字节流不会被误判为 UTF-8', () => {
    const gbk = new Uint8Array([0xb2, 0xe2, 0xcc, 0xe5])
    expect(isValidUtf8(gbk)).toBe(false)
    const text = '0\r\nSECTION\r\n9\r\n$DWGCODEPAGE\r\n  3\r\nANSI_936\r\n' + suffix
    const result = normalizeDxfBytes(encode(text))
    expect(bytesToBinaryString(result.bytes)).toContain('ANSI_936')
  })
})

describe('INSERT 变换', () => {
  it('旋转 90° 并平移后，块内点坐标正确', () => {
    const matrix = buildInsertMatrix({ x: 10, y: 0 }, Math.PI / 2, 1, 1, { x: 0, y: 0 })
    const point = applyMatrix(matrix, { x: 1, y: 0 })
    expect(point.x).toBeCloseTo(10, 9)
    expect(point.y).toBeCloseTo(1, 9)
  })
})

describe('墙体提取与拉伸', () => {
  it('闭合折线生成 4 段墙，重复实体被去重', () => {
    const square = {
      id: '1',
      type: 'LWPOLYLINE',
      layer: 'Wall【墙体】',
      color: 0xffffff,
      primitives: [{
        kind: 'polyline' as const,
        points: [
          { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }, { x: 0, y: 0 },
        ],
        closed: false,
      }],
    }
    const drawing = makeDrawing([square, { ...square, id: '2' }])
    const segments = collectWallSegments(drawing, ['Wall【墙体】'], () => 0.2)
    expect(segments).toHaveLength(4)
  })

  it('单段墙拉伸顶点数为 90，长度为 1m', () => {
    const result = buildWallGeometry(
      [{ a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, layer: 'W', thickness: 0.2, key: 'W|0,0|1000,0' }],
      { miterLimit: 4, height: 3 },
      0.001,
    )
    expect(result.positions.length).toBe(5 * 6 * 3)
    expect(result.totalLength).toBeCloseTo(1, 9)
    expect(result.bounds.maxX).toBeCloseTo(1, 9)
  })
})

describe('墙体拓扑', () => {
  /** 构造一条中心线线段（米） */
  function seg(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    thickness = 0.2,
    layer = 'W',
  ): WallSegment {
    return {
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      layer,
      thickness,
      key: `${layer}|${ax},${ay}|${bx},${by}`,
    }
  }

  /** 取第 index 个三角形的法线 */
  function triangleNormal(positions: Float32Array, index: number): [number, number, number] {
    const base = index * 9
    const ux = positions[base + 3] - positions[base]
    const uy = positions[base + 4] - positions[base + 1]
    const uz = positions[base + 5] - positions[base + 2]
    const vx = positions[base + 6] - positions[base]
    const vy = positions[base + 7] - positions[base + 1]
    const vz = positions[base + 8] - positions[base + 2]
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
  }

  it('顶点焊接会把 0.3mm 偏差的端点合并', () => {
    const graph = weldVertices([seg(0, 0, 1, 0), seg(1.0003, 0, 1, 1)], 0.001)
    expect(graph.vertices).toHaveLength(3)
    expect(graph.edges).toHaveLength(2)
  })

  it('共线三段保留完整顶点序列与逐边身份', () => {
    const graph = weldVertices([seg(0, 0, 1, 0), seg(1, 0, 2, 0), seg(2, 0, 3, 0)], 0.001)
    const chains = mergeCollinearChains(graph, (0.5 * Math.PI) / 180)
    expect(chains).toHaveLength(1)
    // 不再剔除共线中间点：4 个顶点、3 条原始边
    expect(chains[0].vertices).toHaveLength(4)
    expect(chains[0].edges).toHaveLength(3)
    expect(chains[0].thickness).toBeCloseTo(0.2, 9)
  })

  it('中心线 180° 折返时跳过零长度边界段，不抛错', () => {
    // (0,0)→(2,0)→(1,0)：第二段与第一段反向重叠，折返点会被方端拆成一对同位置边界点
    const segments = [seg(0, 0, 2, 0), seg(2, 0, 1, 0)]
    const result = buildWallGeometry(segments, { height: 2.8, miterLimit: 4 }, 1)
    expect(result.positions.length).toBeGreaterThan(0)
    expect(result.pieces.length).toBeGreaterThan(0)
    expect(result.skippedOpeningCount).toBe(0)
  })

  it('转角处的两条边合并为同一条链', () => {
    const graph = weldVertices([seg(0, 0, 2, 0), seg(2, 0, 2, 2)], 0.001)
    const chains = mergeCollinearChains(graph, (0.5 * Math.PI) / 180)
    expect(chains).toHaveLength(1)
    expect(chains[0].vertices).toHaveLength(3)
    expect(chains[0].edges).toHaveLength(2)
    expect(chains[0].closed).toBe(false)
  })

  it('闭合链的边序列长度等于顶点数', () => {
    const graph = weldVertices(
      [seg(0, 0, 4, 0), seg(4, 0, 4, 4), seg(4, 4, 0, 4), seg(0, 4, 0, 0)],
      0.001,
    )
    const chains = mergeCollinearChains(graph, (0.5 * Math.PI) / 180)
    expect(chains[0].closed).toBe(true)
    expect(chains[0].edges).toHaveLength(chains[0].vertices.length)
    // 边序列必须与顶点顺序逐一对应，否则成环后的段身份会整体错位
    const chain = chains[0]
    chain.edges.forEach((edgeIndex, i) => {
      const edge = graph.edges[edgeIndex]
      const current = chain.vertices[i]
      const next = chain.vertices[(i + 1) % chain.vertices.length]
      expect([edge.a, edge.b].sort((x, y) => x - y)).toEqual([current, next].sort((x, y) => x - y))
    })
  })

  it('几何键跨参数变化保持稳定', () => {
    const segments = [seg(0, 0, 2, 0), seg(2, 0, 2, 2)]
    const first = buildWallGeometry(segments, { miterLimit: 4, height: 3 }, 0.001)
    const second = buildWallGeometry(segments, { miterLimit: 4, height: 5 }, 0.001)
    expect(second.pieces.map((piece) => piece.key)).toEqual(first.pieces.map((piece) => piece.key))
  })

  it('片段顶点区间互不重叠且并集覆盖全部三角形', () => {
    // 开放链会额外生成首尾端面，同样必须落在所属段的连续区间内
    const result = buildWallGeometry(
      [seg(0, 0, 2, 0), seg(2, 0, 2, 2)],
      { miterLimit: 4, height: 3 },
      0.001,
    )
    let cursor = 0
    for (const piece of result.pieces) {
      expect(piece.vertexStart).toBe(cursor)
      expect(piece.vertexCount).toBeGreaterThan(0)
      cursor += piece.vertexCount
    }
    expect(cursor).toBe(result.positions.length / 3)
  })

  it('原始线段键一路携带到几何片段', () => {
    const square = {
      id: '1',
      type: 'LWPOLYLINE',
      layer: 'Wall【墙体】',
      color: 0xffffff,
      primitives: [{
        kind: 'polyline' as const,
        points: [
          { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }, { x: 0, y: 0 },
        ],
        closed: false,
      }],
    }
    const drawing = makeDrawing([square])
    const segments = collectWallSegments(drawing, ['Wall【墙体】'], () => 0.2)
    const result = buildWallGeometry(segments, { miterLimit: 4, height: 3 }, drawing.unitScale)
    expect(result.pieces.map((piece) => piece.key).sort()).toEqual(segments.map((item) => item.key).sort())
  })

  it('直角转弯按 miter 生成连续边界', () => {
    const graph = weldVertices([seg(0, 0, 2, 0), seg(2, 0, 2, 2)], 0.001)
    const chains = mergeCollinearChains(graph, (0.5 * Math.PI) / 180)
    const { rings, skippedCount } = buildWallRings(graph, chains, 4)
    expect(skippedCount).toBe(0)
    expect(rings).toHaveLength(1)
    // 半厚 0.1，90° 转角的 miter 点沿两个法线各偏 0.1
    expect(rings[0].left[1].x).toBeCloseTo(1.9, 9)
    expect(rings[0].left[1].y).toBeCloseTo(0.1, 9)
    expect(rings[0].right[1].x).toBeCloseTo(2.1, 9)
    expect(rings[0].right[1].y).toBeCloseTo(-0.1, 9)
  })

  it('锐角 miter 超过上限时退化为方端且不丢墙带', () => {
    // 第二条边近乎折返（约 170°），miter 长度约 11.5 倍半厚，超过上限 4 倍
    const graph = weldVertices([seg(0, 0, 2, 0), seg(2, 0, 0, 0.35)], 0.001)
    const chains = mergeCollinearChains(graph, (0.5 * Math.PI) / 180)
    const { rings, skippedCount } = buildWallRings(graph, chains, 4)
    expect(skippedCount).toBe(0)
    expect(rings).toHaveLength(1)
    // 方端会在转角处插入两个点，边界点数从 3 增加到 4
    expect(rings[0].left.length).toBe(4)
  })

  it('闭合方形墙带不带端面，且顶面法线朝上', () => {
    const graph = weldVertices(
      [
        seg(0, 0, 4, 0),
        seg(4, 0, 4, 4),
        seg(4, 4, 0, 4),
        seg(0, 4, 0, 0),
      ],
      0.001,
    )
    const chains = mergeCollinearChains(graph, (0.5 * Math.PI) / 180)
    expect(chains).toHaveLength(1)
    expect(chains[0].closed).toBe(true)
    const { rings, skippedCount } = buildWallRings(graph, chains, 4)
    expect(skippedCount).toBe(0)
    expect(rings[0].left).toHaveLength(4)

    const result = buildWallGeometry(
      [
        seg(0, 0, 4000, 0),
        seg(4000, 0, 4000, 4000),
        seg(4000, 4000, 0, 4000),
        seg(0, 4000, 0, 0),
      ],
      { miterLimit: 4, height: 3 },
      0.001,
    )
    expect(result.segmentCount).toBe(4)
    const triangleCount = result.positions.length / 9
    // 闭合链：4 个顶面 + 4 个左侧面 + 4 个右侧面，每个四边形 2 个三角形
    expect(triangleCount).toBe(3 * 4 * 2)
    for (let i = 0; i < triangleCount; i += 1) {
      const normal = triangleNormal(result.positions, i)
      const length = Math.hypot(normal[0], normal[1], normal[2])
      expect(length).toBeGreaterThan(0)
    }
  })

  it('单段墙的顶面法线朝 +Y，端面法线沿墙轴线', () => {
    const result = buildWallGeometry([seg(0, 0, 1000, 0)], { miterLimit: 4, height: 3 }, 0.001)
    const triangleCount = result.positions.length / 9
    expect(triangleCount).toBe(10)
    // 起点端面提前到段循环之前，前两个三角形是端面，法线朝 -X
    const startCap = triangleNormal(result.positions, 0)
    expect(startCap[0]).toBeLessThan(0)
    // 顶面随后，法线朝 +Y
    const top = triangleNormal(result.positions, 2)
    expect(top[1]).toBeGreaterThan(0)
    // 终点端面在最后，法线朝 +X
    const endCap = triangleNormal(result.positions, 8)
    expect(endCap[0]).toBeGreaterThan(0)
  })

  it('分图层墙厚写入线段，非法墙厚直接抛错', () => {
    const line = (id: string, layer: string): CadEntity => ({
      id,
      type: 'LINE',
      layer,
      color: 0xffffff,
      primitives: [
        { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], closed: false },
      ],
    })
    const drawing = makeDrawing([line('1', 'W1'), line('2', 'W2')])
    const segments = collectWallSegments(drawing, ['W1', 'W2'], (name) => (name === 'W1' ? 0.24 : 0.12))
    expect(segments.map((item) => item.thickness)).toEqual([0.24, 0.12])
    expect(() => collectWallSegments(drawing, ['W1'], () => 0)).toThrowError(/墙厚无效/)
  })

  it('填充图元没有中心线语义，不参与墙体提取', () => {
    const hatch: CadEntity = {
      id: 'h1',
      type: 'HATCH',
      layer: 'Wall',
      color: 0xffffff,
      primitives: [
        {
          kind: 'fill',
          loops: [
            [
              { x: 0, y: 0 },
              { x: 1000, y: 0 },
              { x: 1000, y: 1000 },
            ],
          ],
        },
      ],
    }
    expect(collectWallSegments(makeDrawing([hatch]), ['Wall'], () => 0.2)).toHaveLength(0)
  })
})

describe('SPLINE 采样', () => {
  it('一次样条退化为一条直线段', () => {
    const points = sampleSpline(
      1,
      [0, 0, 1, 1],
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      0.001,
      false,
    )
    expect(points).toHaveLength(2)
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points[1].x).toBeCloseTo(10, 12)
    expect(points[1].y).toBeCloseTo(0, 12)
  })

  it('二次样条按弦高容差加密，且 u=0.5 落在 (5, 5)', () => {
    const points = sampleSpline(
      2,
      [0, 0, 0, 1, 1, 1],
      [
        { x: 0, y: 0 },
        { x: 5, y: 10 },
        { x: 10, y: 0 },
      ],
      0.01,
      false,
    )
    expect(points.length).toBeGreaterThan(2)
    const middle = points.find((point) => Math.abs(point.x - 5) < 1e-9)
    expect(middle).toBeDefined()
    expect(middle?.y).toBeCloseTo(5, 9)
    // 所有采样点都不应低于端点连线
    for (const point of points) expect(point.y).toBeGreaterThanOrEqual(-1e-9)
  })

  it('有理权重改变曲线形状：权重 0.5 时中点高度为 10/3', () => {
    const points = sampleSpline(
      2,
      [0, 0, 0, 1, 1, 1],
      [
        { x: 0, y: 0, weight: 1 },
        { x: 5, y: 10, weight: 0.5 },
        { x: 10, y: 0, weight: 1 },
      ],
      0.01,
      false,
    )
    const middle = points.find((point) => Math.abs(point.x - 5) < 1e-9)
    expect(middle?.y).toBeCloseTo(10 / 3, 9)
  })

  it('闭合样条在末尾补回起点', () => {
    const points = sampleSpline(
      2,
      [0, 0, 0, 1, 1, 1],
      [
        { x: 0, y: 0 },
        { x: 5, y: 10 },
        { x: 10, y: 0 },
      ],
      0.01,
      true,
    )
    expect(points[points.length - 1]).toEqual(points[0])
  })

  it('结构非法的样条直接抛错', () => {
    expect(() => sampleSpline(3, [0, 1], [{ x: 0, y: 0 }], 0.01, false)).toThrowError(/样条/)
  })
})

describe('HATCH 边界转换', () => {
  /** 生成一条折线边界 */
  function polylinePath(points: CadPoint[], flag = 1): DwgBoundaryPath {
    return {
      boundaryPathTypeFlag: flag,
      hasBulge: false,
      isClosed: true,
      numberOfVertices: points.length,
      vertices: points.map((point) => ({ x: point.x, y: point.y, bulge: 0 })),
    } as unknown as DwgBoundaryPath
  }

  /** 生成一条边路径 */
  function edgePath(edges: unknown[]): DwgBoundaryPath {
    return {
      boundaryPathTypeFlag: 0,
      numberOfEdges: edges.length,
      edges,
    } as unknown as DwgBoundaryPath
  }

  /** 生成一条直线边 */
  function lineEdge(start: CadPoint, end: CadPoint): unknown {
    return { type: 1, start, end }
  }

  /** 生成 HATCH 实体夹具 */
  function makeHatch(paths: DwgBoundaryPath[], solidFill: 0 | 1): DwgHatchEntity {
    return {
      type: 'HATCH',
      patternName: solidFill === 1 ? 'SOLID' : 'ANSI31',
      solidFill,
      boundaryPaths: paths,
    } as unknown as DwgHatchEntity
  }

  /** 环的有符号面积（CAD 的 y 轴向上，正值为逆时针） */
  function area(points: CadPoint[]): number {
    let sum = 0
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      sum += a.x * b.y - b.x * a.y
    }
    return sum / 2
  }

  it('实心填充：外环逆时针、内洞顺时针', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]
    // 内洞故意用与外环相同的绕向，应由归一化纠正
    const hole = [
      { x: 5, y: 5 },
      { x: 15, y: 5 },
      { x: 15, y: 15 },
      { x: 5, y: 15 },
    ]
    const primitives = hatchToPrimitives(
      makeHatch([polylinePath(outer), polylinePath(hole)], 1),
      0.01,
    )
    expect(primitives).toHaveLength(1)
    const fill = primitives[0]
    expect(fill.kind).toBe('fill')
    if (fill.kind !== 'fill') return
    expect(fill.loops).toHaveLength(2)
    expect(area(fill.loops[0])).toBeGreaterThan(0)
    expect(area(fill.loops[1])).toBeLessThan(0)
  })

  it('四条直线边组成闭合填充边界', () => {
    const path = edgePath([
      lineEdge({ x: 0, y: 0 }, { x: 10, y: 0 }),
      lineEdge({ x: 10, y: 0 }, { x: 10, y: 10 }),
      lineEdge({ x: 10, y: 10 }, { x: 0, y: 10 }),
      lineEdge({ x: 0, y: 10 }, { x: 0, y: 0 }),
    ])
    const primitives = hatchToPrimitives(makeHatch([path], 1), 0.01)
    expect(primitives).toHaveLength(1)
    const fill = primitives[0]
    if (fill.kind !== 'fill') throw new Error('应为填充图元')
    expect(fill.loops[0]).toHaveLength(4)
    expect(Math.abs(area(fill.loops[0]))).toBeCloseTo(100, 6)
  })

  it('圆弧边按 isCCW 决定扫掠方向', () => {
    const ccw = edgePath([
      {
        type: 2,
        center: { x: 0, y: 0 },
        radius: 5,
        startAngle: 0,
        endAngle: Math.PI / 2,
        isCCW: true,
      },
    ])
    const cw = edgePath([
      {
        type: 2,
        center: { x: 0, y: 0 },
        radius: 5,
        startAngle: 0,
        // 顺时针时终点角为 3π/2，扫掠应折算为 -π/2
        endAngle: (Math.PI * 3) / 2,
        isCCW: false,
      },
    ])
    const ccwFill = hatchToPrimitives(makeHatch([ccw], 1), 0.001)[0]
    const cwFill = hatchToPrimitives(makeHatch([cw], 1), 0.001)[0]
    if (ccwFill.kind !== 'fill' || cwFill.kind !== 'fill') throw new Error('应为填充图元')
    for (const point of ccwFill.loops[0]) expect(point.y).toBeGreaterThanOrEqual(-1e-9)
    for (const point of cwFill.loops[0]) expect(point.y).toBeLessThanOrEqual(1e-9)
  })

  it('椭圆边落在椭圆方程上', () => {
    const path = edgePath([
      {
        type: 3,
        center: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
        lengthOfMinorAxis: 0.5,
        startAngle: 0,
        endAngle: Math.PI * 2,
        isCCW: true,
      },
    ])
    const fill = hatchToPrimitives(makeHatch([path], 1), 0.001)[0]
    if (fill.kind !== 'fill') throw new Error('应为填充图元')
    for (const point of fill.loops[0]) {
      expect((point.x * point.x) / 100 + (point.y * point.y) / 25).toBeCloseTo(1, 6)
    }
  })

  it('样条边参与填充边界，图案填充只输出闭合折线', () => {
    const splineEdge = {
      type: 4,
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      controlPoints: [
        { x: 0, y: 0, weight: 1 },
        { x: 5, y: 8, weight: 1 },
        { x: 10, y: 0, weight: 1 },
      ],
    }
    const pattern = hatchToPrimitives(makeHatch([edgePath([splineEdge])], 0), 0.01)
    expect(pattern).toHaveLength(1)
    expect(pattern[0].kind).toBe('polyline')
    if (pattern[0].kind !== 'polyline') return
    expect(pattern[0].closed).toBe(true)
    expect(pattern[0].points.length).toBeGreaterThan(2)
  })

  it('无有效边界的 HATCH 返回空数组', () => {
    expect(hatchToPrimitives(makeHatch([], 1), 0.01)).toHaveLength(0)
  })
})

describe('MLINE 解析', () => {
  /** 生成多线顶点 */
  function vertex(x: number, y: number, miterX: number, miterY: number, offsets: number[]) {
    return {
      vertex: { x, y, z: 0 },
      vertexDirection: { x: 0, y: 1, z: 0 },
      miterDirection: { x: miterX, y: miterY, z: 0 },
      numberOfLines: offsets.length,
      lines: offsets.map((offset) => ({
        numberOfSegmentParams: 2,
        segmentParams: [offset, 0],
        numberOfAreaFillParams: 0,
        areaFillParams: [],
      })),
    }
  }

  /** 生成 MLINE 实体夹具 */
  function makeMLine(vertices: unknown[], flags: number): DwgMLineEntity {
    return {
      type: 'MLINE',
      scale: 50,
      justification: 0,
      flags,
      vertices,
    } as unknown as DwgMLineEntity
  }

  it('实测样本：scale=50、segparms=[0,-50] 时带宽为 50 而不是 2500', () => {
    const vertices = [
      vertex(28268.58, 53475.61, -1, 0, [0, -50]),
      vertex(28268.58, 54375.61, -1, 0, [0, -50]),
    ]
    const polylines = buildMLinePolylines(makeMLine(vertices, 1), 0.01)
    expect(polylines).toHaveLength(2)
    const bandwidth = Math.abs(polylines[0].points[0].x - polylines[1].points[0].x)
    expect(bandwidth).toBeCloseTo(50, 9)
    // 每条元素线长度与中心线一致
    expect(polylines[0].points[1].y - polylines[0].points[0].y).toBeCloseTo(900, 9)
  })

  it('flags 第 2 位才表示闭合', () => {
    const vertices = [
      vertex(0, 0, -1, 0, [0, -50]),
      vertex(0, 900, -1, 0, [0, -50]),
    ]
    expect(buildMLinePolylines(makeMLine(vertices, 1), 0.01)[0].closed).toBe(false)
    expect(buildMLinePolylines(makeMLine(vertices, 3), 0.01)[0].closed).toBe(true)
  })

  it('三顶点转角按各顶点的 miterDirection 偏移', () => {
    const vertices = [
      vertex(0, 0, 0, 1, [0, 2]),
      vertex(10, 0, 1, 1, [0, 2]),
      vertex(10, 10, -1, 0, [0, 2]),
    ]
    const polylines = buildMLinePolylines(makeMLine(vertices, 1), 0.01)
    const outer = polylines[1].points
    expect(outer).toEqual([
      { x: 0, y: 2 },
      { x: 12, y: 2 },
      { x: 8, y: 10 },
    ])
  })

  it('元素数不足 2 时返回空数组', () => {
    const vertices = [vertex(0, 0, -1, 0, [0]), vertex(0, 900, -1, 0, [0])]
    expect(buildMLinePolylines(makeMLine(vertices, 1), 0.01)).toHaveLength(0)
  })
})

describe('DwgDatabase 转换', () => {
  it('展开 INSERT，并把块内 0 层实体继承到插入图层', () => {
    const database = {
      header: { INSUNITS: 4 },
      tables: {
        LAYER: {
          entries: [
            { name: 'WALL', colorIndex: 1, color: 0xffffff, off: false, frozen: false },
            { name: '0', colorIndex: 7, color: 0xffffff, off: false, frozen: false },
          ],
        },
        BLOCK_RECORD: {
          entries: [
            {
              name: 'DOOR',
              basePoint: { x: 0, y: 0, z: 0 },
              entities: [
                {
                  type: 'LINE',
                  handle: 'B1',
                  layer: '0',
                  startPoint: { x: 0, y: 0, z: 0 },
                  endPoint: { x: 100, y: 0, z: 0 },
                },
              ],
            },
          ],
        },
      },
      entities: [
        {
          type: 'LINE',
          handle: '1',
          layer: 'WALL',
          startPoint: { x: 0, y: 0, z: 0 },
          endPoint: { x: 100, y: 0, z: 0 },
        },
        {
          type: 'INSERT',
          handle: '2',
          layer: 'WALL',
          name: 'DOOR',
          insertionPoint: { x: 500, y: 0, z: 0 },
          rotation: 0,
          xScale: 1,
          yScale: 1,
          zScale: 1,
          columnCount: 1,
          rowCount: 1,
          columnSpacing: 0,
          rowSpacing: 0,
          attribs: [],
        },
        { type: 'HATCH', handle: '3', layer: 'WALL' },
      ],
    } as unknown as DwgDatabase

    const drawing = buildDrawing(database, { fileName: 'x.dxf', fileType: 'DXF', parseMs: 1, notes: [] })
    expect(drawing.entities).toHaveLength(2)
    expect(drawing.entities[0].color).toBe(0xff0000)
    expect(drawing.entities[1].layer).toBe('WALL')
    const blockPrimitive = drawing.entities[1].primitives[0]
    if (blockPrimitive.kind !== 'polyline') throw new Error('块内实体应为折线')
    expect(blockPrimitive.points[0].x).toBe(500)
    // 块名与块实例号必须保留：门窗识别靠块名判类型、靠实例号聚合块内多图元
    expect(drawing.entities[1].blockName).toBe('DOOR')
    expect(drawing.entities[1].blockInstance).toEqual(expect.any(Number))
    expect(drawing.entities[0].blockName).toBeUndefined()
    expect(drawing.entities[0].blockInstance).toBeUndefined()
    expect(drawing.stats.skippedCount).toBe(1)
    expect(drawing.unitScale).toBe(0.001)
  })

  it('HATCH / MLINE / 块内 SPLINE 都能进入 IR', () => {
    const database = {
      header: { INSUNITS: 4 },
      tables: {
        LAYER: { entries: [{ name: '0', colorIndex: 7, off: false, frozen: false }] },
        BLOCK_RECORD: {
          entries: [
            {
              name: 'SPLINE_BLOCK',
              basePoint: { x: 0, y: 0, z: 0 },
              entities: [
                {
                  type: 'SPLINE',
                  handle: 'B1',
                  layer: '0',
                  flag: 0,
                  degree: 2,
                  knots: [0, 0, 0, 1, 1, 1],
                  controlPoints: [
                    { x: 0, y: 0, z: 0 },
                    { x: 5, y: 10, z: 0 },
                    { x: 10, y: 0, z: 0 },
                  ],
                  fitPoints: [],
                },
              ],
            },
          ],
        },
      },
      entities: [
        {
          type: 'HATCH',
          handle: 'H1',
          layer: '0',
          solidFill: 1,
          boundaryPaths: [
            {
              boundaryPathTypeFlag: 1,
              hasBulge: false,
              isClosed: true,
              numberOfVertices: 4,
              vertices: [
                { x: 0, y: 0, bulge: 0 },
                { x: 100, y: 0, bulge: 0 },
                { x: 100, y: 100, bulge: 0 },
                { x: 0, y: 100, bulge: 0 },
              ],
            },
          ],
        },
        {
          type: 'MLINE',
          handle: 'M1',
          layer: '0',
          scale: 50,
          flags: 1,
          vertices: [0, 900].map((y) => ({
            vertex: { x: 0, y, z: 0 },
            vertexDirection: { x: 0, y: 1, z: 0 },
            miterDirection: { x: -1, y: 0, z: 0 },
            numberOfLines: 2,
            lines: [0, -50].map((offset) => ({
              numberOfSegmentParams: 2,
              segmentParams: [offset, 0],
              numberOfAreaFillParams: 0,
              areaFillParams: [],
            })),
          })),
        },
        {
          type: 'INSERT',
          handle: 'I1',
          layer: '0',
          name: 'SPLINE_BLOCK',
          insertionPoint: { x: 0, y: 0, z: 0 },
          rotation: 0,
          xScale: 1,
          yScale: 1,
          zScale: 1,
          columnCount: 1,
          rowCount: 1,
          columnSpacing: 0,
          rowSpacing: 0,
          attribs: [],
        },
      ],
    } as unknown as DwgDatabase

    const drawing = buildDrawing(database, { fileName: 'y.dxf', fileType: 'DXF', parseMs: 1, notes: [] })
    expect(drawing.stats.skippedCount).toBe(0)
    expect(drawing.stats.renderableCount).toBe(3)
    expect(drawing.entities.map((entity) => entity.type)).toEqual(['HATCH', 'MLINE', 'SPLINE'])
    const hatch = drawing.entities[0].primitives[0]
    expect(hatch.kind).toBe('fill')
    expect(drawing.entities[1].primitives).toHaveLength(2)
  })
})

describe('glTF 导出', () => {
  /** 一个 2m × 2m、1m 高的两层四边形，平面范围完全落在 (10,20)~(12,22) */
  function makeWalls(): {
    positions: Float32Array
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
  } {
    const corners: Array<[number, number]> = [
      [10, 20],
      [12, 20],
      [12, 22],
      [10, 22],
    ]
    const positions = new Float32Array(12 * 3)
    // 两个三角形拼成顶面，足以验证平移与顶点守恒
    const vertices: Array<[number, number, number]> = [
      [corners[0][0], 1, corners[0][1]],
      [corners[1][0], 1, corners[1][1]],
      [corners[2][0], 1, corners[2][1]],
      [corners[0][0], 1, corners[0][1]],
      [corners[2][0], 1, corners[2][1]],
      [corners[3][0], 1, corners[3][1]],
      [corners[0][0], 0, corners[0][1]],
      [corners[2][0], 0, corners[2][1]],
      [corners[1][0], 0, corners[1][1]],
      [corners[0][0], 0, corners[0][1]],
      [corners[3][0], 0, corners[3][1]],
      [corners[2][0], 0, corners[2][1]],
    ]
    vertices.forEach((vertex, index) => positions.set(vertex, index * 3))
    return { positions, bounds: { minX: 10, minY: 20, maxX: 12, maxY: 22 } }
  }

  const options = {
    unitScale: 0.001,
    wallHeight: 1,
    thicknessByLayer: { WALL: 0.24 },
  }

  it('平移归零：顶点包围盒中心落在原点，高度不变', () => {
    const walls = makeWalls()
    const { scene, manifest } = buildExportScene(
      { ...walls, segmentCount: 1, totalLength: 2, skippedRingCount: 0, pieces: [], rings: [], openings: [], skippedOpeningCount: 0 },
      options,
    )
    expect(manifest.origin).toEqual({ x: 11, y: 21 })

    const mesh = scene.getObjectByName('walls') as THREE.Mesh
    const attribute = mesh.geometry.getAttribute('position')
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    const heights = new Set<number>()
    for (let i = 0; i < attribute.count; i += 1) {
      const x = attribute.getX(i)
      const y = attribute.getY(i)
      const z = attribute.getZ(i)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
      heights.add(y)
    }
    expect((minX + maxX) / 2).toBeCloseTo(0, 9)
    expect((minZ + maxZ) / 2).toBeCloseTo(0, 9)
    expect(minX).toBeCloseTo(-1, 9)
    expect(maxZ).toBeCloseTo(1, 9)
    // 高度轴不平移
    expect([...heights].sort()).toEqual([0, 1])
  })

  it('顶点镜像到 −z：图纸北侧落到世界负 z，外法线仍朝上', () => {
    // 南侧三角形 x∈[10,10.5]、北侧三角形 x∈[11,12]，两者在局部坐标里外法线都朝 +Y，
    // 因此「x 最大」的顶点必然属于北侧，可以据此判断镜像方向
    const positions = new Float32Array([
      10, 1, 20, 10, 1, 21, 10.5, 1, 20,
      11, 1, 22, 12, 1, 22, 11.5, 1, 21,
    ])
    const { scene } = buildExportScene(
      {
        positions,
        bounds: { minX: 10, minY: 20, maxX: 12, maxY: 22 },
        segmentCount: 1,
        totalLength: 2,
        skippedRingCount: 0,
        pieces: [],
        rings: [],
        openings: [],
        skippedOpeningCount: 0,
      },
      options,
    )
    const mesh = scene.getObjectByName('walls') as THREE.Mesh
    const attribute = mesh.geometry.getAttribute('position')
    const normal = mesh.geometry.getAttribute('normal')
    let maxXIndex = 0
    let minNormalY = Infinity
    for (let i = 0; i < attribute.count; i += 1) {
      if (attribute.getX(i) > attribute.getX(maxXIndex)) maxXIndex = i
      minNormalY = Math.min(minNormalY, normal.getY(i))
    }
    // 图纸 y=22（北）→ 世界 z = originY − y = 21 − 22 = −1
    expect(attribute.getZ(maxXIndex)).toBeCloseTo(-1, 6)
    // 镜像翻转绕序后必须交换三角形后两个顶点，法线才仍然朝 +Y
    expect(minNormalY).toBeGreaterThan(0.99)
  })

  it('manifest 字段完整且与入参解耦', () => {
    const walls = makeWalls()
    const input = { ...options, thicknessByLayer: { WALL: 0.24 } }
    const { manifest } = buildExportScene(
      { ...walls, segmentCount: 1, totalLength: 2, skippedRingCount: 0, pieces: [], rings: [], openings: [], skippedOpeningCount: 0 },
      input,
    )
    expect(manifest).toEqual({
      origin: { x: 11, y: 21 },
      unitScale: 0.001,
      wallHeight: 1,
      thicknessByLayer: { WALL: 0.24 },
      bounds: { minX: 10, minY: 20, maxX: 12, maxY: 22 },
    })
    input.thicknessByLayer.WALL = 9
    expect(manifest.thicknessByLayer.WALL).toBe(0.24)
  })

  it('顶点数守恒：三角形数量不变，重复顶点被合并', () => {
    const walls = makeWalls()
    const { scene } = buildExportScene(
      { ...walls, segmentCount: 1, totalLength: 2, skippedRingCount: 0, pieces: [], rings: [], openings: [], skippedOpeningCount: 0 },
      options,
    )
    const mesh = scene.getObjectByName('walls') as THREE.Mesh
    const geometry = mesh.geometry
    const index = geometry.getIndex()
    expect(index).not.toBeNull()
    // 12 个原始顶点 → 两个三角形（6 个索引）不变
    expect(index?.count).toBe(12)
    expect(geometry.getAttribute('position').count).toBeLessThan(12)
  })

  it('空几何与非法规格直接抛错', () => {
    expect(() =>
      buildExportScene(
        {
          positions: new Float32Array(0),
          bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          segmentCount: 0,
          totalLength: 0,
          skippedRingCount: 0,
          pieces: [],
          rings: [],
          openings: [],
          skippedOpeningCount: 0,
        },
        options,
      ),
    ).toThrowError(/没有可导出/)
    expect(() =>
      buildExportScene(
        { ...makeWalls(), segmentCount: 1, totalLength: 2, skippedRingCount: 0, pieces: [], rings: [], openings: [], skippedOpeningCount: 0 },
        { ...options, wallHeight: 0 },
      ),
    ).toThrowError(/墙高/)
  })

  it('导出的 GLB 头部合法，manifest 写入场景 extras', async () => {
    const origin = globalThis.FileReader
    // Node 环境没有 FileReader，用 Blob.arrayBuffer 补一个仅供测试的最小实现
    class NodeFileReader {
      result: ArrayBuffer | null = null
      onloadend: (() => void) | null = null
      readAsArrayBuffer(blob: Blob): void {
        void blob.arrayBuffer().then((buffer) => {
          this.result = buffer
          this.onloadend?.()
        })
      }
    }
    vi.stubGlobal('FileReader', NodeFileReader as unknown as typeof FileReader)
    try {
      const { scene, manifest } = buildExportScene(
        { ...makeWalls(), segmentCount: 1, totalLength: 2, skippedRingCount: 0, pieces: [], rings: [], openings: [], skippedOpeningCount: 0 },
        options,
      )
      expect(scene.userData).toEqual(manifest)
      const buffer = await exportGlb({ scene, manifest })
      const view = new DataView(buffer)
      expect(view.getUint32(0, true)).toBe(0x46546c67)
      expect(view.getUint32(4, true)).toBe(2)
      const jsonLength = view.getUint32(12, true)
      const jsonChunk = new Uint8Array(buffer, 20, jsonLength)
      const json = JSON.parse(new TextDecoder().decode(jsonChunk)) as {
        scenes: Array<{ nodes: number[]; extras?: unknown }>
        nodes: Array<{ name?: string }>
      }
      expect(json.scenes[0].extras).toEqual(manifest)
      expect(json.nodes.some((node) => node.name === 'walls')).toBe(true)
    } finally {
      vi.stubGlobal('FileReader', origin)
    }
  })
})

describe('墙段删除与重建', () => {
  const angle = (0.5 * Math.PI) / 180

  function seg(ax: number, ay: number, bx: number, by: number): WallSegment {
    return {
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      layer: 'W',
      thickness: 0.2,
      key: `W|${ax},${ay}|${bx},${by}`,
    }
  }

  // 图纸单位为毫米，unitScale=0.001 → 每段实际长度 1m
  const line = [seg(0, 0, 1000, 0), seg(1000, 0, 2000, 0), seg(2000, 0, 3000, 0)]

  it('删除中间段后墙带断成两段并各自补端面', () => {
    const graph = weldVertices([line[0], line[2]], 0.001)
    const chains = mergeCollinearChains(graph, angle)
    expect(chains).toHaveLength(2)

    const result = buildWallGeometry([line[0], line[2]], { miterLimit: 4, height: 3 }, 0.001)
    expect(result.segmentCount).toBe(2)
    // 两条独立墙带各 10 个三角形（顶面 + 两侧 + 两端面）
    expect(result.positions.length / 9).toBe(20)
  })

  it('删除一段后其余段的几何键完全不变', () => {
    const full = buildWallGeometry(line, { miterLimit: 4, height: 3 }, 0.001)
    const kept = buildWallGeometry([line[0], line[2]], { miterLimit: 4, height: 3 }, 0.001)
    const remaining = full.pieces
      .map((piece) => piece.key)
      .filter((key) => key !== line[1].key)
    expect(kept.pieces.map((piece) => piece.key)).toEqual(remaining)
  })

  it('批量删除、撤销与重置后统计按剩余几何重算', () => {
    const full = buildWallGeometry(line, { miterLimit: 4, height: 3 }, 0.001)
    expect(full.segmentCount).toBe(3)
    expect(full.totalLength).toBeCloseTo(3, 9)

    const removed = new Set([line[0].key, line[1].key])
    const deleted = buildWallGeometry(
      line.filter((segment) => !removed.has(segment.key)),
      { miterLimit: 4, height: 3 },
      0.001,
    )
    expect(deleted.segmentCount).toBe(1)
    expect(deleted.totalLength).toBeCloseTo(1, 9)

    // 撤销：删除集回到空集，重建后恢复全部几何
    const restored = buildWallGeometry(
      line.filter((segment) => !new Set<string>().has(segment.key)),
      { miterLimit: 4, height: 3 },
      0.001,
    )
    expect(restored.segmentCount).toBe(3)
    expect(restored.totalLength).toBeCloseTo(3, 9)
    expect(restored.pieces.map((piece) => piece.key)).toEqual(full.pieces.map((piece) => piece.key))
  })

  it('删除后导出场景只包含剩余墙体，manifest 仍取生成快照', () => {
    const remaining = buildWallGeometry([line[2]], { miterLimit: 4, height: 4 }, 0.001)
    const options = { unitScale: 0.001, wallHeight: 4, thicknessByLayer: { W: 0.25 } }
    const { scene, manifest } = buildExportScene(remaining, options)
    const walls = scene.getObjectByName('walls') as THREE.Mesh
    expect(walls).toBeDefined()
    // mergeVertices 会合并重复顶点，这里比较三角形数量而不是顶点数量
    expect(walls.geometry.getIndex()?.count ?? walls.geometry.getAttribute('position').count).toBe(30)
    expect(manifest.wallHeight).toBe(4)
    expect(manifest.thicknessByLayer).toEqual({ W: 0.25 })
  })
})

describe('编辑态对象拾取', () => {
  const width = 800
  const height = 600

  function makeLine(key: string, ax: number, ay: number, bx: number, by: number): PickLine {
    return {
      key,
      a: new THREE.Vector3(ax, 0, ay),
      b: new THREE.Vector3(bx, 0, by),
    }
  }

  function makeCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000)
    camera.position.set(0, 0, 20)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    return camera
  }

  it('世界原点投影到视口中心', () => {
    const screen = projectPoint(new THREE.Vector3(0, 0, 0), makeCamera(), width, height)
    expect(screen.x).toBeCloseTo(width / 2, 6)
    expect(screen.y).toBeCloseTo(height / 2, 6)
    expect(Math.abs(screen.ndcZ)).toBeLessThan(1)
  })

  it('命中阈值内返回对象键，超出阈值返回 null', () => {
    const camera = makeCamera()
    const lines = [makeLine('seg', -4, 0, 4, 0)]
    const a = projectPoint(new THREE.Vector3(-4, 0, 0), camera, width, height)
    const b = projectPoint(new THREE.Vector3(4, 0, 0), camera, width, height)
    const midX = (a.x + b.x) / 2
    const midY = (a.y + b.y) / 2

    expect(pickLineAt(lines, camera, width, height, { x: midX, y: midY + 5 }, 10)).toBe('seg')
    expect(pickLineAt(lines, camera, width, height, { x: midX, y: midY + 20 }, 10)).toBeNull()
  })

  it('门窗与幕墙的代表线段同样可以被点选', () => {
    const camera = makeCamera()
    const lines = [
      makeLine('@opening:W|window', -2, 0, -0.5, 0),
      makeLine('@curtain:W|a|b', 0.5, 0, 2, 0),
    ]
    const opening = projectPoint(new THREE.Vector3(-1.25, 0, 0), camera, width, height)
    const curtain = projectPoint(new THREE.Vector3(1.25, 0, 0), camera, width, height)
    expect(pickLineAt(lines, camera, width, height, { x: opening.x, y: opening.y }, 10)).toBe(
      '@opening:W|window',
    )
    expect(pickLineAt(lines, camera, width, height, { x: curtain.x, y: curtain.y }, 10)).toBe(
      '@curtain:W|a|b',
    )
  })

  it('距离并列时取更近的一段', () => {
    const camera = makeCamera()
    const lines = [makeLine('far', -1, 0, 1, 0), makeLine('near', -1, 5, 1, 5)]
    expect(pickLineAt(lines, camera, width, height, { x: width / 2, y: height / 2 }, 10)).toBe('near')
  })

  it('相机背后的线段被剔除', () => {
    const camera = makeCamera()
    const lines = [makeLine('behind', -1, 30, 1, 30)]
    expect(pickLineAt(lines, camera, width, height, { x: width / 2, y: height / 2 }, 10)).toBeNull()
  })

  it('矩形与线段相交判定覆盖穿过、包含与不相交', () => {
    const a: ScreenPoint = { x: 0, y: 0, ndcZ: 0 }
    const b: ScreenPoint = { x: 100, y: 0, ndcZ: 0 }
    expect(segmentIntersectsRect(a, b, { minX: 40, minY: -10, maxX: 60, maxY: 10 })).toBe(true)
    expect(segmentIntersectsRect(a, b, { minX: -10, minY: -10, maxX: 10, maxY: 10 })).toBe(true)
    expect(segmentIntersectsRect(a, b, { minX: 40, minY: 20, maxX: 60, maxY: 40 })).toBe(false)
  })

  it('框选返回与矩形相交的对象，墙段 / 门窗 / 幕墙共用同一套判定', () => {
    const camera = makeCamera()
    const lines = [
      makeLine('cross', -4, 0, 4, 0),
      makeLine('outside', 20, 0, 30, 0),
      makeLine('@opening:W|window', -2, 3, 2, 3),
    ]
    const keys = selectLinesInRect(
      lines,
      camera,
      width,
      height,
      { minX: 300, minY: 200, maxX: 500, maxY: 400 },
    )
    expect(keys).toEqual(['cross', '@opening:W|window'])
  })

  it('点到线段的距离按端点与投影分段计算', () => {
    const a: ScreenPoint = { x: 0, y: 0, ndcZ: 0 }
    const b: ScreenPoint = { x: 10, y: 0, ndcZ: 0 }
    expect(distanceToSegment({ x: 5, y: 3, ndcZ: 0 }, a, b)).toBeCloseTo(3, 9)
    expect(distanceToSegment({ x: -4, y: 3, ndcZ: 0 }, a, b)).toBeCloseTo(5, 9)
  })
})

describe('多层建筑参数', () => {
  function params(overrides: Partial<NormalizedBuildingParams> = {}): NormalizedBuildingParams {
    return normalizeBuildingParams({
      floorCount: 5,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
      ...overrides,
    })
  }

  it('楼层数接受 1 与 100，越界或非整数直接抛错', () => {
    expect(normalizeBuildingParams({ ...params(), floorCount: 1 }).floorCount).toBe(1)
    expect(normalizeBuildingParams({ ...params(), floorCount: 100 }).floorCount).toBe(100)
    for (const floorCount of [0, 101, 2.5, -1]) {
      expect(() => normalizeBuildingParams({ ...params(), floorCount })).toThrowError(/楼层数/)
    }
  })

  it('层间距与墙高必须为正，且墙高与板厚之和不得超过层间距', () => {
    expect(() => normalizeBuildingParams({ ...params(), floorSpacing: 0 })).toThrowError(/层间距/)
    expect(() => normalizeBuildingParams({ ...params(), wallHeight: 0 })).toThrowError(/墙高/)
    expect(() => normalizeBuildingParams({ ...params(), wallHeight: 3 })).toThrowError(/墙高/)
    expect(() => normalizeBuildingParams({ ...params(), slabThickness: 0 })).toThrowError(/板厚/)
    // 2.9 + 0.2 = 3.1 超过 3 m 的层间距
    expect(() => normalizeBuildingParams({ ...params(), wallHeight: 2.9 })).toThrowError(/板厚/)
    expect(floorGap(3, 2.65, 0.2)).toBeCloseTo(0.15, 9)
  })

  it('标高与总高度按层间距线性累加', () => {
    const p = params({ floorCount: 3 })
    expect([0, 1, 2].map((index) => floorElevation(index, p))).toEqual([0, 3, 6])
    expect(buildingHeight(p)).toBeCloseTo(6 + 2.8, 9)
  })

  it('展开层滑出、上方楼层整体上移 0.8 个层距，下方不动', () => {
    const p = params({ floorCount: 5 })
    const offsets = instanceOffsets(p, 2, 1)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(0)
    // 被展开层自身不改高度，改为水平滑出
    expect(offsets[2]).toBe(0)
    expect(offsets[3]).toBeCloseTo(2.4, 6)
    expect(offsets[4]).toBeCloseTo(2.4, 6)
    expect([...instanceOffsets(p, null, 1)]).toEqual([0, 0, 0, 0, 0])
    // 进度为 0 时整栋贴合，避免展开动画起点跳变
    expect([...instanceOffsets(p, 2, 0)]).toEqual([0, 0, 0, 0, 0])
  })

  it('展开顶层时没有楼层需要抬升', () => {
    const p = params({ floorCount: 4 })
    const offsets = instanceOffsets(p, 3, 1)
    expect([...offsets]).toEqual([0, 0, 0, 0])
  })

  it('抽屉沿平面短边滑出整层跨度并留出层距间隙', () => {
    // 平面 40 × 20：短边是 Z 方向 20，滑出距离 = 20 + 0.3 × 3 = 20.9
    const bounds = { minX: -20, minY: -10, maxX: 20, maxY: 10 }
    const p = params({ floorCount: 3 })
    const slide = drawerSlide(bounds, p, 1)
    expect(slide.span).toBe(20)
    expect(slide.x).toBe(0)
    expect(slide.z).toBeCloseTo(20.9, 6)

    // 进度只做等比缩放，动画中间值不会越过目标
    const half = drawerSlide(bounds, p, 0.5)
    expect(half.z).toBeCloseTo(10.45, 6)

    // 平面 10 × 30：短边是 X 方向 10，滑出距离 = 10 + 0.9 = 10.9
    const tall = drawerSlide({ minX: 0, minY: 0, maxX: 10, maxY: 30 }, p, 1)
    expect(tall.x).toBeCloseTo(10.9, 6)
    expect(tall.z).toBe(0)
  })

  it('云团分布由固定种子决定，且全部落在地平线以上', () => {
    const puffs = cloudPuffs(20261110, 12)
    expect(cloudPuffs(20261110, 12)).toEqual(puffs)
    expect(puffs).toHaveLength(12 * 6)
    for (const puff of puffs) {
      expect(puff.u).toBeGreaterThanOrEqual(0)
      expect(puff.u).toBeLessThan(1)
      expect(puff.v).toBeGreaterThan(0)
      expect(puff.v).toBeLessThan(0.5)
      expect(puff.radius).toBeGreaterThan(0)
      expect(puff.alpha).toBeGreaterThan(0)
      expect(puff.alpha).toBeLessThan(0.5)
    }
    expect(cloudPuffs(1, 12)).not.toEqual(puffs)
    expect(() => cloudPuffs(1, 0)).toThrow()
  })

  it('指数插值单调收敛且不越过目标', () => {
    let value = 0
    for (let step = 0; step < 120; step += 1) {
      const next = smoothTowards(value, 1, 1 / 60)
      expect(next).toBeGreaterThanOrEqual(value)
      expect(next).toBeLessThanOrEqual(1)
      value = next
    }
    expect(value).toBeCloseTo(1, 3)
    // 大帧间隔时按 1 封顶，不越过目标
    expect(smoothTowards(0, 1, 10)).toBe(1)
  })

  it('线性逼近按固定时长到达目标，且正反向都不越过', () => {
    // 单段 0.5 秒、帧间隔 0.125 秒：4 帧走完，步骤 0.25 为二进制精确值
    const step = 0.125 / 0.5
    let value = 0
    let frames = 0
    while (value < 1 && frames < 120) {
      value = moveTowards(value, 1, step)
      frames += 1
    }
    expect(frames).toBe(4)
    expect(value).toBe(1)
    // 回程同样 4 帧
    frames = 0
    while (value > 0 && frames < 120) {
      value = moveTowards(value, 0, step)
      frames += 1
    }
    expect(frames).toBe(4)
    expect(value).toBe(0)
    // 大步长直接停在目标，非正步长保持不动
    expect(moveTowards(0.2, 1, 10)).toBe(1)
    expect(moveTowards(0.4, 1, 0)).toBe(0.4)
  })
})

describe('整栋导出', () => {
  const options = {
    unitScale: 0.001,
    wallHeight: 2.85,
    thicknessByLayer: { WALL: 0.24 },
  }

  function makeWalls() {
    // 单个竖直三角形，便于核对标高
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 2.85, 0])
    return {
      positions,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      segmentCount: 1,
      totalLength: 1,
      skippedRingCount: 0,
      pieces: [],
      rings: [],
      openings: [],
      skippedOpeningCount: 0,
    }
  }

  it('3 层导出按标高烘焙，extras.floors 记录每层标高', () => {
    const params = normalizeBuildingParams({
      floorCount: 3,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    const walls = makeWalls()
    const floors = [0, 1, 2].map(() => ({ walls }))
    const { manifest, scene } = buildBuildingExportScene(floors, params, options)
    expect(manifest.floors).toEqual([
      { index: 0, elevation: 0 },
      { index: 1, elevation: 3 },
      { index: 2, elevation: 6 },
    ])

    const mesh = scene.getObjectByName('walls') as THREE.Mesh
    const heights = mesh.geometry.getAttribute('position')
    const values: number[] = []
    for (let index = 0; index < heights.count; index += 1) {
      values.push(heights.getY(index))
    }
    expect(Math.min(...values)).toBeCloseTo(0, 6)
    expect(Math.max(...values)).toBeCloseTo(6 + 2.85, 6)
  })

  it('门窗构件并入导出网格，并按楼层标高烘焙', () => {
    const params = normalizeBuildingParams({
      floorCount: 2,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    const opening = {
      wallKey: 'W|0,0|1,0',
      kind: 'door' as const,
      center: { x: 0.5, y: 0 },
      direction: { x: 1, y: 0 },
      width: 0.9,
      height: 2.1,
      sill: 0,
      thickness: 0.2,
    }
    const floors = [
      { walls: { ...makeWalls(), openings: [opening] } },
      { walls: { ...makeWalls(), openings: [] } },
    ]
    const { manifest, scene } = buildBuildingExportScene(floors, params, options)
    expect(manifest.openings).toEqual({ doors: 1, windows: 0 })

    const frames = scene.getObjectByName('opening-frames') as THREE.Mesh
    expect(frames).toBeDefined()
    frames.geometry.computeBoundingBox()
    // 首层洞口在标高 0 烘焙：门套顶 2.1，贴脸向上外挑 0.05 并向洞口内压 3mm
    expect(frames.geometry.boundingBox!.max.y).toBeCloseTo(2.147, 6)
    expect(scene.getObjectByName('opening-leaves')).toBeDefined()
    expect(scene.getObjectByName('opening-hardware')).toBeDefined()
    // 普通木门没有玻璃，不生成空网格
    expect(scene.getObjectByName('opening-glass')).toBeUndefined()
  })

  it('逐层几何不同时按各自顶点烘焙，楼层几何数量不符直接抛错', () => {
    const params = normalizeBuildingParams({
      floorCount: 2,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    const full = makeWalls()
    expect(() => buildBuildingExportScene([{ walls: full }], params, options)).toThrowError(
      /楼层几何数量/,
    )
    // 第 2 层多出三个顶点：合并后顶点数应为两层之和
    const taller = {
      ...full,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 2.85, 0, 2, 0, 0, 2, 2.85, 0, 2.85, 2.85, 0]),
    }
    const { scene } = buildBuildingExportScene(
      [
        { walls: full },
        { walls: taller },
      ],
      params,
      options,
    )
    const mesh = scene.getObjectByName('walls') as THREE.Mesh
    expect(mesh.geometry.getAttribute('position').count).toBe(9)
  })

  it('单层导出不写 floors，与既有单层结构一致', () => {
    const params = normalizeBuildingParams({
      floorCount: 1,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    const { manifest } = buildBuildingExportScene([{ walls: makeWalls() }], params, options)
    expect(manifest.floors).toBeUndefined()
    expect(Object.keys(manifest)).toEqual([
      'origin',
      'unitScale',
      'wallHeight',
      'thicknessByLayer',
      'bounds',
    ])
  })

  it('导出材质使用传入参数，省略时回落到默认灰色金属', () => {
    const params = normalizeBuildingParams({
      floorCount: 1,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    const custom = buildBuildingExportScene([{ walls: makeWalls() }], params, {
      ...options,
      material: { color: '#c0392b', metalness: 0.2, roughness: 0.9 },
    })
    const customMaterial = (custom.scene.getObjectByName('walls') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial
    expect(customMaterial.color.getHexString()).toBe('c0392b')
    expect(customMaterial.metalness).toBe(0.2)
    expect(customMaterial.roughness).toBe(0.9)

    const fallback = buildBuildingExportScene([{ walls: makeWalls() }], params, options)
    const fallbackMaterial = (fallback.scene.getObjectByName('walls') as THREE.Mesh)
      .material as THREE.MeshStandardMaterial
    expect(fallbackMaterial.color.getHexString()).toBe(
      DEFAULT_WALL_MATERIAL.color.replace('#', ''),
    )
    expect(fallbackMaterial.metalness).toBe(DEFAULT_WALL_MATERIAL.metalness)
    expect(fallbackMaterial.roughness).toBe(DEFAULT_WALL_MATERIAL.roughness)
  })

  it('导出材质携带表面贴图，并按米制盒式投影生成 UV', () => {
    const params = normalizeBuildingParams({
      floorCount: 1,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    const texture = new THREE.Texture()
    texture.repeat.set(0.5, 2)
    const { scene } = buildBuildingExportScene([{ walls: makeWalls() }], params, {
      ...options,
      textures: { map: texture, roughnessMap: null, normalMap: null },
    })

    const mesh = scene.getObjectByName('walls') as THREE.Mesh
    const material = mesh.material as THREE.MeshStandardMaterial
    expect(material.map).toBe(texture)
    // 法线 / 粗糙度贴图未提供时不挂空贴图
    expect(material.normalMap).toBeNull()
    expect(material.roughnessMap).toBeNull()

    const uv = mesh.geometry.getAttribute('uv')
    expect(uv).toBeDefined()
    expect(uv.count).toBe(mesh.geometry.getAttribute('position').count)
    // UV 按米制投影，repeat 由 GLTFExporter 写成 KHR_texture_transform
    const us: number[] = []
    const vs: number[] = []
    for (let index = 0; index < uv.count; index += 1) {
      us.push(uv.getX(index))
      vs.push(uv.getY(index))
    }
    expect(Math.min(...us)).toBeCloseTo(0, 5)
    expect(Math.max(...us)).toBeCloseTo(1, 5)
    expect(Math.min(...vs)).toBeCloseTo(0, 5)
    expect(Math.max(...vs)).toBeCloseTo(2.85, 5)

    // 不传贴图时不生成 UV，保持既有纯色导出的顶点布局
    const plain = buildBuildingExportScene([{ walls: makeWalls() }], params, options)
    const plainMesh = plain.scene.getObjectByName('walls') as THREE.Mesh
    expect(plainMesh.geometry.getAttribute('uv')).toBeUndefined()
  })

  it('程序化构件按楼层标高挂载，并以镜像节点完成图纸坐标换算', () => {
    const params = normalizeBuildingParams({
      floorCount: 2,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    const gate = new THREE.Group()
    gate.userData.__kitKind = 'gate'
    gate.position.set(1, 0, 2)
    const partMaterial = new THREE.MeshStandardMaterial({ color: '#336699' })
    const part = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), partMaterial)
    part.position.y = 0.5
    gate.add(part)

    const { scene } = buildBuildingExportScene(
      [{ walls: makeWalls() }, { walls: makeWalls() }],
      params,
      options,
      [{ object: gate, floorIndex: 1 }],
    )

    const root = scene.getObjectByName('procedural-decor') as THREE.Group
    expect(root).toBeDefined()
    // 平面中心 (0.5, 0.5)：平移归零 + z 镜像，与墙体顶点同一套换算
    expect(root.position.toArray()).toEqual([-0.5, 0, 0.5])
    expect(root.scale.toArray()).toEqual([1, 1, -1])

    const wrapper = root.children[0] as THREE.Group
    expect(wrapper.name).toBe('procedural-gate-0')
    expect(wrapper.position.y).toBeCloseTo(3, 9)

    const clone = wrapper.children[0] as THREE.Group
    expect(clone).not.toBe(gate)
    expect(clone.position.toArray()).toEqual([1, 0, 2])
    const clonePart = clone.children[0] as THREE.Mesh
    expect(clonePart).not.toBe(part)
    // 几何与材质共享：导出只复制节点层级，不额外占用显存
    expect(clonePart.geometry).toBe(part.geometry)
    expect(clonePart.material).toBe(partMaterial)
    // 导出不能把预览里的构件从原父节点摘走
    expect(gate.parent).toBeNull()
    expect(part.parent).toBe(gate)
  })

  it('构件楼层下标越界时直接抛错', () => {
    const params = normalizeBuildingParams({
      floorCount: 1,
      floorSpacing: 3,
      wallHeight: 2.8,
      slabThickness: 0.2,
    })
    expect(() =>
      buildBuildingExportScene([{ walls: makeWalls() }], params, options, [
        { object: new THREE.Group(), floorIndex: 1 },
      ]),
    ).toThrowError(/构件楼层下标/)
  })
})

describe('逐层删墙作用范围', () => {
  it('未选中楼层时写入全局，作用于每一层', () => {
    const scope = addRemovedKeys({ global: new Set(), floors: [] }, null, ['a', 'b'])
    expect([...removedKeysForFloor(scope, 0)]).toEqual(['a', 'b'])
    expect([...removedKeysForFloor(scope, 4)]).toEqual(['a', 'b'])
    expect(scope.floors).toEqual([])
  })

  it('选中楼层时只写该层，其他楼层保持不变且不修改入参', () => {
    const base: RemovalScope = { global: new Set(['g']), floors: [] }
    const scope = addRemovedKeys(base, 1, ['x'])
    expect([...removedKeysForFloor(scope, 0)]).toEqual(['g'])
    expect([...removedKeysForFloor(scope, 1)]).toEqual(['g', 'x'])
    expect([...removedKeysForFloor(scope, 2)]).toEqual(['g'])
    expect(base.floors).toEqual([])
  })

  it('楼层下标非法时抛中文错误', () => {
    expect(() => addRemovedKeys({ global: new Set(), floors: [] }, -1, ['a'])).toThrowError(
      /楼层下标/,
    )
    expect(() => removedKeysForFloor({ global: new Set(), floors: [] }, 1.5)).toThrowError(
      /楼层下标/,
    )
  })

  it('签名与删除键顺序无关，空集签名固定为空字符串', () => {
    expect(removalSignature(new Set())).toBe('')
    expect(removalSignature(new Set(['b', 'a']))).toBe(removalSignature(new Set(['a', 'b'])))
    expect(removalSignature(new Set(['a']))).not.toBe(removalSignature(new Set(['b'])))
  })

  it('统计去重后的删除总数，撤销快照与当前范围互不影响', () => {
    const scope = addRemovedKeys({ global: new Set(['a']), floors: [] }, 0, ['a', 'b'])
    expect(removedKeyCount(scope)).toBe(2)
    const snapshot = cloneRemovalScope(scope)
    scope.floors[0].add('c')
    expect([...snapshot.floors[0]]).toEqual(['a', 'b'])
  })
})

describe('墙体材质参数', () => {
  it('默认值为哑光涂料：近白暖灰 / 金属度 0 / 粗糙度 0.85', () => {
    expect(DEFAULT_WALL_MATERIAL).toEqual({ color: '#d8d4cc', metalness: 0, roughness: 0.85 })
  })

  it('预设包含哑光涂料、清水混凝土与金属板，金属板即 #8c8c8c / 1 / 0.5', () => {
    expect(WALL_MATERIAL_PRESETS.map((preset) => preset.id)).toEqual([
      'plaster',
      'concrete',
      'metal',
    ])
    const metal = WALL_MATERIAL_PRESETS.find((preset) => preset.id === 'metal')
    expect(metal?.params).toEqual({ color: '#8c8c8c', metalness: 1, roughness: 0.5 })
  })

  it('合法参数原样返回，颜色统一转小写，0 与 1 边界可用', () => {
    expect(
      normalizeWallMaterial({ color: '#FFFFFF', metalness: 0, roughness: 1 }),
    ).toEqual({ color: '#ffffff', metalness: 0, roughness: 1 })
  })

  it('颜色必须是 #RRGGBB 格式', () => {
    for (const color of ['#fff', 'red', '#12345g', '', '#8c8c8cff']) {
      expect(() => normalizeWallMaterial({ ...DEFAULT_WALL_MATERIAL, color })).toThrowError(/颜色/)
    }
  })

  it('金属度与粗糙度必须在 0–1 之间，非法值不做钳制', () => {
    for (const metalness of [-0.01, 1.01, Number.NaN]) {
      expect(() =>
        normalizeWallMaterial({ ...DEFAULT_WALL_MATERIAL, metalness }),
      ).toThrowError(/金属度/)
    }
    for (const roughness of [-0.01, 1.01, Number.NaN]) {
      expect(() =>
        normalizeWallMaterial({ ...DEFAULT_WALL_MATERIAL, roughness }),
      ).toThrowError(/粗糙度/)
    }
  })
})

describe('表面盒式投影 UV', () => {
  /** 一个三角形：三个顶点坐标拍平后作为 positions */
  function triangle(...points: number[][]): Float32Array {
    return new Float32Array(points.flat())
  }

  it('朝向 ±Z 的墙面用 X / Y 作为 UV，并按贴图尺寸缩放', () => {
    // 逆时针（面向 +Z）的竖直三角形
    const uv = boxProjectUvs(
      triangle([0, 0, 0], [2, 0, 0], [0, 2, 0]),
      SURFACE_TILE_METERS,
    )
    expect(Array.from(uv)).toEqual([
      0 / SURFACE_TILE_METERS,
      0 / SURFACE_TILE_METERS,
      2 / SURFACE_TILE_METERS,
      0 / SURFACE_TILE_METERS,
      0 / SURFACE_TILE_METERS,
      2 / SURFACE_TILE_METERS,
    ])
  })

  it('朝向 +Y 的水平面用 X / Z 作为 UV', () => {
    // 从上方看逆时针（法线 +Y）
    const uv = boxProjectUvs(triangle([0, 0, 0], [2, 0, 0], [0, 0, -2]), 1)
    expect(Array.from(uv)).toEqual([0, 0, 2, 0, 0, 2])
  })

  it('同一三角形的三个顶点共用一套投影轴，不随顶点法线各自变化', () => {
    const uv = boxProjectUvs(triangle([1, 2, 3], [4, 2, 3], [1, 5, 3]), 1)
    // 法线 +Z：u = x，v = y
    expect(Array.from(uv)).toEqual([1, 2, 4, 2, 1, 5])
  })

  it('贴图尺寸必须为正数，顶点数必须是 3 的整数倍', () => {
    expect(() => boxProjectUvs(new Float32Array(9), 0)).toThrowError(/正数/)
    expect(() => boxProjectUvs(new Float32Array(8), 1)).toThrowError(/3 的整数倍/)
  })
})

describe('墙面顶点色 AO', () => {
  /** 一段竖直墙面：z = 0 平面、法线 +Z，x ∈ [0, width]、y ∈ [y0, y1] */
  function wallStrip(width: number, y0: number, y1: number): number[] {
    return [
      0, y0, 0, width, y0, 0, width, y1, 0,
      0, y0, 0, width, y1, 0, 0, y1, 0,
    ]
  }

  it('墙腰保持原亮度，墙脚与墙顶分别被压暗', () => {
    const positions = new Float32Array([
      ...wallStrip(4, 1.2, 1.8),
      ...wallStrip(4, 0, 0.2),
      ...wallStrip(4, 2.9, 3),
    ])
    const shade = wallVertexShade(positions, 3)
    // 墙腰 y=1.2 没有接触阴影
    expect(shade[1]).toBe(1)
    // 墙脚 y=0：压暗 22%
    expect(shade[18]).toBeCloseTo(0.78, 6)
    // 檐口下沿 y=2.9 按比例压暗
    expect(shade[36]).toBeCloseTo(1 - 0.08 * (0.05 / 0.15), 6)
    // 墙顶 y=3：压暗 8%
    expect(shade[42]).toBeCloseTo(1 - 0.08, 6)
  })

  it('水平面（墙顶）不参与接触阴影', () => {
    const positions = new Float32Array([
      // 朝向 +Y 的墙顶三角形
      0, 3, 0, 2, 3, 0, 0, 3, -2,
    ])
    expect(Array.from(wallVertexShade(positions, 3))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
  })

  it('墙高与顶点数非法时抛出中文错误', () => {
    expect(() => wallVertexShade(new Float32Array(9), 0)).toThrowError(/墙高必须为正数/)
    expect(() => wallVertexShade(new Float32Array(8), 3)).toThrowError(/3 的整数倍/)
  })
})

describe('地板轮廓与楼板', () => {
  /** 由点列构造闭合直线轮廓（末点回到首点） */
  function lineOutline(points: Array<{ x: number; y: number }>): SlabOutline {
    let outline: SlabOutline = { segments: [] }
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]
      const end = points[(index + 1) % points.length]
      outline = appendOutlineSegment(outline, createLineSegment(start, end))
    }
    return outline
  }

  /** 4m × 6m 的矩形轮廓 */
  function rectangle(): SlabOutline {
    return lineOutline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 6 },
      { x: 0, y: 6 },
    ])
  }

  it('直线矩形轮廓闭合、扁平后与段数一致', () => {
    const outline = rectangle()
    expect(outline.segments).toHaveLength(4)
    expect(isOutlineClosed(outline)).toBe(true)
    expect(validateOutline(outline)).toEqual({ valid: true, message: '', conflictSegments: [] })
    const flat = flattenOutline(outline)
    expect(flat.points).toHaveLength(4)
    expect(flat.segmentStarts).toEqual([0, 1, 2, 3])
    expect(outlineLength(outline)).toBeCloseTo(32, 6)
  })

  it('三点定弧推导圆心、半径与扫掠方向', () => {
    const arc = arcParameters({ x: 10, y: 0 }, { x: 13, y: 3 }, { x: 10, y: 6 })
    expect(arc.radius).toBeCloseTo(3, 9)
    expect(arc.center.x).toBeCloseTo(10, 9)
    expect(arc.center.y).toBeCloseTo(3, 9)
    expect(arc.sweep).toBeCloseTo(Math.PI, 9)
    // 反向取弧上点：圆心不变，扫掠方向翻转
    const mirror = arcParameters({ x: 10, y: 0 }, { x: 7, y: 3 }, { x: 10, y: 6 })
    expect(mirror.center.x).toBeCloseTo(10, 9)
    expect(mirror.sweep).toBeCloseTo(-Math.PI, 9)
  })

  it('带圆弧凹口的轮廓按 2mm 弦高扁平，弧边点数显著多于直线段', () => {
    let outline = appendOutlineSegment({ segments: [] }, createLineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }))
    outline = appendOutlineSegment(outline, createArcSegment({ x: 10, y: 0 }, { x: 13, y: 3 }, { x: 10, y: 6 }))
    outline = appendOutlineSegment(outline, createLineSegment({ x: 10, y: 6 }, { x: 0, y: 6 }))
    outline = appendOutlineSegment(outline, createLineSegment({ x: 0, y: 6 }, { x: 0, y: 0 }))

    expect(validateOutline(outline).valid).toBe(true)
    const flat = flattenOutline(outline)
    // 半径 3m、半圆的弦高 2mm 需要 40+ 段
    expect(flat.points.length).toBeGreaterThan(40)
    const arcPoints = flat.segmentStarts[2] - flat.segmentStarts[1]
    expect(arcPoints).toBeGreaterThan(30)
    const maxX = Math.max(...flat.points.map((point) => point.x))
    expect(maxX).toBeCloseTo(13, 6)
  })

  it('纯圆弧轮廓（四段四分之一圆弧）同样可校验与扁平', () => {
    const radius = 5
    const corners = [
      { x: radius, y: 0 },
      { x: 0, y: radius },
      { x: -radius, y: 0 },
      { x: 0, y: -radius },
    ]
    const through = [
      { x: radius * Math.SQRT1_2, y: radius * Math.SQRT1_2 },
      { x: -radius * Math.SQRT1_2, y: radius * Math.SQRT1_2 },
      { x: -radius * Math.SQRT1_2, y: -radius * Math.SQRT1_2 },
      { x: radius * Math.SQRT1_2, y: -radius * Math.SQRT1_2 },
    ]
    let outline: SlabOutline = { segments: [] }
    for (let index = 0; index < 4; index += 1) {
      outline = appendOutlineSegment(
        outline,
        createArcSegment(corners[index], through[index], corners[(index + 1) % 4]),
      )
    }
    expect(validateOutline(outline).valid).toBe(true)
    const flat = flattenOutline(outline)
    for (const point of flat.points) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(radius, 6)
    }
    expect(outlineLength(outline)).toBeCloseTo(Math.PI * 2 * radius, 4)
  })

  it('三点共线、端点重合与弧上点重合的圆弧段直接抛错', () => {
    expect(() => createArcSegment({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toThrowError(/共线/)
    expect(() => createArcSegment({ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 0, y: 0 })).toThrowError(/重合/)
    expect(() => createArcSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toThrowError(/重合/)
    // 相邻段不连续也不接受
    const outline = appendOutlineSegment({ segments: [] }, createLineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }))
    expect(() => appendOutlineSegment(outline, createLineSegment({ x: 20, y: 0 }, { x: 20, y: 6 }))).toThrowError(
      /接在上一段终点/,
    )
  })

  it('段数不足、未闭合、零长度段与重复点都被拒绝', () => {
    const two = lineOutline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    const short = validateOutline(two)
    expect(short.valid).toBe(false)
    expect(short.message).toMatch(/至少需要 3 条段/)

    const open = rectangle()
    const openOutline: SlabOutline = { segments: open.segments.slice(0, 2) }
    expect(isOutlineClosed(openOutline)).toBe(false)

    // 零长度段：同一段起点终点重合
    const duplicated: SlabOutline = {
      segments: [
        createLineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }),
        { kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 0 } },
        createLineSegment({ x: 10, y: 0 }, { x: 10, y: 6 }),
        createLineSegment({ x: 10, y: 6 }, { x: 0, y: 0 }),
      ],
    }
    expect(validateOutline(duplicated).message).toMatch(/长度不足 1mm/)
  })

  it('自交轮廓返回冲突段下标且不生成楼板', () => {
    const bowtie = lineOutline([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ])
    const result = validateOutline(bowtie)
    expect(result.valid).toBe(false)
    expect(result.message).toMatch(/自相交/)
    expect(result.conflictSegments.length).toBe(2)
    expect(() => buildSlabGeometry(bowtie, 0.2)).toThrowError(/自相交/)
  })

  it('直线与圆弧相交同样判定为自交', () => {
    // 底边被一段上凸圆弧穿过两次
    let outline = appendOutlineSegment({ segments: [] }, createLineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }))
    outline = appendOutlineSegment(outline, createLineSegment({ x: 10, y: 0 }, { x: 10, y: -5 }))
    outline = appendOutlineSegment(outline, createArcSegment({ x: 10, y: -5 }, { x: 5, y: 2 }, { x: 0, y: -5 }))
    outline = appendOutlineSegment(outline, createLineSegment({ x: 0, y: -5 }, { x: 0, y: 0 }))
    expect(validateOutline(outline).valid).toBe(false)
    expect(validateOutline(outline).message).toMatch(/自相交/)
  })

  it('撤销只移除最后一段，闭合判定随之失效', () => {
    const outline = rectangle()
    const trimmed = removeLastOutlineSegment(outline)
    expect(trimmed.segments).toHaveLength(3)
    expect(isOutlineClosed(trimmed)).toBe(false)
    expect(removeLastOutlineSegment({ segments: [] }).segments).toEqual([])
  })

  it('楼板顶面法线朝上、底面朝下，板顶在 y = 0、板厚向下', () => {
    const geometry = buildSlabGeometry(rectangle(), 0.2)
    expect(geometry.topY).toBe(0)
    expect(geometry.bottomY).toBeCloseTo(-0.2, 9)
    expect(geometry.bounds.minX).toBeCloseTo(0, 6)
    expect(geometry.bounds.maxX).toBeCloseTo(10, 6)
    expect(geometry.bounds.minY).toBeCloseTo(0, 6)
    expect(geometry.bounds.maxY).toBeCloseTo(6, 6)
    // 端盖与侧壁两个材质分组
    expect(geometry.groups).toHaveLength(2)
    expect(geometry.groups.map((group) => group.materialIndex)).toEqual([0, 1])

    let topNormalY = -Infinity
    let bottomNormalY = Infinity
    for (let index = 0; index < geometry.vertexCount; index += 1) {
      const height = geometry.positions[index * 3 + 1]
      const normalY = geometry.normals[index * 3 + 1]
      // 侧壁顶点同样落在 y = 0 / y = −板厚，只比较竖直方向的法线
      if (Math.abs(height) < 1e-6) {
        if (normalY > topNormalY) topNormalY = normalY
        // 顶面不允许朝下的法线
        expect(normalY).toBeGreaterThan(-0.5)
      } else if (Math.abs(height + 0.2) < 1e-6) {
        if (normalY < bottomNormalY) bottomNormalY = normalY
        // 底面不允许朝上的法线
        expect(normalY).toBeLessThan(0.5)
      }
    }
    expect(topNormalY).toBeCloseTo(1, 6)
    expect(bottomNormalY).toBeCloseTo(-1, 6)
  })

  it('顺时针与逆时针轮廓得到相同的楼板范围', () => {
    const ccw = rectangle()
    const cw = lineOutline([
      { x: 0, y: 0 },
      { x: 0, y: 6 },
      { x: 10, y: 6 },
      { x: 10, y: 0 },
    ])
    expect(validateOutline(cw).valid).toBe(true)
    const a = buildSlabGeometry(ccw, 0.15)
    const b = buildSlabGeometry(cw, 0.15)
    expect(b.bounds).toEqual(a.bounds)
    expect(b.vertexCount).toBe(a.vertexCount)
    // 两种绕序的顶面都朝上
    let foundTop = false
    for (let index = 0; index < b.vertexCount; index += 1) {
      if (Math.abs(b.positions[index * 3 + 1]) > 1e-6) continue
      const normalY = b.normals[index * 3 + 1]
      expect(normalY).toBeGreaterThan(-0.5)
      if (normalY > 0.9) foundTop = true
    }
    expect(foundTop).toBe(true)
  })

  it('楼板内环：形状带洞，包围盒仍取外环，顶点多于实心板', () => {
    const hole = lineOutline([
      { x: 3, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 4 },
      { x: 3, y: 4 },
    ])
    const outline = appendOutlineHole(rectangle(), hole)
    expect(outline.holes).toHaveLength(1)
    expect(validateOutline(outline)).toEqual({ valid: true, message: '', conflictSegments: [] })

    // 扁平化返回外环 + 内环两份点列
    const rings = flattenOutlineRings(outline)
    expect(rings).toHaveLength(2)
    expect(rings[0].points).toHaveLength(4)
    expect(rings[1].points).toHaveLength(4)
    // 内环边长计入总长度
    expect(outlineLength(outline)).toBeCloseTo(32 + 12, 6)

    const hollow = buildSlabGeometry(outline, 0.2)
    const solid = buildSlabGeometry(rectangle(), 0.2)
    expect(hollow.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 6 })
    // 洞口会生成额外的洞壁三角面
    expect(hollow.vertexCount).toBeGreaterThan(solid.vertexCount)
    expect(hollow.topY).toBe(0)
    expect(hollow.bottomY).toBeCloseTo(-0.2, 9)
  })

  it('内环越界或内环互交时校验失败，clearOutlineHoles 清空内环', () => {
    const outside = lineOutline([
      { x: 12, y: 2 },
      { x: 16, y: 2 },
      { x: 16, y: 4 },
      { x: 12, y: 4 },
    ])
    expect(validateOutline(appendOutlineHole(rectangle(), outside)).message).toMatch(/必须完全位于外轮廓之内/)

    const big = lineOutline([
      { x: 2, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 3 },
      { x: 2, y: 3 },
    ])
    const nested = lineOutline([
      { x: 3, y: 1.5 },
      { x: 5, y: 1.5 },
      { x: 5, y: 2.5 },
      { x: 3, y: 2.5 },
    ])
    const two = appendOutlineHole(appendOutlineHole(rectangle(), big), nested)
    expect(validateOutline(two).message).toMatch(/相交或嵌套/)

    const cleared = clearOutlineHoles(two)
    expect(cleared.holes).toBeUndefined()
    expect(validateOutline(cleared).valid).toBe(true)
  })

  it('板厚非正或轮廓非法时直接抛错', () => {
    expect(() => buildSlabGeometry(rectangle(), 0)).toThrowError(/板厚必须为正数/)
    expect(() => buildSlabGeometry(rectangle(), -0.1)).toThrowError(/板厚必须为正数/)
    const two = lineOutline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    expect(() => buildSlabGeometry(two, 0.2)).toThrowError(/至少需要 3 条段/)
  })
})

describe('门窗识别与墙体开洞', () => {
  /** 图纸：4m × 3m 房间墙环 + 一个 0.9m 门（块名 M0921） */
  function doorDrawing(): CadDrawing {
    const entities: CadEntity[] = [
      {
        id: 'wall',
        type: 'LWPOLYLINE',
        layer: 'WALL',
        color: 0xffffff,
        primitives: [
          {
            kind: 'polyline',
            closed: true,
            points: [
              { x: 0, y: 0 },
              { x: 4000, y: 0 },
              { x: 4000, y: 3000 },
              { x: 0, y: 3000 },
            ],
          },
        ],
      },
      {
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockName: 'M0921',
        blockInstance: 1,
        primitives: [
          {
            kind: 'polyline',
            closed: false,
            points: [
              { x: 1500, y: 0 },
              { x: 2400, y: 0 },
            ],
          },
        ],
      },
    ]
    return makeDrawing(entities, 0.001)
  }

  /** 4m × 3m 房间的四段墙（米） */
  function roomWalls(): WallSegment[] {
    const thickness = 0.2
    return [
      { a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, layer: 'W', thickness, key: 'south' },
      { a: { x: 4, y: 0 }, b: { x: 4, y: 3 }, layer: 'W', thickness, key: 'east' },
      { a: { x: 4, y: 3 }, b: { x: 0, y: 3 }, layer: 'W', thickness, key: 'north' },
      { a: { x: 0, y: 3 }, b: { x: 0, y: 0 }, layer: 'W', thickness, key: 'west' },
    ]
  }

  it('块名模数换算成常规宽高，非法块名返回 null', () => {
    expect(parseModularSize('M0921')).toEqual({ width: 0.9, height: 2.1 })
    expect(parseModularSize('C1515')).toEqual({ width: 1.5, height: 1.5 })
    expect(parseModularSize('M-1021')).toEqual({ width: 1, height: 2.1 })
    expect(parseModularSize('DOOR')).toBeNull()
    expect(parseModularSize('M0001')).toBeNull()
    expect(parseModularSize(undefined)).toBeNull()
  })

  it('图层名关键词优先判定门窗类型', () => {
    const layer = (name: string) => ({
      name,
      color: 0xffffff,
      colorSource: 'palette' as const,
      entityCount: 1,
      off: false,
      frozen: false,
    })
    const drawing: CadDrawing = {
      ...makeDrawing([], 0.001),
      layers: [layer('A-DOOR'), layer('A-WINDOW'), layer('墙体')],
    }
    expect(recommendOpeningKinds(drawing)).toEqual({ 'A-DOOR': 'door', 'A-WINDOW': 'window' })
  })

  it('块名给出尺寸，门吸附到最近墙段并落在墙中心线上', () => {
    const drawing = doorDrawing()
    const walls = collectWallSegments(drawing, ['WALL'], () => 0.2)
    const result = recognizeOpenings(drawing, {
      layerKinds: { DOOR: 'door' },
      walls,
      unitScale: drawing.unitScale,
      wallHeight: 3,
    })
    expect(result.skipped).toHaveLength(0)
    expect(result.openings).toHaveLength(1)
    const opening = result.openings[0]
    expect(opening.kind).toBe('door')
    // 宽度取块名模数 0.9m，而不是块内图元跨度 0.9m 的近似值
    expect(opening.width).toBeCloseTo(0.9, 6)
    expect(opening.height).toBeCloseTo(2.1, 6)
    expect(opening.sill).toBe(0)
    // 吸附到南墙中心线 y = 0，中心落在图中 1.95m 处
    expect(opening.center.y).toBeCloseTo(0, 6)
    expect(opening.center.x).toBeCloseTo(1.95, 6)
    expect(walls.map((wall) => wall.key)).toContain(opening.wallKey)
  })

  it('无模数块名时按常规窗尺寸与窗台高生成', () => {
    const drawing = doorDrawing()
    const windowEntity: CadEntity = {
      id: 'win',
      type: 'LWPOLYLINE',
      layer: 'WINDOW',
      color: 0xffffff,
      blockName: 'C-MARK',
      blockInstance: 2,
      primitives: [
        {
          kind: 'polyline',
          closed: false,
          points: [
            { x: 1000, y: 0 },
            { x: 2400, y: 0 },
          ],
        },
      ],
    }
    const parsed: CadDrawing = {
      ...drawing,
      entities: [...drawing.entities, windowEntity],
    }
    const walls = collectWallSegments(parsed, ['WALL'], () => 0.2)
    const result = recognizeOpenings(parsed, {
      layerKinds: { WINDOW: 'window' },
      walls,
      unitScale: parsed.unitScale,
      wallHeight: 3,
    })
    expect(result.openings).toHaveLength(1)
    const opening = result.openings[0]
    // 实测 1.4m 归整到常规窗宽 1.5m
    expect(opening.width).toBeCloseTo(1.5, 6)
    expect(opening.height).toBeCloseTo(1.5, 6)
    expect(opening.sill).toBeCloseTo(0.9, 6)
  })

  it('墙段长度不足或洞口超出墙高时计入跳过清单', () => {
    const drawing = doorDrawing()
    const walls = collectWallSegments(drawing, ['WALL'], () => 0.2)
    const result = recognizeOpenings(drawing, {
      layerKinds: { DOOR: 'door' },
      walls,
      unitScale: drawing.unitScale,
      // 墙高 1.5m 装不下 2.1m 的门
      wallHeight: 1.5,
    })
    expect(result.openings).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toMatch(/超过墙高/)
  })

  it('没有实体墙时给出可排查的提示', () => {
    const drawing = doorDrawing()
    const result = recognizeOpenings(drawing, {
      layerKinds: { DOOR: 'door' },
      walls: [],
      unitScale: drawing.unitScale,
      wallHeight: 3,
    })
    expect(result.openings).toHaveLength(0)
    // 门图层参与识别但缺实体墙时不能静默返回，否则界面只会显示「门 0 个」
    expect(result.notes[0]).toMatch(/实体墙/)
  })

  it('门洞真正贯通墙厚：洞口内部没有任何面片', () => {
    const walls = roomWalls()
    const opening: WallOpening = {
      wallKey: 'south',
      kind: 'door',
      start: { x: 1.55, y: 0 },
      end: { x: 2.45, y: 0 },
      sill: 0,
      height: 2.1,
    }
    const result = buildWallGeometry(walls, { height: 3, miterLimit: 4 }, 1, [opening])
    expect(result.skippedOpeningCount).toBe(0)
    expect(result.openings).toHaveLength(1)
    expect(result.openings[0].width).toBeCloseTo(0.9, 6)
    expect(result.openings[0].thickness).toBeCloseTo(0.2, 6)
    // 门窗构件必须落在墙中心线上：南墙中心线为 y = 0，
    // 若偏到墙带边界（y = ±0.1）会让门扇与墙面共面、门套一半埋进墙体
    expect(result.openings[0].center.y).toBeCloseTo(0, 6)
    expect(result.openings[0].center.x).toBeCloseTo(2, 6)
    // 构件整体也要与洞口同心：模型 z 轴即图纸 y，包围盒中心必须落在中心线上
    const doorGeometry = buildOpeningGeometry(result.openings)!
    doorGeometry.computeBoundingBox()
    const doorBox = doorGeometry.boundingBox!
    expect((doorBox.min.z + doorBox.max.z) / 2).toBeCloseTo(0, 6)

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(result.positions), 3))
    geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    mesh.updateMatrixWorld(true)

    const cast = (origin: THREE.Vector3, direction: THREE.Vector3): number => {
      const raycaster = new THREE.Raycaster(origin, direction, 0, 0.3)
      return raycaster.intersectObject(mesh).length
    }

    // 洞口中心沿 ±墙法线方向都没有面片，说明是真的空洞
    expect(cast(new THREE.Vector3(2, 1, 0), new THREE.Vector3(0, 0, 1))).toBe(0)
    expect(cast(new THREE.Vector3(2, 1, 0), new THREE.Vector3(0, 0, -1))).toBe(0)
    // 洞口以外的实心墙必须仍然有面片
    expect(cast(new THREE.Vector3(0.5, 1, 0), new THREE.Vector3(0, 0, 1))).toBeGreaterThan(0)
    // 洞口上方的过梁同样保留
    expect(cast(new THREE.Vector3(2, 2.5, 0), new THREE.Vector3(0, 0, 1))).toBeGreaterThan(0)
  })

  it('同一条边上的重叠洞口只保留第一个', () => {
    const walls = roomWalls()
    const first: WallOpening = {
      wallKey: 'south',
      kind: 'door',
      start: { x: 1.55, y: 0 },
      end: { x: 2.45, y: 0 },
      sill: 0,
      height: 2.1,
    }
    const second: WallOpening = {
      wallKey: 'south',
      kind: 'window',
      start: { x: 2, y: 0 },
      end: { x: 3, y: 0 },
      sill: 0.9,
      height: 1.5,
    }
    const result = buildWallGeometry(walls, { height: 3, miterLimit: 4 }, 1, [first, second])
    expect(result.openings).toHaveLength(1)
    expect(result.skippedOpeningCount).toBe(1)
  })

  it('门窗构件按洞口尺寸生成框料与门扇 / 玻璃分组', () => {
    const door = {
      wallKey: 'south',
      kind: 'door' as const,
      center: { x: 2, y: 0 },
      direction: { x: 1, y: 0 },
      width: 0.9,
      height: 2.1,
      sill: 0,
      thickness: 0.2,
    }
    const doorGeometry = buildOpeningGeometry([door])
    expect(doorGeometry).not.toBeNull()
    // 普通木门：门套 / 门扇 / 五金三组，没有玻璃
    expect(doorGeometry!.groups.map((group) => group.materialIndex)).toEqual([0, 1, 3])
    doorGeometry!.computeBoundingBox()
    const doorBox = doorGeometry!.boundingBox!
    // 贴脸压住洞口边缘：每侧向洞口内压 3mm、向外挑 3mm，因此净宽 = 0.9 + 2 * (0.05 - 0.003)
    expect(doorBox.max.y - doorBox.min.y).toBeCloseTo(2.147, 6)
    expect(doorBox.max.x - doorBox.min.x).toBeCloseTo(0.994, 6)
    // 门套整体退进洞口 2mm，凸出墙面的只剩贴脸：墙面半厚 0.1 + 贴脸外露 0.008。
    // 这个值必须小于「墙厚一半 + 贴脸厚度」，一旦门套重新外凸就会变大
    expect(doorBox.max.z - doorBox.min.z).toBeCloseTo(0.216, 6)

    const windowGeometry = buildOpeningGeometry([{ ...door, kind: 'window', sill: 0.9, height: 1.5 }])
    expect(windowGeometry).not.toBeNull()
    // 窗只有框料与玻璃两个材质组
    expect(windowGeometry!.groups.map((group) => group.materialIndex)).toEqual([0, 2])
    windowGeometry!.computeBoundingBox()
    // 窗台板顶面比洞口底低 3mm（避免与洞口底面共面），向下外挑 30mm
    expect(windowGeometry!.boundingBox!.min.y).toBeCloseTo(0.867, 6)
    expect(buildOpeningGeometry([])).toBeNull()
  })

  it('门型预设决定门扇数量、玻璃与五金做法', () => {
    const base = {
      wallKey: 'south',
      kind: 'door' as const,
      center: { x: 2, y: 0 },
      direction: { x: 1, y: 0 },
      width: 0.9,
      height: 2.1,
      sill: 0,
      thickness: 0.2,
    }
    const single = resolveDoorConfig(base)
    expect(single.preset).toBe('wood_single')
    expect(single.leaf.kind).toBe('single')
    expect(single.glazing.mode).toBe('none')
    // 门扇净宽 = 洞口 - 两道门套 - 两道安装缝
    expect(single.leafWidth).toBeCloseTo(0.9 - 0.12 - 0.012, 6)

    const wide = resolveDoorConfig({ ...base, width: 1.8 })
    expect(wide.preset).toBe('wood_double')
    expect(wide.leaf.kind).toBe('double')

    const glass = resolveDoorConfig({ ...base, preset: 'glass_single' })
    expect(glass.glazing.mode).toBe('full')
    expect(glass.hardware.handle).toBe('pull')
    const glassGeometry = buildOpeningGeometry([{ ...base, preset: 'glass_single' }])
    expect(glassGeometry!.groups.map((group) => group.materialIndex)).toEqual([0, 1, 2, 3])

    const fire = resolveDoorConfig({ ...base, preset: 'steel_fire' })
    expect(fire.hardware.closer).toBe(true)
    expect(fire.hardware.kickPlate).toBe(true)
    expect(fire.frame.kind).toBe('steel')
  })

  it('窗型配置按尺寸分格，推拉窗与固定窗不带开启扇', () => {
    const base = {
      wallKey: 'south',
      kind: 'window' as const,
      center: { x: 2, y: 0 },
      direction: { x: 1, y: 0 },
      width: 2.4,
      height: 1.8,
      sill: 0.9,
      thickness: 0.2,
    }
    const casement = resolveWindowConfig(base)
    expect(casement.preset).toBe('casement_double')
    expect(casement.columns).toBe(2)
    expect(casement.rows).toBe(1)
    expect(casement.operable).toBe(true)
    expect(casement.sillBoardDepth).toBeGreaterThan(0)

    const fixed = resolveWindowConfig({ ...base, preset: 'fixed' })
    expect(fixed.operable).toBe(false)

    const sliding = resolveWindowConfig({ ...base, preset: 'sliding' })
    expect(sliding.preset).toBe('sliding')
    expect(sliding.frame.width).toBeCloseTo(0.05, 6)
  })
})

describe('图层角色解析', () => {
  it('未勾选墙体的门图层仍然参与洞口识别', () => {
    const roles = resolveLayerRoles({
      wallLayers: ['A-WALL'],
      openingKinds: { 'A-DOOR': 'door', 'A-WALL': 'window' },
    })
    // 门图层没有墙厚、不会勾选成墙体图层，但必须保留「门」角色，否则不会生成门模型
    expect(roles['A-DOOR']).toBe('door')
    // 勾选的墙体图层标「窗」仍按嵌墙窗处理，不受影响
    expect(roles['A-WALL']).toBe('window')
  })

  it('门图层即使勾选了墙体也只保留一份「门」角色', () => {
    const roles = resolveLayerRoles({
      wallLayers: ['A-DOOR'],
      openingKinds: { 'A-DOOR': 'door' },
    })
    expect(roles).toEqual({ 'A-DOOR': 'door' })
  })

  it('未勾选墙体的窗 / 幕墙 / 忽略图层不补进角色表', () => {
    const roles = resolveLayerRoles({
      wallLayers: ['A-WALL'],
      openingKinds: { 'A-WALL': 'wall', 'A-WINDOW': 'window', 'A-GLASS': 'curtain' },
    })
    // 「墙体」与「忽略」都按白膜墙生成
    expect(roles['A-WALL']).toBe('massing')
    // 白膜 / 幕墙 / 嵌墙窗的几何只由勾选的墙体图层产出，非墙图层不能补成墙
    expect(roles['A-WINDOW']).toBeUndefined()
    expect(roles['A-GLASS']).toBeUndefined()
  })

  it('未设置类型的勾选墙体图层按白膜墙生成', () => {
    const roles = resolveLayerRoles({ wallLayers: ['A-WALL'], openingKinds: {} })
    expect(roles).toEqual({ 'A-WALL': 'massing' })
  })
})

describe('双线墙实测墙厚', () => {
  /** 图纸单位为 mm，墙线均落在同一图层 */
  function wallLine(a: CadPoint, b: CadPoint): WallSegment {
    return { a, b, layer: 'A-土建墙', thickness: 0.2, key: `${a.x},${a.y}|${b.x},${b.y}` }
  }

  /** 4m × 4m 房间：外墙线 0、内墙线 200mm，双线间距即 200 墙厚 */
  function doubleLineRoom(): WallSegment[] {
    return [
      // 外圈
      wallLine({ x: 0, y: 0 }, { x: 4000, y: 0 }),
      wallLine({ x: 4000, y: 0 }, { x: 4000, y: 4000 }),
      wallLine({ x: 4000, y: 4000 }, { x: 0, y: 4000 }),
      wallLine({ x: 0, y: 4000 }, { x: 0, y: 0 }),
      // 内圈
      wallLine({ x: 200, y: 200 }, { x: 3800, y: 200 }),
      wallLine({ x: 3800, y: 200 }, { x: 3800, y: 3800 }),
      wallLine({ x: 3800, y: 3800 }, { x: 200, y: 3800 }),
      wallLine({ x: 200, y: 3800 }, { x: 200, y: 200 }),
    ]
  }

  it('平行等距的双线合成一条中线，墙厚取实测间距', () => {
    const result = pairDoubleLineWalls(doubleLineRoom(), 0.001)
    expect(result.pairedCount).toBe(4)
    expect(result.unpairedCount).toBe(0)
    expect(result.measuredThickness).toEqual([0.2])
    expect(result.segments).toHaveLength(4)
    for (const segment of result.segments) {
      expect(segment.layer).toBe('A-土建墙')
      expect(segment.thickness).toBeCloseTo(0.2, 6)
      expect(segment.key.startsWith('A-土建墙|pair:')).toBe(true)
      // 中线长度 = 外圈 4m 减去两侧各 0.1m
      expect(Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)).toBeCloseTo(3800, 6)
    }
    // 南墙中线落在 y = 100mm（图纸单位），即两道墙线的正中间
    const south = result.segments.find((segment) => Math.abs(segment.a.y - 100) < 1e-6 && Math.abs(segment.b.y - 100) < 1e-6)
    expect(south).toBeDefined()
    expect(Math.min(south!.a.x, south!.b.x)).toBeCloseTo(100, 6)
    expect(Math.max(south!.a.x, south!.b.x)).toBeCloseTo(3900, 6)
  })

  it('找不到平行搭档的单线沿用图层墙厚并计数', () => {
    const single = wallLine({ x: 0, y: 0 }, { x: 3000, y: 0 })
    const result = pairDoubleLineWalls([single], 0.001)
    expect(result.pairedCount).toBe(0)
    expect(result.unpairedCount).toBe(1)
    expect(result.measuredThickness).toEqual([])
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].thickness).toBeCloseTo(0.2, 6)
    expect(result.segments[0].key).toBe(single.key)
  })

  it('不同图层的平行线不配对', () => {
    const first = wallLine({ x: 0, y: 0 }, { x: 3000, y: 0 })
    const second: WallSegment = { ...wallLine({ x: 0, y: 200 }, { x: 3000, y: 200 }), layer: 'A-新隔墙' }
    const result = pairDoubleLineWalls([first, second], 0.001)
    expect(result.pairedCount).toBe(0)
    expect(result.unpairedCount).toBe(2)
  })
})

describe('门连窗合并与建模', () => {
  /** 构造一樘门 / 一樘窗的洞口 */
  function opening(
    kind: 'door' | 'window',
    centerX: number,
    width: number,
    height: number,
    sill: number,
  ): OpeningSpec {
    return {
      kind,
      wallKey: 'south',
      center: { x: centerX, y: 0 },
      direction: { x: 1, y: 0 },
      width,
      height,
      sill,
      start: { x: centerX - width / 2, y: 0 },
      end: { x: centerX + width / 2, y: 0 },
      preset: kind === 'door' ? 'wood_single' : 'fixed',
    }
  }

  it('窗在门正上方时合并成带上亮的门，门扇高度不变', () => {
    const door = opening('door', 2, 0.9, 2.1, 0)
    const window = opening('window', 2, 0.9, 0.6, 2.1)
    const result = mergeDoorWindowOpenings([door, window], 3)
    expect(result.merged).toBe(1)
    expect(result.openings).toHaveLength(1)
    const merged = result.openings[0]
    expect(merged.height).toBeCloseTo(2.7, 6)
    expect(merged.width).toBeCloseTo(0.9, 6)
    expect(merged.windowPart).toBeUndefined()
    expect(merged.transom).toEqual({ sill: 2.1, height: 0.6 })

    const placement = { ...merged, thickness: 0.2 }
    const config = resolveDoorConfig(placement)
    // 亮子高度 = 洞口高 - 两道门套 - 窗底标高
    expect(config.transomHeight).toBeCloseTo(2.7 - 0.12 - 2.1, 6)
    expect(config.doorSpan.start).toBeCloseTo(-0.45, 6)
    expect(config.doorSpan.end).toBeCloseTo(0.45, 6)
    const geometry = buildOpeningGeometry([placement])!
    geometry.computeBoundingBox()
    // 洞口顶 2.7m，上贴脸再向洞口内压 3mm 后向上外挑一整块板宽
    expect(geometry.boundingBox!.max.y).toBeCloseTo(2.7 + 0.05 - 0.003, 6)
    expect(geometry.groups.map((group) => group.materialIndex)).toEqual([0, 1, 2, 3])
  })

  it('窗在门侧边且高度重叠时合并成带侧窗的门，门扇只占一侧', () => {
    const door = opening('door', 2, 0.9, 2.1, 0)
    // 窗宽 0.6m 紧贴门右侧（门右边界 2.45，窗 2.45~3.05）
    const window = opening('window', 2.75, 0.6, 1.5, 0.9)
    const result = mergeDoorWindowOpenings([door, window], 3)
    expect(result.merged).toBe(1)
    const merged = result.openings[0]
    // 并集洞口宽 1.5m，顶抬到窗顶 2.4m，中心右移到 2.3m
    expect(merged.width).toBeCloseTo(1.5, 6)
    expect(merged.height).toBeCloseTo(2.4, 6)
    expect(merged.center.x).toBeCloseTo(2.3, 6)
    expect(merged.windowPart!.start).toBeCloseTo(0.15, 6)
    expect(merged.windowPart!.end).toBeCloseTo(0.75, 6)
    expect(merged.windowPart!.sill).toBeCloseTo(0.9, 6)
    expect(merged.windowPart!.height).toBeCloseTo(1.5, 6)
    // 窗顶高于门顶：门上方补 0.3m 亮窗，门扇不会被拉高
    expect(merged.transom!.sill).toBeCloseTo(2.1, 6)
    expect(merged.transom!.height).toBeCloseTo(0.3, 6)

    const placement = { ...merged, thickness: 0.2 }
    const config = resolveDoorConfig(placement)
    // 门扇占左侧 0.9m，另一侧 0.6m 留给固定窗
    expect(config.doorSpan.start).toBeCloseTo(-0.75, 6)
    expect(config.doorSpan.end).toBeCloseTo(0.15, 6)
    expect(config.leafWidth).toBeCloseTo(0.9 - 0.12 - 0.012, 6)
    expect(config.windowPart).toEqual(merged.windowPart)

    const geometry = buildOpeningGeometry([placement])!
    expect(geometry.groups.map((group) => group.materialIndex)).toEqual([0, 1, 2, 3])
    geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    // 洞口外轮廓仍由门套与贴脸收口：宽 1.5 + 2 × (0.05 - 0.003)
    expect(box.max.x - box.min.x).toBeCloseTo(1.5 + 2 * (0.05 - 0.003), 6)
    expect(box.max.y).toBeCloseTo(2.4 + 0.05 - 0.003, 6)
    // 贴脸只向墙面外挑 8mm，门套不外凸
    expect(box.max.z - box.min.z).toBeCloseTo(0.216, 6)
  })

  it('门窗相距过远时不合并，各自独立开洞', () => {
    const door = opening('door', 2, 0.9, 2.1, 0)
    const window = opening('window', 3.2, 0.6, 1.5, 0.9)
    const result = mergeDoorWindowOpenings([door, window], 3)
    expect(result.merged).toBe(0)
    expect(result.openings).toHaveLength(2)
    expect(result.openings.every((item) => item.windowPart === undefined)).toBe(true)
  })
})

describe('图层名墙厚标注与宽松取墙线', () => {
  /** 一条折线实体（图纸坐标） */
  function lineEntity(id: string, layer: string, points: CadPoint[], closed = false): CadEntity {
    return {
      id,
      type: 'LWPOLYLINE',
      layer,
      color: 0xffffff,
      primitives: [{ kind: 'polyline', points, closed }],
    }
  }

  it('从图层名解析 100 / 200 / 240 等毫米标注', () => {
    expect(resolveLayerThicknessFromName('A-WALL-200')).toBeCloseTo(0.2, 9)
    expect(resolveLayerThicknessFromName('墙-240')).toBeCloseTo(0.24, 9)
    expect(resolveLayerThicknessFromName('WALL_100_1F')).toBeCloseTo(0.1, 9)
    // 米制小数同样接受
    expect(resolveLayerThicknessFromName('WALL_0.12')).toBeCloseTo(0.12, 9)
    // 楼层号 / 图号 / 年份不是墙厚
    expect(resolveLayerThicknessFromName('A-WALL-1F')).toBeNull()
    expect(resolveLayerThicknessFromName('A-2006-墙体')).toBeNull()
    expect(resolveLayerThicknessFromName('WINDOW')).toBeNull()
  })

  it('未标注厚度的图层收集为 0，等待双线实测回填', () => {
    const drawing = makeDrawing([
      lineEntity('1', 'A-WALL-200', [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 3000 },
      ]),
      lineEntity('2', 'A-WALL', [
        { x: 0, y: 5000 },
        { x: 4000, y: 5000 },
      ]),
    ])
    const segments = collectWallSegmentsLoose(drawing, ['A-WALL-200', 'A-WALL'])
    expect(segments).toHaveLength(3)
    expect(segments.filter((segment) => segment.layer === 'A-WALL-200')).toHaveLength(2)
    for (const segment of segments.filter((item) => item.layer === 'A-WALL-200')) {
      expect(segment.thickness).toBeCloseTo(0.2, 9)
    }
    const unresolved = segments.find((segment) => segment.layer === 'A-WALL')!
    expect(unresolved.thickness).toBe(0)
  })
})

describe('未标注厚度墙线的墙厚回填', () => {
  /** 造一条米制墙段（unitScale = 1，图纸坐标与米一致） */
  function seg(
    key: string,
    layer: string,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    thickness = 0,
  ): WallSegment {
    return { key, layer, thickness, a: { x: ax, y: ay }, b: { x: bx, y: by } }
  }

  it('同图层已解墙段的厚度沿用给本图层单线', () => {
    const resolved = seg('A|1', 'A-WALL', 0, 0, 3, 0, 0.2)
    const unresolved = seg('A|2', 'A-WALL', 0, 1, 3, 1)
    const result = inferWallThicknesses([resolved, unresolved], [resolved, unresolved], 1)
    expect(result.stats.sameLayer).toBe(1)
    expect(result.segments[1].thickness).toBeCloseTo(0.2, 9)
    expect(result.stats.unresolved).toEqual({})
  })

  it('两侧墙线画在不同图层时按平行墙线实测间距回填', () => {
    const unresolved = seg('A|1', 'A-WALL', 0, 0, 3, 0)
    // 另一侧面在未被选中 / 未标注的图层上，只能靠几何量距
    const other = seg('B|1', 'B-WALL', 0, 0.24, 3, 0.24, 0.24)
    const result = inferWallThicknesses([unresolved], [unresolved, other], 1)
    expect(result.stats.parallel).toBe(1)
    expect(result.segments[0].thickness).toBeCloseTo(0.24, 9)
  })

  it('端部相连的墙肢沿用相邻墙段的厚度', () => {
    const resolved = seg('A|1', 'A-WALL', 0, 0, 0, 3, 0.2)
    const stub = seg('B|1', 'B-WALL', 0, 0, 1.2, 0)
    const result = inferWallThicknesses([resolved, stub], [resolved, stub], 1)
    expect(result.stats.neighbor).toBe(1)
    expect(result.segments[1].thickness).toBeCloseTo(0.2, 9)
  })

  it('量到的间距明显偏离本图墙厚时，不把门扇之类的图元当成厚墙', () => {
    // 本图已知墙厚 0.2（双线实测），另有两条相距 0.9 的平行线：那是门扇 / 索引线，不是墙
    const known = seg('K|1', 'A-WALL', 0, 5, 3, 5, 0.2)
    const unresolved = seg('C|1', 'C-WALL', 0, 0, 3, 0)
    const far = seg('B|1', 'B-WALL', 0, 0.9, 3, 0.9)
    const result = inferWallThicknesses([known, unresolved], [known, unresolved, far], 1)
    expect(result.segments[1].thickness).toBe(0)
    expect(result.stats.parallel).toBe(0)
    expect(result.stats.unresolved).toEqual({ 'C-WALL': 1 })
  })

  it('三种证据都没有时保留 0 并计入未解图层', () => {
    const isolated = seg('A|1', 'A-WALL', 0, 0, 2, 2)
    const result = inferWallThicknesses([isolated], [isolated], 1)
    expect(result.segments[0].thickness).toBe(0)
    expect(result.stats).toEqual({ sameLayer: 0, parallel: 0, neighbor: 0, unresolved: { 'A-WALL': 1 } })
  })
})

describe('墙端吸附', () => {
  /** 造一条米制墙段（unitScale = 1，图纸坐标与米一致） */
  function seg(
    key: string,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    thickness = 0.2,
  ): WallSegment {
    return { key, layer: 'WALL', thickness, a: { x: ax, y: ay }, b: { x: bx, y: by } }
  }

  it('转角处短半个墙厚的中心线延伸到相邻墙线', () => {
    const horizontal = seg('H', 0, 0, 4.9, 0)
    const vertical = seg('V', 5, 0, 5, 5)
    const result = snapWallEndpoints([horizontal, vertical], 1)
    expect(result.snappedCount).toBe(1)
    expect(result.segments[0].b.x).toBeCloseTo(5, 9)
    expect(result.segments[0].b.y).toBeCloseTo(0, 9)
  })

  it('共线缺口属于洞口，不吸附', () => {
    const left = seg('L', 0, 0, 5, 0)
    const right = seg('R', 5.2, 0, 8, 0)
    const result = snapWallEndpoints([left, right], 1)
    expect(result.snappedCount).toBe(0)
    expect(result.segments[1].a.x).toBeCloseTo(5.2, 9)
  })

  it('超出容差的近邻墙不吸附', () => {
    const horizontal = seg('H', 0, 0, 5, 0)
    const vertical = seg('V', 5.6, 0, 5.6, 4)
    const result = snapWallEndpoints([horizontal, vertical], 1)
    expect(result.snappedCount).toBe(0)
    expect(result.segments[0].b.x).toBeCloseTo(5, 9)
  })
})

describe('玻璃幕墙范围判定与建模', () => {
  /** 一条折线实体（图纸坐标） */
  function lineEntity(id: string, layer: string, points: CadPoint[], closed = false): CadEntity {
    return {
      id,
      type: 'LWPOLYLINE',
      layer,
      color: 0xffffff,
      primitives: [{ kind: 'polyline', points, closed }],
    }
  }

  /** 12m × 8m 的闭合成环窗线，总长 40m */
  function facadeLoop(): CadEntity {
    return lineEntity(
      '1',
      '幕墙',
      [
        { x: 0, y: 0 },
        { x: 12000, y: 0 },
        { x: 12000, y: 8000 },
        { x: 0, y: 8000 },
      ],
      true,
    )
  }

  it('选「窗」的图层无论窗线多长多围合，都按嵌墙窗处理并给出提示', () => {
    const drawing = makeDrawing([facadeLoop()])
    const loopLines = [
      { a: { x: 0, y: 0 }, b: { x: 12000, y: 0 } },
      { a: { x: 12000, y: 0 }, b: { x: 12000, y: 8000 } },
      { a: { x: 12000, y: 8000 }, b: { x: 0, y: 8000 } },
      { a: { x: 0, y: 8000 }, b: { x: 0, y: 0 } },
    ]
    const stats = measureLayerSpans(loopLines, 0.001)
    expect(stats.closed).toBe(true)
    expect(stats.totalLength).toBeCloseTo(40, 9)
    expect(isCurtainSpan(stats)).toBe(true)

    const plan = planCurtainWalls(drawing, { 幕墙: 'window' }, 0.001)
    // 选「窗」= 嵌墙窗，几何范围再大也不会自动升级成幕墙
    expect(plan.layers).toEqual([])
    expect(plan.lines).toHaveLength(0)
    expect(plan.notes[0]).toContain('改成「幕墙」')
  })

  it('只有选「幕墙」的图层才整体生成玻璃外立面', () => {
    const drawing = makeDrawing([facadeLoop()])
    const plan = planCurtainWalls(drawing, { 幕墙: 'curtain' }, 0.001)
    expect(plan.layers).toEqual(['幕墙'])
    expect(plan.lines).toHaveLength(4)
    expect(plan.notes[0]).toContain('玻璃幕墙')
  })

  it('短窗线仍走常规嵌墙窗，不生成幕墙', () => {
    // 两樘 1.5m 窗线，总长 3m，远低于幕墙总长阈值
    const drawing = makeDrawing([
      lineEntity('1', '窗', [
        { x: 0, y: 0 },
        { x: 1500, y: 0 },
      ]),
      lineEntity('2', '窗', [
        { x: 0, y: 100 },
        { x: 1500, y: 100 },
      ]),
    ])
    const plan = planCurtainWalls(drawing, { 窗: 'window' }, 0.001)
    expect(plan.layers).toEqual([])
    expect(plan.lines).toHaveLength(0)
  })

  it('显式标记为幕墙的图层不做范围判断', () => {
    const drawing = makeDrawing([
      lineEntity('1', '窗', [
        { x: 0, y: 0 },
        { x: 900, y: 0 },
      ]),
    ])
    const plan = planCurtainWalls(drawing, { 窗: 'curtain' }, 0.001)
    expect(plan.layers).toEqual(['窗'])
  })

  it('幕墙几何包含竖梃与双层玻璃，材质组按框 / 玻璃切分', () => {
    const geometry = buildCurtainWallGeometry(
      [{ a: { x: 0, y: 0 }, b: { x: 10000, y: 0 } }],
      0.001,
      { height: 3 },
    )
    expect(geometry).not.toBeNull()
    expect(geometry!.frames.length).toBeGreaterThan(0)
    expect(geometry!.glass.length).toBeGreaterThan(0)
    // 10m 按 1.2m 等分为 8 个开间：9 根竖梃、16 片玻璃（每格两片）
    expect(geometry!.mullionCount).toBe(9)
    expect(geometry!.paneCount).toBe(16)
    expect(geometry!.totalLength).toBeCloseTo(10, 9)
    expect(geometry!.centerlines).toHaveLength(1)
    // 幕墙顺墙方向铺满 10m，两端各多出半个竖梃
    expect(geometry!.bounds.maxX).toBeCloseTo(10.03, 6)
    expect(geometry!.bounds.minX).toBeCloseTo(-0.03, 6)

    const buffer = createCurtainBufferGeometry(geometry!)
    expect(buffer.groups.map((group) => group.materialIndex)).toEqual([0, 1])
    expect(buffer.getAttribute('position').count).toBe(
      (geometry!.frames.length + geometry!.glass.length) / 3,
    )
  })

  it('幕墙高度非法时直接报错，不做兜底', () => {
    expect(() =>
      buildCurtainWallGeometry([{ a: { x: 0, y: 0 }, b: { x: 10000, y: 0 } }], 0.001, {
        height: 0,
      }),
    ).toThrowError(/幕墙高度必须为正数/)
  })

  it('未设置门窗类型的图层按白膜墙规划，与玻璃幕墙分开记录中心线', () => {
    const drawing = makeDrawing([facadeLoop()])
    const curtainPlan = planCurtainWalls(drawing, { 幕墙: 'curtain' }, 0.001)
    expect(curtainPlan.layers).toEqual(['幕墙'])
    expect(curtainPlan.lines).toHaveLength(4)
    expect(curtainPlan.massingLayers).toHaveLength(0)
    expect(curtainPlan.massingLines).toHaveLength(0)

    const onlyMassing = planCurtainWalls(drawing, { 幕墙: 'massing' }, 0.001)
    expect(onlyMassing.layers).toEqual([])
    expect(onlyMassing.massingLayers).toEqual(['幕墙'])
    expect(onlyMassing.massingLines).toHaveLength(4)
    expect(onlyMassing.notes[0]).toContain('白膜墙')
    expect(onlyMassing.notes[0]).toContain('不带幕墙材质')
  })

  it('白膜模式只沿中心线拉一片薄墙，不生成竖梃 / 横档 / 玻璃', () => {
    const geometry = buildCurtainWallGeometry(
      [{ a: { x: 0, y: 0 }, b: { x: 10000, y: 0 } }],
      0.001,
      { height: 3, plain: true },
    )
    expect(geometry).not.toBeNull()
    expect(geometry!.frames).toHaveLength(0)
    expect(geometry!.glass).toHaveLength(0)
    expect(geometry!.massing.length).toBeGreaterThan(0)
    expect(geometry!.mullionCount).toBe(0)
    expect(geometry!.paneCount).toBe(0)
    // 白膜墙没有框料 / 玻璃中心线，只有自己的中心线
    expect(geometry!.centerlines).toHaveLength(0)
    expect(geometry!.massingCenterlines).toHaveLength(1)
    // 厚度取幕墙框料进深 0.12m：沿 x 铺满 10m，法线方向（z）各偏 0.06
    expect(geometry!.bounds.maxX).toBeCloseTo(10, 6)
    expect(geometry!.bounds.minX).toBeCloseTo(0, 6)
    expect(geometry!.bounds.maxY).toBeCloseTo(0.06, 6)
    expect(geometry!.bounds.minY).toBeCloseTo(-0.06, 6)

    const buffer = createCurtainBufferGeometry(geometry!)
    expect(buffer.groups.map((group) => group.materialIndex)).toEqual([2])
    expect(buffer.getAttribute('position').count).toBe(geometry!.massing.length / 3)
  })

  it('玻璃幕墙与白膜墙可以合并到同一份楼层几何', () => {
    const glass = buildCurtainWallGeometry(
      [{ a: { x: 0, y: 0 }, b: { x: 10000, y: 0 } }],
      0.001,
      { height: 3 },
    )
    const massing = buildCurtainWallGeometry(
      [{ a: { x: 0, y: 20000 }, b: { x: 10000, y: 20000 } }],
      0.001,
      { height: 3, plain: true },
    )
    const merged = mergeCurtainGeometries([glass, massing])
    expect(merged).not.toBeNull()
    expect(merged!.frames.length).toBe(glass!.frames.length)
    expect(merged!.glass.length).toBe(glass!.glass.length)
    expect(merged!.massing.length).toBe(massing!.massing.length)
    expect(merged!.segmentCount).toBe(2)
    expect(merged!.mullionCount).toBe(glass!.mullionCount)
    // 合并后包围盒覆盖两类墙
    expect(merged!.bounds.maxY).toBeCloseTo(20.06, 6)
    expect(curtainCenterlines(merged)).toHaveLength(2)

    const buffer = createCurtainBufferGeometry(merged!)
    expect(buffer.groups.map((group) => group.materialIndex)).toEqual([0, 1, 2])
  })

  it('白膜中心线按各自门洞切割，平行墙线不互相误切', () => {
    const lines = [
      { a: { x: 0, y: 0 }, b: { x: 4000, y: 0 } },
      { a: { x: 0, y: 200 }, b: { x: 4000, y: 200 } },
    ]
    // 只有第一条线有门洞（1.5m ~ 2.4m），第二条保持完整
    const cut = cutCurtainLines(lines, [
      [{ a: { x: 1500, y: 0 }, b: { x: 2400, y: 0 } }],
      [],
    ])
    expect(cut).toHaveLength(3)
    expect(cut[0].a).toEqual({ x: 0, y: 0 })
    expect(cut[0].b.x).toBeCloseTo(1500, 6)
    expect(cut[1].a.x).toBeCloseTo(2400, 6)
    expect(cut[1].b.x).toBeCloseTo(4000, 6)
    // 第二条线原样保留，说明没有被第一条线的洞口误切
    expect(cut[2]).toEqual(lines[1])
    // 没有洞口时整组线原样返回
    expect(cutCurtainLines(lines, [[], []])).toEqual(lines)
  })

  it('没有实体墙时，门图层仍能吸附到白膜墙并给出门洞与门顶过梁', () => {
    const entities: CadEntity[] = [
      {
        id: 'wall',
        type: 'LWPOLYLINE',
        layer: 'WALL',
        color: 0xffffff,
        primitives: [
          {
            kind: 'polyline',
            closed: true,
            points: [
              { x: 0, y: 0 },
              { x: 4000, y: 0 },
              { x: 4000, y: 3000 },
              { x: 0, y: 3000 },
            ],
          },
        ],
      },
      {
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockName: 'M0921',
        blockInstance: 1,
        primitives: [
          {
            kind: 'polyline',
            closed: false,
            points: [
              { x: 1500, y: 0 },
              { x: 2400, y: 0 },
            ],
          },
        ],
      },
    ]
    const drawing = makeDrawing(entities, 0.001)
    // 「墙体」图层按白膜墙生成：没有 WallPiece，只能拿中心线当合成墙段
    const hostLines = planCurtainWalls(drawing, { WALL: 'massing' }, 0.001).massingLines.map(
      (line) => ({
        line,
        key: curtainObjectKey({
          a: { x: line.a.x * 0.001, y: line.a.y * 0.001 },
          b: { x: line.b.x * 0.001, y: line.b.y * 0.001 },
        }),
      }),
    )
    const result = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      hostLines,
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(result.doors).toHaveLength(1)
    const door = result.doors[0]
    expect(door.spec.kind).toBe('door')
    expect(door.spec.width).toBeCloseTo(0.9, 6)
    expect(door.spec.center.x).toBeCloseTo(1.95, 6)
    expect(door.spec.center.y).toBeCloseTo(0, 6)
    // 宿主是南墙（第一条白膜中心线），门洞切割区间换算回图纸坐标
    expect(door.hostKey).toBe(hostLines[0].key)
    expect(door.cuts).toHaveLength(1)
    expect(door.cuts[0].hostKey).toBe(hostLines[0].key)
    expect(door.cuts[0].line.a.x).toBeCloseTo(1500, 6)
    expect(door.cuts[0].line.b.x).toBeCloseTo(2400, 6)
    // 门顶 2.1m、墙高 3m：过梁从 2.1 补到 3
    expect(door.lintels).toHaveLength(1)
    expect(door.lintels[0].base).toBeCloseTo(2.1, 6)
    expect(door.lintels[0].height).toBeCloseTo(0.9, 6)
    expect(door.placement.key).toBe(openingObjectKey(door.spec))
    expect(door.placement.thickness).toBeCloseTo(0.12, 6)
    expect(result.notes[0]).toContain('生成 1 樘门')

    // 主识别已经落地的同一樘门不重复生成
    const duplicated = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      hostLines,
      existingDoors: [door.spec],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(duplicated.doors).toHaveLength(0)

    // 没有白膜墙时显式提示，不静默返回
    const noHost = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      hostLines: [],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(noHost.doors).toHaveLength(0)
    expect(noHost.notes[0]).toContain('没有可吸附的白膜墙')

    // 删除门本身或宿主白膜墙段后，门洞切割与门顶过梁同步消失
    expect(massingDoorCuts(result.doors, new Set()).get(door.hostKey)).toHaveLength(1)
    expect(massingDoorCuts(result.doors, new Set([door.placement.key!])).size).toBe(0)
    expect(massingDoorCuts(result.doors, new Set([door.hostKey])).size).toBe(0)
    const lintels = massingDoorLintels(result.doors, new Set())
    expect(lintels).toHaveLength(1)
    expect(lintels[0].lines).toHaveLength(1)
    expect(lintels[0].base).toBeCloseTo(2.1, 6)
    expect(massingDoorLintels(result.doors, new Set([door.hostKey]))).toHaveLength(0)
  })

  it('门扇垂直展开、块心离墙超过吸附距离时，按图元触碰吸附', () => {
    const entities: CadEntity[] = [
      {
        id: 'wall',
        type: 'LINE',
        layer: 'WALL',
        color: 0xffffff,
        primitives: [
          { kind: 'polyline', closed: false, points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }] },
        ],
      },
      {
        // 门扇沿墙法向展开 1.6m：块心离墙 0.8m，超过 0.12/2 + 0.6 = 0.66m
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockName: 'M0921',
        blockInstance: 1,
        primitives: [
          { kind: 'polyline', closed: false, points: [{ x: 1500, y: 0 }, { x: 1500, y: 1600 }] },
        ],
      },
    ]
    const drawing = makeDrawing(entities, 0.001)
    const hostLines = planCurtainWalls(drawing, { WALL: 'massing' }, 0.001).massingLines.map(
      (line) => ({
        line,
        key: curtainObjectKey({
          a: { x: line.a.x * 0.001, y: line.a.y * 0.001 },
          b: { x: line.b.x * 0.001, y: line.b.y * 0.001 },
        }),
      }),
    )
    const result = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      hostLines,
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    // 块心吸附不到（0.8m > 0.66m），但门扇根部落在墙线上，仍然算吸附成功
    expect(result.doors).toHaveLength(1)
    expect(result.doors[0].spec.center.x).toBeCloseTo(1.5, 6)
    expect(result.doors[0].spec.center.y).toBeCloseTo(0, 6)
    expect(result.doors[0].spec.width).toBeCloseTo(0.9, 6)
  })

  it('门洞标记是沿墙细长条时，旁边有垂直墙也不会把门转 90°', () => {
    const entities: CadEntity[] = [
      {
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockInstance: 1,
        primitives: [
          // 门洞标记：沿墙 0.9m、厚 0.08m 的细长条，块心 (2.0, 0.1)
          {
            kind: 'polyline',
            closed: true,
            points: [
              { x: 1550, y: 60 },
              { x: 2450, y: 60 },
              { x: 2450, y: 140 },
              { x: 1550, y: 140 },
            ],
          },
        ],
      },
    ]
    const host = (ax: number, ay: number, bx: number, by: number) => {
      const line = { a: { x: ax, y: ay }, b: { x: bx, y: by } }
      return {
        line,
        key: curtainObjectKey({
          a: { x: ax * 0.001, y: ay * 0.001 },
          b: { x: bx * 0.001, y: by * 0.001 },
        }),
      }
    }
    const horizontal = host(0, 0, 6000, 0)
    const vertical = host(2000, -2000, 2000, 2000)
    const drawing = makeDrawing(entities, 0.001)
    const result = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      hostLines: [vertical, horizontal],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    // 垂直墙穿过块心、吸附距离更小，但门块长边沿水平墙，门必须沿水平墙落进洞口
    expect(result.doors).toHaveLength(1)
    expect(result.doors[0].hostKey).toBe(horizontal.key)
    expect(result.doors[0].spec.center.x).toBeCloseTo(2, 6)
    expect(result.doors[0].spec.center.y).toBeCloseTo(0, 6)
    expect(result.doors[0].spec.width).toBeCloseTo(0.9, 6)
    expect(result.doors[0].spec.direction.y).toBeCloseTo(0, 6)
  })

  it('门块紧贴墙端碎段时按门扇图元定位，不再因碎段短而跳过', () => {
    const entities: CadEntity[] = [
      {
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockName: 'M0921',
        blockInstance: 1,
        primitives: [
          // 门扇沿墙法向展开：块心落在 (2.0, 0.6)，碎段比长墙更近
          { kind: 'polyline', closed: false, points: [{ x: 2000, y: 100 }, { x: 2000, y: 1100 }] },
        ],
      },
    ]
    const host = (ax: number, ay: number, bx: number, by: number) => {
      const line = { a: { x: ax, y: ay }, b: { x: bx, y: by } }
      return {
        line,
        key: curtainObjectKey({
          a: { x: ax * 0.001, y: ay * 0.001 },
          b: { x: bx * 0.001, y: by * 0.001 },
        }),
      }
    }
    const fragment = host(1950, 100, 2050, 100)
    const wall = host(0, 0, 6000, 0)
    const drawing = makeDrawing(entities, 0.001)
    const result = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      hostLines: [fragment, wall],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    // 门扇根部落在 0.1m 处的墙端碎段上，门就照图落在 (2.0, 0.1)，不再整樘跳过
    expect(result.doors).toHaveLength(1)
    expect(result.doors[0].hostKey).toBe(fragment.key)
    expect(result.doors[0].spec.center.x).toBeCloseTo(2, 6)
    expect(result.doors[0].spec.center.y).toBeCloseTo(0.1, 6)
    expect(result.doors[0].spec.width).toBeCloseTo(0.9, 6)
    expect(result.skipped).toBe(0)
  })

  it('双线墙两面同步开洞，门构件落在墙厚带中间', () => {
    const entities: CadEntity[] = [
      {
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockName: 'M0921',
        blockInstance: 1,
        primitives: [
          { kind: 'polyline', closed: false, points: [{ x: 1550, y: 0 }, { x: 2450, y: 0 }] },
        ],
      },
    ]
    const host = (ay: number) => {
      const line = { a: { x: 0, y: ay }, b: { x: 6000, y: ay } }
      return {
        line,
        key: curtainObjectKey({
          a: { x: 0, y: ay * 0.001 },
          b: { x: 6, y: ay * 0.001 },
        }),
      }
    }
    const front = host(0)
    const back = host(200)
    const drawing = makeDrawing(entities, 0.001)
    const result = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      hostLines: [front, back],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(result.doors).toHaveLength(1)
    const door = result.doors[0]
    // 两面白膜板都断开，否则另一面会完整挡住门
    expect(door.cuts).toHaveLength(2)
    expect(door.cuts.map((cut) => cut.hostKey)).toEqual([front.key, back.key])
    expect(door.cuts[1].line.a.y).toBeCloseTo(200, 6)
    expect(door.lintels).toHaveLength(2)
    // 门居中在墙厚带里：两块白膜板外表面间距 = 中心线间距 0.2 + 板厚 0.12
    expect(door.placement.center.y).toBeCloseTo(0.1, 6)
    expect(door.placement.thickness).toBeCloseTo(0.32, 6)
    const cuts = massingDoorCuts(result.doors, new Set())
    expect(cuts.get(front.key)).toHaveLength(1)
    expect(cuts.get(back.key)).toHaveLength(1)
  })

  it('墙体在洞口处断开时，门严格按门块图元位置落进洞口', () => {
    const entities: CadEntity[] = [
      {
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockName: 'M1021',
        blockInstance: 1,
        primitives: [
          // 门扇画在 1.5~2.5m 的洞口里，块心 (2.0, 0.45) 落在洞口内
          { kind: 'polyline', closed: false, points: [{ x: 2000, y: 0 }, { x: 2000, y: 900 }] },
        ],
      },
    ]
    const host = (ax: number, bx: number) => {
      const line = { a: { x: ax, y: 0 }, b: { x: bx, y: 0 } }
      return {
        line,
        key: curtainObjectKey({
          a: { x: ax * 0.001, y: 0 },
          b: { x: bx * 0.001, y: 0 },
        }),
      }
    }
    const drawing = makeDrawing(entities, 0.001)
    const result = recognizeMassingDoors(drawing, {
      doorLayers: ['DOOR'],
      // 墙线在洞口处断开：只剩洞口两侧各一段
      hostLines: [host(0, 1500), host(2500, 4000)],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(result.doors).toHaveLength(1)
    const door = result.doors[0]
    // 门块图元在 1.5~2.5m 的洞口里，门口就落在图元位置，没有被夹到左侧墙垛末端
    expect(door.spec.width).toBeCloseTo(1, 6)
    expect(door.placement.center.x).toBeCloseTo(2, 6)
    expect(door.cuts).toHaveLength(1)
    expect(result.notes.join('')).toContain('位置按门图层图元解析')
  })

  it('双线墙两面各标一次门块时合并成一樘，位置取两面中点', () => {
    // 白膜墙在洞口处断开：两面墙线只剩洞口两侧的墙垛，且旁边有垂直墙端
    const host = (ax: number, ay: number, bx: number, by: number) => {
      const line = { a: { x: ax, y: ay }, b: { x: bx, y: by } }
      return {
        line,
        key: curtainObjectKey({
          a: { x: ax * 0.001, y: ay * 0.001 },
          b: { x: bx * 0.001, y: by * 0.001 },
        }),
      }
    }
    // 两块分居双线墙的两个面（相距 0.2m = 墙厚），块内图元是近方形的门大样
    const entities: CadEntity[] = [
      {
        id: 'door-front',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockInstance: 1,
        primitives: [
          {
            kind: 'polyline',
            closed: true,
            points: [
              { x: 1050, y: -300 },
              { x: 1950, y: -300 },
              { x: 1950, y: 300 },
              { x: 1050, y: 300 },
            ],
          },
        ],
      },
      {
        id: 'door-back',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockInstance: 2,
        primitives: [
          {
            kind: 'polyline',
            closed: true,
            points: [
              { x: 1050, y: -100 },
              { x: 1950, y: -100 },
              { x: 1950, y: 500 },
              { x: 1050, y: 500 },
            ],
          },
        ],
      },
    ]
    const frontLeft = host(0, 0, 400, 0)
    const frontRight = host(2600, 0, 4000, 0)
    const backLeft = host(0, 200, 400, 200)
    const backRight = host(2600, 200, 4000, 200)
    // 门洞旁边的垂直墙端比同向墙垛更近，旧逻辑会把门吸到它上面转 90°
    const vertical = host(950, -1000, 950, 1000)
    const result = recognizeMassingDoors(makeDrawing(entities, 0.001), {
      doorLayers: ['DOOR'],
      hostLines: [vertical, frontLeft, frontRight, backLeft, backRight],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(result.doors).toHaveLength(1)
    const door = result.doors[0]
    // 位置取两块心的中点，也就是这道墙的中心线
    expect(door.spec.center.x).toBeCloseTo(1.5, 6)
    expect(door.spec.center.y).toBeCloseTo(0.1, 6)
    // 方向由两块心连线的法向得到，与垂直墙无关
    expect(door.spec.direction.y).toBeCloseTo(0, 6)
    expect(door.spec.width).toBeCloseTo(0.9, 6)
    // 两块心距就是墙厚，门套按墙厚带撑满两面
    expect(door.spec.markSpan).toBeCloseTo(0.2, 6)
    expect(door.placement.thickness).toBeCloseTo(0.32, 6)
    expect(result.notes.join('')).toContain('合并为一樘')
  })

  it('双面标记合并后只找到一面墙线时，门套仍居中在墙厚带里', () => {
    const host = (ax: number, ay: number, bx: number, by: number) => {
      const line = { a: { x: ax, y: ay }, b: { x: bx, y: by } }
      return {
        line,
        key: curtainObjectKey({
          a: { x: ax * 0.001, y: ay * 0.001 },
          b: { x: bx * 0.001, y: by * 0.001 },
        }),
      }
    }
    const doorBlock = (id: string, instance: number, y0: number, y1: number): CadEntity => ({
      id,
      type: 'LWPOLYLINE',
      layer: 'DOOR',
      color: 0xffffff,
      blockInstance: instance,
      primitives: [
        {
          kind: 'polyline',
          closed: true,
          points: [
            { x: 1050, y: y0 },
            { x: 1950, y: y0 },
            { x: 1950, y: y1 },
            { x: 1050, y: y1 },
          ],
        },
      ],
    })
    // 两面各标一块（相距 0.2 = 墙厚），但另一面白膜墙线在洞口处彻底断开
    const entities: CadEntity[] = [
      doorBlock('door-front', 1, -300, 300),
      doorBlock('door-back', 2, -100, 500),
    ]
    const result = recognizeMassingDoors(makeDrawing(entities, 0.001), {
      doorLayers: ['DOOR'],
      hostLines: [host(0, 0, 400, 0), host(2600, 0, 4000, 0)],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(result.doors).toHaveLength(1)
    const door = result.doors[0]
    // 只找到前一面墙线时，门套中心必须仍在两面中点 (0.1)，不能被推到前面墙线 (0) 上
    expect(door.placement.center.y).toBeCloseTo(0.1, 6)
    expect(door.placement.thickness).toBeCloseTo(0.32, 6)
  })

  it('门块落在墙线的延长线上时，墙垛离得远也不算离墙太远', () => {
    // 门洞标记：沿墙 0.9m 的细长条，块心 (1.5, 0)
    const entities: CadEntity[] = [
      {
        id: 'door',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        blockInstance: 1,
        primitives: [
          {
            kind: 'polyline',
            closed: true,
            points: [
              { x: 1050, y: -50 },
              { x: 1950, y: -50 },
              { x: 1950, y: 50 },
              { x: 1050, y: 50 },
            ],
          },
        ],
      },
    ]
    const host = (ax: number, bx: number, ay = 0) => {
      const line = { a: { x: ax, y: ay }, b: { x: bx, y: ay } }
      return {
        line,
        key: curtainObjectKey({
          a: { x: ax * 0.001, y: ay * 0.001 },
          b: { x: bx * 0.001, y: ay * 0.001 },
        }),
      }
    }
    const left = host(0, 300)
    const right = host(2900, 4000)
    const result = recognizeMassingDoors(makeDrawing(entities, 0.001), {
      doorLayers: ['DOOR'],
      // 墙体在洞口处断开得比较远：墙垛离门块超过吸附余量，但门仍在这条墙线上
      hostLines: [left, right],
      existingDoors: [],
      unitScale: 0.001,
      wallHeight: 3,
    })
    expect(result.skipped).toBe(0)
    expect(result.doors).toHaveLength(1)
    expect(result.doors[0].hostKey).toBe(left.key)
    expect(result.doors[0].spec.center.x).toBeCloseTo(1.5, 6)
    expect(result.doors[0].spec.center.y).toBeCloseTo(0, 6)
    expect(result.doors[0].spec.width).toBeCloseTo(0.9, 6)
  })

  it('门图层里的长墙线补成白膜墙，门扇与斜向索引线不当墙', () => {
    const entities: CadEntity[] = [
      {
        id: 'walls',
        type: 'LWPOLYLINE',
        layer: 'DOOR',
        color: 0xffffff,
        primitives: [
          // 6m 长的正交墙线：留作白膜墙
          { kind: 'polyline', closed: false, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }] },
          // 0.9m 门扇：太短，不当墙
          { kind: 'polyline', closed: false, points: [{ x: 2000, y: 0 }, { x: 2000, y: 900 }] },
          // 3m 斜向索引线：斜向，不当墙
          { kind: 'polyline', closed: false, points: [{ x: 0, y: 0 }, { x: 3000, y: 3000 }] },
        ],
      },
    ]
    const result = doorLayerWallLines(makeDrawing(entities, 0.001), ['DOOR'], 0.001)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].a).toEqual({ x: 0, y: 0 })
    expect(result.lines[0].b).toEqual({ x: 6000, y: 0 })
    expect(result.skipped).toBe(2)
  })
})

describe('编辑态对象键', () => {
  it('门窗键由墙段 / 类型 / 洞口起止点组成，重建后保持稳定', () => {
    const opening = {
      wallKey: 'W|0,0|1000,0',
      kind: 'window' as const,
      start: { x: 100, y: 0 },
      end: { x: 900, y: 0 },
    }
    expect(openingObjectKey(opening)).toBe('@opening:W|0,0|1000,0|window|100000,0|900000,0')
    expect(openingObjectKey({ ...opening })).toBe(openingObjectKey(opening))
    // 同位置换成门是另一个对象，不能与原窗共用删除记录
    expect(openingObjectKey({ ...opening, kind: 'door' })).not.toBe(openingObjectKey(opening))
  })

  it('幕墙键按米制中心线取键，与墙段键互不冲突', () => {
    const key = curtainObjectKey({ a: { x: 0, y: 0 }, b: { x: 3.5, y: 0 } })
    expect(key).toBe('@curtain:0,0|3500,0')
    expect(openingObjectKey({
      wallKey: 'W|0,0|1000,0',
      kind: 'window',
      start: { x: 0, y: 0 },
      end: { x: 1000, y: 0 },
    })).not.toBe(key)
  })
})
