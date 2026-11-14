/**
 * CAD 图纸试验模块的中间表示（IR）类型。
 *
 * 说明：
 * - 本模块与编辑器主流程完全隔离，不引用 src/lib 下的任何业务逻辑；
 * - IR 统一使用「图纸坐标」（DXF 中通常为毫米），渲染时再乘以 unitScale 转成米；
 * - 曲线（圆弧 / 椭圆 / 多段线 bulge）在解析阶段就离散为折线，
 *   避免渲染层重复实现曲线采样。
 */

/** 图纸二维坐标点 */
export interface CadPoint {
  x: number
  y: number
}

/** 折线图元：closed 为 true 时首尾自动闭合 */
export interface CadPolylinePrimitive {
  kind: 'polyline'
  points: CadPoint[]
  closed: boolean
}

/**
 * 填充图元：用于 HATCH 的实心填充。
 * loops[0] 为外环，其余为内洞（island）；每个环均为隐式闭合折线，
 * 不重复记录首点，方向已归一化为「外环逆时针、内洞顺时针」。
 */
export interface CadFillPrimitive {
  kind: 'fill'
  loops: CadPoint[][]
}

export type CadPrimitive = CadPolylinePrimitive | CadFillPrimitive

/** 一条可渲染的 CAD 实体 */
export interface CadEntity {
  /** 实体唯一标识（INSERT 展开后的子实体带层级前缀） */
  id: string
  /** 原始 DXF 实体类型，如 LINE / LWPOLYLINE / ARC */
  type: string
  /** 所属图层名称（块内 0 层实体已继承插入图层） */
  layer: string
  /** 解析后的颜色，0xRRGGBB */
  color: number
  /**
   * 最近的 INSERT 块名（顶层实体为 undefined）。
   * 门窗通常以标准块插入（如 M0921 / C1515），是比几何更可靠的识别依据。
   */
  blockName?: string
  /**
   * 同一次 INSERT 块实例展开出的实体共享同一编号（顶层实体为 undefined）。
   * 一个门窗块内部通常有门扇、门框、开启弧等多个图元，
   * 聚合这些图元才能得到该门窗的整体尺寸。
   */
  blockInstance?: number
  primitives: CadPrimitive[]
}

/** 图层信息（可见性由 UI 单独维护，不写回解析结果） */
export interface CadLayerInfo {
  name: string
  /** 解析后的图层颜色，0xRRGGBB */
  color: number
  /** 有效颜色来源：ACI 索引 / 图纸未给出有效 ACI 时的确定性调色板 */
  colorSource: 'aci' | 'palette'
  /** 该图层在当前图纸中的实体数量（含块展开后的实体） */
  entityCount: number
  off: boolean
  frozen: boolean
}

/** 轴对齐包围盒（图纸单位） */
export interface CadBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 解析统计，用于界面展示与问题定位 */
export interface CadDrawingStats {
  /** 模型空间顶层实体数 */
  topLevelCount: number
  /** 生成的可渲染实体数（含 INSERT 展开） */
  renderableCount: number
  /** INSERT 展开出的子实体数 */
  expandedCount: number
  /** 未支持的实体数量（DIMENSION / TEXT 等） */
  skippedCount: number
  /** 解析 + 转换耗时（毫秒） */
  parseMs: number
}

/** 图纸解析结果 */
export interface CadDrawing {
  fileName: string
  fileType: 'DXF' | 'DWG'
  /** 1 图纸单位 = unitScale 米 */
  unitScale: number
  /** $INSUNITS 原始值，0 表示未声明 */
  insUnits: number
  /** 全部几何的包围盒（图纸单位） */
  bounds: CadBounds
  /** 剔除离群实体后的主体包围盒，用于初始视图适配 */
  focusBounds: CadBounds
  layers: CadLayerInfo[]
  entities: CadEntity[]
  stats: CadDrawingStats
  /** 输入归一化 / 解析限制说明，直接展示给用户 */
  notes: string[]
}

/** 主线程发给解析 Worker 的请求 */
export interface CadParseRequest {
  id: number
  fileName: string
  fileType: 'DXF' | 'DWG'
  buffer: ArrayBuffer
  /** libredwg.wasm 所在目录（以 / 结尾） */
  wasmDir: string
}

/** Worker 回传的解析结果 */
export type CadParseResponse =
  | { id: number; ok: true; drawing: CadDrawing }
  | { id: number; ok: false; error: string }
