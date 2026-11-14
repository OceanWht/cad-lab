/**
 * 楼层模型导出：把墙体几何打包成可被主应用复用的 glTF 二进制（.glb）。
 *
 * 说明：
 * - 只导出墙体网格，预览用的网格地面、灯光、相机都不进入导出场景；
 * - 导出前把全部顶点按平面中心平移归零，避免大坐标在 float32 中丢精度，
 *   被减掉的中心写入 manifest.origin，供加载方还原到图纸坐标；
 * - 多层建筑按实例矩阵把每层顶点烘焙进同一份合并网格，不写 InstancedMesh，
 *   保证加载方（含不支持实例化的查看器）都能直接渲染；
 * - manifest 写入 glTF 场景节点的 `extras`，加载方无需额外配对文件；
 * - 导出时把顶点的 z 取负：图纸 +y 为北，而 three.js / 主应用世界坐标以 −z 为北，
 *   直接沿用 z=+y 会让模型在外部查看器里左右手性相反（镜像）；
 * - 镜像会翻转三角形绕序，导出时逐三角形交换后两个顶点，`FrontSide` 材质在导出后依然正确。
 */

import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { floorElevation, type NormalizedBuildingParams } from './buildingModel'
import { boxProjectUvs } from './surfaceUv'
import { DEFAULT_WALL_MATERIAL, type WallMaterialParams } from './materialModel'
import {
  collectOpeningVertices,
  createOpeningMaterials,
  OPENING_FRAME_GROUP,
  OPENING_GLASS_GROUP,
  OPENING_HARDWARE_GROUP,
  OPENING_LEAF_GROUP,
  type OpeningVertexBuckets,
} from './openingModel'
import type { WallGeometryResult } from './wallModel'
import type { SlabGeometry } from './slabOutline'
import {
  createCurtainMaterials,
  CURTAIN_FRAME_GROUP,
  CURTAIN_GLASS_GROUP,
  CURTAIN_MASSING_GROUP,
  type CurtainWallGeometry,
} from './curtainModel'

/** 顶点合并容差（米），即 0.1mm */
const MERGE_TOLERANCE = 1e-4

/** 每层记录，写入 manifest.floors */
export interface FloorRecord {
  /** 楼层下标，从 0 起 */
  index: number
  /** 楼层标高（米） */
  elevation: number
}

/** 导出物料的还原信息，写入 glTF 场景节点的 extras */
export interface FloorExportManifest {
  /** 模型中心的图纸坐标（米）；顶点 x = 图纸 x − origin.x，顶点 z = origin.y − 图纸 y */
  origin: { x: number; y: number }
  /** 1 图纸单位 = unitScale 米，供加载方换算回原始单位 */
  unitScale: number
  /** 墙高（米） */
  wallHeight: number
  /** 参与导出的图层及其墙厚（米） */
  thicknessByLayer: Record<string, number>
  /** 平移前的平面包围盒（米） */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** 楼板厚度（米）；没有绘制地板轮廓时不写该字段 */
  slabThickness?: number
  /** 多层建筑的楼层清单；单层导出不写该字段，与既有格式保持一致 */
  floors?: FloorRecord[]
  /** 门窗构件统计；没有门窗时不写该字段 */
  openings?: { doors: number; windows: number }
  /** 玻璃幕墙统计；没有幕墙时不写该字段 */
  curtain?: { segments: number; panels: number }
}

/**
 * 一层的导出几何：墙体与可选楼板。
 *
 * 逐层删墙后每层可能不同，导出必须按层取各自的几何，不能拿一层烘焙到底；
 * 没有单独编辑过的楼层直接复用同一份对象，导出侧不做去重也不受影响。
 * 楼板整栋唯一，每层都指向同一份几何，按各自标高烘焙。
 */
