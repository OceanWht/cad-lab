<script setup lang="ts">
/**
 * CAD 图纸解析试验台。
 *
 * 独立入口（cad-lab.html），不经过主应用路由与鉴权，
 * 也不引用任何既有模块，便于快速验证「解析 → 图层 → 渲染 → 楼层模型」链路。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { CadDrawing } from './core/types'
import { disposeCadParser, parseCadFile, resolveWasmDir } from './core/parseClient'
import {
  floorGap,
  normalizeBuildingParams,
  type NormalizedBuildingParams,
} from './core/buildingModel'
import { appendOutlineHole, buildSlabGeometry, clearOutlineHoles, validateOutline, type OutlinePoint, type SlabOutline } from './core/slabOutline'
import {
  DEFAULT_WALL_MATERIAL,
  normalizeWallMaterial,
  WALL_MATERIAL_PRESETS,
  type WallMaterialParams,
  type WallMaterialPreset,
} from './core/materialModel'
import {
  buildWallGeometry,
  collectWallSegmentsLoose,
  filterDiagonalShortSegments,
  inferWallThicknesses,
  openingObjectKey,
  pairDoubleLineWalls,
  resolveLayerThicknessFromName,
  snapWallEndpoints,
  type WallGeometryResult,
  type WallOpening,
  type WallOpeningPlacement,
  type WallPairingResult,
  type WallPiece,
  type WallSegment,
} from './core/wallModel'
import {
  buildCurtainWallGeometry,
  CURTAIN_KEY_PREFIX,
  curtainObjectKey,
  cutCurtainLines,
  curtainVertexCount,
  mergeCurtainGeometries,
  planCurtainWalls,
  type CurtainLine,
  type CurtainWallGeometry,
} from './core/curtainModel'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  recognizeOpenings,
  recommendOpeningKinds,
  type OpeningKind,
  type OpeningSpec,
} from './core/doorWindowModel'
import {
  addRemovedKeys,
  cloneRemovalScope,
  removedKeyCount,
  removedKeysForFloor,
  removalSignature,
  type RemovalScope,
} from './core/floorEdit'
import {
  buildClosureSegments,
  planWallClosure,
  type WallClosurePath,
} from './core/wallClosure'
import { resolveLayerRoles } from './core/layerRoles'
import {
  doorLayerWallLines,
  keepMassingDoor,
  massingDoorCuts,
  massingDoorLintels,
  recognizeMassingDoors,
} from './core/massingDoors'
import {
  buildBuildingPackageGeoJson,
  type BuildingPackageGeoJson,
  type BuildingPackageStats,
} from './core/exportBuildingGeoJson'
import { CadPlanView, type OutlineGuides, type OutlinePurpose, type OutlineTool } from './viewport/CadPlanView'
import {
  FloorModelView,
  floorObjectKeys,
  type BuildingGeometry,
  type CameraMode,
  type FloorGeometry,
  type SelectionMode,
} from './viewport/FloorModelView'
import {
  buildProceduralKit,
  disposeProceduralKit,
  type ProceduralKitAppearance,
  type ProceduralKitResult,
} from '../adapter/proceduralKit'
import { createFacadeWallTexture, disposeFacadeWallTexture } from '../adapter/facadeSkin'
import { createFacadeFaceConfig } from '../lib/facade/facadeTypes'
import { defaultPodiumConfig } from '../lib/podium/podiumTypes'
import { defaultRoofConfig } from '../lib/roof/roofTypes'
import { createEntranceGateConfig } from '../lib/gate/gateTypes'
import type {
  EntranceGateStyle,
  FacadeStyle,
  PodiumType,
  RoofType,
} from '../shared/types'
import type { WallRing } from './core/wallTopology'
import type { Group, Texture } from 'three'

/**
 * 图层在生成时的角色：门 / 窗 / 幕墙 / 显式实体墙。
 * 未设置（下拉为「忽略」）与「墙体」的图层都按白膜墙生成（沿窗线拉薄墙，不带幕墙材质）。
 */
type LayerOpeningKind = OpeningKind | 'curtain' | 'wall'

const planElement = ref<HTMLElement | null>(null)
const floorElement = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const drawing = ref<CadDrawing | null>(null)
const parsing = ref(false)
const errorMessage = ref('')
const activeTab = ref<'plan' | 'floor'>('plan')
const layerSearch = ref('')
/** 楼层数（1–100），上限由参数校验统一约束；首次生成前由 floorCountLocked 锁定为 1 */
const floorCount = ref(1)
/** 层间距（米），相邻两层板顶之间的高差 */
const floorSpacing = ref(3)
/** 墙高（米）：必须与板厚之和不超过层间距，差值就是楼层之间的空隙 */
const wallHeight = ref(2.8)
/** 楼板厚度（米）：板顶与墙脚齐平，板厚向下占用层间距 */
const slabThickness = ref(0.2)
/** 楼层之间的空隙（米）：层间距减墙高再减板厚，只用于面板提示 */
const wallGap = computed(() => floorGap(floorSpacing.value, wallHeight.value, slabThickness.value))
/** 已提交的地板轮廓；null 表示未绘制，不生成楼板 */
const slabOutline = ref<SlabOutline | null>(null)
/** 是否处于平面绘制模式（楼板轮廓 / 墙体闭合共用同一套落点交互） */
const outlineDrawing = ref(false)
/** 当前绘制用途：楼板轮廓或墙体闭合 */
const outlinePurpose = ref<OutlinePurpose>('slab')
/** 当前绘制工具 */
const outlineTool = ref<OutlineTool>('line')
/** 绘制中已落定的段数，用于提示进度 */
const outlineSegments = ref(0)
/** 用户手动绘制的墙体闭合连接线；可有多条（多个开口分别闭合），空数组表示未做手动闭合 */
const wallClosures = ref<WallClosurePath[]>([])
/** 墙体材质预置：默认灰色 + 金属度 1 + 粗糙度 0.5，生成模型时即生效，多层沿用同一份 */
const wallColor = ref(DEFAULT_WALL_MATERIAL.color)
const wallMetalness = ref(DEFAULT_WALL_MATERIAL.metalness)
const wallRoughness = ref(DEFAULT_WALL_MATERIAL.roughness)
const wallSummary = ref<{
  segments: number
  length: number
  skipped: number
  /** 双线墙实测的墙段数（每对双线计一道墙） */
  paired: number
  /** 未配对、按图层标注或图纸实测厚度建墙的单线条数 */
  unpaired: number
  /** 实测墙厚取值（米，升序去重） */
  measured: number[]
  /** 未标注厚度的单线按图纸证据回填的条数 */
  filled: { sameLayer: number; parallel: number; neighbor: number }
  /** 墙端延伸吸附到相邻墙体的数量 */
  snappedCount: number
  /** 被判为斜向短线而剔除的线段数 */
  droppedDiagonal: number
  /** 三种证据都取不到厚度、被跳过的单线条数 */
  skippedUnresolved: number
  /** 墙厚解析不到、已跳过的图层 */
  unresolvedLayers: string[]
  /** 本次生成使用的墙体图层（含未标注厚度的图层，重建时沿用） */
  layers: string[]
  /** 本次生成使用的楼层参数快照 */
  params: NormalizedBuildingParams
  /** 本次生成使用的图层墙厚（米，仅含有明确厚度的图层） */
  thicknessByLayer: Record<string, number>
  /** 本次生成使用的门窗图层配置，重建时沿用同一份 */
  openingKinds: Record<string, LayerOpeningKind>
  /** 玻璃幕墙统计；null 表示本次没有识别到幕墙 */
  curtain: { layers: string[]; segments: number; mullions: number; panes: number; totalLength: number } | null
  /** 白膜墙统计（未设置门窗类型与「墙体」图层）；null 表示本次没有白膜墙 */
  massing: { layers: string[]; segments: number; totalLength: number } | null
  /** 导出版本的顶点数（逐层墙体之和），用于导出前估算烘焙规模 */
  vertices: number
} | null>(null)
const exporting = ref(false)
/** 最近一次重建的整栋几何与参数快照，供建筑包导出复用，避免重算 */
const lastBuildingGeometry = ref<BuildingGeometry | null>(null)
const lastBuildingParams = ref<NormalizedBuildingParams | null>(null)
/**
 * 楼层数是否锁定：首次生成（wallSummary 为空）前没有可堆叠的几何，
 * 强制固定为单层，生成完成后才允许修改层数。
 */
const floorCountLocked = computed(() => wallSummary.value === null)
/**
 * 删墙作用范围：未选中楼层时写全局（作用于每一层），
 * 选中楼层时只写该层的追加集合，其他楼层不受影响。
 */
const removal = ref<RemovalScope>({ global: new Set(), floors: [] })
/** 当前选中的对象键（墙段 / 门窗 / 幕墙混合） */
const selection = ref<Set<string>>(new Set())
/** 每次删除前的删除范围快照，用于多级撤销 */
const undoStack = ref<RemovalScope[]>([])
/** 当前几何的全部墙段片段，供全选 / 反选与删除确认统计；编辑态取编辑目标楼层的片段 */
const lastPieces = ref<WallPiece[]>([])
/** 当前编辑目标里所有可拾取对象（墙段 / 门窗 / 幕墙）的键，供全选 / 反选与删除统计 */
const lastObjectKeys = ref<string[]>([])
/** 是否处于墙段编辑模式 */
const editMode = ref(false)
/** 编辑态当前编辑的楼层下标；null 表示整栋同步编辑 */
const editFloor = ref<number | null>(null)
/** 当前相机模式 */
const cameraMode = ref<CameraMode>('orbit')
/** 当前展开的楼层下标；null 表示整栋贴合 */
const expandedFloor = ref<number | null>(null)

/** 底座开关与类型 */
const podiumEnabled = ref(false)
const podiumType = ref<PodiumType>('stone_plinth')
/** 屋顶开关与类型 */
const roofEnabled = ref(false)
const roofType = ref<RoofType>('parapet')
/** 大门开关、风格与净宽净高（米） */
const gateEnabled = ref(false)
const gateStyle = ref<EntranceGateStyle>('office')
const gateWidth = ref(8)
const gateHeight = ref(4.2)
/** 墙面立面开关与风格 */
const facadeEnabled = ref(false)
const facadeStyle = ref<FacadeStyle>('office')
/** 构件禁用原因与提示：缺轮廓、零宽度墙带、超预算等都在这里显式上报 */
const proceduralNotices = ref<string[]>([])
/** 已挂载到楼层视图的构件容器，重建前统一释放 */
let proceduralDecor: Array<Group | null> = []
/** 当前构件外观配置：导出建筑包时一并写入，供 webmap 编辑器重建同名构件 */
let proceduralAppearance: ProceduralKitAppearance | null = null
/** 当前墙面立面贴图：所有楼层共享一份，切换风格时重建 */
let facadeSkinTexture: Texture | null = null

/** 底座类型选项 */
const PODIUM_TYPES: Array<{ value: PodiumType; label: string }> = [
  { value: 'stone_plinth', label: '石材台基' },
  { value: 'arcade', label: '柱廊' },
  { value: 'rotunda', label: '圆台' },
  { value: 'stepped', label: '退台' },
  { value: 'terraced', label: '梯台' },
  { value: 'canopy', label: '雨棚' },
]

/** 屋顶类型选项 */
const ROOF_TYPES: Array<{ value: RoofType; label: string }> = [
  { value: 'parapet', label: '女儿墙' },
  { value: 'lattice', label: '格栅冠' },
  { value: 'oval_rim', label: '椭圆环' },
  { value: 'penthouse', label: '屋顶机房' },
  { value: 'skylight', label: '天窗' },
  { value: 'eave', label: '挑檐' },
]

/** 大门风格选项 */
const GATE_STYLES: Array<{ value: EntranceGateStyle; label: string }> = [
  { value: 'office', label: '办公' },
  { value: 'residential', label: '住宅' },
  { value: 'hospital', label: '医院' },
  { value: 'factory', label: '工厂' },
]

