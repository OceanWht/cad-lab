/**
 * 建筑包 GeoJSON 导出：把 cad-lab 的楼层墙体 / 楼板写成 webmap 编辑器可识别的文件。
 *
 * 契约（openspec: add-outdoor-multi-floor-building-from-geojson）：
 * - 顶层 `webmapBuilding.schemaVersion === 'webmap-building/1'`；
 * - 坐标为局部米制，原点取建筑平面中心，y 轴与 CAD 图纸 y 轴同向；
 * - 墙体为 `MultiPolygon`，直接取 `buildWallGeometry` 的墙带边界，不重算 offset / miter；
 * - 楼板为独立 `Polygon`（内环即内院），未绘制轮廓时不输出；
 * - 几何相同的楼层用 `levels[].geometryRef` 指向首个楼层，不重复输出几何。
 *
 * 本模块为纯函数，不依赖 DOM 与 three.js 渲染资源；
 * 门窗语义复用 openingModel 的解析结果（只取配置，不取几何）。
 */

import type { NormalizedBuildingParams } from './buildingModel'
import type { WallMaterialParams } from './materialModel'
import type { ProceduralKitAppearance, ProceduralKitLevelAppearance } from '../../adapter/proceduralKit'
import type { EntranceGateConfig, FacadeStyle, PodiumConfig, RoofConfig } from '../../shared/types'
import type { SlabOutline, OutlinePoint } from './slabOutline'
import { flattenOutline } from './slabOutline'
import type { WallGeometryResult, WallOpeningPlacement } from './wallModel'
import {
  CURTAIN_FRAME_COLOR,
  CURTAIN_GLASS_COLOR,
  DEFAULT_FRAME_DEPTH,
  DEFAULT_GLASS_GAP,
  DEFAULT_GLASS_THICKNESS,
  DEFAULT_MULLION_SPACING,
  DEFAULT_MULLION_WIDTH,
  DEFAULT_TRANSOM_HEIGHT,
  type CurtainLine,
  type CurtainWallGeometry,
} from './curtainModel'
import {
  OPENING_FRAME_COLOR,
  OPENING_GLASS_COLOR,
  OPENING_HARDWARE_COLOR,
  OPENING_LEAF_COLOR,
  resolveDoorConfig,
  resolveWindowConfig,
  type DoorOpeningConfig,
  type WindowOpeningConfig,
} from './openingModel'

/** 建筑包版本号：编辑器据此识别专用导入分支 */
export const BUILDING_PACKAGE_SCHEMA_VERSION = 'webmap-building/1'

/** 楼层几何内容（同一份 WallGeometryResult 可被多层引用） */
export interface FloorExportInput {
  /** 稳定楼层 id：f0..fN */
  levelId: string
  walls: WallGeometryResult
  /** 玻璃幕墙几何；null / 省略表示该层没有幕墙 */
  curtain?: CurtainWallGeometry | null
}

/** 单栋建筑的导出输入 */
export interface BuildingExportInput {
  buildingId: string
  name: string
  /** 逐层几何，下标即楼层序号 */
  floors: ReadonlyArray<FloorExportInput>
  /** 地板轮廓；null 表示未绘制 */
  slabOutline: SlabOutline | null
  /** 楼层参数（层高 / 板厚 / 层间距） */
  params: NormalizedBuildingParams
  /** 墙体材质参数 */
  material: WallMaterialParams
  /**
   * 程序化构件外观（可选）。
   * 由 `buildProceduralKit` 的返回值提供，导出后 webmap 编辑器按同一套配置重建构件；
   * 缺省时只导出墙体 / 楼板 / 门窗，不携带构件参数。
   */
  appearance?: ProceduralKitAppearance | null
}