export interface FloorExportGeometry {
  walls: WallGeometryResult
  /** 整栋共用的楼板几何；null / 省略表示没有绘制地板轮廓 */
  slab?: SlabGeometry | null
  /** 玻璃幕墙几何；null / 省略表示该层没有幕墙 */
  curtain?: CurtainWallGeometry | null
}

/** 墙体表面贴图：与预览共用同一批贴图对象，导出时连同 UV 一起写入 .glb */
export interface WallExportTextures {
  /** 颜色贴图；它的 repeat 会烘焙进 UV，不依赖 KHR_texture_transform */
  map: THREE.Texture | null
  /** 粗糙度贴图；null / 省略表示不使用 */
  roughnessMap?: THREE.Texture | null
  /** 法线贴图；null / 省略表示不使用 */
  normalMap?: THREE.Texture | null
  /** 法线强度；与预览材质的 normalScale 保持一致 */
  normalScale?: number
}

/** 程序化构件导出项（屋顶 / 底座 / 大门 / 立面） */
export interface FloorExportDecor {
  /** 构件容器；导出时复制节点，不改动预览里的对象 */
  object: THREE.Object3D
  /** 所属楼层下标，导出时按该层标高抬升 */
  floorIndex: number
}

/** 生成导出场景时需要的上下文 */
export interface FloorExportOptions {
  unitScale: number
  wallHeight: number
  thicknessByLayer: Record<string, number>
  /** 墙体 PBR 材质；省略时用默认灰色金属 */
  material?: WallMaterialParams
  /** 墙体表面贴图；省略时导出为纯色材质，也不生成 UV */
  textures?: WallExportTextures | null
}

/** 导出载荷：场景与配套 manifest */
export interface FloorExportPayload {
  scene: THREE.Scene
  manifest: FloorExportManifest
}

/**
 * 构建只含墙体网格的单层导出场景。
 * 未生成墙体时直接抛错，由界面给出明确提示，不做空模型兜底。
 */
export function buildExportScene(
  walls: WallGeometryResult,
  options: FloorExportOptions,
): FloorExportPayload {
  if (walls.positions.length === 0) throw new Error('没有可导出的墙体几何，请先生成楼层模型')
  const buckets = collectOpeningVertices(walls.openings)
  return assemble(
    walls.positions,
    null,
    buckets,
    walls.bounds,
    options,
    null,
    null,
    countOpenings(walls),
    null,
    null,
    [],
  )
}

/**
 * 构建整栋建筑的导出场景：按楼层取各自的墙体，按标高烘焙进合并网格。
 * 单层时与 `buildExportScene` 等价，且不写 `extras.floors`。
 * 存在楼板时每层按同一份楼板几何、按各自标高烘焙，`extras` 写入板厚。
 * 程序化构件（屋顶 / 底座 / 大门 / 立面）按所属楼层标高挂进同一场景，
 * 材质与贴图随节点一起导出。
 */