/** 立面风格选项 */
const FACADE_STYLES: Array<{ value: FacadeStyle; label: string }> = [
  { value: 'office', label: '办公' },
  { value: 'residential', label: '住宅' },
  { value: 'hospital', label: '医院' },
  { value: 'factory', label: '厂房' },
  { value: 'curtain_wall', label: '幕墙' },
  { value: 'concrete_punched', label: '清水混凝土' },
  { value: 'brutalist_banded', label: '粗野横带' },
  { value: 'brick_apartment', label: '砖砌住宅' },
  { value: 'stone_office', label: '石材办公' },
]

/**
 * 当前选中的楼层：编辑态看编辑目标，非编辑态看展开楼层。
 * 材质作用范围与面板回填都跟随它。
 */
const activeFloor = computed<number | null>(() => (editMode.value ? editFloor.value : expandedFloor.value))
/** 已删除对象总数（全局 ∪ 各层追加），用于工具栏统计 */
const removedCount = computed(() => removedKeyCount(removal.value))

/** miter 长度上限（相对半墙厚的倍数） */
const MITER_LIMIT = 4
/** 整栋导出顶点数告警阈值：超过后先确认，避免误生成超大文件 */
const EXPORT_VERTEX_WARN = 500000
/** 墙厚允许范围（米） */
const MIN_THICKNESS = 0.02
const MAX_THICKNESS = 2

const layerVisible = reactive<Record<string, boolean>>({})
const wallSelected = reactive<Record<string, boolean>>({})
/** 按图层覆盖墙厚（米）；未覆盖时从图层名里的 100 / 200 / 240 等标注解析，没有全局默认值 */
const wallThicknessByLayer = reactive<Record<string, number>>({})
/** 按图层指定门窗类型；未列出的图层按白膜墙生成 */
const openingKindByLayer = reactive<Record<string, LayerOpeningKind>>({})
/** 最近一次重建的门窗统计，供面板展示 */
const openingSummary = ref<{ doors: number; windows: number; skipped: number; notes: string[] } | null>(null)

/** 门窗图层下拉选项 */
const OPENING_KIND_OPTIONS: { value: LayerOpeningKind | 'none'; label: string }[] = [
  { value: 'none', label: '忽略' },
  { value: 'wall', label: '墙体' },
  { value: 'door', label: '门' },
  { value: 'window', label: '窗' },
  { value: 'curtain', label: '幕墙' },
]

/** 设置某个图层的门窗类型；选「忽略」即从识别集合中移除 */
function setOpeningKind(layerName: string, raw: string): void {
  if (raw !== 'door' && raw !== 'window' && raw !== 'curtain' && raw !== 'wall') {
    delete openingKindByLayer[layerName]
    return
  }
  openingKindByLayer[layerName] = raw
}

let planView: CadPlanView | null = null
let floorView: FloorModelView | null = null

/** 按实体数量倒序，便于快速找到墙、柱等主要图层 */
const sortedLayers = computed(() => {
  if (!drawing.value) return []
  const keyword = layerSearch.value.trim().toLowerCase()
  const layers = drawing.value.layers.filter((layer) => {
    if (keyword.length === 0) return true
    return layer.name.toLowerCase().includes(keyword)
  })
  return layers.slice().sort((a, b) => b.entityCount - a.entityCount)
})

/** 已勾选的墙体图层 */
const selectedWallLayers = computed(() => Object.keys(wallSelected).filter((name) => wallSelected[name]))

/**
 * 取图层墙厚（米）：面板手填值优先，其次从图层名 / 线型名里的厚度标注解析
 * （如 `A-WALL-200`、`墙-240`）。解析不到时返回 NaN，表示该图层没有可用墙厚，
 * 交给双线实测与图纸几何回填（同图层 / 平行墙线 / 端部相连）；
 * 三种证据都没有的单线才会被跳过并在面板提示，不套用任何默认厚度。
 */
function layerThickness(name: string): number {
  const override = wallThicknessByLayer[name]
  if (override !== undefined) return override
  const parsed = resolveLayerThicknessFromName(name)
  return parsed === null ? Number.NaN : parsed
}

/** 墙厚输入框回填：未标注时留空，避免显示 NaN */
function layerThicknessText(name: string): string {
  const value = layerThickness(name)
  return Number.isFinite(value) ? String(value) : ''
}

/** 图层墙厚的来源说明，供输入框 title 使用 */
function layerThicknessHint(name: string): string {
  if (wallThicknessByLayer[name] !== undefined) return '手动填写的墙厚（米）'
  const parsed = resolveLayerThicknessFromName(name)
  if (parsed === null) return '图层名未标注墙厚：将按双线实测 / 同图层 / 平行墙线 / 相邻墙段回填，仍取不到才跳过'
  return `从图层名解析出的墙厚 ${Math.round(parsed * 1000)}mm，可手动覆盖`
}

function setLayerThickness(name: string, raw: string): void {
  if (raw.trim() === '') {
    delete wallThicknessByLayer[name]
    return
  }
  wallThicknessByLayer[name] = Number(raw)
}

/** 墙厚超出允许范围的墙体图层；NaN 表示未标注，不算非法（双线墙仍可实测） */
const invalidWallLayers = computed(() =>
  selectedWallLayers.value.filter((name) => {
    const value = layerThickness(name)
    return Number.isFinite(value) && (value < MIN_THICKNESS || value > MAX_THICKNESS)
  }),
)

const stats = computed(() => drawing.value?.stats ?? null)

function resetLayerState(parsed: CadDrawing): void {
  for (const key of Object.keys(layerVisible)) delete layerVisible[key]
  for (const key of Object.keys(wallSelected)) delete wallSelected[key]
  for (const key of Object.keys(wallThicknessByLayer)) delete wallThicknessByLayer[key]
  for (const key of Object.keys(openingKindByLayer)) delete openingKindByLayer[key]
  // 门窗图层按图层名与块名前缀自动预判，用户可在图层表里改成「忽略 / 门 / 窗」
  const recommended = recommendOpeningKinds(parsed)
  for (const layer of parsed.layers) {
    // 图纸中已关闭 / 冻结的图层默认不显示
    layerVisible[layer.name] = !layer.off && !layer.frozen
    wallSelected[layer.name] = false
    const kind = recommended[layer.name]
    if (kind) openingKindByLayer[layer.name] = kind
  }
  openingSummary.value = null
}

async function loadFile(file: File): Promise<void> {
  const lower = file.name.toLowerCase()
  if (!lower.endsWith('.dxf') && !lower.endsWith('.dwg')) {
    errorMessage.value = '目前只支持 .dxf 与 .dwg 文件。'
    return
  }
  errorMessage.value = ''
  parsing.value = true
  try {
    const parsed = await parseCadFile(file, resolveWasmDir())
    drawing.value = parsed
    resetLayerState(parsed)
    wallSummary.value = null
    lastBuildingGeometry.value = null
    lastBuildingParams.value = null
    // 新图纸尚未生成模型，楼层数回到锁定状态下的固定值 1
    floorCount.value = 1
    activeTab.value = 'plan'
    // 换图纸时清空删除范围、选择集与撤销栈，避免旧键误伤新几何
    removal.value = { global: new Set(), floors: [] }
    selection.value = new Set()
    undoStack.value = []
    lastPieces.value = []
    lastObjectKeys.value = []
    editMode.value = false
    editFloor.value = null
    cameraMode.value = 'orbit'
    // 换图纸后旧轮廓、手动闭合连接线与绘制态一并清空，避免把上一张图的几何带进新模型
    slabOutline.value = null
    wallClosures.value = []
    outlineDrawing.value = false
    outlinePurpose.value = 'slab'
    outlineSegments.value = 0
    planView?.setOutlineGuides(null)
    planView?.setCommittedOutline(null)
    planView?.setDrawing(parsed)
    for (const layer of parsed.layers) {
      planView?.setLayerVisible(layer.name, layerVisible[layer.name])
    }
    floorView?.setEditMode(false)
    floorView?.setCameraMode('orbit')
    floorView?.clearBuilding()
    clearProceduralKit()
    expandedFloor.value = null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    parsing.value = false
  }
}

function handleFileInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void loadFile(file)
  input.value = ''
}

function handleDrop(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0]
  if (file) void loadFile(file)
}

function toggleLayerVisibility(name: string, visible: boolean): void {
  layerVisible[name] = visible
  planView?.setLayerVisible(name, visible)
}

function setAllLayersVisible(visible: boolean): void {
  if (!drawing.value) return
  for (const layer of drawing.value.layers) {
    layerVisible[layer.name] = visible
    planView?.setLayerVisible(layer.name, visible)
  }
}

/** 按图层名推荐墙体图层，省去在几十个图层里逐个寻找 */
function recommendWallLayers(): void {
  if (!drawing.value) return
  for (const layer of drawing.value.layers) {
    const lower = layer.name.toLowerCase()
    const isWall = lower.includes('wall') || layer.name.includes('墙')
    if (isWall) wallSelected[layer.name] = true
  }
}

function fitPlan(): void {
  if (!drawing.value || !planView) return
  planView.fit(drawing.value.focusBounds, drawing.value.unitScale)
}

function ensureFloorView(): FloorModelView {
  if (!floorView && floorElement.value) {
    floorView = new FloorModelView(floorElement.value, {
      onPick: handlePick,
      onEmptyClick: handleEmptyClick,
      onBoxSelect: handleBoxSelect,
      onFloorPick: handleFloorPick,
      onCameraModeChange: (mode) => {
        cameraMode.value = mode
      },
    })
    // 实例可能晚于 UI 状态创建：创建后立即同步，否则会停留在默认的透视轴测视角，
    // 编辑态下也就不会锁成正交俯视
    floorView.setEditMode(editMode.value)
    if (editMode.value) cameraMode.value = 'top'
    floorView.setCameraMode(cameraMode.value)
    floorView.setEditFloor(editFloor.value)
    // 材质预置在视图创建时就要套用：此时生成的模型直接使用面板里的值
    floorView.setWallMaterial({
      color: wallColor.value,
      metalness: Number(wallMetalness.value),
      roughness: Number(wallRoughness.value),
    })
    if (selection.value.size > 0) floorView.setSelection(selection.value)
  }
  if (!floorView) throw new Error('三维视图容器尚未就绪')
  return floorView
}

/** 重建参数快照：删除后重建不读当前表单，避免模型与清单不一致 */
interface BuildParams {
  layers: string[]
  /** 仅含有明确厚度的图层；未标注的图层靠双线实测，不进这张表 */
  thicknessByLayer: Record<string, number>
  openingKinds: Record<string, LayerOpeningKind>
  building: NormalizedBuildingParams
}

/** 墙线与双线配对结果，附带「按图纸证据回填墙厚」与「仍无厚度被跳过」的统计 */
interface CurrentWallSegments {
  segments: WallSegment[]
  pairing: WallPairingResult
  /** 未标注厚度的单线按图纸证据回填的条数 */
  filled: { sameLayer: number; parallel: number; neighbor: number }
  /** 墙端延伸吸附到相邻墙体的数量 */
  snappedCount: number
  /** 被判为斜向短线（门扇 / 开启弧线 / 索引线）而剔除的线段数 */
  droppedDiagonal: number
  /** 三种证据都取不到厚度、被跳过的单线条数 */
  skippedUnresolved: number
  /** 厚度解析不到、被跳过的图层 */
  unresolvedLayers: string[]
}

/**
 * 图纸墙体中心线 + 用户手动绘制的闭合连接线。
 *
 * 墙厚来源（按优先级）：
 * 1. 双线墙配对后的实测垂距；
 * 2. 面板手填 / 图层名里的厚度标注（如 `A-WALL-200`）；
 * 3. 仍未取到的，按图纸自身证据回填：同图层已解墙段 → 平行墙线实测间距 → 端部相连墙段；
 * 4. 三种证据都没有的单线才跳过，计数与图层交给面板提示，不使用任何全局默认墙厚。
 */
