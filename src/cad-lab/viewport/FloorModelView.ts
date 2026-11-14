/**
 * 楼层三维预览：把墙体拉伸几何放进独立的 three.js 场景。
 *
 * 与平面视图互不影响：只有用户切到「楼层模型」并触发生成时才创建网格。
 * 本视图同时承担墙段选择：透视轴测与正交俯视两种相机共用同一套屏幕空间拾取逻辑。
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import {
  buildingHeight,
  drawerSlide,
  floorElevation,
  instanceOffsets,
  moveTowards,
  smoothTowards,
  type NormalizedBuildingParams,
} from '../core/buildingModel'
import {
  buildBuildingExportScene,
  exportGlb as serializeGlb,
  type FloorExportOptions,
  type WallExportTextures,
} from '../core/exportGlb'
import type { WallGeometryResult } from '../core/wallModel'
import { buildOpeningGeometry, createOpeningMaterials, pushBox } from '../core/openingModel'
import {
  createCurtainBufferGeometry,
  createCurtainMaterials,
  curtainCenterlines,
  curtainObjectKey,
  DEFAULT_FRAME_DEPTH,
  DEFAULT_MASSING_THICKNESS,
  type CurtainWallGeometry,
} from '../core/curtainModel'
import type { SlabGeometry } from '../core/slabOutline'
import {
  DEFAULT_WALL_MATERIAL,
  normalizeWallMaterial,
  type WallMaterialParams,
} from '../core/materialModel'
import { pickLineAt, selectLinesInRect, type PickLine, type ScreenRect } from '../core/wallSelection'
import { boxProjectUvs } from '../core/surfaceUv'
import { wallVertexShade } from '../core/surfaceShade'
import { createSkyTexture, HORIZON_COLOR, SKY_GROUND_COLOR } from './skyTexture'
import { createPlasterTextures, type PlasterTextures } from './surfaceTextures'

/**
 * 面光源的 LTC 查找表全局只需初始化一次。
 * 视图会随模型重建反复创建销毁，重复初始化只会白白重建两张查找表纹理。
 */
let rectAreaLightReady = false

/** 点选命中阈值（CSS 像素） */
const PICK_THRESHOLD_PX = 10
/** 按下到抬起的位移小于该值时视为点击，否则视为框选 */
const CLICK_DRAG_PX = 4
/** 抽屉单段动画时长（秒）：收回 + 抽出合计约 1 秒 */
const PULL_LEG_SECONDS = 0.5
/** 选中高亮颜色 */
const SELECTION_COLOR = 0xffa23a
/** 悬浮高亮颜色 */
const HOVER_COLOR = 0x7aa7ff
/** 非展开层压暗色：作为实例色与材质色相乘，因此是灰阶乘数 */
const DIM_COLOR = 0x9a958c
/**
 * 石膏法线强度。
 *
 * 与贴图内的起伏联调：1.0 会把 1 米平铺的颗粒放大成砂纸感，
 * 参考视频里的墙面是平整抹灰，只保留掠射角下极轻的起伏。
 * 导出 GLB 时沿用同一数值，保证外部查看器的材质与预览一致。
 */
const WALL_NORMAL_SCALE = 0.1
/** 辅助网格主 / 次线颜色 */
const GRID_MAJOR_COLOR = 0x8f979b
const GRID_MINOR_COLOR = 0x9ea5a8
/** 辅助网格不透明度：只做定位参考，不能抢建筑 */
const GRID_OPACITY = 0.28
/**
 * 半球光强度。
 *
 * 补光只负责把阴影面从死黑拉回到能看清，不能让背光面接近迎光面：
 * 原值 0.7 与天空环境贴图叠加后，整栋楼像被均匀打亮，明暗关系被抹平。
 */
const HEMISPHERE_INTENSITY = 0.35
/**
 * 天空贴图作为环境光（IBL）时的强度。
 *
 * `scene.environmentIntensity` 是全局乘数，只影响照明、不影响背景天空颜色，
 * 因此可以单独压暗环境光而不改动材质颜色与贴图。
 */
const ENVIRONMENT_INTENSITY = 0.45
/**
 * 面光源（柔光箱）强度。
 *
 * 这盏灯不参与造型、也不投影，只负责在墙面上打出一块柔和的反光：
 * 平行光是点状光源，低粗糙度时高光只是一个针尖大的点，几乎看不见；
 * 面光源有面积，反射到墙面上是一片随视角滑动的亮带，这才是「墙面有光泽」的观感。
 */
const SHEEN_LIGHT_INTENSITY = 2.5
/**
 * 面光源方向（单位向量，仰角约 12°）。
 *
 * 压得很低：太阳在 36° 左右，低角度的柔光箱不会和太阳的高光重叠，
 * 两面墙都能各自看到一条柔和的亮带。
 */
const SHEEN_LIGHT_DIRECTION = new THREE.Vector3(1, 0.22, 1).normalize()
/**
 * 俯视姿态相对垂直方向的倾角（弧度，约 1.7°）。
 *
 * 正交相机俯视时如果把 up 设成 (0,0,-1) 并把相机放到正上方，OrbitControls 会按
 * `quat.setFromUnitVectors(up, (0,1,0))` 把偏移换算到 up 对齐的坐标系，极角恰好
 * 等于 π/2，被 maxPolarAngle 钳在边界上：垂直旋转失效、水平旋转退化为绕视线公转
 * （表现为模型在画面里漂移）。因此 up 始终保留 (0,1,0)，用极小倾角避开视线与 up
 * 共线的 lookAt 退化，同时让极角落在可自由旋转的区间内。
 */
const TOP_TILT_RAD = 0.03
/** 极角下限（弧度）：避免相机转到正上方时视线与 up 共线导致画面翻转 */
const MIN_POLAR_ANGLE = 0.01

/** 选择模式：替换 / 追加 / 减选 */
export type SelectionMode = 'replace' | 'add' | 'subtract'
/** 相机模式：透视轴测 / 正交俯视 */
export type CameraMode = 'orbit' | 'top'

/** 一层的墙体几何：逐层删墙后各层可能不同 */
export interface FloorGeometry {
  walls: WallGeometryResult
  /** 玻璃幕墙几何；null / 省略表示该层没有幕墙，各层共用同一份 */
  curtain?: CurtainWallGeometry | null
}

/**
 * 整栋几何：基准 + 逐层。
 *
 * 未做逐层删除的楼层与 `base` 指向同一对象，视图按对象身份复用同一份 three 几何；
 * 做了逐层删除的楼层各自持有一份，避免把顶点复制到每一层。
 */
export interface BuildingGeometry {
  /** 未叠加逐层删除的基准楼层几何 */
  base: FloorGeometry
  /** 每层实际几何，长度等于楼层数 */
  floors: FloorGeometry[]
  /**
   * 整栋共用的楼板几何；null 表示尚未绘制地板轮廓。
   * 轮廓全楼唯一，因此只存一份，逐层复用同一份顶点。
   */
  slab: SlabGeometry | null
}

/** 一份楼层几何对应的 three 资源 */
interface CachedFloorGeometry {
  walls: THREE.BufferGeometry
  /** 门窗构件几何；null 表示该层没有落地洞口 */
  openings: THREE.BufferGeometry | null
  /** 幕墙几何；null 表示该层没有幕墙 */
  curtain: THREE.BufferGeometry | null
}

/**
 * 一层几何里所有可拾取对象（墙段 / 门窗 / 幕墙）的稳定键。
 *
 * 编辑态的点选、框选、全选与删除集都用这套键；宿主在重建后也用它剔除已不存在的键。
 */
export function floorObjectKeys(geometry: FloorGeometry): string[] {
  const keys: string[] = geometry.walls.pieces.map((piece) => piece.key)
  for (const opening of geometry.walls.openings) {
    if (opening.key) keys.push(opening.key)
  }
  for (const line of curtainCenterlines(geometry.curtain)) {
    keys.push(curtainObjectKey(line))
  }
  return keys
}

/** 视图向宿主上报的选择事件 */
export interface FloorModelCallbacks {
  /** 点选到某个可编辑对象（墙段 / 门窗 / 幕墙） */
  onPick?: (key: string, mode: SelectionMode) => void
  /** 点击空白区域 */
  onEmptyClick?: () => void
  /** 框选结果 */
  onBoxSelect?: (keys: string[], mode: SelectionMode) => void
  /** 多层态点击到某一层（下标从 0 起） */
  onFloorPick?: (floorIndex: number) => void
  /** 视图内部切换了相机模式（展开楼层时从俯视正交切回透视轴测），需要同步宿主状态 */
  onCameraModeChange?: (mode: CameraMode) => void
}

/** 楼层预览控制器 */
export class FloorModelView {
  private readonly container: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly perspectiveCamera: THREE.PerspectiveCamera
  private readonly orthographicCamera: THREE.OrthographicCamera
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly gridRoot: THREE.Group
  private readonly modelRoot: THREE.Group
  private readonly boxElement: HTMLDivElement
  private readonly callbacks: FloorModelCallbacks

  private activeCamera: THREE.Camera
  private cameraMode: CameraMode = 'orbit'
  private editMode = false
  private frameHandle = 0
  private disposed = false
  /** 最近一次生成的整栋几何，供取景、拾取与导出复用；为空表示当前没有可导出的模型 */
  private buildingGeometry: BuildingGeometry | null = null
  /** 生成墙体时使用的墙高，拾取时取半高作为中心线代表位置 */
  private wallHeight = 0
  /** 当前相机适配的平面中心 */
  private readonly frameCenter = new THREE.Vector3()
  /** 当前相机适配的模型跨度（米） */
  private frameSpan = 20

  private readonly selectionKeys = new Set<string>()
  /** 主墙体网格；编辑态删除墙段时原地替换它的 position 属性，不重建场景 */
  private wallMesh: THREE.Mesh | null = null
  /** 整栋共用的楼板 three 几何；各层楼板网格共享它，只按层设置标高 */
  private slabGeometry: THREE.BufferGeometry | null = null
  /** 单层态 / 编辑态显示的楼板网格 */
  private slabMesh: THREE.Mesh | null = null
  /** 单层态 / 编辑态显示的门窗构件网格；多层态由各楼层组各自挂载 */
  private openingMesh: THREE.Mesh | null = null
  /** 单层态 / 编辑态显示的幕墙网格；多层态由各楼层组各自挂载 */
  private curtainMesh: THREE.Mesh | null = null
  private selectionMesh: THREE.Mesh | null = null
  private hoverMesh: THREE.Mesh | null = null
  private hoverKey: string | null = null
  private pendingHover: { x: number; y: number } | null = null
  private pointerStart: { x: number; y: number } | null = null
  private boxSelecting = false