export function buildBuildingExportScene(
  floors: FloorExportGeometry[],
  params: NormalizedBuildingParams,
  options: FloorExportOptions,
  decor: ReadonlyArray<FloorExportDecor> = [],
): FloorExportPayload {
  if (floors.length !== params.floorCount) {
    throw new Error(`楼层几何数量与楼层数不一致：${floors.length} / ${params.floorCount}`)
  }
  for (const item of decor) {
    if (
      !Number.isInteger(item.floorIndex) ||
      item.floorIndex < 0 ||
      item.floorIndex >= params.floorCount
    ) {
      throw new Error(`构件楼层下标超出范围：${item.floorIndex} / ${params.floorCount}`)
    }
  }

  let wallVertices = 0
  let slabVertices = 0
  let curtainFrameVertices = 0
  let curtainGlassVertices = 0
  let curtainMassingVertices = 0
  for (const floor of floors) {
    wallVertices += floor.walls.positions.length
    if (floor.slab) slabVertices += floor.slab.positions.length
    if (floor.curtain) {
      curtainFrameVertices += floor.curtain.frames.length
      curtainGlassVertices += floor.curtain.glass.length
      curtainMassingVertices += floor.curtain.massing.length
    }
  }
  if (wallVertices === 0) throw new Error('没有可导出的墙体几何，请先生成楼层模型')

  const bakedWalls = new Float32Array(wallVertices)
  const bakedSlabs = slabVertices > 0 ? new Float32Array(slabVertices) : null
  const bakedCurtainFrames = curtainFrameVertices > 0 ? new Float32Array(curtainFrameVertices) : null
  const bakedCurtainGlass = curtainGlassVertices > 0 ? new Float32Array(curtainGlassVertices) : null
  const bakedCurtainMassing =
    curtainMassingVertices > 0 ? new Float32Array(curtainMassingVertices) : null
  // 门窗构件按材质分桶烘焙：每层顶点按各自标高抬高后再汇入同一个桶
  const bakedOpenings = emptyOpeningBuckets()
  let doorCount = 0
  let windowCount = 0
  let curtainSegments = 0
  let curtainPanels = 0
  let wallCursor = 0
  let slabCursor = 0
  let curtainFrameCursor = 0
  let curtainGlassCursor = 0
  let curtainMassingCursor = 0
  for (let index = 0; index < floors.length; index += 1) {
    const offsetY = floorElevation(index, params)
    wallCursor = appendShifted(bakedWalls, wallCursor, floors[index].walls.positions, offsetY)
    const slab = floors[index].slab
    if (bakedSlabs && slab) {
      slabCursor = appendShifted(bakedSlabs, slabCursor, slab.positions, offsetY)
    }
    // 幕墙：整栋共用同一份几何，但每层都要按各自标高烘焙一份；白膜墙同理
    const curtain = floors[index].curtain
    if (curtain) {
      if (bakedCurtainFrames) {
        curtainFrameCursor = appendShifted(
          bakedCurtainFrames,
          curtainFrameCursor,
          curtain.frames,
          offsetY,
        )
      }
      if (bakedCurtainGlass) {
        curtainGlassCursor = appendShifted(
          bakedCurtainGlass,
          curtainGlassCursor,
          curtain.glass,
          offsetY,
        )
      }
      if (bakedCurtainMassing) {
        curtainMassingCursor = appendShifted(
          bakedCurtainMassing,
          curtainMassingCursor,
          curtain.massing,
          offsetY,
        )
      }
      curtainSegments += curtain.segmentCount
      curtainPanels += curtain.paneCount
    }
    const localOpenings = collectOpeningVertices(floors[index].walls.openings)
    appendOpeningBucket(bakedOpenings.frame, localOpenings.frame, offsetY)
    appendOpeningBucket(bakedOpenings.leaf, localOpenings.leaf, offsetY)
    appendOpeningBucket(bakedOpenings.glass, localOpenings.glass, offsetY)
    appendOpeningBucket(bakedOpenings.hardware, localOpenings.hardware, offsetY)
    for (const opening of floors[index].walls.openings) {
      if (opening.kind === 'door') doorCount += 1
      else windowCount += 1
    }
  }

  const floorRecords: FloorRecord[] | null =
    params.floorCount > 1
      ? Array.from({ length: params.floorCount }, (_, index) => ({
          index,
          elevation: floorElevation(index, params),
        }))
      : null

  // 三类顶点可能只有其一（例如全部是白膜墙），缺失的用空数组占位，assemble 会跳过空网格
  const hasCurtain =
    bakedCurtainFrames !== null || bakedCurtainGlass !== null || bakedCurtainMassing !== null

  return assemble(
    bakedWalls,
    bakedSlabs,
    bakedOpenings,
    unionBounds(floors),
    options,
    floorRecords,
    bakedSlabs ? params.slabThickness : null,
    { doors: doorCount, windows: windowCount },
    hasCurtain
      ? {
          frames: bakedCurtainFrames ?? new Float32Array(0),
          glass: bakedCurtainGlass ?? new Float32Array(0),
          massing: bakedCurtainMassing ?? new Float32Array(0),
        }
      : null,
    curtainSegments > 0 ? { segments: curtainSegments, panels: curtainPanels } : null,
    decor.map((item) => ({
      object: item.object,
      elevation: floorElevation(item.floorIndex, params),
    })),
  )
}