function currentWallSegments(
  current: CadDrawing,
  layers: string[],
  thicknessByLayer: Record<string, number>,
): CurrentWallSegments {
  if (layers.length === 0) {
    return {
      segments: [],
      pairing: { segments: [], pairedCount: 0, unpairedCount: 0, measuredThickness: [] },
      filled: { sameLayer: 0, parallel: 0, neighbor: 0 },
      snappedCount: 0,
      droppedDiagonal: 0,
      skippedUnresolved: 0,
      unresolvedLayers: [],
    }
  }
  const collected = collectWallSegmentsLoose(current, layers)
  // 图层名已自带厚度；面板手填值优先覆盖
  for (const segment of collected) {
    const override = thicknessByLayer[segment.layer]
    if (Number.isFinite(override) && override > 0) segment.thickness = override
  }
  // 门扇、开启弧线、索引线都是斜向短线，先剔除，避免沿斜向立起又厚又歪的假墙
  const filtered = filterDiagonalShortSegments(collected, current.unitScale)
  const usable = filtered.segments
  const pairing = pairDoubleLineWalls(usable, current.unitScale)
  // 没有标注厚度的单线不能直接丢掉：一道墙从墙链中间缺失，整条墙链就断了。
  // 先按图纸自身的几何证据回填厚度（参考线用配对前的原始墙线，才能量到真实双线间距）
  const inferred = inferWallThicknesses(pairing.segments, usable, current.unitScale)
  const resolved = inferred.segments.filter((segment) => segment.thickness > 0)
  // 中心线在转角 / T 形接头处短半个墙厚，延伸吸附后再建墙带，接缝才闭合
  const snapped = snapWallEndpoints(resolved, current.unitScale)
  const unresolved = inferred.stats.unresolved
  const skippedUnresolved = Object.values(unresolved).reduce((sum, count) => sum + count, 0)
  const closureSegments = wallClosures.value.flatMap((path) =>
    buildClosureSegments(path, current.unitScale),
  )
  return {
    segments: [...snapped.segments, ...closureSegments],
    pairing: {
      ...pairing,
      segments: snapped.segments,
      // 跳过的单线同样属于未配对，扣除后才是真正按厚度建墙的条数
      unpairedCount: Math.max(0, pairing.unpairedCount - skippedUnresolved),
    },
    filled: {
      sameLayer: inferred.stats.sameLayer,
      parallel: inferred.stats.parallel,
      neighbor: inferred.stats.neighbor,
    },
    snappedCount: snapped.snappedCount,
    droppedDiagonal: filtered.droppedCount,
    skippedUnresolved,
    unresolvedLayers: Object.keys(unresolved),
  }
}

/** 过滤已删除键后重建几何，并同步选择集与统计 */
function rebuild(params: BuildParams, keepView = false): void {
  const current = drawing.value
  if (!current) return
  const view = ensureFloorView()
  const unitScale = current.unitScale

  // 未设置门窗类型（下拉为「忽略」）与显式「墙体」的图层统一按「白膜墙」生成：
  // 沿用幕墙沿中心线拉板的方式生成薄墙，但不带竖梃 / 横档 / 玻璃与任何贴图，
  // 只保留白色体量，不做墙体厚度推断；
  // 显式标记为「幕墙」的图层生成玻璃幕墙，显式标记为「窗」的图层仍按嵌墙窗开洞；
  // 标记为「门」的图层里画的是门扇与开启弧线（斜线 + 圆弧），当成墙建会得到又厚又斜的假墙；
  // 这类图层通常不会被勾选成墙体图层，但它的「门」标记必须参与洞口识别，详见 resolveLayerRoles
  const effectiveKinds = resolveLayerRoles({
    wallLayers: params.layers,
    openingKinds: params.openingKinds,
  })
  const curtainPlan = planCurtainWalls(current, effectiveKinds, unitScale)
  const curtainLayers = new Set(curtainPlan.layers)
  const doorLayers = new Set(
    Object.entries(effectiveKinds)
      .filter(([, kind]) => kind === 'door')
      .map(([name]) => name),
  )
  const excludedDoorLayers = params.layers.filter((name) => doorLayers.has(name))
  // 「墙体」与「忽略」都已按白膜墙生成，实体墙只服务显式「窗」图层的嵌墙洞口
  const wallLayers = params.layers.filter((name) => params.openingKinds[name] === 'window')
  const { segments, pairing, filled, snappedCount, droppedDiagonal, skippedUnresolved, unresolvedLayers } =
    currentWallSegments(current, wallLayers, params.thicknessByLayer)
  const wallOptions = { height: params.building.wallHeight, miterLimit: MITER_LIMIT }
  // 幕墙 / 白膜墙段按对象键索引：删除集合里记的是键，规划阶段先乘单位换算再取键才能与几何输出对上
  const editableCurtainLines = (
    source: readonly CurtainLine[],
  ): Array<{ line: CurtainLine; key: string }> =>
    source.map((line) => ({
      line,
      key: curtainObjectKey({
        a: { x: line.a.x * unitScale, y: line.a.y * unitScale },
        b: { x: line.b.x * unitScale, y: line.b.y * unitScale },
      }),
    }))
  const curtainLines = editableCurtainLines(curtainPlan.lines)
  // 门图层如果同时被勾选成墙体图层（墙线与门块画在同一层），
  // 把其中够长且接近正交的线补成白膜墙：否则整层都会被排除在墙体之外，门也没有宿主
  const doorWallLayers = params.layers.filter((name) => doorLayers.has(name))
  const doorWallLines = doorLayerWallLines(current, doorWallLayers, unitScale)
  if (doorWallLines.lines.length > 0) {
    for (const name of doorWallLayers) {
      if (!curtainPlan.massingLayers.includes(name)) curtainPlan.massingLayers.push(name)
    }
    curtainPlan.notes.push(
      `门图层里的长墙线按白膜墙补齐：${doorWallLines.lines.length} 段（门扇与开启弧线不当墙）。`,
    )
  }
  const massingLines = editableCurtainLines([
    ...curtainPlan.massingLines,
    ...doorWallLines.lines,
  ])

  // 门窗识别以墙中心线为吸附目标，必须在墙体拓扑之前算好；
  // 识别结果按墙段稳定键索引，逐层删除墙体后对应洞口自然失效
  const layerKinds: Record<string, OpeningKind> = {}
  for (const [layer, kind] of Object.entries(effectiveKinds)) {
    // 玻璃幕墙与白膜墙都不参与嵌墙门窗识别：它们本身就是沿中心线的独立构件
    if (kind === 'curtain' || kind === 'massing' || curtainLayers.has(layer)) continue
    layerKinds[layer] = kind
  }
  const recognition = recognizeOpenings(current, {
    layerKinds,
    walls: segments,
    unitScale,
    wallHeight: params.building.wallHeight,
    doorWidth: DEFAULT_DOOR_WIDTH,
    doorHeight: DEFAULT_DOOR_HEIGHT,
    windowWidth: DEFAULT_WINDOW_WIDTH,
    windowHeight: DEFAULT_WINDOW_HEIGHT,
    windowSill: DEFAULT_WINDOW_SILL,
  })
  const wallOpenings: WallOpening[] = recognition.openings.map((spec: OpeningSpec) => ({
    key: openingObjectKey(spec),
    wallKey: spec.wallKey,
    kind: spec.kind,
    start: spec.start,
    end: spec.end,
    sill: spec.sill,
    height: spec.height,
    preset: spec.preset,
    ...(spec.windowPart ? { windowPart: spec.windowPart } : {}),
    ...(spec.transom ? { transom: spec.transom } : {}),
  }))
  /** 剔除已删除的门窗构件；没有键的洞口不参与编辑态删除 */
  const keepOpenings = (removed: ReadonlySet<string>): WallOpening[] =>
    wallOpenings.filter((opening) => opening.key === undefined || !removed.has(opening.key))

  /**
   * 白膜墙上的门：白膜墙没有 WallPiece 可以开洞，门块却常画在这些墙线上，
   * 因此把白膜中心线当作合成墙段单独识别一次门。只处理显式「门」图层，
   * 实体墙上的门窗分支保持原样。
   */
  const massingDoors = recognizeMassingDoors(current, {
    doorLayers: [...doorLayers],
    hostLines: massingLines.map((entry) => ({ line: entry.line, key: entry.key })),
    existingDoors: recognition.openings,
    unitScale,
    wallHeight: params.building.wallHeight,
    doorWidth: DEFAULT_DOOR_WIDTH,
    doorHeight: DEFAULT_DOOR_HEIGHT,
  })
  // 门识别的输入输出一次性打出来：出现「选了门却没有门模型」时可直接对着数字排查
  console.info('[cad-lab] 门窗识别', {
    门图层: [...doorLayers],
    已勾选的门图层: doorWallLayers,
    白膜墙线: massingLines.length,
    实体墙段: segments.length,
    白膜墙上的门: massingDoors.doors.length,
    白膜墙开洞面数: massingDoors.doors.reduce((sum, door) => sum + door.cuts.length, 0),
    门构件中心: massingDoors.doors.map(
      (door) => `${door.placement.center.x.toFixed(2)},${door.placement.center.y.toFixed(2)}`,
    ),
    门构件厚度: massingDoors.doors.map((door) => door.placement.thickness),
    // 每樘门的来源块心、宿主白膜墙线与落点：门的位置不对时对照图纸一次就能定位
    门明细: massingDoors.doors.slice(0, 8).map((door) => {
      const block = door.spec.blockKey?.split('|') ?? []
      return {
        块心: block.length >= 3 ? block.slice(2).join('|') : '未知',
        宿主线: door.hostKey,
        落点: `${door.spec.center.x.toFixed(2)},${door.spec.center.y.toFixed(3)}`,
        方向: `${door.spec.direction.x.toFixed(2)},${door.spec.direction.y.toFixed(2)}`,
        宽: Number(door.spec.width.toFixed(2)),
        // 双线墙两面各标一次时会合并成一樘，这里记录两块块心距（即墙厚）
        墙厚: door.spec.markSpan === undefined ? '单面标记' : Number(door.spec.markSpan.toFixed(3)),
      }
    }),
    实体墙上的门窗: recognition.openings.length,
    跳过门构件: massingDoors.skipped,
    提示: massingDoors.notes,
  })
  /**
   * 白膜墙上的门不经过墙体开洞，直接作为独立构件追加到每层洞口列表；
   * 删除门本身或它的宿主白膜墙段时，门一并消失。
   */
  const massingDoorPlacements = (removed: ReadonlySet<string>): WallOpeningPlacement[] =>
    massingDoors.doors
      .filter((door) => keepMassingDoor(door, removed))
      .map((door) => door.placement)

  /**
   * 白膜墙几何：按门洞切开中心线后再拉板，门顶用过梁补墙。
   * 切割后的子线段不能直接当对象键（编辑态删除的是原始白膜墙段），
   * 因此中心线、段数与总长都按「保留下来的原始白膜墙线」覆盖。
   */
  const buildMassingGeometry = (removed: ReadonlySet<string>): CurtainWallGeometry | null => {
    const keptMassing = massingLines.filter((entry) => !removed.has(entry.key))
    if (keptMassing.length === 0) return null
    const cuts = massingDoorCuts(massingDoors.doors, removed)
    const body = buildCurtainWallGeometry(
      cutCurtainLines(
        keptMassing.map((entry) => entry.line),
        keptMassing.map((entry) => cuts.get(entry.key) ?? []),
      ),
      unitScale,
      { height: params.building.wallHeight, plain: true },
    )
    const lintelParts = massingDoorLintels(massingDoors.doors, removed).map((group) =>
      buildCurtainWallGeometry(group.lines, unitScale, {
        height: group.height,
        base: group.base,
        plain: true,
      }),
    )
    const merged = mergeCurtainGeometries([body, ...lintelParts])
    if (merged === null) return null
    merged.massingCenterlines = keptMassing.map((entry) => ({
      a: { x: entry.line.a.x * unitScale, y: entry.line.a.y * unitScale },
      b: { x: entry.line.b.x * unitScale, y: entry.line.b.y * unitScale },
    }))
    merged.segmentCount = merged.massingCenterlines.length
    merged.totalLength = merged.massingCenterlines.reduce(
      (sum, line) => sum + Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y),
      0,
    )
    return merged
  }
  /** 分别构建玻璃幕墙与白膜墙：两者构造不同，但共用同一套删除键 */
  const buildCurtainParts = (
    removed: ReadonlySet<string>,
  ): { glass: CurtainWallGeometry | null; massing: CurtainWallGeometry | null } => {
    const keptGlass = curtainLines.filter((entry) => !removed.has(entry.key)).map((entry) => entry.line)
    return {
      glass:
        keptGlass.length > 0
          ? buildCurtainWallGeometry(keptGlass, unitScale, { height: params.building.wallHeight })
          : null,
      massing: buildMassingGeometry(removed),
    }
  }
  const buildCurtain = (removed: ReadonlySet<string>): CurtainWallGeometry | null => {
    const parts = buildCurtainParts(removed)
    return mergeCurtainGeometries([parts.glass, parts.massing])
  }
  const baseCurtainParts = buildCurtainParts(removal.value.global)
  const curtain = mergeCurtainGeometries([baseCurtainParts.glass, baseCurtainParts.massing])

  // 基准楼层：只叠加上全局删除集，未单独编辑过的楼层都直接复用它
  const baseKept = segments.filter((segment) => !removal.value.global.has(segment.key))
  const baseWalls = buildWallGeometry(baseKept, wallOptions, unitScale, keepOpenings(removal.value.global))
  // 白膜墙上的门不经过墙体开洞，只把构件追加到洞口列表，供渲染与拾取复用同一份
  const base: FloorGeometry = {
    walls: {
      ...baseWalls,
      openings: [...baseWalls.openings, ...massingDoorPlacements(removal.value.global)],
    },
    curtain,
  }

  // 每层几何按删除集签名去重：签名相同必然得到同一份几何，只有单独编辑过的层才多一份
  const baseSignature = removalSignature(removal.value.global)
  const bySignature = new Map<string, FloorGeometry>([[baseSignature, base]])
  const floors: FloorGeometry[] = []
  let exportVertices = 0
  for (let index = 0; index < params.building.floorCount; index += 1) {
    const keys = removedKeysForFloor(removal.value, index)
    const signature = removalSignature(keys)
    let floorGeometry = bySignature.get(signature)
    if (!floorGeometry) {
      const walls = buildWallGeometry(
        segments.filter((segment) => !keys.has(segment.key)),
        wallOptions,
        unitScale,
        keepOpenings(keys),
      )
      // 该层删过幕墙段、或删过白膜墙上的门时才另建一份幕墙，其余层继续共用基准几何
      const doorTouched = massingDoors.doors.some(
        (door) =>
          keys.has(door.hostKey) ||
          (door.placement.key !== undefined && keys.has(door.placement.key)),
      )
      const removedCurtain =
        doorTouched || [...keys].some((key) => key.startsWith(CURTAIN_KEY_PREFIX))
      floorGeometry = {
        walls: { ...walls, openings: [...walls.openings, ...massingDoorPlacements(keys)] },
        curtain: removedCurtain ? buildCurtain(keys) : curtain,
      }
      bySignature.set(signature, floorGeometry)
    }
    floors.push(floorGeometry)
    exportVertices += floorGeometry.walls.positions.length
  }
  const geometry: BuildingGeometry = {
    base,
    floors,
    // 轮廓全楼唯一，只建一份楼板几何，各层复用
    slab: slabOutline.value
      ? buildSlabGeometry(slabOutline.value, params.building.slabThickness)
      : null,
  }

  // 编辑目标：选中楼层时用该层的片段，否则用基准楼层
  const target = editMode.value && editFloor.value !== null ? floors[editFloor.value] : base
  lastPieces.value = target.walls.pieces
  lastObjectKeys.value = floorObjectKeys(target)
  const curtainVertices = curtainVertexCount(curtain) * params.building.floorCount
  wallSummary.value = {
    segments: baseWalls.segmentCount,
    length: baseWalls.totalLength,
    skipped: baseWalls.skippedRingCount,
    paired: pairing.pairedCount,
    unpaired: pairing.unpairedCount,
    measured: pairing.measuredThickness,
    filled,
    snappedCount,
    droppedDiagonal,
    skippedUnresolved,
    unresolvedLayers,
    layers: params.layers,
    params: params.building,
    thicknessByLayer: params.thicknessByLayer,
    openingKinds: params.openingKinds,
    curtain:
      baseCurtainParts.glass === null
        ? null
        : {
            layers: curtainPlan.layers,
            segments: baseCurtainParts.glass.segmentCount,
            mullions: baseCurtainParts.glass.mullionCount,
            panes: baseCurtainParts.glass.paneCount,
            totalLength: baseCurtainParts.glass.totalLength,
          },
    massing:
      baseCurtainParts.massing === null
        ? null
        : {
            layers: curtainPlan.massingLayers,
            segments: baseCurtainParts.massing.segmentCount,
            totalLength: baseCurtainParts.massing.totalLength,
          },
    // 导出顶点数含楼板与幕墙：每层都烘焙一份，和导出时的顶点规模一致
    vertices:
      exportVertices +
      curtainVertices +
      (geometry.slab ? geometry.slab.positions.length * params.building.floorCount : 0),
  }
  // 门窗统计按基准楼层实际落地的洞口记，删除墙体后洞口会一同消失；含白膜墙上的门
  const placedDoors = base.walls.openings.filter((item) => item.kind === 'door').length
  const placedWindows = base.walls.openings.length - placedDoors
  openingSummary.value = {
    doors: placedDoors,
    windows: placedWindows,
    skipped:
      recognition.skipped.length + massingDoors.skipped + baseWalls.skippedOpeningCount,
    notes: [
      // 白膜墙上已经生成门时，「没有可用的实体墙」的说法不再成立
      ...recognition.notes.filter(
        (note) => !(massingDoors.doors.length > 0 && note.includes('没有可用的实体墙')),
      ),
      ...curtainPlan.notes,
      ...massingDoors.notes,
      ...excludedDoorLayers.map((name) =>
        doorWallLines.lines.length > 0 && doorWallLayers.includes(name)
          ? `图层「${name}」标记为「门」：门扇与开启弧线不当墙，图层里的长墙线已按白膜墙补齐。`
          : `图层「${name}」标记为「门」，已从墙体图层中排除（门扇与开启弧线不是墙）。`,
      ),
    ],
  }
  // 保存几何快照，建筑包导出直接复用，保证与当前楼层模型一致
  lastBuildingGeometry.value = geometry
  lastBuildingParams.value = params.building
  // 墙带边界作为平面视图的绘制参照与吸附目标；白膜墙同样没有墙带，中心线一并给出
  updateOutlineGuides(
    baseWalls,
    segments,
    [...curtainPlan.lines, ...curtainPlan.massingLines],
    unitScale,
  )
  // 编辑态只替换几何数据，不重建场景、不重置相机
  if (keepView) view.updateBuilding(geometry, params.building)
  else view.setBuilding(geometry, params.building)
  // 构件依赖逐层墙带与轮廓，必须在楼层视图重建之后挂载
  applyProceduralKit(
    floors.map((floor) => floor.walls.rings),
    params.building,
  )
  // 重建后丢弃已不存在的选择键
  const available = new Set(floorObjectKeys(target))
  const next = new Set<string>()
  for (const key of selection.value) {
    if (available.has(key)) next.add(key)
  }
  selection.value = next
  view.setSelection(next)
}

