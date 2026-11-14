import { describe, expect, it } from 'vitest'
import {
  BUILDING_PACKAGE_SCHEMA_VERSION,
  buildBuildingPackageGeoJson,
} from '../cad-lab/core/exportBuildingGeoJson'
import type { NormalizedBuildingParams } from '../cad-lab/core/buildingModel'
import type { ProceduralKitAppearance } from '../adapter/proceduralKit'
import type { WallSegment } from '../cad-lab/core/wallModel'
import { buildWallGeometry } from '../cad-lab/core/wallModel'
import { createLineSegment, type SlabOutline } from '../cad-lab/core/slabOutline'

/** 构造一条米制墙中心线 */
function seg(ax: number, ay: number, bx: number, by: number, thickness = 0.2): WallSegment {
  return {
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    layer: 'W',
    thickness,
    key: `W|${ax},${ay}|${bx},${by}`,
  }
}

/** 边长为 size 的闭合方形墙环 */
function squareSegments(size: number, origin = 0): WallSegment[] {
  const x0 = origin
  const y0 = origin
  const x1 = origin + size
  const y1 = origin + size
  return [
    seg(x0, y0, x1, y0),
    seg(x1, y0, x1, y1),
    seg(x1, y1, x0, y1),
    seg(x0, y1, x0, y0),
  ]
}

/** 边长为 size 的方形楼板轮廓 */
function squareOutline(size: number): SlabOutline {
  const points = [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ]
  return {
    segments: points.map((point, index) =>
      createLineSegment(point, points[(index + 1) % points.length]),
    ),
  }
}

/** 边长为 size、左下角在 (x0, y0) 的方形内环 */
function squareHole(x0: number, y0: number, size: number): SlabOutline {
  const points = [
    { x: x0, y: y0 },
    { x: x0 + size, y: y0 },
    { x: x0 + size, y: y0 + size },
    { x: x0, y: y0 + size },
  ]
  return {
    segments: points.map((point, index) =>
      createLineSegment(point, points[(index + 1) % points.length]),
    ),
  }
}

const PARAMS: NormalizedBuildingParams = {
  floorCount: 2,
  floorSpacing: 3,
  wallHeight: 2.8,
  slabThickness: 0.2,
}

const MATERIAL = { color: '#cfcfcf', metalness: 0.2, roughness: 0.6 }

/** 计算闭合环的有符号面积 */
function ringArea(ring: number[][]): number {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return sum / 2
}