/** 空的材质分桶 */
function emptyOpeningBuckets(): OpeningVertexBuckets {
  return { frame: [], leaf: [], glass: [], hardware: [] }
}

/** 把一层门窗顶点按标高抬升后追加进整栋桶 */
function appendOpeningBucket(target: number[], source: number[], offsetY: number): void {
  for (let index = 0; index < source.length; index += 3) {
    target.push(source[index], source[index + 1] + offsetY, source[index + 2])
  }
}

/** 统计一层门窗数量 */
function countOpenings(walls: WallGeometryResult): { doors: number; windows: number } {
  let doors = 0
  let windows = 0
  for (const opening of walls.openings) {
    if (opening.kind === 'door') doors += 1
    else windows += 1
  }
  return { doors, windows }
}

/**
 * 整栋平面包围盒：逐层取并集，墙体与楼板都要覆盖。
 *
 * 某一层删掉边缘墙段后包围盒会变窄，拿单层包围盒当整栋原点会让其它楼层的顶点
 * 平移量不一致，因此必须覆盖每一层的墙体与楼板范围。
 */
function unionBounds(floors: FloorExportGeometry[]): WallGeometryResult['bounds'] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const floor of floors) {
    const bounds = floor.walls.bounds
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
    if (floor.slab) {
      minX = Math.min(minX, floor.slab.bounds.minX)
      minY = Math.min(minY, floor.slab.bounds.minY)
      maxX = Math.max(maxX, floor.slab.bounds.maxX)
      maxY = Math.max(maxY, floor.slab.bounds.maxY)
    }
    // 幕墙可能细长地伸出墙体之外（雨篷、连廊），包围盒必须一并覆盖
    if (floor.curtain) {
      minX = Math.min(minX, floor.curtain.bounds.minX)
      minY = Math.min(minY, floor.curtain.bounds.minY)
      maxX = Math.max(maxX, floor.curtain.bounds.maxX)
      maxY = Math.max(maxY, floor.curtain.bounds.maxY)
    }
  }
  return { minX, minY, maxX, maxY }
}

/** 把一段顶点抬高 `offsetY` 后写入目标数组，返回新的游标；平面中心归零交给 assemble 统一处理 */
function appendShifted(
  target: Float32Array,
  cursor: number,
  source: Float32Array,
  offsetY: number,
): number {
  for (let index = 0; index < source.length; index += 3) {
    target[cursor] = source[index]
    target[cursor + 1] = source[index + 1] + offsetY
    target[cursor + 2] = source[index + 2]
    cursor += 3
  }
  return cursor
}

/**
 * 把已知顶点数组装配成导出场景。
 * @param wallsRaw 墙体顶点（米，未经平面归零）；调用方负责按楼层烘焙
 * @param slabsRaw 楼板顶点（米，未经平面归零）；null 表示没有楼板
 * @param openings 门窗顶点分桶（米，未经平面归零）；空桶表示该材质无构件
 * @param floors 楼层清单；为 null 时不写 extras.floors
 * @param slabThickness 板厚（米）；null 时不写 extras.slabThickness
 * @param openingCounts 门窗数量；为零时不写 extras.openings
 * @param curtainRaw 幕墙顶点（铝框 / 玻璃 / 白膜墙分开，米，未经平面归零）；null 表示没有幕墙
 * @param curtainCounts 幕墙统计；为零时不写 extras.curtain
 * @param decor 程序化构件与各自标高（米）；空数组表示不导出构件
 */