/** 用上次生成的快照重建，供删除 / 撤销 / 重置与参数调整复用 */
function regenerate(keepView = false, building?: NormalizedBuildingParams): void {
  const summary = wallSummary.value
  if (!summary) return
  rebuild(
    {
      // 未标注厚度的图层也要保留：它们的双线墙能按实测间距生成，
      // 只有真正无法解析厚度的单线才会在重建时被跳过
      layers: summary.layers,
      thicknessByLayer: summary.thicknessByLayer,
      openingKinds: summary.openingKinds,
      building: building ?? summary.params,
    },
    keepView,
  )
}

/** 释放已挂载的程序化构件、墙面立面贴图并清空提示 */
function clearProceduralKit(): void {
  disposeProceduralKit(proceduralDecor)
  proceduralDecor = []
  proceduralAppearance = null
  // 墙面回到默认石膏材质后再释放贴图，避免材质仍引用已释放的贴图
  floorView?.setWallFacadeTexture(null)
  disposeFacadeWallTexture(facadeSkinTexture)
  facadeSkinTexture = null
  proceduralNotices.value = []
}

/**
 * 按当前面板参数生成并挂载四类程序化构件。
 *
 * 轮廓来源与禁用原因由适配层判定：缺闭合轮廓时不生成屋顶 / 底座 / 大门，
 * 并在面板里显示具体原因，不做任何兜底几何。
 *
 * 立面分两步：附件（竖梃 / 窗台等）由 `buildProceduralKit` 生成，
 * 墙面贴图由 `setWallFacadeTexture` 铺到墙带外表面；只做附件时风格切换几乎不可见。
 */
function applyProceduralKit(
  ringsByFloor: ReadonlyArray<readonly WallRing[]>,
  building: NormalizedBuildingParams,
): void {
  const view = floorView
  if (!view) return
  const result: ProceduralKitResult = buildProceduralKit({
    floorRings: ringsByFloor,
    slabOutline: slabOutline.value,
    wallHeight: building.wallHeight,
    podium: podiumEnabled.value ? defaultPodiumConfig(podiumType.value) : null,
    roof: roofEnabled.value ? defaultRoofConfig(roofType.value) : null,
    gate: gateEnabled.value
      ? createEntranceGateConfig(gateStyle.value, 0, [0, 0], 0.5, {
          width: gateWidth.value,
          height: gateHeight.value,
        })
      : null,
    facadeStyle: facadeEnabled.value ? facadeStyle.value : null,
  })
  clearProceduralKit()
  proceduralDecor = result.floorDecor
  proceduralAppearance = result.appearance
  proceduralNotices.value = result.warnings
  view.setProceduralDecor(result.floorDecor)

  // 墙面换装：带序不影响 tile 平铺，统一用面序号 0 生成一份全楼共享的贴图
  if (facadeEnabled.value) {
    const skinConfig = createFacadeFaceConfig(facadeStyle.value, 0, [0, 0], {
      floorHeight: building.wallHeight,
    })
    facadeSkinTexture = createFacadeWallTexture(skinConfig)
    view.setWallFacadeTexture(facadeSkinTexture)
    if (!facadeSkinTexture) proceduralNotices.value = [...proceduralNotices.value, '墙面立面贴图未生成：立面配置不合法']
  }
  console.info('[cad-lab] 程序化构件', {
    facade: facadeEnabled.value ? facadeStyle.value : null,
    stats: result.stats,
    warnings: result.warnings,
  })
}

/** 构件参数变化：已生成模型时立即重建，否则只提示先生成模型 */
function onProceduralChange(): void {
  if (!wallSummary.value) {
    proceduralNotices.value = ['请先生成楼层模型，再启用程序化构件。']
    return
  }
  regenerate(false)
}

/**
 * 把首层墙带边界与中心线交给平面视图，作为轮廓绘制的参照与吸附目标。
 *
 * 吸附目标同时包含墙带内外边界、墙中心线与幕墙中心线：
 * 墙带环可能因 miter 退化被跳过、幕墙图层干脆没有墙带，
 * 中心线仍能保证可以吸附到图上，不会出现「画轮廓时怎么都吸不上」的空档。
 */
function updateOutlineGuides(
  walls: WallGeometryResult,
  segments: readonly WallSegment[],
  curtainLines: readonly CurtainLine[],
  unitScale: number,
): void {
  if (!planView) return
  const bands: OutlineGuides['bands'] = []
  for (const ring of walls.rings) {
    bands.push({ points: ring.left, closed: ring.closed })
    bands.push({ points: ring.right, closed: ring.closed })
  }
  const centerlines: OutlineGuides['centerlines'] = walls.pieces.map((piece) => ({
    a: piece.a,
    b: piece.b,
  }))
  // 墙带里没有对应片段的墙线（退化环）补进中心线吸附目标，坐标换算成米
  const hasPiece = new Set(walls.pieces.map((piece) => piece.key))
  for (const segment of segments) {
    if (hasPiece.has(segment.key)) continue
    centerlines.push({
      a: { x: segment.a.x * unitScale, y: segment.a.y * unitScale },
      b: { x: segment.b.x * unitScale, y: segment.b.y * unitScale },
    })
  }
  // 幕墙图层不产生实体墙带：中心线同样作为轮廓吸附目标，否则默认幕墙的图纸会吸不上
  for (const line of curtainLines) {
    centerlines.push({
      a: { x: line.a.x * unitScale, y: line.a.y * unitScale },
      b: { x: line.b.x * unitScale, y: line.b.y * unitScale },
    })
  }
  planView.setOutlineGuides(bands.length > 0 || centerlines.length > 0 ? { bands, centerlines } : null)
}