  /** 墙体材质参数：默认哑光涂料；由设置面板写入，单层与多层共用 */
  private wallMaterial: WallMaterialParams = { ...DEFAULT_WALL_MATERIAL }
  /** 石膏质感贴图：颜色 / 粗糙度 / 法线，一次生成反复复用 */
  private readonly plasterTextures: PlasterTextures
  /** 蓝天白云背景纹理：同时充当环境光照贴图，销毁时需要手动释放 */
  private readonly skyTexture: THREE.CanvasTexture
  /** 主平行光：提供明暗对比与墙体自阴影 */
  private readonly sunLight: THREE.DirectionalLight
  /** 柔光箱面光源：只负责墙面的柔和反光，不投影 */
  private readonly sheenLight: THREE.RectAreaLight

  /**
   * 多层渲染：每层一个容器组，组内墙体共享同一份几何、各自持有材质。
   *
   * 不用单个 `InstancedMesh`：实例只能共用一份材质，无法做到「改一层的材质不影响
   * 其他层」；分组后每层材质独立，后续要往某层放置模型时直接加进该层 group，
   * 天然跟随该层的抽屉位移与压暗。
   */
  private floorGroups: THREE.Group[] = []
  /**
   * 程序化构件容器（屋顶 / 底座 / 大门 / 立面），附带所属楼层下标。
   * 视图只负责挂载与跟随楼层位移，几何与材质由宿主持有并释放；
   * 楼层下标在导出时用来按标高抬升构件。
   */
  private proceduralDecor: Array<{ object: THREE.Object3D; floorIndex: number }> = []
  /** 墙面立面贴图；null 表示使用默认石膏墙面 */
  private facadeWallTexture: THREE.Texture | null = null
  /** 逐层墙体材质参数，下标即楼层；未单独设置过的层沿用全局材质 */
  private floorMaterials: WallMaterialParams[] = []
  /** 当前建筑的楼层参数；为 null 表示尚未生成 */
  private building: NormalizedBuildingParams | null = null
  /** 当前展开层下标；null 表示整栋贴合 */
  private expandedFloor: number | null = null
  /**
   * 编辑态当前编辑的楼层下标；null 表示编辑基准楼层（改动作用于全部楼层）。
   * 与 `expandedFloor` 分开：编辑态不播放抽屉动画，退出编辑态后展开状态保持不变。
   */
  private editFloor: number | null = null
  /** 抽屉抬升进度 0–1 */
  private pullProgress = 0
  private pullAnimating = false
  /** 切换楼层时的待办目标：先把原楼层收回到 0，再提交这一层 */
  private pendingSwitch: { floor: number | null } | null = null
  /** 相机聚焦目标；null 表示不需要聚焦动画 */
  private readonly focusTarget = new THREE.Vector3()
  private focusDistance: number | null = null
  private focusActive = false
  private lastFrameTime = 0
  /** 视觉状态发生变化、需要提交一帧渲染；无变化时跳过渲染以消除空转开销 */
  private needsRender = true