/** 楼层元数据（写入 webmapBuilding.buildings[].levels[]） */
export interface BuildingPackageLevel {
  levelId: string
  name: string
  /** 相对首层的标高（米） */
  elevation: number
  /** 墙高（米） */
  wallHeight: number
  /** 板厚（米） */
  slabThickness: number
  /** 几何与其它楼层相同时指向首个楼层；缺省表示本层几何独立 */
  geometryRef?: string
  material: WallMaterialParams
  /**
   * 程序化构件外观（立面 / 底座 / 屋顶 / 大门）。
   * 只在 cad-lab 实际生成了对应构件时写入；导入侧据此用同源构建器重建。
   */
  appearance?: BuildingPackageLevelAppearance
}

/** 建筑包楼层外观：字段名与 webmap `render3d` 中的同名配置完全一致 */
export interface BuildingPackageLevelAppearance {
  /** 立面风格（逐层） */
  facadeStyle?: FacadeStyle
  /** 底座配置（仅首层） */
  podium?: PodiumConfig
  /** 屋顶配置（仅顶层） */
  roof?: RoofConfig
  /** 大门配置（仅首层；faceIndex 相对建筑 outline 的边序） */
  entranceGates?: EntranceGateConfig[]
}

/** 建筑包内单栋建筑 */
export interface BuildingPackageBuilding {
  buildingId: string
  name: string
  /** 建筑平面中心（局部米制，与墙体坐标同一坐标系） */
  origin: { x: number; y: number }
  /**
   * 程序化构件使用的建筑外轮廓（局部米制，逆时针，首尾点相同）。
   * 与墙体同坐标系，面序号即 `entranceGates[].faceIndex`。
   */
  outline?: number[][]
  /** 正立面边序号（相对 outline 的边序），无大门时供底座 / 屋顶对齐使用 */
  frontFaceIndex?: number
  levels: BuildingPackageLevel[]
}

/** 顶层建筑包块 */
export interface BuildingPackageBlock {
  schemaVersion: string
  buildings: BuildingPackageBuilding[]
}

/** GeoJSON 要素属性（导入侧按这些字段重建楼层） */
export interface BuildingPackageFeatureProperties {
  id: string
  /** 墙面 / 楼板为 BUILDING_EXTERIOR；门复用 webmap 的 INDOOR_DOOR；窗为 WINDOW_OPENING；玻璃幕墙为 CURTAIN_WALL */
  type: 'BUILDING_EXTERIOR' | 'INDOOR_DOOR' | 'WINDOW_OPENING' | 'CURTAIN_WALL'
  name: string
  buildingId: string
  levelId: string
  role: 'walls' | 'slab' | 'opening'
  /** 门窗：门 / 窗 */
  openingKind?: 'door' | 'window'
  /** 墙体：层高（米） */
  height?: number
  /** 楼板：板厚（米） */
  thickness?: number
  /** 门窗：洞口总宽（米） */
  width?: number
  /** 门窗：洞口底标高（米） */
  sillHeight?: number
  /** 相对首层标高（米） */
  elevation: number
  material: WallMaterialParams
  /**
   * 门窗宿主绑定：字段与 webmap `IndoorDoorSemantic` 完全一致，
   * 墙 / 楼板要素不写该字段。
   */
  semantic?: {
    hostType: 'WALL'
    hostId: string
    levelId: string
    hostSegmentIndex: number
    hostT: number
    direction: [number, number]
    faceSign: number
    wallThickness: number
    width: number
    height: number
    sillHeight: number
  }
  render3d: {
    baseColor: string
    metalness: number
    roughness: number
    opacity: number
    transparent: boolean
    /** 门构件配置：字段与 webmap `IndoorDoorConfig` 完全一致 */
    indoorDoor?: Record<string, unknown>
    /** 窗构件配置：字段与立面窗档案（sillHeight / mullionWidth / columns / rows）一致 */
    windowOpening?: Record<string, unknown>
    /** 玻璃幕墙构造参数：竖梃间距 / 截面、双层玻璃等 */
    curtainWall?: Record<string, unknown>
  }
}