function assemble(
  wallsRaw: Float32Array,
  slabsRaw: Float32Array | null,
  openings: OpeningVertexBuckets,
  bounds: WallGeometryResult['bounds'],
  options: FloorExportOptions,
  floors: FloorRecord[] | null,
  slabThickness: number | null,
  openingCounts: { doors: number; windows: number },
  curtainRaw: { frames: Float32Array; glass: Float32Array; massing: Float32Array } | null,
  curtainCounts: { segments: number; panels: number } | null,
  decor: ReadonlyArray<{ object: THREE.Object3D; elevation: number }>,
): FloorExportPayload {
  if (!(options.unitScale > 0)) throw new Error(`单位换算比例必须为正数：${options.unitScale}`)
  if (!(options.wallHeight > 0)) throw new Error(`墙高必须为正数：${options.wallHeight}`)

  const originX = (bounds.minX + bounds.maxX) / 2
  const originY = (bounds.minY + bounds.maxY) / 2

  const textures = options.textures ?? null
  const geometry = buildMergedGeometry(
    wallsRaw,
    originX,
    originY,
    'wall-geometry',
    textures !== null,
  )
  const material = new THREE.MeshStandardMaterial({
    color: options.material?.color ?? DEFAULT_WALL_MATERIAL.color,
    roughness: options.material?.roughness ?? DEFAULT_WALL_MATERIAL.roughness,
    metalness: options.material?.metalness ?? DEFAULT_WALL_MATERIAL.metalness,
    side: THREE.FrontSide,
  })
  if (textures) {
    material.map = textures.map
    material.roughnessMap = textures.roughnessMap ?? null
    material.normalMap = textures.normalMap ?? null
    if (textures.normalMap) material.normalScale.setScalar(textures.normalScale ?? 1)
  }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'walls'

  const scene = new THREE.Scene()
  scene.name = 'cad-floor'
  scene.add(mesh)

  if (slabsRaw) {
    const slabGeometry = buildMergedGeometry(slabsRaw, originX, originY, 'slab-geometry')
    // 楼板与墙同色系但更暗一档，避免板面与墙面糊成一片
    const slabColor = new THREE.Color(options.material?.color ?? DEFAULT_WALL_MATERIAL.color).multiplyScalar(0.9)
    const slabMaterial = new THREE.MeshStandardMaterial({
      color: slabColor,
      roughness: 0.88,
      metalness: 0,
      side: THREE.FrontSide,
    })
    const slabMesh = new THREE.Mesh(slabGeometry, slabMaterial)
    slabMesh.name = 'slabs'
    scene.add(slabMesh)
  }

  // 门窗构件：按材质组分别合并成网格，网格名与材质疑义一一对应，
  // 加载方可按名字单独控制门扇 / 玻璃的显隐（如剖切时隐藏门窗）
  const openingMaterials = createOpeningMaterials()
  const openingGroups: Array<{ name: string; positions: number[]; materialIndex: number }> = [
    { name: 'opening-frames', positions: openings.frame, materialIndex: OPENING_FRAME_GROUP },
    { name: 'opening-leaves', positions: openings.leaf, materialIndex: OPENING_LEAF_GROUP },
    { name: 'opening-glass', positions: openings.glass, materialIndex: OPENING_GLASS_GROUP },
    { name: 'opening-hardware', positions: openings.hardware, materialIndex: OPENING_HARDWARE_GROUP },
  ]
  for (const group of openingGroups) {
    if (group.positions.length === 0) continue
    const openingGeometry = buildMergedGeometry(
      new Float32Array(group.positions),
      originX,
      originY,
      `${group.name}-geometry`,
    )
    const openingMesh = new THREE.Mesh(openingGeometry, openingMaterials[group.materialIndex])
    openingMesh.name = group.name
    scene.add(openingMesh)
  }

  // 玻璃幕墙：铝框、玻璃与白膜墙分成三个网格，透明玻璃保留 opacity，
  // 加载方可按名称 `curtain-glass` 单独做折射 / 环境反射替换，
  // 白膜墙 `curtain-massing` 为无贴图白色实体，可直接沿用默认墙体材质
  if (curtainRaw) {
    const curtainMaterials = createCurtainMaterials()
    const curtainParts: Array<{ name: string; positions: Float32Array; materialIndex: number }> = [
      { name: 'curtain-frames', positions: curtainRaw.frames, materialIndex: CURTAIN_FRAME_GROUP },
      { name: 'curtain-glass', positions: curtainRaw.glass, materialIndex: CURTAIN_GLASS_GROUP },
      { name: 'curtain-massing', positions: curtainRaw.massing, materialIndex: CURTAIN_MASSING_GROUP },
    ]
    for (const part of curtainParts) {
      if (part.positions.length === 0) continue
      const curtainGeometry = buildMergedGeometry(
        part.positions,
        originX,
        originY,
        `${part.name}-geometry`,
      )
      const curtainMesh = new THREE.Mesh(curtainGeometry, curtainMaterials[part.materialIndex])
      curtainMesh.name = part.name
      scene.add(curtainMesh)
    }
  }

  const manifest: FloorExportManifest = {
    origin: { x: originX, y: originY },
    unitScale: options.unitScale,
    wallHeight: options.wallHeight,
    thicknessByLayer: { ...options.thicknessByLayer },
    bounds: { ...bounds },
  }
  if (floors !== null) manifest.floors = floors
  if (slabThickness !== null) manifest.slabThickness = slabThickness
  if (openingCounts.doors + openingCounts.windows > 0) manifest.openings = openingCounts
  if (curtainCounts) manifest.curtain = curtainCounts

  // GLTFExporter 会把 Object3D.userData 原样写入节点的 extras
  scene.userData = manifest

  // 程序化构件最后挂载：材质、贴图与节点层级由 glTF 一并承载
  if (decor.length > 0) scene.add(buildDecorGroup(decor, originX, originY))

  return { scene, manifest }
}