describe('建筑包 GeoJSON 导出', () => {
  it('矩形闭合墙输出 MultiPolygon，并写入契约字段与楼层标高', () => {
    const walls = buildWallGeometry(squareSegments(10), { height: 2.8, miterLimit: 4 }, 1)
    const result = buildBuildingPackageGeoJson({
      buildingId: 'B1',
      name: '测试楼',
      floors: [
        { levelId: 'f0', walls },
        { levelId: 'f1', walls },
      ],
      slabOutline: null,
      params: PARAMS,
      material: MATERIAL,
    })

    expect(result.geojson.webmapBuilding.schemaVersion).toBe(BUILDING_PACKAGE_SCHEMA_VERSION)
    const building = result.geojson.webmapBuilding.buildings[0]
    expect(building.buildingId).toBe('B1')
    expect(building.levels.map((level) => level.levelId)).toEqual(['f0', 'f1'])
    expect(building.levels[1].elevation).toBeCloseTo(3, 9)
    expect(building.levels[1].geometryRef).toBe('f0')
    expect(building.origin.x).toBeCloseTo(5, 9)
    expect(building.origin.y).toBeCloseTo(5, 9)

    // 只有 f0 输出几何；f1 通过 geometryRef 共享
    expect(result.geojson.features).toHaveLength(1)
    const wallsFeature = result.geojson.features[0]
    expect(wallsFeature.geometry.type).toBe('MultiPolygon')
    if (wallsFeature.geometry.type !== 'MultiPolygon') throw new Error('unreachable')
    // 闭合墙带 = 外环 + 内环
    expect(wallsFeature.geometry.coordinates[0]).toHaveLength(2)
    const [outer, inner] = wallsFeature.geometry.coordinates[0]
    expect(ringArea(outer)).toBeGreaterThan(0)
    expect(ringArea(inner)).toBeLessThan(0)
    // 墙体厚度体现在内外环面积差上（10m 见方，墙厚 0.2m）
    const expectedOuter = 10.2 * 10.2
    const expectedInner = 9.8 * 9.8
    expect(Math.abs(ringArea(outer))).toBeCloseTo(expectedOuter, 3)
    expect(Math.abs(ringArea(inner))).toBeCloseTo(expectedInner, 3)
    expect(result.stats.uniqueGeometryCount).toBe(1)
  })

  it('不同楼层几何各自输出，opaque 楼层不引用 geometryRef', () => {
    const wallsA = buildWallGeometry(squareSegments(10), { height: 2.8, miterLimit: 4 }, 1)
    const wallsB = buildWallGeometry(
      squareSegments(10).slice(0, 3),
      { height: 2.8, miterLimit: 4 },
      1,
    )
    const result = buildBuildingPackageGeoJson({
      buildingId: 'B2',
      name: '删墙楼',
      floors: [
        { levelId: 'f0', walls: wallsA },
        { levelId: 'f1', walls: wallsB },
      ],
      slabOutline: null,
      params: PARAMS,
      material: MATERIAL,
    })
    const levels = result.geojson.webmapBuilding.buildings[0].levels
    expect(levels[1].geometryRef).toBeUndefined()
    expect(result.geojson.features).toHaveLength(2)
  })

  it('提供楼板轮廓时输出独立 Polygon，且与墙体坐标同为局部米制', () => {
    const walls = buildWallGeometry(squareSegments(10), { height: 2.8, miterLimit: 4 }, 1)
    const result = buildBuildingPackageGeoJson({
      buildingId: 'B3',
      name: '带板楼',
      floors: [{ levelId: 'f0', walls }],
      slabOutline: squareOutline(10),
      params: { ...PARAMS, floorCount: 1 },
      material: MATERIAL,
    })
    const slab = result.geojson.features.find((feature) => feature.properties.role === 'slab')
    expect(slab).toBeDefined()
    expect(slab!.geometry.type).toBe('Polygon')
    if (slab!.geometry.type !== 'Polygon') throw new Error('unreachable')
    const ring = slab!.geometry.coordinates[0]
    // 局部坐标：以平面中心为原点，方形范围 [-5, 5]
    expect(Math.min(...ring.map((point) => point[0]))).toBeCloseTo(-5, 6)
    expect(Math.max(...ring.map((point) => point[0]))).toBeCloseTo(5, 6)
    expect(slab!.properties.thickness).toBeCloseTo(0.2, 9)
  })

  it('楼板内环写入 Polygon 第二环，外环逆时针、内环顺时针', () => {
    const walls = buildWallGeometry(squareSegments(10), { height: 2.8, miterLimit: 4 }, 1)
    const outline = squareOutline(10)
    const result = buildBuildingPackageGeoJson({
      buildingId: 'B3H',
      name: '带内院楼',
      floors: [{ levelId: 'f0', walls }],
      slabOutline: { ...outline, holes: [squareHole(4, 4, 2)] },
      params: { ...PARAMS, floorCount: 1 },
      material: MATERIAL,
    })
    const slab = result.geojson.features.find((feature) => feature.properties.role === 'slab')
    expect(slab).toBeDefined()
    if (!slab || slab.geometry.type !== 'Polygon') throw new Error('unreachable')
    expect(slab.geometry.coordinates).toHaveLength(2)
    const [outer, hole] = slab.geometry.coordinates
    expect(ringArea(outer)).toBeGreaterThan(0)
    expect(ringArea(hole)).toBeLessThan(0)
    // 洞环局部坐标：建筑中心 (5, 5)，洞范围 [4, 6] → [-1, 1]
    expect(Math.min(...hole.map((point) => point[0]))).toBeCloseTo(-1, 6)
    expect(Math.max(...hole.map((point) => point[0]))).toBeCloseTo(1, 6)
    expect(result.stats.slabVertices).toBe(outer.length + hole.length)
  })

  it('开放墙体输出单一多边形（左边界正向 + 右边界反向）', () => {
    const walls = buildWallGeometry([seg(0, 0, 10, 0)], { height: 2.8, miterLimit: 4 }, 1)
    const result = buildBuildingPackageGeoJson({
      buildingId: 'B4',
      name: '单墙',
      floors: [{ levelId: 'f0', walls }],
      slabOutline: null,
      params: { ...PARAMS, floorCount: 1 },
      material: MATERIAL,
    })
    const feature = result.geojson.features[0]
    if (feature.geometry.type !== 'MultiPolygon') throw new Error('unreachable')
    expect(feature.geometry.coordinates).toHaveLength(1)
    expect(feature.geometry.coordinates[0][0]).toHaveLength(5)
  })

  it('门窗按 LineString 要素导出，语义字段与 webmap 门窗定义同名同义', () => {
    const south = seg(0, 0, 10, 0)
    const walls = buildWallGeometry(squareSegments(10), { height: 2.8, miterLimit: 4 }, 1, [
      {
        wallKey: south.key,
        kind: 'door',
        start: { x: 2, y: 0 },
        end: { x: 2.9, y: 0 },
        sill: 0,
        height: 2.1,
        preset: 'steel_fire',
      },
      {
        wallKey: south.key,
        kind: 'window',
        start: { x: 5, y: 0 },
        end: { x: 6.5, y: 0 },
        sill: 0.9,
        height: 1.5,
        preset: 'casement_double',
      },
    ])
    const result = buildBuildingPackageGeoJson({
      buildingId: 'B6',
      name: '带门窗楼',
      floors: [{ levelId: 'f0', walls }],
      slabOutline: null,
      params: { ...PARAMS, floorCount: 1 },
      material: MATERIAL,
    })

    const openings = result.geojson.features.filter((feature) => feature.properties.role === 'opening')
    expect(openings).toHaveLength(2)
    expect(result.stats.doorCount).toBe(1)
    expect(result.stats.windowCount).toBe(1)

    const door = openings.find((feature) => feature.properties.openingKind === 'door')!
    expect(door.geometry.type).toBe('LineString')
    if (door.geometry.type !== 'LineString') throw new Error('unreachable')
    expect(door.geometry.coordinates).toHaveLength(2)
    expect(door.properties.type).toBe('INDOOR_DOOR')
    expect(door.properties.semantic).toMatchObject({
      hostType: 'WALL',
      hostId: south.key,
      wallThickness: 0.2,
      sillHeight: 0,
      direction: [1, 0],
    })
    expect(door.properties.semantic!.width).toBeCloseTo(0.9, 6)
    expect(door.properties.semantic!.height).toBeCloseTo(2.1, 6)
    // 防火门语义映射到 webmap 的 IndoorDoorConfig：钢质门套 + 闭门器 + 推杠
    expect(door.properties.render3d.indoorDoor).toMatchObject({
      preset: 'steel_fire',
      material: 'steel_wood',
      frame: { kind: 'steel' },
      hardware: { handle: 'bar', closer: true, kickPlate: true },
    })

    const window = openings.find((feature) => feature.properties.openingKind === 'window')!
    expect(window.properties.type).toBe('WINDOW_OPENING')
    expect(window.properties.sillHeight).toBeCloseTo(0.9, 9)
    expect(window.properties.render3d.windowOpening).toMatchObject({
      preset: 'casement_double',
      sillHeight: 0.9,
      columns: 2,
      rows: 1,
    })
  })

  it('导出构件外观：整栋轮廓、正立面与逐层构件配置写入建筑包', () => {
    const walls = buildWallGeometry(squareSegments(10), { height: 2.8, miterLimit: 4 }, 1)
    const result = buildBuildingPackageGeoJson({
      buildingId: 'B7',
      name: '构件楼',
      floors: [
        { levelId: 'f0', walls },
        { levelId: 'f1', walls },
      ],
      slabOutline: squareOutline(10),
      params: PARAMS,
      material: MATERIAL,
      appearance: {
        outlineRing: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        frontFaceIndex: 0,
        levels: [
          {
            facadeStyle: 'office',
            podium: { enabled: true } as unknown as ProceduralKitAppearance['levels'][number]['podium'],
            roof: null,
            entranceGates: [
              { faceIndex: 0, anchor: [0, 0] } as unknown as ProceduralKitAppearance['levels'][number]['entranceGates'][number],
            ],
          },
          {
            facadeStyle: 'office',
            podium: null,
            roof: { enabled: true } as unknown as ProceduralKitAppearance['levels'][number]['roof'],
            entranceGates: [],
          },
        ],
      },
    })

    const building = result.geojson.webmapBuilding.buildings[0]
    // 轮廓随墙体使用同一局部米制原点（建筑中心 5,5 → 范围 [-5,5]）
    expect(building.outline).toHaveLength(5)
    expect(building.outline![0]).toEqual([-5, -5])
    expect(building.outline![2]).toEqual([5, 5])
    expect(building.frontFaceIndex).toBe(0)

    // 首层：底座 + 大门 + 立面；顶层：屋顶 + 立面
    expect(building.levels[0].appearance).toMatchObject({
      facadeStyle: 'office',
      podium: { enabled: true },
      entranceGates: [{ faceIndex: 0 }],
    })
    expect(building.levels[0].appearance?.roof).toBeUndefined()
    expect(building.levels[1].appearance).toMatchObject({
      facadeStyle: 'office',
      roof: { enabled: true },
    })
    expect(building.levels[1].appearance?.podium).toBeUndefined()
    expect(building.levels[1].appearance?.entranceGates).toBeUndefined()
  })

  it('没有墙体时拒绝导出并给出中文错误', () => {
    const empty = buildWallGeometry([], { height: 2.8, miterLimit: 4 }, 1)
    expect(() =>
      buildBuildingPackageGeoJson({
        buildingId: 'B5',
        name: '空楼',
        floors: [{ levelId: 'f0', walls: empty }],
        slabOutline: null,
        params: { ...PARAMS, floorCount: 1 },
        material: MATERIAL,
      }),
    ).toThrow('没有可导出的墙体几何')
  })
})