/** 导出的 FeatureCollection（含 webmapBuilding 顶层块） */
export interface BuildingPackageGeoJson {
  type: 'FeatureCollection'
  webmapBuilding: BuildingPackageBlock
  features: Array<{
    type: 'Feature'
    geometry:
      | { type: 'MultiPolygon'; coordinates: number[][][][] }
      | { type: 'Polygon'; coordinates: number[][][] }
      /** 门窗：沿墙洞口线（局部米制，起止点为洞口两侧） */
      | { type: 'LineString'; coordinates: number[][] }
    properties: BuildingPackageFeatureProperties
  }>
}

/** 导出规模统计：用于导出前确认，不做静默裁剪 */
export interface BuildingPackageStats {
  floorCount: number
  /** 唯一几何份数（geometryRef 共享后） */
  uniqueGeometryCount: number
  /** 唯一几何的墙体顶点数 */
  wallVertices: number
  /** 唯一几何的楼板顶点数 */
  slabVertices: number
  /** 导入侧按层展开后的墙体顶点总数 */
  expandedWallVertices: number
  /** 导出的门要素数量（按唯一几何计） */
  doorCount: number
  /** 导出的窗要素数量（按唯一几何计） */
  windowCount: number
  /** 导出的玻璃幕墙中心线数量（按唯一几何计） */
  curtainCount: number
}

/** 导出结果 */
export interface BuildingPackageExportResult {
  geojson: BuildingPackageGeoJson
  stats: BuildingPackageStats
}

/** 平面环的有符号面积（正为逆时针） */
function signedArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** 局部米制坐标：减去建筑平面中心 */
function toLocal(point: { x: number; y: number }, origin: { x: number; y: number }): number[] {
  return [point.x - origin.x, point.y - origin.y]
}

/** 去掉连续重复点（1mm 内），保证 GeoJSON 环合法 */
function dedupeRing(points: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.001) continue
    out.push({ x: point.x, y: point.y })
  }
  if (out.length > 1) {
    const first = out[0]
    const last = out[out.length - 1]
    if (Math.hypot(first.x - last.x, first.y - last.y) < 0.001) out.pop()
  }
  return out
}

/** 闭合环并写入局部坐标；`counterClockwise` 指定输出绕序 */
function toRing(
  points: ReadonlyArray<{ x: number; y: number }>,
  origin: { x: number; y: number },
  counterClockwise: boolean,
): number[][] {
  let ring = dedupeRing(points)
  if (ring.length < 3) return []
  const area = signedArea(ring)
  const isCcw = area > 0
  if (isCcw !== counterClockwise) ring = ring.slice().reverse()
  const coords = ring.map((point) => toLocal(point, origin))
  coords.push(coords[0].slice())
  return coords
}

/**
 * 把一条墙带转成多边形：
 * - 闭合墙带 → 外环 + 内环（墙带是环形，中间是房间）；
 * - 开放墙带 → 左边界正向 + 右边界反向拼成的闭合多边形。
 */
function wallBandToPolygons(
  ring: WallGeometryResult['rings'][number],
  origin: { x: number; y: number },
): number[][][] {
  const left = ring.left
  const right = ring.right
  if (ring.closed) {
    const leftArea = Math.abs(signedArea(left))
    const rightArea = Math.abs(signedArea(right))
    const outer = leftArea >= rightArea ? left : right
    const inner = leftArea >= rightArea ? right : left
    const outerRing = toRing(outer, origin, true)
    const innerRing = toRing(inner, origin, false)
    if (outerRing.length === 0) return []
    // 内环为空时退化为实心墙带（极窄墙），但不丢外环
    return innerRing.length === 0 ? [outerRing] : [outerRing, innerRing]
  }
  const loop = [...left, ...right.slice().reverse()]
  const outerRing = toRing(loop, origin, true)
  return outerRing.length === 0 ? [] : [outerRing]
}

/** 收集所有楼层的平面包围盒（米） */
function collectBounds(floors: ReadonlyArray<FloorExportInput>): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const floor of floors) {
    const bounds = floor.walls.bounds
    if (!(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) continue
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
    // 幕墙可能比墙体更靠外，原点必须覆盖，否则局部坐标会整体偏移
    if (floor.curtain) {
      minX = Math.min(minX, floor.curtain.bounds.minX)
      minY = Math.min(minY, floor.curtain.bounds.minY)
      maxX = Math.max(maxX, floor.curtain.bounds.maxX)
      maxY = Math.max(maxY, floor.curtain.bounds.maxY)
    }
  }
  return { minX, minY, maxX, maxY }
}