/**
 * 把程序化构件挂进导出场景。
 *
 * 构件与墙体顶点必须使用同一套换算（平移归零 + z 镜像），否则屋顶 / 大门会
 * 偏离墙体。构件是带材质与贴图的 three 对象，逐顶点改写代价高且会污染预览数据，
 * 因此用父节点的负 z 缩放表达镜像：glTF 2.0 规定负行列式变换由加载方翻转绕序，
 * 主流加载器（three / Blender / Babylon）都能正确渲染。
 */
function buildDecorGroup(
  items: ReadonlyArray<{ object: THREE.Object3D; elevation: number }>,
  originX: number,
  originY: number,
): THREE.Group {
  const root = new THREE.Group()
  root.name = 'procedural-decor'
  root.position.set(-originX, 0, originY)
  root.scale.set(1, 1, -1)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const wrapper = new THREE.Group()
    wrapper.name = `procedural-${decorKind(item.object)}-${index}`
    wrapper.position.y = item.elevation
    wrapper.add(cloneDecorObject(item.object))
    root.add(wrapper)
  }
  return root
}

/** 构件种类：优先取 adapter 写入的标记，缺失时回落到节点名 */
function decorKind(object: THREE.Object3D): string {
  const kind = object.userData.__kitKind
  return typeof kind === 'string' && kind.length > 0 ? kind : object.name || 'decor'
}

/**
 * 复制构件节点树，只保留几何与材质。
 *
 * 不用 `Object3D.clone`：它会把 userData 走一遍 JSON 序列化，而构件 userData 里存着
 * 材质与 Vector3（LOD 注册表用），复制既昂贵也容易丢原型；导出只需要网格本身。
 */
