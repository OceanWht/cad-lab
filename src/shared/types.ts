/**
 * 程序化构件类型子集（从 webmap `src/lib/types.ts` 裁剪）。
 *
 * 只保留屋顶 / 底座 / 大门 / 墙面立面四类构件实际引用的声明，
 * 其余编辑器专用类型（围界、路网、独立式大门、楼层数据等）一律不搬。
 */

/** 程序化立面风格 */
export type FacadeStyle =
  | 'factory'
  | 'residential'
  | 'office'
  | 'hospital'
  | 'curtain_wall'
  | 'concrete_punched'
  | 'brutalist_banded'
  | 'brick_apartment'
  | 'stone_office'

/** 几何附件开关（立面档案的一部分，由几何生成器消费） */
export interface FacadeReliefFlags {
  /** 竖梃（窗间竖向构件） */
  mullion: boolean
  /** 窗台板 */
  sill: boolean
  /** 檐口 / 顶部线脚 */
  cornice: boolean
  /** 女儿墙 */
  parapet: boolean
  /** 阳台（可选） */
  balcony: boolean
}

/** 程序化建筑底座原型 */
export type PodiumType = 'rotunda' | 'arcade' | 'stone_plinth' | 'stepped' | 'terraced' | 'canopy'

/**
 * 程序化构件材质：颜色 + 金属度 + 粗糙度，可选材质库贴图与缩放。
 * 底座与屋顶的每个构件独立持有一套，用于面板逐项调材质。
 */
export interface PartMaterialConfig {
  /** 基础颜色（hex） */
  color: string
  /** 粗糙度 0~1 */
  roughness: number
  /** 金属度 0~1 */
  metalness: number
  /** 材质库纹理 ID（数据库数字 ID 字符串）；空表示不贴图 */
  textureId?: string
  /** 贴图名称（面板展示用） */
  textureName?: string
  /** 贴图缩放：1 表示 1 米平铺一次，数值越大纹理越大 */
  textureScale?: number
  /** 运行时解析出的贴图 URL（standalone-engine 在 enrich 阶段写入，编辑器不使用） */
  textureUrl?: string
}

/** 底座构件键：每个键独立材质与贴图 */
export type PodiumPartKey =
  | 'tier'
  | 'band'
  | 'recess'
  | 'louver'
  | 'rail'
  | 'column'
  | 'canopy'
  | 'steps'
  | 'planter'

/** 屋顶构件键：每个键独立材质与贴图 */
export type RoofPartKey =
  | 'deck'
  | 'cornice'
  | 'parapet'
  | 'crown'
  | 'penthouse'
  | 'skylight'
  | 'skylightFrame'
  | 'equipment'
  | 'solar'
  | 'zonePad'
  | 'infrastructure'

/** 立面装饰构件键：每个键独立材质与贴图 */
export type FacadeReliefPartKey =
  | 'mullion'
  | 'reveal'
  | 'sill'
  | 'slabBand'
  | 'cornice'
  | 'parapet'
  | 'balconySlab'
  | 'balconyRail'

/**
 * 程序化建筑底座配置：整体作用于建筑底层，按轮廓环程序化生成。
 * 所有尺寸为真实米。
 */
export interface PodiumConfig {
  enabled: boolean
  type: PodiumType
  /** 台基级数 0~3 */
  tierCount: number
  /** 单级台基高（米） */
  tierHeight: number
  /** 每级台基外扩（米） */
  tierOffset: number
  /** 底层裙房带高（米） */
  bandHeight: number
  /** 裙墙外扩（米），0 表示不做实心裙墙，只保留深色背板 */
  bandOffset: number
  /** 柱截面形态 */
  columnShape: 'round' | 'square'
  /** 柱距（米），0 表示不生成柱廊 */
  columnSpacing: number
  /** 柱径（圆柱直径 / 方柱边长，米） */
  columnSize: number
  /** 柱中心相对建筑外墙的外退距（米），形成内凹观感 */
  columnInset: number
  /** 横向百叶条数（0 表示无） */
  louverCount: number
  /** 横向扶手/横梁道数（0 表示无） */
  railCount: number
  /** 雨棚出挑（米），0 表示无雨棚 */
  canopyDepth: number
  /** 雨棚板厚（米） */
  canopyThickness: number
  /** 雨棚底面离地高（米），柱廊到雨棚底为止 */
  canopyHeight: number
  /** 前场台阶级数（0 表示无） */
  stepCount: number
  /** 每级台阶外扩（米） */
  stepOffset: number
  /** 中央入口平台额外突出深度（米） */
  entranceProjection: number
  /** 花池墙高（米），0 表示无花池 */
  planterHeight: number
  /** 花池墙厚（米） */
  planterThickness: number
  /** 正面 faceIndex；null 表示自动（优先大门所在面，否则最长边） */
  frontFace?: number | null
  /** 各构件材质（颜色 / 金属度 / 粗糙度 / 贴图） */
  parts: Record<PodiumPartKey, PartMaterialConfig>
  /** 确定性种子 */
  seed: number
}

/** 程序化建筑屋顶原型 */
export type RoofType = 'parapet' | 'lattice' | 'oval_rim' | 'penthouse' | 'skylight' | 'eave'

/** 屋面设备类别 */
export type RoofEquipmentKind = 'ahu' | 'tower' | 'fan' | 'duct' | 'solar' | 'tank' | 'mast'

/** 手动放置的一台屋面设备（建筑局部 XZ，场景米） */
export interface RoofEquipmentPlacement {
  id: string
  kind: RoofEquipmentKind
  x: number
  z: number
}

/**
 * 程序化屋顶配置：作用于建筑顶面（y = 建筑高度），按轮廓环生成。
 * 所有尺寸为真实米。
 */