/** 楼板轮廓扁平化后的外环与内环（米）；未绘制或外环退化时返回 null */
function slabRings(outline: SlabOutline | null): { outer: OutlinePoint[]; holes: OutlinePoint[][] } | null {
  if (!outline || outline.segments.length === 0) return null
  const flat = flattenOutline(outline)
  if (flat.points.length < 3) return null
  const holes: OutlinePoint[][] = []
  for (const hole of outline.holes ?? []) {
    const holeFlat = flattenOutline(hole)
    // 退化内环不写入 GeoJSON，避免生成非法 Ring
    if (holeFlat.points.length >= 3) holes.push(holeFlat.points)
  }
  return { outer: flat.points, holes }
}

/** 颜色数值 → `#rrggbb` */
function hexColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

/** 门预设 → webmap 室内门材质大类 */
function doorMaterialKind(preset: DoorOpeningConfig['preset']): string {
  if (preset === 'glass_single' || preset === 'glass_double' || preset === 'glass_sliding') return 'glass'
  if (preset === 'steel_fire' || preset === 'security_steel') return 'steel_wood'
  if (preset === 'louver') return 'molded'
  return 'engineered_wood'
}

/** 门构件配置 → webmap `IndoorDoorConfig`（字段一一对应，可直接被室内门生成器消费） */
function toIndoorDoorConfig(config: DoorOpeningConfig): Record<string, unknown> {
  return {
    preset: config.preset,
    material: doorMaterialKind(config.preset),
    leafWidth: config.leafWidth,
    leafHeight: config.leafHeight,
    sillHeight: config.sillHeight,
    frame: {
      kind: config.frame.kind,
      width: config.frame.width,
      depth: config.frame.depth,
      casingWidth: config.frame.casingWidth,
    },
    leaf: {
      kind: config.preset === 'glass_sliding' ? 'sliding' : config.leaf.kind,
      panel: config.leaf.panel,
      thickness: config.leaf.thickness,
      archRise: 0,
      stileWidth: config.leaf.stileWidth,
      railWidth: config.leaf.railWidth,
    },
    glazing: {
      mode: config.glazing.mode,
      inset: config.glazing.inset,
      cols: config.glazing.cols,
      rows: config.glazing.rows,
    },
    assembly: {
      sidelightLeft: false,
      sidelightRight: false,
      transom: config.transomHeight > 0,
      sidelightWidth: 0.4,
      transomHeight: config.transomHeight,
    },
    hardware: {
      handle: config.hardware.handle,
      finish: 'brushed_nickel',
      closer: config.hardware.closer,
      kickPlate: config.hardware.kickPlate,
    },
    finish: {
      frame: hexColor(OPENING_FRAME_COLOR),
      leaf: hexColor(OPENING_LEAF_COLOR),
      glass: hexColor(OPENING_GLASS_COLOR),
    },
    motion: {
      isOpen: false,
      openAngleDeg: 90,
      hingeSide: 'left',
      swing: 'in',
    },
    seed: config.seed,
  }
}

/** 窗构件配置 → 与 webmap 立面窗档案同名同义的参数 */
function toWindowOpeningConfig(config: WindowOpeningConfig): Record<string, unknown> {
  return {
    preset: config.preset,
    width: config.width,
    height: config.height,
    sillHeight: config.sillHeight,
    frameWidth: config.frame.width,
    frameDepth: config.frame.depth,
    mullionWidth: config.mullionWidth,
    columns: config.columns,
    rows: config.rows,
    operable: config.operable,
    glassThickness: config.glazing.thickness,
    glassLayers: config.glazing.layers,
    sillBoardDepth: config.sillBoardDepth,
    frameColor: hexColor(OPENING_FRAME_COLOR),
    glassColor: hexColor(OPENING_GLASS_COLOR),
    hardwareColor: hexColor(OPENING_HARDWARE_COLOR),
    seed: config.seed,
  }
}