function cloneDecorObject(source: THREE.Object3D): THREE.Object3D {
  // 构件只有网格与容器两类；出现别的节点类型说明构建器变了，直接报错而不是静默丢掉
  if (!(source instanceof THREE.Mesh) && !(source instanceof THREE.Group)) {
    throw new Error(`无法导出的构件节点类型：${source.type}`)
  }
  const copy =
    source instanceof THREE.Mesh
      ? new THREE.Mesh(source.geometry, source.material)
      : new THREE.Group()
  copy.name = source.name
  copy.position.copy(source.position)
  copy.quaternion.copy(source.quaternion)
  copy.scale.copy(source.scale)
  // 不复制 visible：预览按相机距离隐藏远景构件，导出的静态模型必须始终显示细部
  for (const child of source.children) copy.add(cloneDecorObject(child))
  return copy
}

/**
 * 顶点（米，未归零）→ 镜像到世界轴 → 平移到中心 → 平面法线 → 合并重复顶点。
 *
 * 图纸包围盒中心是 `originY`（图纸 y），镜像后世界 z 的中心是 `-originY`，
 * 因此平移量为 `originY - z`，而非原来的 `z - originY`。
 * 先算平面法线再合并顶点：合并会把「位置相同但法线不同」的顶点视为不同，
 * 因此表面保持平面着色，同时重复顶点仍能被压掉。
 *
 * @param withUv 是否生成盒式投影 UV；有贴图时必须生成，否则颜色 / 法线 / 粗糙度
 *   贴图无处采样。贴图的 repeat / offset 由 GLTFExporter 写成 KHR_texture_transform，
 *   因此 UV 只按米制坐标输出，不在这里预先缩放
 */
function buildMergedGeometry(
  source: Float32Array,
  originX: number,
  originY: number,
  name: string,
  withUv = false,
): THREE.BufferGeometry {
  // 顶点布局为 (x, 高度, z)，其中 z 对应图纸的 y
  if (source.length % 9 !== 0) {
    throw new Error(`导出的顶点数组不是三角形列表：长度 ${source.length}`)
  }
  const shifted = new Float32Array(source.length)
  const writeVertex = (readBase: number, writeBase: number): void => {
    shifted[writeBase] = source[readBase] - originX
    shifted[writeBase + 1] = source[readBase + 1]
    shifted[writeBase + 2] = originY - source[readBase + 2]
  }
  // UV 取镜像前的坐标：与预览用的盒式投影完全一致，镜像后的三角形再按同一套
  // 顶点交换顺序重排 UV
  const uvSource = withUv ? boxProjectUvs(source) : null
  const uv = uvSource ? new Float32Array(uvSource.length) : null
  const writeUv = (readVertex: number, writeVertexIndex: number): void => {
    if (!uvSource || !uv) return
    uv[writeVertexIndex * 2] = uvSource[readVertex * 2]
    uv[writeVertexIndex * 2 + 1] = uvSource[readVertex * 2 + 1]
  }
  for (let index = 0; index < source.length; index += 9) {
    // 镜像翻转绕序，交换每个三角形的后两个顶点，保证外法线仍朝外
    const vertex = index / 3
    writeVertex(index, index)
    writeUv(vertex, vertex)
    writeVertex(index + 6, index + 3)
    writeUv(vertex + 2, vertex + 1)
    writeVertex(index + 3, index + 6)
    writeUv(vertex + 1, vertex + 2)
  }

  const raw = new THREE.BufferGeometry()
  raw.setAttribute('position', new THREE.BufferAttribute(shifted, 3))
  if (uv) raw.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  raw.computeVertexNormals()
  const geometry = mergeVertices(raw, MERGE_TOLERANCE)
  raw.dispose()
  geometry.name = name
  return geometry
}

/** 把导出场景序列化为 .glb 二进制 */
export async function exportGlb(payload: FloorExportPayload): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter()
  const result = await exporter.parseAsync(payload.scene, { binary: true })
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('glTF 导出未返回二进制数据')
  }
  return result
}