/** 开始（或重画）楼板轮廓：必须先有楼层模型，绘制只在平面视图中进行 */
function startOutlineDraw(): void {
  if (!wallSummary.value) {
    errorMessage.value = '请先生成楼层模型，再沿模型边缘绘制地板轮廓。'
    return
  }
  if (!planView) return
  errorMessage.value = ''
  activeTab.value = 'plan'
  outlineDrawing.value = true
  outlinePurpose.value = 'slab'
  outlineSegments.value = 0
  outlineTool.value = 'line'
  planView.setOutlineTool('line')
  planView.startOutlineDraw('slab')
}

/** 当前是否处于墙体闭合绘制模式 */
const wallClosureDrawing = computed(() => outlineDrawing.value && outlinePurpose.value === 'wall')

/** 当前是否处于楼板内环绘制模式 */
const slabHoleDrawing = computed(() => outlineDrawing.value && outlinePurpose.value === 'slab-hole')

/** 楼板内环（洞口）数量 */
const slabHoleCount = computed(() => slabOutline.value?.holes?.length ?? 0)

/**
 * 开始绘制楼板内环（挖洞）：必须先有外轮廓。
 * 内环完全落在外部轮廓内且不相交时才会被写入楼板模型。
 */
function startSlabHoleDraw(): void {
  if (!slabOutline.value) {
    errorMessage.value = '请先绘制地板轮廓，再绘制内环。'
    return
  }
  if (!planView) return
  errorMessage.value = ''
  activeTab.value = 'plan'
  outlineDrawing.value = true
  outlinePurpose.value = 'slab-hole'
  outlineSegments.value = 0
  outlineTool.value = 'line'
  planView.setOutlineTool('line')
  planView.startOutlineDraw('slab-hole')
}

/**
 * 内环校验通过：追加到楼板轮廓并立即重建全部楼层。
 * 与外轮廓相交、越界或内环互交时返回中文错误并停留在绘制态。
 */
function handleOutlineHoleFinish(hole: SlabOutline): string | null {
  const base = slabOutline.value
  if (!base) return '请先绘制地板轮廓，再绘制内环。'
  let next: SlabOutline
  try {
    next = appendOutlineHole(base, hole)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const validation = validateOutline(next)
  if (!validation.valid) return validation.message
  slabOutline.value = next
  outlineDrawing.value = false
  outlinePurpose.value = 'slab'
  outlineSegments.value = 0
  errorMessage.value = ''
  planView?.setCommittedOutline(next)
  if (wallSummary.value) regenerate(false)
  return null
}

/** 清空全部楼板内环，保留外轮廓 */
function clearSlabHoles(): void {
  const base = slabOutline.value
  if (!base || (base.holes?.length ?? 0) === 0) return
  const next = clearOutlineHoles(base)
  slabOutline.value = next
  errorMessage.value = ''
  planView?.setCommittedOutline(next)
  if (wallSummary.value) regenerate(false)
}

/**
 * 开始手动闭合墙体：从一段未闭合墙体的端点画到另一段端点，
 * 连接线会成为真实墙段（不是楼板），闭合后即可识别内 / 外墙面。
 */
function startWallClosureDraw(): void {
  if (!wallSummary.value) {
    errorMessage.value = '请先生成楼层模型，再闭合未闭合的墙体。'
    return
  }
  if (!planView) return
  errorMessage.value = ''
  activeTab.value = 'plan'
  outlineDrawing.value = true
  outlinePurpose.value = 'wall'
  outlineSegments.value = 0
  outlineTool.value = 'line'
  planView.setOutlineTool('line')
  planView.startOutlineDraw('wall')
}

/** 切换直线段 / 三点圆弧 */
function selectOutlineTool(tool: OutlineTool): void {
  outlineTool.value = tool
  planView?.setOutlineTool(tool)
}

function undoOutlinePoint(): void {
  planView?.undoOutlinePoint()
}

/** 闭合轮廓（等价于双击 / Enter） */
function finishOutline(): void {
  planView?.finishOutline()
}

function cancelOutlineDraw(): void {
  planView?.cancelOutlineDraw()
  outlineDrawing.value = false
  outlinePurpose.value = 'slab'
  outlineSegments.value = 0
}

/** 草稿段数变化，用于提示绘制进度 */
function handleOutlineChange(count: number): void {
  outlineSegments.value = count
}

/** 轮廓校验通过：写入轮廓并立即重建全部楼层 */
function handleOutlineFinish(outline: SlabOutline): void {
  slabOutline.value = outline
  outlineDrawing.value = false
  outlinePurpose.value = 'slab'
  outlineSegments.value = 0
  errorMessage.value = ''
  if (wallSummary.value) regenerate(false)
}

/**
 * 墙体闭合连接线绘制完成：连接线无条件转成墙体。
 * 只有「不足一条直线段」时返回中文错误并停留在绘制态。
 */
function handleWallFinish(points: OutlinePoint[]): string | null {
  const current = drawing.value
  const summary = wallSummary.value
  if (!current || !summary) return '请先生成楼层模型，再闭合未闭合的墙体。'
  const layers = summary.layers
  if (layers.length === 0) return '当前没有可用的墙体图层，无法生成墙体。'
  const existing = currentWallSegments(current, layers, summary.thicknessByLayer).segments.filter(
    (segment) => !removal.value.global.has(segment.key),
  )
  if (existing.length === 0) return '当前没有可用的墙体线段，无法生成闭合墙。'
  // 连接线跟随「墙线最长」的图层，厚度取该图层已解墙段的中位厚度：
  // 这些厚度来自双线实测或图纸几何回填，未标注墙厚的图层同样可以闭合，
  // 不再要求用户先在面板里填一个值
  const totals = new Map<string, { length: number; thicknesses: number[] }>()
  for (const segment of existing) {
    const entry = totals.get(segment.layer) ?? { length: 0, thicknesses: [] }
    entry.length += Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y) * current.unitScale
    entry.thicknesses.push(segment.thickness)
    totals.set(segment.layer, entry)
  }
  let layer = ''
  let longest = -Infinity
  for (const [name, entry] of totals) {
    if (entry.length > longest) {
      longest = entry.length
      layer = name
    }
  }
  if (layer === '' || !(longest > 0)) return '当前没有可用的墙体线段，无法生成闭合墙。'
  const measured = totals.get(layer)!.thicknesses.slice().sort((left, right) => left - right)
  const thickness = measured[Math.floor(measured.length / 2)]
  if (!(thickness > 0)) return `图层「${layer}」没有可用的墙厚，无法生成闭合墙。`
  const result = planWallClosure(existing, points, current.unitScale, {
    layer,
    thickness,
  })
  if (!result.plan) return result.error
  wallClosures.value = [...wallClosures.value, result.plan.path]
  outlineDrawing.value = false
  outlinePurpose.value = 'slab'
  outlineSegments.value = 0
  errorMessage.value = ''
  regenerate(false)
  return null
}

function handleOutlineCancel(): void {
  outlineDrawing.value = false
  outlinePurpose.value = 'slab'
  outlineSegments.value = 0
}

function handleOutlineError(message: string): void {
  errorMessage.value = message
}

/**
 * 读取面板里的楼层参数。
 * 参数非法时写入错误提示并返回 null，调用方直接放弃本次生成，不做任何钳制。
 */