/** 构造一条门窗要素：LineString 为沿墙洞口线，语义在 properties 中 */
function buildOpeningFeature(
  opening: WallOpeningPlacement,
  context: {
    buildingId: string
    name: string
    levelId: string
    elevation: number
    origin: { x: number; y: number }
    index: number
    material: WallMaterialParams
  },
): BuildingPackageGeoJson['features'][number] {
  const { buildingId, name, levelId, elevation, origin, index, material } = context
  const isDoor = opening.kind === 'door'
  const tag = isDoor ? 'door' : 'window'
  const preset = opening.preset ?? ''
  const semantic = {
    hostType: 'WALL' as const,
    // CAD 墙体按墙带导出，没有逐段要素；hostId 用稳定的墙段键，
    // 导入侧可据此与墙体几何对齐，hostSegmentIndex 为洞口在墙段上的序号。
    hostId: opening.wallKey,
    levelId,
    hostSegmentIndex: index,
    hostT: 0.5,
    direction: [opening.direction.x, opening.direction.y] as [number, number],
    faceSign: 1,
    wallThickness: opening.thickness,
    width: opening.width,
    height: opening.height,
    sillHeight: opening.sill,
  }
  const render3d = {
    baseColor: hexColor(OPENING_FRAME_COLOR),
    metalness: 0.05,
    roughness: 0.62,
    opacity: 1,
    transparent: false,
    ...(isDoor
      ? { indoorDoor: toIndoorDoorConfig(resolveDoorConfig(opening)) }
      : { windowOpening: toWindowOpeningConfig(resolveWindowConfig(opening)) }),
  }
  const halfWidth = opening.width / 2
  const startPoint = {
    x: opening.center.x - opening.direction.x * halfWidth,
    y: opening.center.y - opening.direction.y * halfWidth,
  }
  const endPoint = {
    x: opening.center.x + opening.direction.x * halfWidth,
    y: opening.center.y + opening.direction.y * halfWidth,
  }
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [toLocal(startPoint, origin), toLocal(endPoint, origin)],
    },
    properties: {
      id: `B-${buildingId}-${levelId}-${tag}-${index}`,
      type: isDoor ? 'INDOOR_DOOR' : 'WINDOW_OPENING',
      name: `${name} ${levelId} ${isDoor ? '门' : '窗'}${index + 1}${preset ? `（${preset}）` : ''}`,
      buildingId,
      levelId,
      role: 'opening',
      openingKind: opening.kind,
      width: opening.width,
      height: opening.height,
      sillHeight: opening.sill,
      elevation,
      material,
      semantic,
      render3d,
    },
  }
}

/**
 * 构造一条玻璃幕墙要素：LineString 为幕墙中心线，构造参数写入 render3d.curtainWall。
 * 幕墙不挂在任何墙体上，因此不写 semantic（导入侧按开洞 / 独立构件两套语义任选）。
 */
function buildCurtainFeature(
  line: CurtainLine,
  context: {
    buildingId: string
    name: string
    levelId: string
    elevation: number
    origin: { x: number; y: number }
    index: number
    wallHeight: number
    material: WallMaterialParams
  },
): BuildingPackageGeoJson['features'][number] {
  const { buildingId, name, levelId, elevation, origin, index, wallHeight, material } = context
  const width = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y)
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [toLocal(line.a, origin), toLocal(line.b, origin)],
    },
    properties: {
      id: `B-${buildingId}-${levelId}-curtain-${index}`,
      type: 'CURTAIN_WALL',
      name: `${name} ${levelId} 幕墙${index + 1}`,
      buildingId,
      levelId,
      role: 'opening',
      openingKind: 'window',
      width,
      height: wallHeight,
      sillHeight: 0,
      elevation,
      material,
      render3d: {
        baseColor: hexColor(CURTAIN_FRAME_COLOR),
        metalness: 0.82,
        roughness: 0.34,
        opacity: 1,
        transparent: false,
        curtainWall: {
          mullionSpacing: DEFAULT_MULLION_SPACING,
          mullionWidth: DEFAULT_MULLION_WIDTH,
          frameDepth: DEFAULT_FRAME_DEPTH,
          transomHeight: DEFAULT_TRANSOM_HEIGHT,
          glassThickness: DEFAULT_GLASS_THICKNESS,
          glassGap: DEFAULT_GLASS_GAP,
          glassLayers: 2,
          glassColor: hexColor(CURTAIN_GLASS_COLOR),
          glassOpacity: 0.28,
        },
      },
    },
  }
}