  constructor(container: HTMLElement, callbacks: FloorModelCallbacks = {}) {
    this.container = container
    this.callbacks = callbacks
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(HORIZON_COLOR, 1)
    // 天空贴图被当成环境光照，开 ACES 色调映射后高光才不会糊成一片
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    // 曝光略高于 1：ACES 会压暗中间调，抬高一点才能让墙面保持接近本色
    this.renderer.toneMappingExposure = 1.12
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // 光源与建筑几何在两次重建之间是静态的：关闭每帧自动更新，只在模型 / 构件 /
    // 楼层位移变化时重算一次阴影。多层模型每帧重算 4096² 阴影是卡顿的主要来源。
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.skyTexture = createSkyTexture()
    // 表面贴图只生成一次：重建几何时不需要重新生成
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    this.plasterTextures = createPlasterTextures(anisotropy)
    // 同一张天空贴图既当背景又当环境光照：蓝色天光自然落到墙体上
    this.scene.background = this.skyTexture
    this.scene.environment = this.skyTexture
    // 环境光单独压暗：背景天空保持明亮，落到材质上的天光只占补光份额
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY
    this.scene.fog = new THREE.Fog(HORIZON_COLOR, 260, 1100)

    this.perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)
    this.perspectiveCamera.position.set(60, 60, 60)
    this.orthographicCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 5000)
    // 两个相机都保持 up = (0,1,0)：OrbitControls 依赖 up 推导旋转坐标系，
    // 换成别的方向会让极角落到边界上（详见 TOP_TILT_RAD 注释）
    this.activeCamera = this.perspectiveCamera

    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minPolarAngle = MIN_POLAR_ANGLE
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.minDistance = 1
    this.controls.maxDistance = 3000
    this.applyControlMapping()

    // 主光与环境光拉开配比：太阳占主导才有「亮面 / 暗面」的层次，
    // 环境光只负责把阴影补到能看清，不至于把整面墙照平
    const hemisphere = new THREE.HemisphereLight(0xcfe0f2, SKY_GROUND_COLOR, HEMISPHERE_INTENSITY)
    this.scene.add(hemisphere)
    this.sunLight = new THREE.DirectionalLight(0xfff2dd, 2.8)
    // 低角度侧光（仰角约 33°）：墙面出现从墙脚到墙顶的明暗过渡，地面投出长影
    this.sunLight.position.set(95, 72, 60)
    this.sunLight.castShadow = true
    this.sunLight.shadow.mapSize.set(4096, 4096)
    this.sunLight.shadow.bias = -0.0004
    // 薄墙容易出现自阴影条纹，法线偏移比单纯调 bias 更干净
    this.sunLight.shadow.normalBias = 0.02
    this.scene.add(this.sunLight)
    this.scene.add(this.sunLight.target)

    // 柔光箱面光源：面积越大反光越柔，具体尺寸与位置在 fitShadowCamera 里按建筑
    // 尺度重设，保证任何大小的平面图都能在墙面上看到一条连续的反光带
    if (!rectAreaLightReady) {
      RectAreaLightUniformsLib.init()
      rectAreaLightReady = true
    }
    this.sheenLight = new THREE.RectAreaLight(0xeef4ff, SHEEN_LIGHT_INTENSITY, 60, 24)
    this.sheenLight.position.copy(SHEEN_LIGHT_DIRECTION).multiplyScalar(120)
    this.sheenLight.lookAt(0, 0, 0)
    this.scene.add(this.sheenLight)

    this.gridRoot = new THREE.Group()
    this.modelRoot = new THREE.Group()
    // 图纸平面以 +y 为北，three.js 世界坐标以 −z 为北；几何一律按图纸坐标生成，
    // 再在这里对整栋模型做一次 z 轴镜像，俯视时才能与平面图完全一致（北在上、东在右）。
    // 镜像的行列式为负，three 会据此自动翻转正面绕序，法线走逆转置矩阵，光照与阴影仍然正确。
    this.modelRoot.scale.set(1, 1, -1)
    this.scene.add(this.gridRoot)
    this.scene.add(this.modelRoot)

    this.boxElement = document.createElement('div')
    this.boxElement.className = 'cl-select-box'
    this.boxElement.style.display = 'none'
    container.appendChild(this.boxElement)

    const target = this.renderer.domElement
    target.addEventListener('pointerdown', this.handlePointerDown)
    target.addEventListener('pointermove', this.handlePointerMove)
    target.addEventListener('pointerup', this.handlePointerUp)
    target.addEventListener('pointerleave', this.handlePointerLeave)
    target.addEventListener('wheel', this.handleWheel, { passive: true })

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)
    this.handleResize()
    this.startLoop()
  }

  /**
   * 用整栋建筑替换当前模型。
   *
   * 每层持有各自的墙体几何（逐层删墙后各层可能不同），未单独编辑的楼层与
   * 基准楼层是同一份对象，three 几何按对象身份只创建一次。单层与多层共用同一个
   * 单层网格入口：编辑态显示当前编辑目标的几何，非编辑态显示每层的容器组。
   */
  setBuilding(geometry: BuildingGeometry, params: NormalizedBuildingParams): void {
    this.clearModel()
    this.building = params
    this.buildingGeometry = geometry
    this.expandedFloor = null
    this.editFloor = null
    this.pullProgress = 0
    this.pullAnimating = false
    this.pendingSwitch = null
    this.focusActive = false
    this.focusDistance = null
    this.wallHeight = params.wallHeight
    this.selectionKeys.clear()
    this.selectionMesh = null
    this.hoverMesh = null
    this.hoverKey = null
    this.pendingHover = null
    const frameBounds = this.viewBounds() ?? geometry.base.walls.bounds
    this.buildGrid(frameBounds)
    this.fitShadowCamera(frameBounds)

    // 逐层材质按楼层数对齐：已有楼层保留各自设置，新增楼层沿用全局材质
    this.floorMaterials = this.alignFloorMaterials(params)
    this.rebuildMeshes()

    this.applyVisibility()
    this.applyFloorTransforms()
    this.updateFloorAppearance()
    this.viewWholeBuilding()
  }

  /**
   * 挂载程序化构件：下标即楼层，容器跟随该层的抽屉位移与显隐。
   *
   * 单层建筑没有楼层容器，构件直接挂到模型根（标高同样为 0）。
   * 旧构件在这里只摘除不释放：释放规则由宿主决定（构件材质多为共享缓存）。
   */
  setProceduralDecor(groups: ReadonlyArray<THREE.Object3D | null>): void {
    this.detachProceduralDecor()
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]
      if (!group) continue
      const target = this.floorGroups[index] ?? (index === 0 ? this.modelRoot : null)
      if (!target) continue
      target.add(group)
      this.proceduralDecor.push({ object: group, floorIndex: index })
    }
    // 构件自带投影几何，挂载后需要重算一次阴影
    this.invalidateShadow()
  }

  private detachProceduralDecor(): void {
    for (const entry of this.proceduralDecor) entry.object.removeFromParent()
    this.proceduralDecor = []
    this.invalidateShadow()
  }

  /**
   * 切换墙面外皮：传入立面贴图时墙带外表面改用该风格的立面 tile，
   * 传 null 时恢复默认石膏墙面。
   *
   * 只替换颜色贴图，并在上立面时关闭石膏法线 / 粗糙度贴图，避免两层纹理互相干扰；
   * 贴图释放由调用方负责（同一张贴图被所有楼层共享）。
   */
  setWallFacadeTexture(texture: THREE.Texture | null): void {
    this.facadeWallTexture = texture
    for (const material of this.wallMaterials()) {
      material.map = texture ?? this.plasterTextures.color
      material.normalMap = texture ? null : this.plasterTextures.normal
      material.roughnessMap = texture ? null : this.plasterTextures.roughness
      material.userData.facadeSkinned = texture !== null
      material.needsUpdate = true
    }
    // 立面贴图下墙体基色取纯白，否则漆面颜色会把贴图整体染色
    this.applyWallBaseColors()
    this.invalidate()
  }

  /** 当前模型的全部墙体材质（单层墙网格 + 各楼层墙网格） */
  private wallMaterials(): THREE.MeshStandardMaterial[] {
    const result: THREE.MeshStandardMaterial[] = []
    const single = this.wallMesh?.material
    if (single instanceof THREE.MeshStandardMaterial) result.push(single)
    for (const group of this.floorGroups) {
      for (const child of group.children) {
        if (!(child instanceof THREE.Mesh)) continue
        if (child.userData.floorPart !== 'walls') continue
        if (child.material instanceof THREE.MeshStandardMaterial) result.push(child.material)
      }
    }
    return result
  }

  /** 按当前是否铺立面贴图重置墙体基色（多层时保留非展开层的压暗） */
  private applyWallBaseColors(): void {
    const dim = new THREE.Color(DIM_COLOR)
    const single = this.wallMesh?.material
    if (single instanceof THREE.MeshStandardMaterial) {
      if (this.facadeWallTexture) single.color.setScalar(1)
      else single.color.set(this.wallMaterial.color)
    }
    for (const group of this.floorGroups) {
      const dimmed = this.expandedFloor !== null && group !== this.floorGroups[this.expandedFloor]
      for (const child of group.children) {
        if (!(child instanceof THREE.Mesh)) continue
        if (child.userData.floorPart !== 'walls') continue
        const material = child.material
        if (!(material instanceof THREE.MeshStandardMaterial)) continue
        if (this.facadeWallTexture) material.color.setScalar(1)
        else {
          const base = child.userData.baseColor as THREE.Color | undefined
          if (!base) continue
          material.color.copy(base)
        }
        if (dimmed) material.color.multiply(dim)
      }
    }
  }

  /**
   * 原地更新整栋建筑：只替换几何数据，不重置相机与展开状态。
   *
   * 逐层删墙后每层几何可能不同，无法再原地改一份共享属性；改为按新的楼层几何
   * 重建网格（几何对象仍按身份复用），相机、展开状态与楼层材质保持不变。
   */
  updateBuilding(geometry: BuildingGeometry, params: NormalizedBuildingParams): void {
    this.building = params
    this.buildingGeometry = geometry
    this.wallHeight = params.wallHeight
    // 楼层数变化后原编辑目标可能越界：回到基准楼层，由宿主重新选择
    if (this.editFloor !== null && this.editFloor >= params.floorCount) this.editFloor = null
    this.floorMaterials = this.alignFloorMaterials(params)

    this.clearModel()
    this.rebuildMeshes()
    this.applyVisibility()
    this.applyFloorTransforms()
    this.updateFloorAppearance()

    // 选中集里已不存在的键直接丢弃，避免高亮指向已删除的片段
    this.pruneSelection()
    this.hoverKey = null
    this.clearHover()
    this.rebuildSelection()
  }

  /**
   * 设置编辑态编辑的楼层；`null` 表示编辑基准楼层（改动作用于全部楼层）。
   *
   * 只换编辑目标的几何与取景，不改动展开状态，也不播放抽屉动画。
   */
  setEditFloor(index: number | null): void {
    const params = this.building
    if (index !== null) {
      if (!params || !Number.isInteger(index) || index < 0 || index >= params.floorCount) {
        throw new Error(`楼层下标超出范围：${index}`)
      }
    }
    if (this.editFloor === index) return
    this.editFloor = index
    if (!this.buildingGeometry) return

    this.clearModel()
    this.rebuildMeshes()
    this.applyVisibility()
    this.applyFloorTransforms()
    this.updateFloorAppearance()
    this.pruneSelection()
    this.hoverKey = null
    this.clearHover()
    this.rebuildSelection()
    // 编辑态锁定正交俯视：换了编辑目标就把取景同步到该层
    if (this.editMode && this.cameraMode === 'top') this.applyTopViewFrame()
  }

  /** 逐层材质按楼层数对齐：已有楼层保留，新增楼层继承全局材质 */
  private alignFloorMaterials(params: NormalizedBuildingParams): WallMaterialParams[] {
    const previous = this.floorMaterials
    return Array.from({ length: params.floorCount }, (_, index) =>
      previous[index] ? { ...previous[index] } : { ...this.wallMaterial },
    )
  }

  /**
   * 按当前整栋几何重建墙体网格。
   *
   * 编辑态单层网格与楼层组共用同一个几何缓存：`FloorGeometry` 对象相同即复用，
   * 所以未做逐层删除的楼层仍然只存一份顶点，只有单独编辑过的楼层才多一份。
   */
  private rebuildMeshes(): void {
    const geometry = this.buildingGeometry
    const params = this.building
    if (!geometry || !params) return

    const cache = new Map<FloorGeometry, CachedFloorGeometry>()
    const cached = (entry: FloorGeometry): CachedFloorGeometry => {
      const existing = cache.get(entry)
      if (existing) return existing
      const created = this.createCachedGeometry(entry)
      cache.set(entry, created)
      return created
    }

    const edit = cached(this.editTarget())
    const editMaterial =
      this.editFloor === null ? this.wallMaterial : this.floorMaterials[this.editFloor]
    const wallMesh = new THREE.Mesh(edit.walls, this.createWallMaterial(editMaterial))
    wallMesh.name = this.editFloor === null ? 'walls' : `floor-${this.editFloor}-walls`
    wallMesh.castShadow = true
    wallMesh.receiveShadow = true
    this.wallMesh = wallMesh
    this.modelRoot.add(wallMesh)

    // 门窗构件：与墙体同一份洞口数据，编辑态同样跟随编辑目标
    if (edit.openings) {
      const openingMesh = new THREE.Mesh(edit.openings, createOpeningMaterials())
      openingMesh.name = this.editFloor === null ? 'openings' : `floor-${this.editFloor}-openings`
      openingMesh.castShadow = true
      openingMesh.receiveShadow = true
      openingMesh.userData.floorPart = 'openings'
      this.openingMesh = openingMesh
      this.modelRoot.add(openingMesh)
    }

    // 玻璃幕墙：整栋共用同一份几何，逐层按标高复制网格
    if (edit.curtain) {
      const curtainMesh = new THREE.Mesh(edit.curtain, createCurtainMaterials())
      curtainMesh.name = this.editFloor === null ? 'curtain' : `floor-${this.editFloor}-curtain`
      curtainMesh.castShadow = true
      curtainMesh.receiveShadow = true
      curtainMesh.userData.floorPart = 'curtain'
      this.curtainMesh = curtainMesh
      this.modelRoot.add(curtainMesh)
    }

    // 楼板：几何只建一份，各层网格共享；轮廓为空时不生成任何板
    if (geometry.slab) {
      this.slabGeometry = this.createSlabBufferGeometry(geometry.slab)
      const slabMesh = this.createSlabMesh(this.slabGeometry, this.createSlabMaterials())
      slabMesh.name = 'slab'
      this.slabMesh = slabMesh
      this.modelRoot.add(slabMesh)
    }

    if (params.floorCount > 1) this.buildFloorGroups(cached, params)
    // 新网格与阴影投射体都变了：提交一帧并重算阴影
    this.invalidateShadow()
  }

  /** 楼板 three 几何：位置与法线直接来自挤出结果，UV 按米平铺 */
  private createSlabBufferGeometry(slab: SlabGeometry): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(slab.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(slab.normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(boxProjectUvs(slab.positions), 2))
    // group 0 为上下端盖（顶面 / 底面），group 1 为侧壁，各自一套材质
    for (const group of slab.groups) {
      geometry.addGroup(group.start, group.count, group.materialIndex)
    }
    geometry.computeBoundingSphere()
    return geometry
  }

  /** 楼板材质：板面与墙同色，侧壁略深，避免整块板糊成一个平面色块 */
  private createSlabMaterials(): THREE.MeshStandardMaterial[] {
    const base = new THREE.Color(this.wallMaterial.color)
    const cap = base.clone()
    const side = base.clone().multiplyScalar(0.9)
    return [cap, side].map((color) => {
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.88,
        metalness: 0,
        envMapIntensity: 0.45,
        side: THREE.FrontSide,
      })
      // 展开楼层时其余层要压暗，基准色存在材质上，逐层材质互不影响
      material.userData.baseColor = color.clone()
      return material
    })
  }

  /** 用共享几何建一个楼板网格；顶面落在 y = 0，即所在楼层的标高 */
  private createSlabMesh(
    slabGeometry: THREE.BufferGeometry,
    materials: THREE.MeshStandardMaterial[],
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(slabGeometry, materials)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.floorPart = 'slab'
    // 楼板不参与楼层拾取：俯视时它铺满整个平面，否则永远命中楼板而不是墙体
    mesh.raycast = () => {}
    return mesh
  }

  /** 编辑目标几何：选中楼层优先，否则基准楼层 */
  private editTarget(): FloorGeometry {
    const geometry = this.buildingGeometry
    if (!geometry) throw new Error('尚未生成楼层模型')
    if (this.editFloor === null) return geometry.base
    return geometry.floors[this.editFloor]
  }

  /** 当前可拾取的墙段来源：编辑目标楼层；没有模型时为空 */
  private pickableGeometry(): FloorGeometry | null {
    return this.buildingGeometry === null ? null : this.editTarget()
  }

  /**
   * 当前可拾取对象的代表线段：墙中心线 + 门窗洞口中心线 + 幕墙中心线。
   *
   * 三者共用同一套屏幕空间判定，编辑态因此可以点选 / 框选任意构件，
   * 而不是只能选到墙段。
   */
  private pickLines(): PickLine[] {
    const target = this.pickableGeometry()
    if (!target) return []
    const midHeight = this.wallHeight / 2
    const lines: PickLine[] = []
    for (const piece of target.walls.pieces) {
      lines.push({
        key: piece.key,
        a: new THREE.Vector3(piece.a.x, midHeight, piece.a.y),
        b: new THREE.Vector3(piece.b.x, midHeight, piece.b.y),
      })
    }
    for (const opening of target.walls.openings) {
      if (!opening.key) continue
      // 洞口取自身半高作为代表标高：高处是窗、低处是门，选中的位置与看到的构件一致
      const y = opening.sill + opening.height / 2
      const half = opening.width / 2
      const ux = opening.direction.x
      const uz = opening.direction.y
      lines.push({
        key: opening.key,
        a: new THREE.Vector3(opening.center.x - ux * half, y, opening.center.y - uz * half),
        b: new THREE.Vector3(opening.center.x + ux * half, y, opening.center.y + uz * half),
      })
    }
    for (const line of curtainCenterlines(target.curtain)) {
      lines.push({
        key: curtainObjectKey(line),
        a: new THREE.Vector3(line.a.x, midHeight, line.a.y),
        b: new THREE.Vector3(line.b.x, midHeight, line.b.y),
      })
    }
    return lines
  }

  /** 丢弃编辑目标几何里已不存在的选择键 */
  private pruneSelection(): void {
    const available = new Set(floorObjectKeys(this.editTarget()))
    for (const key of [...this.selectionKeys]) {
      if (!available.has(key)) this.selectionKeys.delete(key)
    }
  }


  /** 由楼层几何数据创建 three 几何 */
  private createCachedGeometry(entry: FloorGeometry): CachedFloorGeometry {
    const params = this.building
    if (!params) throw new Error('尚未生成楼层模型')

    const walls = new THREE.BufferGeometry()
    walls.setAttribute('position', new THREE.BufferAttribute(entry.walls.positions, 3))
    // 盒式投影 UV：让石膏贴图按米平铺，墙面朝向不同也不会拉伸
    walls.setAttribute('uv', new THREE.BufferAttribute(boxProjectUvs(entry.walls.positions), 2))
    // 顶点色伪 AO：墙脚、墙顶与内转角压暗，这是「落地感」的主要来源
    walls.setAttribute(
      'color',
      new THREE.BufferAttribute(wallVertexShade(entry.walls.positions, params.wallHeight), 3),
    )
    walls.computeVertexNormals()
    walls.computeBoundingSphere()

    return {
      walls,
      openings: buildOpeningGeometry(entry.walls.openings),
      curtain: entry.curtain ? createCurtainBufferGeometry(entry.curtain) : null,
    }
  }

  /**
   * 为每层建一个容器组：几何按楼层取（未编辑的层与基准共享），材质逐层独立。
   *
   * 后续「放置模型到指定楼层」时直接 `floorGroups[i].add(model)` 即可，
   * 该对象会自动跟随这一层的抽屉位移，也不会被别的楼层的材质改动波及。
   */
  private buildFloorGroups(
    cached: (entry: FloorGeometry) => CachedFloorGeometry,
    params: NormalizedBuildingParams,
  ): void {
    const geometry = this.buildingGeometry
    if (!geometry) throw new Error('尚未生成楼层模型')
    if (geometry.floors.length !== params.floorCount) {
      throw new Error(`楼层几何数量与楼层数不一致：${geometry.floors.length} / ${params.floorCount}`)
    }

    for (let index = 0; index < params.floorCount; index += 1) {
      const group = new THREE.Group()
      group.name = `floor-${index}`
      group.userData.floorIndex = index

      const floorGeometry = cached(geometry.floors[index])
      const material = this.createWallMaterial(this.floorMaterials[index])
      const mesh = new THREE.Mesh(floorGeometry.walls, material)
      mesh.name = `floor-${index}-walls`
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.floorIndex = index
      mesh.userData.floorPart = 'walls'
      mesh.userData.baseColor = new THREE.Color(this.floorMaterials[index].color)
      group.add(mesh)

      // 门窗构件与墙体共用同一份洞口数据，逐层各自一份材质以便压暗
      if (floorGeometry.openings) {
        const openingMesh = new THREE.Mesh(floorGeometry.openings, createOpeningMaterials())
        openingMesh.name = `floor-${index}-openings`
        openingMesh.castShadow = true
        openingMesh.receiveShadow = true
        openingMesh.userData.floorIndex = index
        openingMesh.userData.floorPart = 'openings'
        group.add(openingMesh)
      }

      // 玻璃幕墙：与墙体同样逐层挂载，几何共享、材质独立
      if (floorGeometry.curtain) {
        const curtainMesh = new THREE.Mesh(floorGeometry.curtain, createCurtainMaterials())
        curtainMesh.name = `floor-${index}-curtain`
        curtainMesh.castShadow = true
        curtainMesh.receiveShadow = true
        curtainMesh.userData.floorIndex = index
        curtainMesh.userData.floorPart = 'curtain'
        group.add(curtainMesh)
      }

      // 楼板与墙体共用同一份 BufferGeometry，只是每层各自一份材质
      if (this.slabGeometry) {
        const slabMesh = this.createSlabMesh(this.slabGeometry, this.createSlabMaterials())
        slabMesh.name = `floor-${index}-slab`
        slabMesh.userData.floorIndex = index
        group.add(slabMesh)
      }

      this.floorGroups.push(group)
      this.modelRoot.add(group)
    }
  }

  /** 清空模型但保留场景、地面、灯光与相机 */
  clearBuilding(): void {
    this.clearModel()
    this.building = null
    this.buildingGeometry = null
    // 逐层材质属于这份模型，换图纸后回到全局材质
    this.floorMaterials = []
    this.expandedFloor = null
    this.editFloor = null
    this.pullProgress = 0
    this.pullAnimating = false
    this.focusActive = false
    this.focusDistance = null
    this.selectionKeys.clear()
    this.disposeHighlight(this.selectionMesh)
    this.selectionMesh = null
    this.clearHover()
    this.invalidateShadow()
  }

  /**
   * 展开 / 收起某一层。
   * `index` 为 null 表示收起；重复传入同一下标视为状态不变，切换逻辑由宿主负责。
   *
   * 展开时若处于俯视正交，先切回透视轴测：抽屉位移沿 Y 轴，正好与俯视视线同向，
   * 正交俯视下完全看不出抬升，必须换成有透视缩放的轴测视角。
   */
  setExpandedFloor(index: number | null): void {
    const params = this.building
    if (!params || params.floorCount <= 1) {
      this.expandedFloor = null
      this.pendingSwitch = null
      return
    }
    if (index !== null && (index < 0 || index >= params.floorCount)) {
      throw new Error(`楼层下标超出范围：${index}`)
    }
    if (index === this.expandedFloor) {
      // 回撤途中又点了原楼层：取消切换，让进度直接回到 1，重新抽出来
      if (this.pendingSwitch) {
        this.pendingSwitch = null
        this.pullAnimating = true
      }
      return
    }

    // 已有楼层展开：先把原楼层整体收回去，收完再抽出新楼层，避免两层硬切
    if (this.expandedFloor !== null && this.pullProgress > 0) {
      this.pendingSwitch = { floor: index }
      this.pullAnimating = true
      return
    }

    this.commitExpandedFloor(index)
  }

  /** 提交展开目标：更新高亮、相机与抽屉动画方向 */
  private commitExpandedFloor(index: number | null): void {
    const wasExpanded = this.expandedFloor !== null
    this.expandedFloor = index
    this.pullAnimating = true
    this.updateFloorAppearance()
    if (index === null) {
      this.viewWholeBuilding(wasExpanded)
      return
    }
    this.switchToOrbitCamera()
    this.focusFloor(index)
  }

  /** 从正交俯视切回透视轴测；已经处于轴测时不做任何事 */
  private switchToOrbitCamera(): void {
    if (this.cameraMode === 'orbit') return
    this.cameraMode = 'orbit'
    this.activeCamera = this.perspectiveCamera
    this.controls.object = this.perspectiveCamera
    // 从俯视切回轴测：恢复左键旋转
    this.applyControlMapping()
    // 先把透视相机放回整栋取景位，再交给 focusFloor 平滑推近
    this.viewWholeBuilding()
    this.callbacks.onCameraModeChange?.('orbit')
  }

  /**
   * 把当前建筑导出为 .glb。
   *
   * 多层按各层几何逐层烘焙为合并网格，并写入 `extras.floors`；
   * 墙体材质连同表面贴图、程序化构件（屋顶 / 底座 / 大门 / 立面）一起导出，
   * 外部查看器看到的材质与细部与预览一致。
   */
  async exportGlb(options: FloorExportOptions): Promise<ArrayBuffer> {
    const geometry = this.buildingGeometry
    const params = this.building
    if (!geometry || !params) throw new Error('尚未生成楼层模型，无法导出')
    return serializeGlb(
      buildBuildingExportScene(
        geometry.floors.map((floor) => ({
          walls: floor.walls,
          slab: geometry.slab,
          curtain: floor.curtain ?? null,
        })),
        params,
        {
          ...options,
          material: this.wallMaterial,
          textures: this.exportWallTextures(),
        },
        this.proceduralDecor,
      ),
    )
  }

  /** 导出用的墙体表面贴图：铺了立面时只用立面贴图，否则用石膏三件套 */
  private exportWallTextures(): WallExportTextures {
    if (this.facadeWallTexture) {
      return { map: this.facadeWallTexture, roughnessMap: null, normalMap: null }
    }
    return {
      map: this.plasterTextures.color,
      roughnessMap: this.plasterTextures.roughness,
      normalMap: this.plasterTextures.normal,
      normalScale: WALL_NORMAL_SCALE,
    }
  }

  /** 墙体材质：哑光石膏质感，颜色 / 金属度 / 粗糙度由设置面板覆盖 */
  private createWallMaterial(params: WallMaterialParams = this.wallMaterial): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: params.color,
      roughness: params.roughness,
      metalness: params.metalness,
      map: this.plasterTextures.color,
      roughnessMap: this.plasterTextures.roughness,
      normalMap: this.plasterTextures.normal,
      // 与贴图内的法线强度联调：1.0 会把 1 米平铺的颗粒放大成砂纸感，
      // 参考视频里的墙面是平整抹灰，只保留掠射角下极轻的起伏
      normalScale: new THREE.Vector2(WALL_NORMAL_SCALE, WALL_NORMAL_SCALE),
      // 哑光墙面几乎不反射天空，压低环境贴图强度才能保住太阳形成的明暗层次
      envMapIntensity: 1,
      // 顶点色是伪 AO：未开启时 color 属性会被忽略，墙脚与转角就回到硬切状
      vertexColors: true,
      side: THREE.FrontSide,
    })
  }

  /**
   * 更新墙体 PBR 材质。
   *
   * `floorIndex` 省略时改全局材质并同步到所有楼层；传入楼层下标时只改这一层，
   * 其他楼层（含后续放进该层 group 的模型）不受影响。
   */
  setWallMaterial(params: WallMaterialParams, floorIndex?: number): void {
    const material = normalizeWallMaterial(params)
    if (floorIndex === undefined) {
      this.wallMaterial = material
      this.floorMaterials = this.floorMaterials.map(() => ({ ...material }))
      this.applyWallParams(this.wallMesh?.material, material)
      for (const group of this.floorGroups) {
        for (const child of group.children) {
          if (!(child instanceof THREE.Mesh)) continue
          if (child.userData.floorPart !== 'walls') continue
          this.applyWallParams(child.material, material)
          child.userData.baseColor = new THREE.Color(material.color)
        }
      }
    } else {
      if (!Number.isInteger(floorIndex) || floorIndex < 0 || floorIndex >= this.floorMaterials.length) {
        throw new Error(`楼层下标超出范围：${floorIndex}`)
      }
      this.floorMaterials[floorIndex] = { ...material }
      const group = this.floorGroups[floorIndex]
      for (const child of group?.children ?? []) {
        if (!(child instanceof THREE.Mesh)) continue
        if (child.userData.floorPart !== 'walls') continue
        this.applyWallParams(child.material, material)
        child.userData.baseColor = new THREE.Color(material.color)
      }
      // 编辑态显示的是该层的单层网格，改的正是这一层时同步过去
      if (this.editFloor === floorIndex) this.applyWallParams(this.wallMesh?.material, material)
    }
    this.updateFloorAppearance()
    this.invalidate()
  }

  /** 读取某一层的墙体材质；省略下标时返回全局材质（新增楼层的默认值） */
  getWallMaterial(floorIndex?: number): WallMaterialParams {
    if (floorIndex === undefined) return { ...this.wallMaterial }
    if (!Number.isInteger(floorIndex) || floorIndex < 0 || floorIndex >= this.floorMaterials.length) {
      throw new Error(`楼层下标超出范围：${floorIndex}`)
    }
    return { ...this.floorMaterials[floorIndex] }
  }

  /** 把一组 PBR 参数写进材质；非标准材质直接忽略 */
  private applyWallParams(material: THREE.Material | THREE.Material[] | undefined, params: WallMaterialParams): void {
    if (!(material instanceof THREE.MeshStandardMaterial)) return
    // 已铺立面贴图的墙面忽略漆面颜色，避免把 tile 整体染色
    if (!material.userData.facadeSkinned) material.color.set(params.color)
    material.metalness = params.metalness
    material.roughness = params.roughness
    material.needsUpdate = true
  }

  /** 单层与多层、编辑态与非编辑态的可见性切换 */
  private applyVisibility(): void {
    const multi = (this.building?.floorCount ?? 1) > 1
    const showFloors = multi && !this.editMode
    for (const group of this.floorGroups) group.visible = showFloors
    if (this.wallMesh) this.wallMesh.visible = !showFloors
    if (this.slabMesh) this.slabMesh.visible = !showFloors
    if (this.openingMesh) this.openingMesh.visible = !showFloors
    if (this.curtainMesh) this.curtainMesh.visible = !showFloors
    this.invalidate()
  }

  /** 按展开进度刷新每层容器组的位置；被展开层水平滑出，其上方楼层整体抬升 */
  private applyFloorTransforms(): void {
    const params = this.building
    if (!params || params.floorCount <= 1) return
    const offsets = instanceOffsets(params, this.expandedFloor, this.pullProgress)
    const bounds = this.viewBounds()
    // 被展开的楼层不做竖向位移，改为沿 XZ 平面整体滑出
    const slide =
      this.expandedFloor === null || !bounds
        ? { x: 0, z: 0, span: 0 }
        : drawerSlide(bounds, params, this.pullProgress)
    for (let index = 0; index < this.floorGroups.length; index += 1) {
      const pulled = index === this.expandedFloor
      this.floorGroups[index].position.set(
        pulled ? slide.x : 0,
        floorElevation(index, params) + offsets[index],
        pulled ? slide.z : 0,
      )
    }
    // 楼层位移改变了阴影投射体位置，需要重算阴影并重绘
    this.invalidateShadow()
  }

  /**
   * 展开层保持本色、其余楼层压暗；无展开层时全部恢复本色。
   *
   * 压暗作用在每层自己的材质上（基准色 × 中性乘数），不会覆盖用户为该层单独
   * 设置的颜色，也不会波及别的楼层。
   */
  private updateFloorAppearance(): void {
    this.invalidate()
    if (!this.building || this.building.floorCount <= 1) return
    const dim = new THREE.Color(DIM_COLOR)
    for (let index = 0; index < this.floorGroups.length; index += 1) {
      const dimmed = this.expandedFloor !== null && index !== this.expandedFloor
      for (const child of this.floorGroups[index].children) {
        if (!(child instanceof THREE.Mesh)) continue
        // 楼板是材质数组（端盖 / 侧壁），基准色存在各自材质上
        if (Array.isArray(child.material)) {
          for (const material of child.material) {
            const base = material.userData.baseColor as THREE.Color | undefined
            if (!(material instanceof THREE.MeshStandardMaterial) || !base) continue
            material.color.copy(base)
            if (dimmed) material.color.multiply(dim)
          }
          continue
        }
        const material = child.material
        if (!(material instanceof THREE.MeshStandardMaterial)) continue
        const base = child.userData.baseColor as THREE.Color | undefined
        if (!base) continue
        // 已铺立面贴图的墙面基色取纯白，避免漆面颜色把贴图染色
        if (material.userData.facadeSkinned) material.color.setScalar(1)
        else material.color.copy(base)
        if (dimmed) material.color.multiply(dim)
      }
    }
  }

  /** 相机对准整栋建筑：目标在总高度中心，距离覆盖最大平面跨度与总高 */
  private viewWholeBuilding(smooth = false): void {
    const params = this.building
    const bounds = this.viewBounds()
    if (!params || !bounds) {
      this.applyVisibility()
      return
    }
    const totalHeight = buildingHeight(params)
    const spanX = bounds.maxX - bounds.minX
    const spanY = bounds.maxY - bounds.minY
    const span = spanX > spanY ? spanX : spanY
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerZ = this.planCenterZ(bounds)

    if (params.floorCount <= 1) {
      this.fit(bounds)
      return
    }

    const size = Math.max(span, totalHeight, 20) * 1.15
    // 收起时只设置聚焦目标，由逐帧插值平滑退回整栋取景
    if (smooth) {
      this.focusTarget.set(centerX, totalHeight / 2, centerZ)
      this.focusDistance = size
      this.focusActive = true
      return
    }

    this.frameCenter.set(centerX, totalHeight / 2, centerZ)
    this.frameSpan = size
    this.perspectiveCamera.position.set(
      centerX + size * 0.72,
      totalHeight / 2 + size * 0.65,
      centerZ + size * 0.72,
    )
    this.perspectiveCamera.near = size / 500
    this.perspectiveCamera.far = size * 20
    this.perspectiveCamera.updateProjectionMatrix()
    this.applyOrthoFrustum()
    if (this.cameraMode === 'top') {
      // 俯视正交不看整栋高度：高度不参与俯视投影，按整栋跨度取景只会把模型缩成一小块
      this.applyTopViewFrame()
    } else {
      this.controls.target.copy(this.frameCenter)
      this.syncActiveCamera()
    }
    this.scene.fog = new THREE.Fog(HORIZON_COLOR, size * 2.2, size * 6)
  }

  /** 聚焦到某一层：目标点落在该层墙高中部，横坐标跟随抽屉滑出位置 */
  private focusFloor(index: number): void {
    const params = this.building
    const bounds = this.viewBounds()
    if (!params || !bounds || this.editMode) return
    const slide = drawerSlide(bounds, params, 1)
    this.focusTarget.set(
      (bounds.minX + bounds.maxX) / 2 + slide.x,
      floorElevation(index, params) + params.wallHeight / 2,
      // 楼层在模型内沿 +z 滑出，镜像后世界 z 取负
      this.planCenterZ(bounds) - slide.z,
    )
    // 被抽出的楼层已经离开建筑轮廓，取景距离要同时覆盖滑出后的位置与平面跨度
    const spanX = bounds.maxX - bounds.minX
    const spanZ = bounds.maxY - bounds.minY
    const span = Math.max(spanX, spanZ, params.floorSpacing) + slide.span
    this.focusDistance = Math.max(params.floorSpacing * 8, span * 1.2)
    this.focusActive = true
  }

  /**
   * 切换编辑模式。
   *
   * 编辑态是「锁定视角 + 自由移动」：强制正交俯视、禁止旋转，但平移与缩放必须保留
   * ——否则没法挪到图纸的其他区域继续框选。左键专用于点选 / 框选，平移放在中键与右键。
   * 退出编辑态恢复透视轴测与默认鼠标映射。
   *
   * 不做「状态相同就跳过」的提前返回：类定义热更新后旧实例的 editMode 可能已经
   * 是目标值，但鼠标映射仍是旧的默认值，跳过会让映射永远修不回来。
   */
  setEditMode(enabled: boolean): void {
    this.editMode = enabled
    this.controls.enablePan = true
    this.controls.enableZoom = true
    this.applyControlMapping()

    // 编辑态只显示单层网格；退出后切回整栋实例
    this.applyVisibility()
    this.focusActive = false
    this.focusDistance = null

    if (enabled) {
      this.cameraMode = 'top'
      this.activeCamera = this.orthographicCamera
      this.controls.object = this.orthographicCamera
      this.orthographicCamera.zoom = 1
      // 复用 fit 的取景逻辑：把模型完整、居中地放进正交视锥，
      // 不沿用透视模式下的平移与缩放状态
      const bounds = this.viewBounds()
      if (bounds) this.fit(bounds)
      else this.syncActiveCamera()
      return
    }

    this.cancelPointer()
    this.clearHover()
    this.cameraMode = 'orbit'
    this.activeCamera = this.perspectiveCamera
    this.controls.object = this.perspectiveCamera
    // 退出编辑态后相机模式回到轴测，鼠标映射要跟着恢复成可旋转
    this.applyControlMapping()
    if (this.building && this.building.floorCount > 1) this.viewWholeBuilding()
    else this.syncActiveCamera()
  }

  /** 切换相机：透视轴测 / 正交俯视；编辑态锁定俯视，不接受切换 */
  setCameraMode(mode: CameraMode): void {
    if (this.editMode || this.cameraMode === mode) return
    this.cameraMode = mode
    // 两个相机的 up 都保持 (0,1,0)，俯视姿态由 syncActiveCamera 的微小倾角实现
    this.activeCamera = mode === 'top' ? this.orthographicCamera : this.perspectiveCamera
    this.controls.object = this.activeCamera
    // 俯视正交下禁止旋转，只允许平面平移
    this.applyControlMapping()
    // 俯视正交沿用编辑态的默认视角：缩放复位、镜头对准模型正中央
    if (mode === 'top') {
      this.applyTopViewFrame()
      return
    }
    this.syncActiveCamera()
  }

  /**
   * 非编辑态进入俯视正交的默认取景。
   *
   * 选中楼层时只框这一层（含它滑出建筑后的位置），与其余楼层无关；没有选中楼层时
   * 框整栋平面。两种情况下都不沿用轴测态取景：多层建筑的整栋取景把总高也算进跨度，
   * 而高度不参与俯视投影，照搬会把模型缩成画面中央的一小块；用户在轴测态平移后
   * `controls.target` 也已经偏离模型中心，不重置就会出现「模型偏出画面」。
   */
  private applyTopViewFrame(): void {
    // 聚焦插值会按帧改写 target 与相机位置，先终止它，否则画面会被拉回楼层中心
    this.focusActive = false
    this.focusDistance = null

    const bounds = this.viewBounds()
    const params = this.building
    // 编辑态选中的是编辑目标楼层，非编辑态选中的是展开楼层
    const selected = this.editMode ? this.editFloor : this.expandedFloor
    if (bounds && params && selected !== null) {
      // 选中楼层：非编辑态取景中心跟随抽屉滑出位移，视锥只按这一层的平面跨度；
      // 编辑态该层摆在原点，不做滑出位移
      const slide = this.editMode ? { x: 0, z: 0, span: 0 } : drawerSlide(bounds, params, 1)
      const spanX = bounds.maxX - bounds.minX
      const spanZ = bounds.maxY - bounds.minY
      const span = spanX > spanZ ? spanX : spanZ
      this.frameSpan = span > 1 ? span : 20
      this.frameCenter.set(
        (bounds.minX + bounds.maxX) / 2 + slide.x,
        floorElevation(selected, params) + params.wallHeight / 2,
        // 楼层在模型内沿 +z 滑出，镜像后世界 z 取负
        this.planCenterZ(bounds) - slide.z,
      )
    } else if (bounds) {
      const spanX = bounds.maxX - bounds.minX
      const spanZ = bounds.maxY - bounds.minY
      const span = spanX > spanZ ? spanX : spanZ
      this.frameSpan = span > 1 ? span : 20
      // 俯视只看平面，中心高度取 0：画面中心就是整栋建筑的平面中心
      this.frameCenter.set((bounds.minX + bounds.maxX) / 2, 0, this.planCenterZ(bounds))
    }

    this.orthographicCamera.zoom = 1
    this.applyOrthoFrustum()
    this.controls.target.copy(this.frameCenter)
    this.syncActiveCamera()
  }

  /**
   * 按当前模式配置鼠标 / 触摸映射。
   *
   * 编辑态与俯视正交态都禁止旋转：前者要保持俯视框选，后者要保持正俯视姿态。
   * 若仍允许旋转，OrbitControls 会把俯视拖成斜视，画面里的平面不再水平。
   */
  private applyControlMapping(): void {
    if (this.editMode) {
      this.controls.enableRotate = false
      this.controls.mouseButtons = {
        LEFT: null,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      }
      this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
      return
    }
    if (this.cameraMode === 'top') {
      this.controls.enableRotate = false
      this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      }
      this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
      return
    }
    this.controls.enableRotate = true
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
  }

  /** 更新选中集合：只重建高亮副本，不动主几何 */
  setSelection(keys: ReadonlySet<string>): void {
    this.selectionKeys.clear()
    for (const key of keys) this.selectionKeys.add(key)
    this.rebuildSelection()
    if (this.hoverKey !== null && this.selectionKeys.has(this.hoverKey)) {
      this.hoverKey = null
      this.rebuildHover()
    }
  }

  /** 当前编辑目标里所有可拾取对象的键，供宿主做全选 / 反选与删除统计 */
  objectKeys(): string[] {
    return this.buildingGeometry === null ? [] : floorObjectKeys(this.editTarget())
  }

  /**
   * 图纸包围盒中心在世界坐标里的 z。
   *
   * 模型根做过 z 轴镜像（图纸 +y 北 → 世界 −z），相机、网格与阴影都要用镜像后的中心，
   * 否则会偏到建筑另一侧。
   */
  private planCenterZ(bounds: WallGeometryResult['bounds']): number {
    return -(bounds.minY + bounds.maxY) / 2
  }

  /** 模型根的局部→世界矩阵：拾取前刷新，抽屉动画中的楼层位置才算最新 */
  private modelMatrix(): THREE.Matrix4 {
    this.modelRoot.updateMatrixWorld()
    return this.modelRoot.matrixWorld
  }

  /**
   * 整栋取景范围。
   *
   * 墙体优先；当所有墙体图层都按白膜墙 / 玻璃幕墙生成时没有实体墙，
   * 墙体包围盒退化为零，此时改用幕墙或楼板范围，避免相机停在原点把模型甩出画面。
   */
  private viewBounds(): WallGeometryResult['bounds'] | null {
    const geometry = this.buildingGeometry
    if (!geometry) return null
    const walls = geometry.base.walls.bounds
    if (walls.maxX > walls.minX || walls.maxY > walls.minY) return walls
    return geometry.base.curtain?.bounds ?? geometry.slab?.bounds ?? walls
  }

  /** 适配相机到墙体范围 */
  fit(bounds: WallGeometryResult['bounds']): void {
    const spanX = bounds.maxX - bounds.minX
    const spanY = bounds.maxY - bounds.minY
    const span = spanX > spanY ? spanX : spanY
    const size = span > 1 ? span : 20
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerZ = this.planCenterZ(bounds)
    const distance = size * 1.15

    this.frameCenter.set(centerX, 0, centerZ)
    this.frameSpan = size

    this.controls.target.set(centerX, 0, centerZ)
    this.perspectiveCamera.position.set(centerX + distance * 0.62, distance * 0.72, centerZ + distance * 0.62)
    this.perspectiveCamera.near = distance / 500
    this.perspectiveCamera.far = distance * 20
    this.perspectiveCamera.updateProjectionMatrix()

    this.applyOrthoFrustum()
    // 俯视正交下缩放复位，保证切换相机后与编辑态的默认视角一致
    if (this.cameraMode === 'top') this.orthographicCamera.zoom = 1
    this.syncActiveCamera()
    this.scene.fog = new THREE.Fog(HORIZON_COLOR, distance * 1.6, distance * 5)
  }

  /** 释放资源 */
  dispose(): void {
    this.disposed = true
    this.buildingGeometry = null
    cancelAnimationFrame(this.frameHandle)
    this.resizeObserver.disconnect()
    const target = this.renderer.domElement
    target.removeEventListener('pointerdown', this.handlePointerDown)
    target.removeEventListener('pointermove', this.handlePointerMove)
    target.removeEventListener('pointerup', this.handlePointerUp)
    target.removeEventListener('pointerleave', this.handlePointerLeave)
    target.removeEventListener('wheel', this.handleWheel)
    this.boxElement.remove()
    this.clearModel()
    this.clearGrid()
    this.scene.background = null
    this.scene.environment = null
    this.skyTexture.dispose()
    this.plasterTextures.color.dispose()
    this.plasterTextures.roughness.dispose()
    this.plasterTextures.normal.dispose()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  /**
   * 用户一按下左键就把相机交还给他。
   *
   * 聚焦动画每帧都会改写相机距离，若不立即让位，用户在展开过程中拖动或滚轮缩放
   * 会被下一帧覆盖，看起来就是「点了楼层以后视角动不了」。
   */
  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.releaseFocus()
    const point = this.localPoint(event)
    this.pointerStart = point
    this.boxSelecting = false
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  /** 滚轮缩放同样立刻终止聚焦动画 */
  private readonly handleWheel = (): void => {
    this.releaseFocus()
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.editMode) return
    const point = this.localPoint(event)
    if (this.pointerStart) {
      const dragged = Math.hypot(point.x - this.pointerStart.x, point.y - this.pointerStart.y) >= CLICK_DRAG_PX
      if (dragged) {
        this.boxSelecting = true
        this.updateBox(this.pointerStart, point)
      }
      return
    }
    this.pendingHover = point
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart
    this.pointerStart = null
    if (!start) return
    const point = this.localPoint(event)
    const dragged = Math.hypot(point.x - start.x, point.y - start.y) >= CLICK_DRAG_PX

    // 非编辑态：左键拖动是旋转视角，只有未拖动的点击才用于选中楼层
    if (!this.editMode) {
      if (!dragged) this.pickFloorAt(point)
      return
    }

    const mode = this.selectionModeOf(event)
    this.boxSelecting = false
    this.hideBox()

    if (dragged) {
      const rect: ScreenRect = {
        minX: Math.min(start.x, point.x),
        minY: Math.min(start.y, point.y),
        maxX: Math.max(start.x, point.x),
        maxY: Math.max(start.y, point.y),
      }
      const target = this.pickableGeometry()
      const lines = this.pickLines()
      const keys = selectLinesInRect(
        lines,
        this.activeCamera,
        this.viewportWidth(),
        this.viewportHeight(),
        rect,
        this.modelMatrix(),
      )
      // 框选没命中时把关键数据留在控制台：能直接区分是「没有可拾取对象」还是「投影 / 矩形对不上」
      if (keys.length === 0) {
        console.warn('[cad-lab] 框选未命中对象', {
          pieces: target?.walls.pieces.length ?? 0,
          openings: target?.walls.openings.length ?? 0,
          curtain: curtainCenterlines(target?.curtain).length,
          wallHeight: this.wallHeight,
          viewport: [this.viewportWidth(), this.viewportHeight()],
          rect,
          camera: this.activeCamera === this.orthographicCamera ? 'ortho' : 'perspective',
          editFloor: this.editFloor,
        })
      }
      this.callbacks.onBoxSelect?.(keys, mode)
    } else {
      const key = pickLineAt(
        this.pickLines(),
        this.activeCamera,
        this.viewportWidth(),
        this.viewportHeight(),
        point,
        PICK_THRESHOLD_PX,
        this.modelMatrix(),
      )
      if (key === null) {
        this.callbacks.onEmptyClick?.()
      } else {
        this.callbacks.onPick?.(key, mode)
      }
    }
    this.pendingHover = point
  }

  private readonly handlePointerLeave = (): void => {
    if (this.pointerStart) return
    this.pendingHover = null
    this.clearHover()
  }

  /** 根据修饰键决定选择模式 */
  private selectionModeOf(event: PointerEvent): SelectionMode {
    if (event.shiftKey) return 'add'
    if (event.ctrlKey || event.metaKey) return 'subtract'
    return 'replace'
  }

  /** 多层态：用射线命中楼层容器组的网格，读取 userData.floorIndex 作为楼层下标 */
  private pickFloorAt(point: { x: number; y: number }): void {
    const targets = this.floorGroups.filter((group) => group.visible)
    if (targets.length === 0) return

    const width = this.viewportWidth()
    const height = this.viewportHeight()
    if (width === 0 || height === 0) return
    const pointer = new THREE.Vector2((point.x / width) * 2 - 1, -(point.y / height) * 2 + 1)
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(pointer, this.activeCamera)
    const hits = raycaster.intersectObjects(targets, true)
    if (hits.length === 0) {
      this.callbacks.onEmptyClick?.()
      return
    }
    const index = hits[0].object.userData.floorIndex
    if (typeof index !== 'number') return
    this.callbacks.onFloorPick?.(index)
  }

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private viewportWidth(): number {
    return this.renderer.domElement.clientWidth
  }

  private viewportHeight(): number {
    return this.renderer.domElement.clientHeight
  }

  private updateBox(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const left = Math.min(a.x, b.x)
    const top = Math.min(a.y, b.y)
    this.boxElement.style.left = `${left}px`
    this.boxElement.style.top = `${top}px`
    this.boxElement.style.width = `${Math.abs(b.x - a.x)}px`
    this.boxElement.style.height = `${Math.abs(b.y - a.y)}px`
    this.boxElement.style.display = 'block'
  }

  private hideBox(): void {
    this.boxElement.style.display = 'none'
  }

  private cancelPointer(): void {
    this.pointerStart = null
    this.boxSelecting = false
    this.pendingHover = null
    this.hideBox()
  }

  private rebuildSelection(): void {
    this.disposeHighlight(this.selectionMesh)
    this.selectionMesh = this.buildHighlight(this.selectionKeys, SELECTION_COLOR, 0.5)
    if (this.selectionMesh) {
      this.selectionMesh.name = 'selection'
      this.modelRoot.add(this.selectionMesh)
    }
    this.invalidate()
  }

  private rebuildHover(): void {
    this.disposeHighlight(this.hoverMesh)
    this.hoverMesh = null
    if (this.hoverKey === null || this.selectionKeys.has(this.hoverKey)) {
      this.invalidate()
      return
    }
    this.hoverMesh = this.buildHighlight(new Set([this.hoverKey]), HOVER_COLOR, 0.35)
    if (this.hoverMesh) {
      this.hoverMesh.name = 'hover'
      this.modelRoot.add(this.hoverMesh)
    }
    this.invalidate()
  }

  private clearHover(): void {
    if (this.hoverKey === null && this.hoverMesh === null) return
    this.hoverKey = null
    this.disposeHighlight(this.hoverMesh)
    this.hoverMesh = null
    this.invalidate()
  }

  /**
   * 生成选中对象的叠加高亮：墙段按顶点区间切片，门窗与幕墙按其几何尺寸生成薄盒。
   *
   * 三类对象共用一套高亮材质与叠加方式，编辑态不需要区分类型就能看到选中结果。
   */
  private buildHighlight(keys: ReadonlySet<string>, color: number, emissiveIntensity: number): THREE.Mesh | null {
    const target = this.pickableGeometry()
    if (!target || keys.size === 0) return null
    const result = target.walls
    const parts: number[] = []
    for (const piece of result.pieces) {
      if (!keys.has(piece.key)) continue
      const start = piece.vertexStart * 3
      const end = start + piece.vertexCount * 3
      for (let i = start; i < end; i += 1) parts.push(result.positions[i])
    }
    // 门窗：沿洞口中心线、按洞口尺寸外扩 2cm 生成高亮盒
    for (const opening of result.openings) {
      if (!opening.key || !keys.has(opening.key)) continue
      const ux = opening.direction.x
      const uz = opening.direction.y
      pushBox(
        parts,
        [opening.center.x, opening.sill + opening.height / 2, opening.center.y],
        [ux, 0, uz],
        [0, 1, 0],
        [-uz, 0, ux],
        [opening.width / 2 + 0.02, opening.height / 2 + 0.02, opening.thickness / 2 + 0.02],
      )
    }
    // 幕墙 / 白膜墙：沿中心线按整层墙高生成薄板高亮；
    // 高亮必须比墙本身略厚（白膜墙是实体薄墙），否则会被包在墙体内部看不见
    const highlightThickness =
      Math.max(DEFAULT_FRAME_DEPTH, DEFAULT_MASSING_THICKNESS) / 2 + 0.02
    for (const line of curtainCenterlines(target.curtain)) {
      if (!keys.has(curtainObjectKey(line))) continue
      const dx = line.b.x - line.a.x
      const dz = line.b.y - line.a.y
      const length = Math.hypot(dx, dz)
      if (length <= 0) continue
      const ux = dx / length
      const uz = dz / length
      pushBox(
        parts,
        [(line.a.x + line.b.x) / 2, this.wallHeight / 2, (line.a.y + line.b.y) / 2],
        [ux, 0, uz],
        [0, 1, 0],
        [-uz, 0, ux],
        [length / 2, this.wallHeight / 2, highlightThickness],
      )
    }
    if (parts.length === 0) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(parts), 3))
    geometry.computeVertexNormals()
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity,
      roughness: 0.55,
      metalness: 0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })
    return new THREE.Mesh(geometry, material)
  }

  private disposeHighlight(mesh: THREE.Mesh | null): void {
    if (!mesh) return
    this.modelRoot.remove(mesh)
    mesh.geometry.dispose()
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => material.dispose())
    } else {
      mesh.material.dispose()
    }
  }

  /** 按动画帧节流：每帧最多重新计算一次悬浮命中 */
  private refreshHover(): boolean {
    if (this.pendingHover === null) return false
    const cursor = this.pendingHover
    this.pendingHover = null
    const key = pickLineAt(
      this.pickLines(),
      this.activeCamera,
      this.viewportWidth(),
      this.viewportHeight(),
      cursor,
      PICK_THRESHOLD_PX,
      this.modelMatrix(),
    )
    if (key === this.hoverKey) return false
    this.hoverKey = key
    this.rebuildHover()
    return true
  }

  /** 正交相机视锥由模型跨度与容器宽高比决定 */
  private applyOrthoFrustum(): void {
    const halfHeight = (this.frameSpan * 1.15) / 2
    const aspect = this.viewportHeight() > 0 ? this.viewportWidth() / this.viewportHeight() : 1
    const halfWidth = halfHeight * aspect
    this.orthographicCamera.left = -halfWidth
    this.orthographicCamera.right = halfWidth
    this.orthographicCamera.top = halfHeight
    this.orthographicCamera.bottom = -halfHeight
    this.orthographicCamera.near = 0.1
    // 远裁剪面同时要覆盖「俯视相机站在整栋楼上方」的距离，否则高层会被切掉
    const farSpan = this.topCameraRadius() * 2
    const farDefault = this.frameSpan * 20
    this.orthographicCamera.far = farSpan > farDefault ? farSpan : farDefault
    this.orthographicCamera.updateProjectionMatrix()
  }

  /**
   * 俯视相机到取景中心的高度。
   *
   * 正交投影的缩放与距离无关，但相机必须高过取景对象：相机低于楼层顶面时，
   * 高出相机的部分落在相机背后，会被近裁剪面直接切掉。只按取景对象的高度算，
   * 才能让相机贴近模型，避免被远处的雾吃掉。
   */
  private topCameraRadius(): number {
    const top = this.building ? buildingHeight(this.building) : 0
    const clearance = top - this.frameCenter.y + this.frameSpan * 0.5
    return clearance > this.frameSpan ? clearance : this.frameSpan
  }

  /**
   * 把当前激活相机放到模型上方的俯视姿态（正交）或保持原位（透视），并同步控制器。
   *
   * 俯视姿态不能让相机严格位于天顶：视线会与 up=(0,1,0) 共线，lookAt 退化，
   * 且 OrbitControls 的极角会落在地面边界。因此沿 +Z 方向留一个 TOP_TILT_RAD 的
   * 微小倾角 —— 正交投影下墙高方向的投影偏差不到 10cm，肉眼看仍是标准俯视图，
   * 但极角处于合法区间，控制器按帧更新时不会把相机推离这个姿态（编辑态的平移依赖这一点）。
   */
  private syncActiveCamera(): void {
    if (this.cameraMode === 'top') {
      const radius = this.topCameraRadius()
      this.orthographicCamera.position.set(
        this.frameCenter.x,
        this.frameCenter.y + radius * Math.cos(TOP_TILT_RAD),
        this.frameCenter.z + radius * Math.sin(TOP_TILT_RAD),
      )
      this.orthographicCamera.lookAt(this.frameCenter)
    }
    this.controls.update()
    // 相机是被外部直接摆放的，OrbitControls 的 update() 可能感知不到这次变化
    this.invalidate()
  }

  private clearModel(): void {
    // 程序化构件由宿主释放：先摘除，避免这里按建筑几何的规则 dispose 它们的共享材质
    this.detachProceduralDecor()
    // 多层共用同一份几何：先去重，避免同一份 BufferGeometry 被 dispose 上百次
    const geometries = new Set<THREE.BufferGeometry>()
    this.modelRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      geometries.add(object.geometry)
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.dispose()
    })
    for (const geometry of geometries) geometry.dispose()
    this.modelRoot.clear()
    this.wallMesh = null
    this.slabGeometry = null
    this.slabMesh = null
    this.openingMesh = null
    this.curtainMesh = null
    this.floorGroups = []
    this.selectionMesh = null
    this.hoverMesh = null
    this.invalidateShadow()
  }

  /** 清掉旧的辅助网格并释放几何与材质 */
  private clearGrid(): void {
    this.gridRoot.traverse((object) => {
      if (object instanceof THREE.GridHelper) {
        object.geometry.dispose()
        if (Array.isArray(object.material)) {
          object.material.forEach((material) => material.dispose())
        } else {
          object.material.dispose()
        }
      }
    })
    this.gridRoot.clear()
  }

  /**
   * 辅助网格：只给尺度参照，不生成任何地面平面或托板。
   * 网格范围取 `1.6 × 建筑跨度` 并以建筑包围盒为中心，随图纸尺度自适应。
   */
  private buildGrid(bounds: WallGeometryResult['bounds']): void {
    this.clearGrid()
    const spanX = bounds.maxX - bounds.minX
    const spanY = bounds.maxY - bounds.minY
    const span = spanX > spanY ? spanX : spanY
    const size = span > 1 ? span * 1.6 : 40
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerZ = this.planCenterZ(bounds)

    const grid = new THREE.GridHelper(size, 60, GRID_MAJOR_COLOR, GRID_MINOR_COLOR)
    grid.position.set(centerX, 0, centerZ)
    const fade = (material: THREE.Material): void => {
      material.transparent = true
      material.opacity = GRID_OPACITY
    }
    if (Array.isArray(grid.material)) grid.material.forEach(fade)
    else fade(grid.material)
    this.gridRoot.add(grid)
    this.invalidate()
  }

  /**
   * 按建筑包围盒重设平行光的阴影相机范围与位置。
   * 场景没有地面，阴影只落在墙体之间，范围收紧到包围盒上才不会糊。
   */
  private fitShadowCamera(bounds: WallGeometryResult['bounds']): void {
    const spanX = bounds.maxX - bounds.minX
    const spanY = bounds.maxY - bounds.minY
    const span = spanX > spanY ? spanX : spanY
    const size = span > 1 ? span * 1.6 : 40
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerZ = this.planCenterZ(bounds)

    // 阴影相机跟着建筑尺度走：收紧到 1.1 倍包围盒，把 4096 的阴影图集中到
    // 建筑与抽屉滑出范围上，阴影边缘才不会糊成一团
    const shadowSpan = size * 1.1
    const shadowCamera = this.sunLight.shadow.camera
    shadowCamera.left = -shadowSpan
    shadowCamera.right = shadowSpan
    shadowCamera.top = shadowSpan
    shadowCamera.bottom = -shadowSpan
    shadowCamera.near = 0.5
    shadowCamera.far = shadowSpan * 6
    shadowCamera.updateProjectionMatrix()
    // 仰角约 36°：既能照亮墙面形成明暗过渡，又能在背光面拉出可辨认的暗部
    this.sunLight.position.set(centerX + shadowSpan, shadowSpan * 1.05, centerZ + shadowSpan)
    this.sunLight.target.position.set(centerX, 0, centerZ)
    this.sunLight.target.updateMatrixWorld()

    // 柔光箱跟着建筑尺度走：低角度斜射，宽度拉到建筑跨度以上，
    // 反光才不会缩成一小块，而是沿墙脚铺开
    const sheenDistance = size * 2.2
    this.sheenLight.position.copy(SHEEN_LIGHT_DIRECTION).multiplyScalar(sheenDistance)
    this.sheenLight.position.x += centerX
    this.sheenLight.position.z += centerZ
    this.sheenLight.width = size * 1.8
    this.sheenLight.height = size * 0.8
    this.sheenLight.lookAt(centerX, 0, centerZ)
    // 阴影相机与光源位置都变了：关闭自动更新后必须显式标记一次
    this.invalidateShadow()
  }

  private handleResize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return
    // 必须让 three 同步写 canvas 的 CSS 尺寸（第三个参数不能传 false）：
    // setPixelRatio 之后绘图缓冲区是 CSS 尺寸的 DPR 倍，而 canvas 的 width/height
    // 属性只能决定绘制分辨率、不能决定布局尺寸；不写 style 时浏览器按属性像素
    // 布局画布，画布在 DPR>1 的屏幕上会被撑成 N 倍大小，再被容器的 overflow:hidden
    // 裁成左上角一块，模型就跑到视口右下方了。
    this.renderer.setSize(width, height)
    this.perspectiveCamera.aspect = width / height
    this.perspectiveCamera.updateProjectionMatrix()
    this.applyOrthoFrustum()
    this.invalidate()
  }

  /** 逐帧推进抽屉抬升与相机聚焦；两者都用同一套指数插值。返回是否仍在动画中 */
  private stepAnimation(dt: number): boolean {
    let changed = false
    const params = this.building
    if (!params || params.floorCount <= 1) return changed

    if (this.pullAnimating) {
      // 切换楼层时先把原楼层收回到 0，收完立刻提交新楼层再抽出来；
      // 每段固定 PULL_LEG_SECONDS，切换总时长因此稳定在 1 秒左右
      const target = this.pendingSwitch !== null || this.expandedFloor === null ? 0 : 1
      this.pullProgress = moveTowards(this.pullProgress, target, dt / PULL_LEG_SECONDS)
      if (this.pullProgress === target) {
        this.pullAnimating = false
        const pending = this.pendingSwitch
        if (pending) {
          this.pendingSwitch = null
          this.commitExpandedFloor(pending.floor)
        }
      }
      this.applyFloorTransforms()
      changed = true
    }

    if (!this.focusActive) return changed
    changed = true
    const target = this.focusTarget
    const previousX = this.controls.target.x
    const previousY = this.controls.target.y
    const previousZ = this.controls.target.z
    const nextX = smoothTowards(previousX, target.x, dt)
    const nextY = smoothTowards(previousY, target.y, dt)
    const nextZ = smoothTowards(previousZ, target.z, dt)
    this.controls.target.set(nextX, nextY, nextZ)

    let distanceReached = true
    if (this.cameraMode === 'top') {
      // 正交投影不随距离缩放，只能让相机跟着目标一起平移，保持俯视方向不变
      this.activeCamera.position.x += nextX - previousX
      this.activeCamera.position.y += nextY - previousY
      this.activeCamera.position.z += nextZ - previousZ
    } else if (this.focusDistance !== null) {
      // 只沿当前视线调整距离，保留用户旋转后的观察方位
      const offset = this.activeCamera.position.clone().sub(this.controls.target)
      const currentDistance = offset.length()
      const nextDistance = smoothTowards(currentDistance, this.focusDistance, dt)
      offset.setLength(nextDistance)
      this.activeCamera.position.copy(this.controls.target).add(offset)
      distanceReached = Math.abs(nextDistance - this.focusDistance) < 0.001
    }

    const targetReached =
      Math.abs(nextX - target.x) < 0.001 &&
      Math.abs(nextY - target.y) < 0.001 &&
      Math.abs(nextZ - target.z) < 0.001
    if (targetReached && distanceReached) {
      this.controls.target.copy(target)
      // 同步取景中心：后续切换相机或适配视图时以聚焦位置为准，避免画面跳回原处
      this.frameCenter.copy(target)
      this.focusActive = false
      this.focusDistance = null
    }
    return changed
  }

  /**
   * 终止相机聚焦动画，把控制权交还用户。
   * 聚焦只是「把镜头带到这一层」的一次性动作，之后旋转、平移、缩放都由 OrbitControls 接管。
   */
  private releaseFocus(): void {
    this.focusActive = false
    this.focusDistance = null
  }

  private startLoop(): void {
    const tick = (time: number) => {
      if (this.disposed) return
      const dt = this.lastFrameTime === 0 ? 0 : (time - this.lastFrameTime) / 1000
      this.lastFrameTime = time
      // 阻尼 / 惯性必须在每一帧推进；返回值表示相机这一帧是否真的发生了变化
      const cameraChanged = this.controls.update()
      const hoverChanged = this.editMode ? this.refreshHover() : false
      const animated = this.stepAnimation(dt)
      // 按需渲染：静止、无动画且没有悬停变化时不提交绘制，
      // 避免多层模型在空闲状态下持续占用 GPU（阴影已随 autoUpdate=false 一起跳过）
      if (this.needsRender || cameraChanged || animated || hoverChanged) {
        this.needsRender = false
        this.renderer.render(this.scene, this.activeCamera)
      }
      this.frameHandle = requestAnimationFrame(tick)
    }
    this.frameHandle = requestAnimationFrame(tick)
  }

  /** 请求下一帧重绘：几何 / 材质 / 选中 / 相机等状态变化后调用 */
  private invalidate(): void {
    this.needsRender = true
  }

  /** 请求下一帧重绘并重算阴影：模型、程序化构件或楼层位移变化后调用 */
  private invalidateShadow(): void {
    this.renderer.shadowMap.needsUpdate = true
    this.needsRender = true
  }
}