function readBuildingParams(): NormalizedBuildingParams | null {
  try {
    return normalizeBuildingParams({
      floorCount: floorCount.value,
      floorSpacing: floorSpacing.value,
      wallHeight: wallHeight.value,
      slabThickness: slabThickness.value,
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    return null
  }
}

/**
 * 楼层参数即时生效：已生成模型后调整楼层数 / 层间距 / 墙高，
 * 直接用已有几何重新堆叠，不需要再点一次生成。
 *
 * 尚未生成模型时没有几何可重建，生成按钮会直接按面板参数生成对应层数。
 */
function applyBuildingParams(): void {
  if (!wallSummary.value || !drawing.value) return
  const building = readBuildingParams()
  if (!building) return
  errorMessage.value = ''
  // 楼层数变化后旧的展开层与编辑目标可能越界，统一收起（setBuilding 会重置视图的编辑目标）
  expandedFloor.value = null
  editFloor.value = null
  regenerate(false, building)
  syncWallPanelToFloor(null)
}

/**
 * 材质设置即时生效：面板里改颜色 / 金属度 / 粗糙度，直接更新已生成模型的材质。
 *
 * 已展开（选中）某层时只改这一层，其余楼层不受影响；没有选中楼层时改全部楼层。
 * 尚未生成模型时只记下预置值，等生成时套用。
 */
function applyWallMaterial(): void {
  let material: WallMaterialParams
  try {
    material = normalizeWallMaterial({
      color: wallColor.value,
      metalness: Number(wallMetalness.value),
      roughness: Number(wallRoughness.value),
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    return
  }
  errorMessage.value = ''
  wallColor.value = material.color
  wallMetalness.value = material.metalness
  wallRoughness.value = material.roughness
  floorView?.setWallMaterial(material, activeFloor.value ?? undefined)
}

/** 当前材质改动的作用范围：选中楼层时只作用于该层 */
const materialScopeText = computed(() => {
  if (floorCount.value <= 1) return '当前作用于整层模型。'
  if (activeFloor.value === null) return '未选中楼层，改动作用于全部楼层。'
  return `已选中 F${activeFloor.value + 1}，改动只作用于该层，其他楼层不受影响。`
})

/** 材质恢复默认哑光涂料 */
function resetWallMaterial(): void {
  wallColor.value = DEFAULT_WALL_MATERIAL.color
  wallMetalness.value = DEFAULT_WALL_MATERIAL.metalness
  wallRoughness.value = DEFAULT_WALL_MATERIAL.roughness
  applyWallMaterial()
}

/** 套用质感预设（哑光涂料 / 清水混凝土 / 金属板） */
function applyWallPreset(preset: WallMaterialPreset): void {
  wallColor.value = preset.params.color
  wallMetalness.value = preset.params.metalness
  wallRoughness.value = preset.params.roughness
  applyWallMaterial()
}

async function generateFloor(): Promise<void> {
  if (!drawing.value) return
  if (invalidWallLayers.value.length > 0) {
    errorMessage.value = `墙厚需在 ${MIN_THICKNESS} ~ ${MAX_THICKNESS} m 之间：${invalidWallLayers.value.join('、')}`
    return
  }

  // 首次生成固定为单层（楼层数在模型生成前锁定），生成完成后可由面板调整层数
  const building = readBuildingParams()
  if (!building) return

  errorMessage.value = ''
  if (outlineDrawing.value) cancelOutlineDraw()
  activeTab.value = 'floor'
  await nextTick()
  const view = ensureFloorView()
  const layers = selectedWallLayers.value
  if (layers.length === 0) {
    view.clearBuilding()
    clearProceduralKit()
    wallSummary.value = null
    openingSummary.value = null
    // 没有墙体就没有可参照的模型边缘，轮廓、手动闭合连接线与楼板一并清空
    slabOutline.value = null
    wallClosures.value = []
    planView?.cancelOutlineDraw()
    planView?.setOutlineGuides(null)
    planView?.setCommittedOutline(null)
    outlineDrawing.value = false
    outlinePurpose.value = 'slab'
    outlineSegments.value = 0
    // 模型清空后回到未生成状态，楼层数重新锁定为 1
    floorCount.value = 1
    lastPieces.value = []
    lastObjectKeys.value = []
    selection.value = new Set()
    expandedFloor.value = null
    return
  }
  // 记录本次生成实际使用的墙厚与楼层参数，导出清单以几何为准而不是当前表单值；
  // 未标注厚度的图层不进表，留给双线实测，避免写出 NaN
  const thicknessByLayer: Record<string, number> = {}
  for (const name of layers) {
    const value = layerThickness(name)
    if (Number.isFinite(value) && value > 0) thicknessByLayer[name] = value
  }
  expandedFloor.value = null
  editFloor.value = null
  rebuild({ layers, thicknessByLayer, openingKinds: { ...openingKindByLayer }, building })
  console.info('[cad-lab] 已生成楼层模型', {
    楼层数: building.floorCount,
    层间距: building.floorSpacing,
    墙高: building.wallHeight,
  })
  syncWallPanelToFloor(null)
}

/** 点选：Shift 追加，Ctrl 减选，无修饰键替换 */
function handlePick(key: string, mode: SelectionMode): void {
  const next = new Set(mode === 'replace' ? [] : selection.value)
  if (mode === 'subtract') {
    next.delete(key)
  } else {
    next.add(key)
  }
  selection.value = next
  floorView?.setSelection(next)
}

/** 点击空白：清空选择 */
function handleEmptyClick(): void {
  if (selection.value.size === 0) return
  selection.value = new Set()
  floorView?.setSelection(selection.value)
}

/** 框选：按修饰键替换 / 追加 / 减选 */
function handleBoxSelect(keys: string[], mode: SelectionMode): void {
  const next = new Set(mode === 'replace' ? [] : selection.value)
  for (const key of keys) {
    if (mode === 'subtract') {
      next.delete(key)
    } else {
      next.add(key)
    }
  }
  selection.value = next
  floorView?.setSelection(next)
}

function toggleEditMode(): void {
  editMode.value = !editMode.value
  const view = ensureFloorView()
  if (editMode.value) {
    // 进入编辑态：把当前展开的楼层带进编辑目标，再收起抽屉（编辑态不播放抽屉动画）
    const target = expandedFloor.value
    expandedFloor.value = null
    view.setExpandedFloor(null)
    editFloor.value = target
    // 编辑态视图锁定为正交俯视（由 FloorModelView 强制），先锁视角再切编辑目标，
    // 这样取景会直接落到选中的楼层上
    cameraMode.value = 'top'
    view.setEditMode(true)
    view.setEditFloor(target)
    lastObjectKeys.value = view.objectKeys()
    if (target !== null) syncWallPanelToFloor(target)
  } else {
    editFloor.value = null
    view.setEditFloor(null)
    cameraMode.value = 'orbit'
    view.setEditMode(false)
  }
}

/** 编辑态选择要编辑的楼层；选中后只显示、只编辑这一层，null 表示整栋同步编辑 */
function selectEditFloor(index: number | null): void {
  if (!editMode.value) return
  editFloor.value = index
  floorView?.setEditFloor(index)
  // 换了编辑目标，原选择集的键可能不属于这一层，统一清空
  selection.value = new Set()
  floorView?.setSelection(selection.value)
  lastObjectKeys.value = floorView?.objectKeys() ?? []
  syncWallPanelToFloor(index)
}

/** 三维点击与侧边列表共用同一份展开状态，再次点击同一层收起 */
function toggleFloor(index: number): void {
  const next = expandedFloor.value === index ? null : index
  expandedFloor.value = next
  floorView?.setExpandedFloor(next)
  // 面板跟随选中楼层：显示这一层自己的材质，避免把上一层的参数改到新选中的层上
  syncWallPanelToFloor(next)
}

/** 把材质面板的数值同步成某一层的当前材质；取消选中时回到全局材质 */
function syncWallPanelToFloor(index: number | null): void {
  if (index !== null && floorCount.value <= 1) return
  const material = floorView?.getWallMaterial(index ?? undefined)
  if (!material) return
  wallColor.value = material.color
  wallMetalness.value = material.metalness
  wallRoughness.value = material.roughness
}

/** 三维模型点击到某一层；编辑态下由墙段拾取接管，不响应楼层展开 */
function handleFloorPick(index: number): void {
  if (editMode.value) return
  toggleFloor(index)
}

function toggleCamera(): void {
  cameraMode.value = cameraMode.value === 'orbit' ? 'top' : 'orbit'
  ensureFloorView().setCameraMode(cameraMode.value)
}

function selectAllPieces(): void {
  selection.value = new Set(lastObjectKeys.value)
  floorView?.setSelection(selection.value)
}

function invertSelection(): void {
  const next = new Set<string>()
  for (const key of lastObjectKeys.value) {
    if (!selection.value.has(key)) next.add(key)
  }
  selection.value = next
  floorView?.setSelection(next)
}

function clearSelection(): void {
  if (selection.value.size === 0) return
  selection.value = new Set()
  floorView?.setSelection(selection.value)
}

/** 删除选中对象（墙段 / 门窗 / 幕墙）：批量删除前二次确认，删除后可撤销 */
function deleteSelection(): void {
  const count = selection.value.size
  if (count === 0) return
  if (count >= 50) {
    const wallPieces = lastPieces.value.filter((piece) => selection.value.has(piece.key))
    const total = wallPieces.reduce((sum, piece) => sum + piece.length, 0)
    const message = `即将删除 ${count} 个对象（墙体 ${wallPieces.length} 段，总长 ${Math.round(total)} m）。该操作可撤销，确定继续吗？`
    if (!window.confirm(message)) return
  }
  undoStack.value = [...undoStack.value, cloneRemovalScope(removal.value)]
  // 选中楼层时只删这一层，未选中时写入全局（作用于每一层）
  removal.value = addRemovedKeys(
    removal.value,
    editMode.value ? editFloor.value : null,
    selection.value,
  )
  selection.value = new Set()
  regenerate(true)
}

function undoRemove(): void {
  const stack = undoStack.value.slice()
  if (stack.length === 0) return
  const previous = stack.pop() as RemovalScope
  undoStack.value = stack
  removal.value = cloneRemovalScope(previous)
  selection.value = new Set()
  regenerate(true)
}

function resetRemoval(): void {
  if (removedCount.value === 0) return
  if (!window.confirm('确定恢复全部已删除的对象吗？')) return
  removal.value = { global: new Set(), floors: [] }
  undoStack.value = []
  selection.value = new Set()
  regenerate(true)
}

/** Delete 键删除选中对象；输入框内不拦截 */
function handleKeydown(event: KeyboardEvent): void {
  if (!editMode.value || activeTab.value !== 'floor') return
  if (event.key !== 'Delete') return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  event.preventDefault()
  deleteSelection()
}

/** 触发浏览器下载 */
function downloadGlb(buffer: ArrayBuffer, sourceName: string): void {
  const base = sourceName.replace(/\.(dxf|dwg)$/i, '')
  const blob = new Blob([buffer], { type: 'model/gltf-binary' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${base}-floor.glb`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** 导出当前墙体为 .glb；未生成墙体时明确提示 */
async function exportFloor(): Promise<void> {
  const current = drawing.value
  const summary = wallSummary.value
  if (!current) return
  if (!floorView || !summary) {
    errorMessage.value = '尚未生成楼层模型，无法导出。'
    return
  }
  errorMessage.value = ''
  // summary.vertices 已经是逐层累计后的整栋顶点数，不能再乘楼层数
  const estimated = summary.vertices
  if (estimated > EXPORT_VERTEX_WARN) {
    const message = `整栋导出将烘焙约 ${estimated.toLocaleString()} 个顶点，文件可能较大。确定继续吗？`
    if (!window.confirm(message)) return
  }
  exporting.value = true
  try {
    const buffer = await floorView.exportGlb({
      unitScale: current.unitScale,
      wallHeight: summary.params.wallHeight,
      thicknessByLayer: summary.thicknessByLayer,
    })
    downloadGlb(buffer, current.fileName)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    exporting.value = false
  }
}

/** 触发浏览器下载 GeoJSON 文本 */
function downloadGeoJson(text: string, sourceName: string): void {
  const base = sourceName.replace(/\.(dxf|dwg)$/i, '')
  const blob = new Blob([text], { type: 'application/geo+json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${base}-building.geojson`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * 导出建筑包 GeoJSON：供 webmap 编辑器 View3D 室外场景直接导入。
 *
 * 坐标为局部米制（建筑平面中心为原点），墙体取墙带边界，楼板带内环；
 * 几何相同的楼层用 geometryRef 共享，导出前统计规模，超阈值先确认。
 */
function exportBuildingPackage(): void {
  const current = drawing.value
  const geometry = lastBuildingGeometry.value
  const params = lastBuildingParams.value
  if (!current || !geometry || !params) {
    errorMessage.value = '尚未生成楼层模型，无法导出建筑包。'
    return
  }
  errorMessage.value = ''
  let result: { geojson: BuildingPackageGeoJson; stats: BuildingPackageStats }
  try {
    const material = normalizeWallMaterial({
      color: wallColor.value,
      metalness: Number(wallMetalness.value),
      roughness: Number(wallRoughness.value),
    })
    const baseName = current.fileName.replace(/\.(dxf|dwg)$/i, '')
    result = buildBuildingPackageGeoJson({
      buildingId: `cad-${baseName}`,
      name: baseName,
      floors: geometry.floors.map((floor, index) => ({
        levelId: `f${index}`,
        walls: floor.walls,
        curtain: floor.curtain ?? null,
      })),
      slabOutline: slabOutline.value,
      params,
      material,
      appearance: proceduralAppearance,
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    return
  }
  const { stats } = result
  if (stats.expandedWallVertices > EXPORT_VERTEX_WARN || stats.floorCount > 40) {
    const message =
      `建筑包包含 ${stats.floorCount} 层、唯一几何 ${stats.uniqueGeometryCount} 份，` +
      `展开后墙体顶点约 ${stats.expandedWallVertices.toLocaleString()} 个，文件可能较大。确定继续吗？`
    if (!window.confirm(message)) return
  }
  downloadGeoJson(JSON.stringify(result.geojson), current.fileName)
  console.info('[cad-lab] 已导出建筑包 GeoJSON', stats)
}

async function switchTab(tab: 'plan' | 'floor'): Promise<void> {
  // 离开平面图时未闭合的草稿直接丢弃，避免它留在后台拦住键盘事件
  if (tab !== 'plan' && outlineDrawing.value) cancelOutlineDraw()
  activeTab.value = tab
  if (tab === 'floor') {
    await nextTick()
    ensureFloorView()
  }
}

onMounted(() => {
  if (planElement.value) {
    planView = new CadPlanView(planElement.value, {
      onChange: handleOutlineChange,
      onFinish: handleOutlineFinish,
      onHoleFinish: handleOutlineHoleFinish,
      onWallFinish: handleWallFinish,
      onCancel: handleOutlineCancel,
      onError: handleOutlineError,
    })
  }
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  clearProceduralKit()
  planView?.dispose()
  floorView?.dispose()
  planView = null
  floorView = null
  disposeCadParser()
})
</script>

<template>
  <div class="cl-shell" @dragover.prevent @drop.prevent="handleDrop">
    <header class="cl-header">
      <div class="cl-brand">
        <span class="cl-brand-mark">CAD</span>
        <div class="cl-brand-text">
          <h1>图纸解析试验台</h1>
          <p>独立模块 · 本地 WASM 解析 · 不影响现有编辑器与地图逻辑</p>
        </div>
      </div>
      <div class="cl-header-actions">
        <span v-if="drawing" class="cl-file-chip" :title="drawing.fileName">{{ drawing.fileName }}</span>
        <button class="cl-button cl-button-primary" type="button" :disabled="parsing" @click="fileInput?.click()">
          {{ parsing ? '解析中…' : '打开图纸' }}
        </button>
      </div>
    </header>

    <div class="cl-body">
      <aside class="cl-sidebar">
        <section v-if="!drawing" class="cl-empty-panel">
          <h2>开始</h2>
          <p>把 DXF / DWG 文件拖到右侧画布，或点击「打开图纸」。</p>
          <ul class="cl-hints">
            <li>文件只在浏览器本地解析，不会上传。</li>
            <li>首次解析需要加载约 11MB WASM，之后复用。</li>
            <li>可勾选图层显隐，并指定哪些图层作为墙体。</li>
          </ul>
        </section>

        <template v-else>
          <section class="cl-section">
            <div class="cl-section-title">
              <h2>图纸概览</h2>
              <span class="cl-muted">{{ drawing.fileType }}</span>
            </div>
            <dl class="cl-stats">
              <div><dt>实体</dt><dd>{{ stats?.renderableCount.toLocaleString() }}</dd></div>
              <div><dt>顶层</dt><dd>{{ stats?.topLevelCount.toLocaleString() }}</dd></div>
              <div><dt>图层</dt><dd>{{ drawing.layers.length }}</dd></div>
              <div><dt>解析</dt><dd>{{ stats?.parseMs }} ms</dd></div>
            </dl>
            <p class="cl-muted cl-small">
              块展开 {{ stats?.expandedCount.toLocaleString() }} 个，未渲染 {{ stats?.skippedCount.toLocaleString() }} 个；
              主体范围 {{ Math.round((drawing.focusBounds.maxX - drawing.focusBounds.minX) * drawing.unitScale) }} ×
              {{ Math.round((drawing.focusBounds.maxY - drawing.focusBounds.minY) * drawing.unitScale) }} m。
            </p>
            <ul v-if="drawing.notes.length > 0" class="cl-notes">
              <li v-for="note in drawing.notes" :key="note">{{ note }}</li>
            </ul>
          </section>

          <section class="cl-section cl-layer-section">
            <div class="cl-section-title">
              <h2>图层</h2>
              <div class="cl-inline-actions">
                <button class="cl-link" type="button" @click="setAllLayersVisible(true)">全显</button>
                <button class="cl-link" type="button" @click="setAllLayersVisible(false)">全隐</button>
              </div>
            </div>
            <input v-model="layerSearch" class="cl-search" type="search" placeholder="搜索图层名称" />
            <div class="cl-layer-head">
              <span>图层</span>
              <span>实体</span>
              <span>显示</span>
              <span>墙体</span>
              <span>墙厚 m</span>
              <span>门窗</span>
            </div>
            <div class="cl-layer-list">
              <div v-for="layer in sortedLayers" :key="layer.name" class="cl-layer-row">
                <span class="cl-layer-name" :title="layer.name">
                  <i class="cl-color-dot" :style="{ background: `#${layer.color.toString(16).padStart(6, '0')}` }" />
                  <span>{{ layer.name }}</span>
                </span>
                <span class="cl-layer-count">{{ layer.entityCount }}</span>
                <input
                  type="checkbox"
                  :checked="layerVisible[layer.name]"
                  @change="toggleLayerVisibility(layer.name, ($event.target as HTMLInputElement).checked)"
                />
                <input
                  type="checkbox"
                  :checked="wallSelected[layer.name]"
                  @change="wallSelected[layer.name] = ($event.target as HTMLInputElement).checked"
                />
                <input
                  v-if="wallSelected[layer.name]"
                  class="cl-thickness-input"
                  type="number"
                  :min="MIN_THICKNESS"
                  :max="MAX_THICKNESS"
                  step="0.01"
                  :value="layerThicknessText(layer.name)"
                  placeholder="自动"
                  :title="invalidWallLayers.includes(layer.name) ? '墙厚超出允许范围' : layerThicknessHint(layer.name)"
                  @change="setLayerThickness(layer.name, ($event.target as HTMLInputElement).value)"
                />
                <span v-else class="cl-muted cl-layer-placeholder">—</span>
                <select
                  class="cl-opening-select"
                  :value="openingKindByLayer[layer.name] ?? 'none'"
                  title="墙体 / 门 / 窗 / 幕墙 / 忽略：「忽略」与「墙体」都按白膜墙生成（沿窗线拉薄墙，不带幕墙材质）"
                  @change="setOpeningKind(layer.name, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="option in OPENING_KIND_OPTIONS" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </div>
            </div>
          </section>
        </template>
      </aside>

      <main class="cl-stage">
        <div class="cl-stage-toolbar">
          <div class="cl-tabs">
            <button type="button" :class="['cl-tab', { 'is-active': activeTab === 'plan' }]" @click="switchTab('plan')">平面图</button>
            <button type="button" :class="['cl-tab', { 'is-active': activeTab === 'floor' }]" @click="switchTab('floor')">楼层模型</button>
          </div>
          <div class="cl-stage-actions">
            <span v-if="errorMessage" class="cl-error">{{ errorMessage }}</span>
            <span v-else-if="parsing" class="cl-muted cl-small">正在解析图纸…</span>
            <button v-if="drawing && activeTab === 'plan'" class="cl-button cl-button-ghost" type="button" @click="fitPlan">适配视图</button>
            <button
              v-if="drawing && activeTab === 'floor'"
              class="cl-button cl-button-ghost"
              type="button"
              :disabled="!wallSummary || wallSummary.segments === 0 || exporting"
              :title="wallSummary ? '把当前墙体导出为 .glb' : '请先生成楼层模型'"
              @click="exportFloor"
            >
              {{ exporting ? '导出中…' : '导出 glTF' }}
            </button>
            <button
              v-if="drawing && activeTab === 'floor'"
              class="cl-button cl-button-ghost"
              type="button"
              :disabled="!wallSummary || wallSummary.segments === 0"
              :title="wallSummary ? '导出建筑包 GeoJSON，可在编辑器 View3D 室外场景导入' : '请先生成楼层模型'"
              @click="exportBuildingPackage"
            >
              导出建筑包 GeoJSON
            </button>
          </div>
        </div>

        <div v-if="activeTab === 'floor' && wallSummary" class="cl-floor-toolbar">
          <div class="cl-toolbar-group">
            <button
              class="cl-button cl-button-ghost"
              :class="{ 'is-active': editMode }"
              type="button"
              @click="toggleEditMode"
            >
              {{ editMode ? '退出编辑' : '编辑' }}
            </button>
            <button
              class="cl-button cl-button-ghost"
              type="button"
              :disabled="editMode"
              :title="editMode ? '编辑态锁定为正交俯视' : '切换俯视正交 / 透视轴测'"
              @click="toggleCamera"
            >
              {{ cameraMode === 'orbit' ? '俯视正交' : '透视轴测' }}
            </button>
          </div>
          <div class="cl-toolbar-group">
            <button class="cl-button cl-button-ghost" type="button" :disabled="!editMode" @click="selectAllPieces">全选</button>
            <button class="cl-button cl-button-ghost" type="button" :disabled="!editMode" @click="invertSelection">反选</button>
            <button
              class="cl-button cl-button-ghost"
              type="button"
              :disabled="!editMode || selection.size === 0"
              @click="clearSelection"
            >
              清空选择
            </button>
          </div>
          <div class="cl-toolbar-group">
            <span class="cl-muted cl-small">
              选中 {{ selection.size }} 个对象<template v-if="removedCount > 0"> · 已删 {{ removedCount }} 个对象</template>
              <template v-if="editMode && wallSummary.params.floorCount > 1">
                · {{ editFloor === null ? '整栋同步' : `只改 F${editFloor + 1}` }}
              </template>
            </span>
            <button
              class="cl-button cl-button-danger"
              type="button"
              :disabled="selection.size === 0"
              @click="deleteSelection"
            >
              删除选中
            </button>
            <button
              class="cl-button cl-button-ghost"
              type="button"
              :disabled="undoStack.length === 0"
              @click="undoRemove"
            >
              撤销
            </button>
            <button
              class="cl-button cl-button-ghost"
              type="button"
              :disabled="removedCount === 0"
              @click="resetRemoval"
            >
              重置
            </button>
          </div>
        </div>

        <div v-if="activeTab === 'plan' && wallSummary" class="cl-floor-toolbar">
          <div class="cl-toolbar-group">
            <button
              class="cl-button cl-button-ghost"
              :class="{ 'is-active': outlineDrawing && outlinePurpose === 'slab' }"
              type="button"
              @click="outlineDrawing ? cancelOutlineDraw() : startOutlineDraw()"
            >
              {{ outlineDrawing && outlinePurpose === 'slab' ? '取消绘制' : slabOutline ? '重画地板轮廓' : '绘制地板轮廓' }}
            </button>
            <button
              class="cl-button cl-button-ghost"
              :class="{ 'is-active': slabHoleDrawing }"
              type="button"
              :disabled="!slabOutline && !slabHoleDrawing"
              @click="slabHoleDrawing ? cancelOutlineDraw() : startSlabHoleDraw()"
            >
              {{ slabHoleDrawing ? '取消内环' : '绘制内环' }}
            </button>
            <button
              v-if="slabHoleCount > 0 && !outlineDrawing"
              class="cl-button cl-button-ghost"
              type="button"
              @click="clearSlabHoles"
            >
              清除内环（{{ slabHoleCount }}）
            </button>
            <button
              class="cl-button cl-button-ghost"
              :class="{ 'is-active': wallClosureDrawing }"
              type="button"
              @click="wallClosureDrawing ? cancelOutlineDraw() : startWallClosureDraw()"
            >
              {{ wallClosureDrawing ? '取消闭合墙体' : '闭合墙体' }}
            </button>
          </div>
          <template v-if="outlineDrawing">
            <div class="cl-toolbar-group">
              <button
                v-if="outlinePurpose !== 'wall'"
                class="cl-button cl-button-ghost"
                :class="{ 'is-active': outlineTool === 'line' }"
                type="button"
                @click="selectOutlineTool('line')"
              >
                直线段
              </button>
              <button
                v-if="outlinePurpose !== 'wall'"
                class="cl-button cl-button-ghost"
                :class="{ 'is-active': outlineTool === 'arc' }"
                type="button"
                @click="selectOutlineTool('arc')"
              >
                圆弧段
              </button>
              <button
                class="cl-button cl-button-ghost"
                type="button"
                :disabled="outlineSegments === 0"
                @click="undoOutlinePoint"
              >
                撤销一点
              </button>
              <button
                class="cl-button cl-button-ghost"
                type="button"
                :disabled="outlinePurpose === 'wall' ? outlineSegments === 0 : outlineSegments < 2"
                @click="finishOutline"
              >
                {{ outlinePurpose === 'wall' ? '完成连接' : '闭合' }}
              </button>
            </div>
            <span class="cl-muted cl-small">
              <template v-if="outlinePurpose === 'wall'">
                已画 {{ outlineSegments }} 段 · 连接墙体：画好连接线后双击 / Enter 即生成墙体，Backspace 撤销，Esc 取消
              </template>
              <template v-else-if="outlinePurpose === 'slab-hole'">
                已画 {{ outlineSegments }} 段 · 楼板内环：闭合后需完全位于外轮廓内，Esc 取消
              </template>
              <template v-else>
                已画 {{ outlineSegments }} 段 · 左键落点，双击 / Enter 闭合，Backspace 撤销，Esc 取消
              </template>
            </span>
          </template>
          <span v-else-if="slabOutline" class="cl-muted cl-small">
            地板轮廓已应用到全部楼层（内环 {{ slabHoleCount }} 个），改板厚会即时重建
          </span>
        </div>

        <div class="cl-viewport-wrap">
          <div ref="planElement" v-show="activeTab === 'plan'" class="cl-viewport" />

          <div ref="floorElement" v-show="activeTab === 'floor'" class="cl-viewport" />

          <!-- 侧边楼层列表：非编辑态切换展开楼层，编辑态切换要编辑的楼层 -->
          <div
            v-if="activeTab === 'floor' && wallSummary && wallSummary.params.floorCount > 1"
            class="cl-floor-list"
          >
            <div class="cl-floor-list-title">{{ editMode ? '编辑楼层' : '楼层' }}</div>
            <div class="cl-floor-list-items">
              <button
                v-if="editMode"
                type="button"
                :class="['cl-floor-item', { 'is-active': activeFloor === null }]"
                @click="selectEditFloor(null)"
              >
                整栋
              </button>
              <button
                v-for="index in wallSummary.params.floorCount"
                :key="index"
                type="button"
                :class="['cl-floor-item', { 'is-active': activeFloor === index - 1 }]"
                @click="editMode ? selectEditFloor(index - 1) : toggleFloor(index - 1)"
              >
                F{{ index }}
              </button>
            </div>
          </div>

          <div v-if="!drawing && !parsing" class="cl-drop-zone">
            <div class="cl-drop-card">
              <span class="cl-drop-icon">DXF</span>
              <h2>拖入 CAD 图纸</h2>
              <p>支持 .dxf 与 .dwg，解析后可按图层查看，并选墙体图层生成楼层模型。</p>
              <button class="cl-button cl-button-primary" type="button" @click="fileInput?.click()">选择文件</button>
            </div>
          </div>

          <div v-if="parsing" class="cl-drop-zone">
            <div class="cl-drop-card">
              <span class="cl-spinner" />
              <h2>正在解析</h2>
              <p>首次加载 WASM 需要一点时间，请稍候。</p>
            </div>
          </div>

          <p v-if="activeTab === 'plan' && drawing" class="cl-viewport-hint">滚轮缩放 · 左键拖拽平移 · 双击空白处可重新适配</p>
          <p v-else-if="activeTab === 'floor' && drawing && editMode" class="cl-viewport-hint">
            正交俯视已锁定 · {{ editFloor === null ? '当前编辑整栋，改动同步到全部楼层' : `当前只编辑 F${editFloor + 1}，其他楼层不受影响` }} · 左键点选 / 拖拽框选 · Shift 追加 · Ctrl 减选 · Delete 删除 · 右键或中键平移 · 滚轮缩放
          </p>
          <p v-else-if="activeTab === 'floor' && drawing" class="cl-viewport-hint">
            <template v-if="wallSummary && wallSummary.params.floorCount > 1 && !editMode">
              点击模型或右侧楼层展开 ·
            </template>
            左键旋转 · 右键平移 · 滚轮缩放
          </p>
        </div>
      </main>

      <!-- 右侧面板：材质与楼层模型，紧贴平面视图右侧 -->
      <aside v-if="drawing" class="cl-sidebar cl-sidebar-right">
          <section class="cl-section">
            <div class="cl-section-title">
              <h2>墙体材质</h2>
              <button class="cl-link" type="button" @click="resetWallMaterial">恢复默认</button>
            </div>
            <div class="cl-preset-row">
              <button
                v-for="preset in WALL_MATERIAL_PRESETS"
                :key="preset.id"
                class="cl-link"
                type="button"
                @click="applyWallPreset(preset)"
              >
                {{ preset.label }}
              </button>
            </div>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>颜色</span>
                <input v-model="wallColor" type="color" @change="applyWallMaterial" />
              </label>
              <label class="cl-field">
                <span>金属度</span>
                <input
                  v-model.number="wallMetalness"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  title="0 为非金属，1 为纯金属"
                  @change="applyWallMaterial"
                />
              </label>
            </div>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>粗糙度</span>
                <input
                  v-model.number="wallRoughness"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  title="0 为镜面，1 为全漫反射"
                  @change="applyWallMaterial"
                />
              </label>
            </div>
            <p class="cl-muted cl-small">
              默认哑光涂料；金属度 1 / 粗糙度 0.5 即「金属板」。预置值在生成模型时生效。
            </p>
            <p class="cl-muted cl-small">{{ materialScopeText }}</p>
          </section>

          <section class="cl-section">
            <div class="cl-section-title">
              <h2>楼层模型</h2>
              <button class="cl-link" type="button" @click="recommendWallLayers">推荐墙体图层</button>
            </div>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>楼层数</span>
                <input
                  v-model.number="floorCount"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  :disabled="floorCountLocked"
                  :title="floorCountLocked ? '首次生成前固定为 1，生成楼层模型后可修改' : '调整后立即重新堆叠'"
                  @change="applyBuildingParams"
                />
              </label>
              <label class="cl-field">
                <span>层间距 (m)</span>
                <input
                  v-model.number="floorSpacing"
                  type="number"
                  min="0.5"
                  max="30"
                  step="0.1"
                  title="相邻两层墙体底面的高差"
                  @change="applyBuildingParams"
                />
              </label>
            </div>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>墙高 (m)</span>
                <input
                  v-model.number="wallHeight"
                  type="number"
                  :min="0.5"
                  :max="floorSpacing"
                  step="0.05"
                  title="墙高与板厚之和不得超过层间距"
                  @change="applyBuildingParams"
                />
              </label>
              <label class="cl-field">
                <span>板厚 (m)</span>
                <input
                  v-model.number="slabThickness"
                  type="number"
                  min="0.01"
                  :max="floorSpacing"
                  step="0.01"
                  title="板顶与墙脚齐平，板厚向下占用层间距"
                  @change="applyBuildingParams"
                />
              </label>
            </div>
            <p class="cl-muted cl-small">
              已选 {{ selectedWallLayers.length }} 个墙体图层：门窗类型选「忽略」或「墙体」的按白膜墙生成
              （沿窗线拉薄墙，不带幕墙材质）。
              楼层间隙 {{ wallGap }} m（层间距 − 墙高 − 板厚）。
              <template v-if="floorCountLocked">楼层数首次生成前固定为 1，生成楼层模型后可修改。</template>
              <template v-else>调整楼层数 / 层间距 / 墙高 / 板厚后立即重新堆叠。</template>
            </p>
            <p v-if="invalidWallLayers.length > 0" class="cl-error cl-small">
              墙厚需在 {{ MIN_THICKNESS }} ~ {{ MAX_THICKNESS }} m 之间：{{ invalidWallLayers.join('、') }}
            </p>
            <button
              class="cl-button cl-button-primary cl-full"
              type="button"
              :disabled="selectedWallLayers.length === 0 || invalidWallLayers.length > 0"
              @click="generateFloor"
            >
              {{ floorCount > 1 ? `生成 ${floorCount} 层模型` : '生成单层模型' }}
            </button>
            <template v-if="wallSummary">
              <p class="cl-muted cl-small">
                {{ wallSummary.segments }} 段墙，总长 {{ Math.round(wallSummary.length) }} m，共
                {{ wallSummary.params.floorCount }} 层。
                <template v-if="wallSummary.skipped > 0">因几何退化跳过 {{ wallSummary.skipped }} 条墙带。</template>
              </p>
              <p v-if="wallSummary.paired > 0 || wallSummary.unpaired > 0" class="cl-muted cl-small">
                <template v-if="wallSummary.paired > 0">
                  双线墙实测 {{ wallSummary.paired }} 段，墙厚
                  {{ wallSummary.measured.map((item) => Math.round(item * 1000) + 'mm').join(' / ') }}。
                </template>
                <template v-if="wallSummary.unpaired > 0">
                  {{ wallSummary.unpaired }} 条单线按图层标注或图纸实测厚度建墙。
                </template>
              </p>
              <p
                v-if="wallSummary.filled.sameLayer + wallSummary.filled.parallel + wallSummary.filled.neighbor > 0"
                class="cl-muted cl-small"
              >
                未标注墙厚的单线已按图纸自身证据回填：同图层已解墙段
                {{ wallSummary.filled.sameLayer }} 条、平行墙线实测
                {{ wallSummary.filled.parallel }} 条、端部相连墙段 {{ wallSummary.filled.neighbor }} 条。
              </p>
              <p v-if="wallSummary.snappedCount > 0" class="cl-muted cl-small">
                {{ wallSummary.snappedCount }} 个墙端已延伸吸附到相邻墙体，转角与 T 形接头不再留缝。
              </p>
              <p v-if="wallSummary.droppedDiagonal > 0" class="cl-muted cl-small">
                {{ wallSummary.droppedDiagonal }} 条斜向短线（门扇 / 开启弧线 / 索引线）未生成墙体。
              </p>
              <p v-if="wallSummary.skippedUnresolved > 0" class="cl-error cl-small">
                跳过 {{ wallSummary.skippedUnresolved }} 条单线：图层
                {{ wallSummary.unresolvedLayers.join('、') }} 没有厚度标注，也量不到平行墙线或相邻墙段；
                请在图层面板里补一个墙厚（m）。
              </p>
              <p v-if="wallSummary.curtain" class="cl-muted cl-small">
                玻璃幕墙：{{ wallSummary.curtain.layers.join('、') }}，
                {{ wallSummary.curtain.segments }} 段、总长
                {{ Math.round(wallSummary.curtain.totalLength) }} m，
                竖梃 {{ wallSummary.curtain.mullions }} 根、玻璃 {{ wallSummary.curtain.panes }} 片。
              </p>
              <p v-if="wallSummary.massing" class="cl-muted cl-small">
                白膜墙：{{ wallSummary.massing.layers.join('、') }}，
                {{ wallSummary.massing.segments }} 段、总长
                {{ Math.round(wallSummary.massing.totalLength) }} m，无幕墙材质。
              </p>
            </template>
            <template v-if="openingSummary">
              <p class="cl-muted cl-small">
                门窗：门 {{ openingSummary.doors }} 个，窗 {{ openingSummary.windows }} 个。
                <template v-if="openingSummary.skipped > 0">跳过 {{ openingSummary.skipped }} 个。</template>
              </p>
              <ul v-if="openingSummary.notes.length > 0" class="cl-notes">
                <li v-for="note in openingSummary.notes" :key="note">{{ note }}</li>
              </ul>
            </template>
          </section>

          <section class="cl-section">
            <div class="cl-section-title">
              <h2>程序化构件</h2>
            </div>
            <label class="cl-check">
              <input v-model="podiumEnabled" type="checkbox" @change="onProceduralChange" />
              <span>底座（仅首层）</span>
            </label>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>底座类型</span>
                <select v-model="podiumType" :disabled="!podiumEnabled" @change="onProceduralChange">
                  <option v-for="item in PODIUM_TYPES" :key="item.value" :value="item.value">{{ item.label }}</option>
                </select>
              </label>
            </div>

            <label class="cl-check">
              <input v-model="roofEnabled" type="checkbox" @change="onProceduralChange" />
              <span>屋顶（仅顶层）</span>
            </label>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>屋顶类型</span>
                <select v-model="roofType" :disabled="!roofEnabled" @change="onProceduralChange">
                  <option v-for="item in ROOF_TYPES" :key="item.value" :value="item.value">{{ item.label }}</option>
                </select>
              </label>
            </div>

            <label class="cl-check">
              <input v-model="gateEnabled" type="checkbox" @change="onProceduralChange" />
              <span>大门（正立面）</span>
            </label>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>大门风格</span>
                <select v-model="gateStyle" :disabled="!gateEnabled" @change="onProceduralChange">
                  <option v-for="item in GATE_STYLES" :key="item.value" :value="item.value">{{ item.label }}</option>
                </select>
              </label>
            </div>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>门洞宽 (m)</span>
                <input
                  v-model.number="gateWidth"
                  type="number"
                  min="1"
                  max="40"
                  step="0.1"
                  :disabled="!gateEnabled"
                  @change="onProceduralChange"
                />
              </label>
              <label class="cl-field">
                <span>门洞高 (m)</span>
                <input
                  v-model.number="gateHeight"
                  type="number"
                  min="1"
                  max="20"
                  step="0.1"
                  :disabled="!gateEnabled"
                  @change="onProceduralChange"
                />
              </label>
            </div>

            <label class="cl-check">
              <input v-model="facadeEnabled" type="checkbox" @change="onProceduralChange" />
              <span>墙面立面（逐层）</span>
            </label>
            <div class="cl-field-row">
              <label class="cl-field">
                <span>立面风格</span>
                <select v-model="facadeStyle" :disabled="!facadeEnabled" @change="onProceduralChange">
                  <option v-for="item in FACADE_STYLES" :key="item.value" :value="item.value">{{ item.label }}</option>
                </select>
              </label>
            </div>

            <p v-if="proceduralNotices.length > 0" class="cl-muted cl-small">
              <span v-for="notice in proceduralNotices" :key="notice" class="cl-notice">{{ notice }}</span>
            </p>
            <p v-else class="cl-muted cl-small">
              屋顶与底座优先使用已绘制楼板轮廓，否则取面积最大的闭合墙环；两者都没有时禁用并提示原因。
            </p>
          </section>
      </aside>
    </div>

    <input ref="fileInput" class="cl-hidden-input" type="file" accept=".dxf,.dwg" @change="handleFileInput" />
  </div>
</template>