/**
 * 构件外观 → 建筑包层外观。
 * 空配置不写入，避免 `{}` 之类无意义字段进入文件。
 */
function toPackageLevelAppearance(
  source: ProceduralKitLevelAppearance | undefined,
): BuildingPackageLevelAppearance | undefined {
  if (!source) return undefined
  const out: BuildingPackageLevelAppearance = {}
  if (source.facadeStyle) out.facadeStyle = source.facadeStyle
  if (source.podium) out.podium = source.podium
  if (source.roof) out.roof = source.roof
  if (source.entranceGates.length > 0) out.entranceGates = source.entranceGates
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 组装建筑包 GeoJSON。
 *
 * @throws 没有可导出的墙体、楼层参数非法、楼板轮廓自交等情况下抛出中文错误，
 *         由调用方提示用户；本函数不做兜底几何。
 */
export function buildBuildingPackageGeoJson(input: BuildingExportInput): BuildingPackageExportResult {
  const { buildingId, name, floors, params, material } = input
  if (!buildingId) throw new Error('建筑 id 不能为空')
  if (floors.length === 0) throw new Error('没有可导出的楼层，请先生成楼层模型')
  const hasWall = floors.some((floor) => floor.walls.segmentCount > 0 && floor.walls.positions.length > 0)
  if (!hasWall) throw new Error('没有可导出的墙体几何，请先生成楼层模型')
  if (!(params.floorSpacing > 0)) throw new Error(`层间距必须为正数：${params.floorSpacing}`)

  const bounds = collectBounds(floors)
  if (!Number.isFinite(bounds.minX)) throw new Error('墙体包围盒无效，无法确定建筑平面中心')
  const origin = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  }

  // 同一份 WallGeometryResult 视为同一份几何，用首次出现的楼层作为 geometryRef 目标
  const ownerByGeometry = new Map<WallGeometryResult, string>()
  const levels: BuildingPackageLevel[] = []
  const features: BuildingPackageGeoJson['features'] = []
  let wallVertices = 0
  let slabVertices = 0
  let expandedWallVertices = 0
  let doorCount = 0
  let windowCount = 0
  let curtainCount = 0

  const rings = slabRings(input.slabOutline)
  // 楼板 Polygon 第一环为外轮廓（逆时针），其余环为内院洞口（顺时针）
  const slabCoords: number[][][] = []
  if (rings) {
    const outerCoords = toRing(rings.outer, origin, true)
    if (outerCoords.length > 0) {
      slabCoords.push(outerCoords)
      for (const hole of rings.holes) {
        const holeCoords = toRing(hole, origin, false)
        if (holeCoords.length > 0) slabCoords.push(holeCoords)
      }
    }
  }

  floors.forEach((floor, index) => {
    const levelId = floor.levelId || `f${index}`
    const elevation = index * params.floorSpacing
    const owner = ownerByGeometry.get(floor.walls)
    const geometryRef = owner === undefined ? undefined : owner
    const appearance = toPackageLevelAppearance(input.appearance?.levels?.[index])
    levels.push({
      levelId,
      name: `F${index + 1}`,
      elevation,
      wallHeight: params.wallHeight,
      slabThickness: params.slabThickness,
      ...(geometryRef ? { geometryRef } : {}),
      material,
      ...(appearance ? { appearance } : {}),
    })
    // positions 每个顶点占 3 个浮点数
    expandedWallVertices += Math.floor(floor.walls.positions.length / 3)
    if (owner !== undefined) return

    ownerByGeometry.set(floor.walls, levelId)
    const polygons: number[][][][] = []
    for (const wallRing of floor.walls.rings) {
      // 每条墙带是一条 Polygon（外环 + 可选内环），多条墙带组成 MultiPolygon
      const band = wallBandToPolygons(wallRing, origin)
      if (band.length > 0) polygons.push(band)
    }
    wallVertices += Math.floor(floor.walls.positions.length / 3)
    if (polygons.length === 0) return
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: polygons },
      properties: {
        id: `B-${buildingId}-${levelId}-walls`,
        type: 'BUILDING_EXTERIOR',
        name: `${name} ${levelId}`,
        buildingId,
        levelId,
        role: 'walls',
        height: params.wallHeight,
        elevation,
        material,
        render3d: {
          baseColor: material.color,
          metalness: material.metalness,
          roughness: material.roughness,
          opacity: 1,
          transparent: false,
        },
      },
    })

    // 楼板与墙体同属一份楼层几何：共享 geometryRef 的楼层复用 f0 的楼板
    if (slabCoords.length > 0) {
      slabVertices += slabCoords.reduce((sum, ring) => sum + ring.length, 0)
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: slabCoords },
        properties: {
          id: `B-${buildingId}-${levelId}-slab`,
          type: 'BUILDING_EXTERIOR',
          name: `${name} ${levelId} 楼板`,
          buildingId,
          levelId,
          role: 'slab',
          thickness: params.slabThickness,
          elevation,
          material,
          render3d: {
            baseColor: material.color,
            metalness: material.metalness,
            roughness: material.roughness,
            opacity: 1,
            transparent: false,
          },
        },
      })
    }

    // 门窗语义与墙体同属一份楼层几何：共享 geometryRef 的楼层复用 owner 的洞口清单
    floor.walls.openings.forEach((opening, openingIndex) => {
      features.push(
        buildOpeningFeature(opening, {
          buildingId,
          name,
          levelId,
          elevation,
          origin,
          index: openingIndex,
          material,
        }),
      )
      if (opening.kind === 'door') doorCount += 1
      else windowCount += 1
    })

    // 玻璃幕墙与墙体同属一份楼层几何：共享 geometryRef 的楼层复用 owner 的幕墙
    const curtain = floor.curtain
    if (curtain) {
      curtain.centerlines.forEach((line, curtainIndex) => {
        features.push(
          buildCurtainFeature(line, {
            buildingId,
            name,
            levelId,
            elevation,
            origin,
            index: curtainIndex,
            wallHeight: params.wallHeight,
            material,
          }),
        )
        curtainCount += 1
      })
    }
  })

  if (features.length === 0) throw new Error('墙体拓扑退化，未生成任何墙带多边形')

  // 构件轮廓：与墙体同一局部坐标系，导入侧据此重建底座 / 屋顶 / 立面 / 大门
  const outlineRing = input.appearance?.outlineRing ?? null
  const outlineCoords = outlineRing
    ? toRing(
        outlineRing.map((point) => ({ x: point[0], y: point[1] })),
        origin,
        true,
      )
    : []
  const frontFaceIndex = input.appearance?.frontFaceIndex

  const geojson: BuildingPackageGeoJson = {
    type: 'FeatureCollection',
    webmapBuilding: {
      schemaVersion: BUILDING_PACKAGE_SCHEMA_VERSION,
      buildings: [
        {
          buildingId,
          name,
          origin,
          ...(outlineCoords.length > 0 ? { outline: outlineCoords } : {}),
          ...(typeof frontFaceIndex === 'number' && frontFaceIndex >= 0 ? { frontFaceIndex } : {}),
          levels,
        },
      ],
    },
    features,
  }

  return {
    geojson,
    stats: {
      floorCount: floors.length,
      uniqueGeometryCount: ownerByGeometry.size,
      wallVertices,
      slabVertices,
      expandedWallVertices,
      doorCount,
      windowCount,
      curtainCount,
    },
  }
}