export interface RoofConfig {
  enabled: boolean
  type: RoofType
  /** 女儿墙高（米），0 表示无女儿墙 */
  parapetHeight: number
  /** 女儿墙厚（米） */
  parapetThickness: number
  /** 挑檐外挑（米），0 表示无挑檐 */
  corniceOffset: number
  /** 挑檐板厚（米） */
  corniceThickness: number
  /** 格栅冠分格数（每边） */
  crownCount: number
  /** 格栅冠高（米） */
  crownHeight: number
  /** 格栅梁截面（米） */
  crownThickness: number
  /** 屋顶机房长边占比 0~1 */
  penthouseWidthRatio: number
  /** 屋顶机房短边占比 0~1 */
  penthouseDepthRatio: number
  /** 屋顶机房高（米） */
  penthouseHeight: number
  /** 屋顶机房内退（米） */
  penthouseInset: number
  /** 天窗带条数 */
  skylightCount: number
  /** 天窗带宽（米） */
  skylightWidth: number
  /** 天窗凸起高（米） */
  skylightHeight: number
  /** 檐口外挑（米） */
  eaveOffset: number
  /** 檐口板厚（米） */
  eaveThickness: number
  /** 屋面设备箱数量（旧版自动布置；手动放置列表为空时才生效） */
  equipmentCount: number
  /** 设备箱高（米） */
  equipmentHeight: number
  /** 设备箱边长（米） */
  equipmentSize: number
  /** 手动放置的屋面设备（按类别逐个点击添加，无数量上限） */
  equipment?: RoofEquipmentPlacement[]
  /** 设备区占可用进深比例 0~1（设备区与光伏区的分界） */
  mechZoneRatio: number
  /** 光伏设备占屋面设备数量的比例 0~1，0 表示不设光伏区 */
  solarZoneQuota: number
  /** 正面 faceIndex；null 表示自动（优先大门所在面，否则最长边） */
  frontFace?: number | null
  /** 各构件材质（颜色 / 金属度 / 粗糙度 / 贴图） */
  parts: Record<RoofPartKey, PartMaterialConfig>
  /** 确定性种子 */
  seed: number
}

/**
 * 单面立面配置
 * - `faceIndex`：外环第 i 条边对应的侧面
 * - `anchor`：该面中点坐标，用于面索引漂移时自愈重绑
 * - 档案字段（模块尺寸 / 玻璃 / 环境反射 / AO / relief）为可选，缺省按风格预设补齐
 */
export interface FacadeFaceConfig {
  faceIndex: number
  anchor: [number, number]
  style: FacadeStyle
  /** 开间（真实米） */
  bayWidth: number
  /** 层高（真实米） */
  floorHeight: number
  /** 窗墙比 0.2~0.8 */
  windowRatio: number
  /** 窗台高（真实米） */
  sillHeight: number
  wallColor: string
  frameColor: string
  glassColor: string
  /** 窗型 / 亮灯分布确定性种子 */
  seed: number
  /** 亮窗自发光强度 0~1，0 表示不亮窗 */
  emissiveIntensity: number
  /** 窗框凹凸强度 0~1 */
  normalStrength: number
  /** 窗框金属度 0~1（仅作用于窗框/窗台，玻璃与墙板不受影响） */
  windowFrameMetalness: number
  /** 竖梃 / 窗框可见宽度（米） */
  mullionWidth?: number
  /** 窗洞内凹深度提示（米，供几何生成） */
  revealDepth?: number
  /** 楼板腰线高度（米） */
  slabBandHeight?: number
  /** 角部内缩，避免半窗（米） */
  cornerInset?: number
  /** 玻璃粗糙度 0~1 */
  glassRoughness?: number
  /** 玻璃金属度 0~1 */
  glassMetalness?: number
  /** 环境反射强度 0~2 */
  envMapIntensity?: number
  /** AO 强度 0~1 */
  aoStrength?: number
  /** 几何附件开关 */
  relief?: Partial<FacadeReliefFlags>
  /** 立面装饰各构件的独立材质（缺省按默认白色 + trimsheet 贴图） */
  parts?: Partial<Record<FacadeReliefPartKey, PartMaterialConfig>>
  /** 立面档案版本：缺省视为 1，当前为 2 */
  profileVersion?: number
}

/** 程序化大门风格 */
export type EntranceGateStyle = 'office' | 'residential' | 'hospital' | 'factory'

/** 大门门扇形态：双开 / 自动平移 / 卷帘 */
export type EntranceGateDoorType = 'double' | 'sliding' | 'roller'

/**
 * 单面大门配置
 * - `faceIndex`：外环第 i 条边对应的侧面
 * - `anchor`：该面中点坐标，仅用于面索引漂移时自愈重绑
 * - `offsetT`：点击落点在面长方向上的归一化位置 0~1
 */
export interface EntranceGateConfig {
  /** 实例 id：同一面可放置多个大门，按 id 区分（旧数据缺省时自动派生） */
  id?: string
  faceIndex: number
  anchor: [number, number]
  offsetT: number
  style: EntranceGateStyle
  doorType: EntranceGateDoorType
  /** 门洞净宽（真实米） */
  width: number
  /** 门洞净高（真实米） */
  height: number
  /** 雨棚进深（真实米），0 表示无雨棚 */
  canopyDepth: number
  /** 台阶级数 0~3 */
  steps: number
  frameColor: string
  doorColor: string
  glassColor: string
  /** 门头招牌文字，空字符串表示无招牌 */
  signText: string
  /** 门头 / 门扇夜间亮灯强度 0~1 */
  emissiveIntensity: number
  /** 门框金属度 0~1（门套 / 雨棚 / 门扇包边） */
  frameMetalness: number
  seed: number
}
