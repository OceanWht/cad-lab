/**
 * 二维平面视图：用 three.js 正交相机俯视渲染 CAD 折线。
 *
 * 每个图层一个 Group，组内按颜色分桶生成 LineSegments，
 * 这样图层显隐只需切换 Group.visible，不需要重建几何。
 */

import * as THREE from 'three'
import { sampleArc } from '../core/geometry'
import type { CadBounds, CadDrawing, CadPoint } from '../core/types'
import {
  appendOutlineSegment,
  arcParameters,
  createArcSegment,
  createLineSegment,
  removeLastOutlineSegment,
  validateOutline,
  OUTLINE_MERGE_DISTANCE_M,
  OUTLINE_TOLERANCE_M,
  type OutlinePoint,
  type OutlineSegment,
  type SlabOutline,
} from '../core/slabOutline'

const BACKGROUND_COLOR = 0x0e131f
const GRID_COLOR = 0x232a3a
const GRID_CELL_METERS = 10

/** 填充面片透明度 */
const FILL_OPACITY = 0.32

/** 填充面片的 z 偏移（米），压在线框下方避免共面闪烁 */
const FILL_Z_OFFSET = -0.01

/** 轮廓绘制层的 z 偏移，压在 CAD 线框之上 */
const GUIDE_Z = 0.05
const OUTLINE_Z = 0.1
const DRAFT_Z = 0.15
const MARKER_Z = 0.2

const GUIDE_COLOR = 0x3f8ea0
const OUTLINE_COLOR = 0x4ade80
/** 内环（楼板洞口）回显颜色，与外环区分 */
const HOLE_COLOR = 0x38bdf8
const DRAFT_COLOR = 0xffd166
const CONFLICT_COLOR = 0xff5c5c

/** 吸附阈值（屏幕像素） */
const SNAP_PIXELS = 12
/** 判定为拖拽而不是点击的位移（像素） */
const CLICK_MOVE_TOLERANCE = 4
/** 双击判定间隔（毫秒） */
const DOUBLE_CLICK_MS = 320

/** 绘制工具：直线段两下，圆弧段三点 */
export type OutlineTool = 'line' | 'arc'

/** 绘制用途：楼板外轮廓 / 楼板内环（洞口）/ 墙体闭合连接线 */
export type OutlinePurpose = 'slab' | 'slab-hole' | 'wall'

/** 墙带边界与中心线，作为绘制时的参照与吸附目标 */
export interface OutlineGuides {
  /** 墙带边界折线（米） */
  bands: Array<{ points: CadPoint[]; closed: boolean; conflict?: boolean }>
  /** 墙中心线线段（米） */
  centerlines: Array<{ a: CadPoint; b: CadPoint }>
}

/** 轮廓绘制回调 */
export interface OutlineDrawHandlers {
  /** 草稿变化（段数变化 / 撤销），用于界面提示进度 */
  onChange?: (segmentCount: number) => void
  /** 轮廓校验通过并闭合 */
  onFinish?: (outline: SlabOutline) => void
  /**
   * 楼板内环绘制完成：收到一条闭合内环。
   * 返回中文错误表示未通过校验并停留在绘制态，返回 null 表示接受并退出绘制。
   */
  onHoleFinish?: (hole: SlabOutline) => string | null
  /**
   * 墙体闭合完成：收到连接线折点（米）。
   * 返回中文错误表示未通过校验并停留在绘制态，返回 null 表示接受并退出绘制。
   */
  onWallFinish?: (points: OutlinePoint[]) => string | null
  /** 用户按 Esc 取消绘制 */
  onCancel?: () => void
  /** 绘制过程中的中文错误（校验失败、弧退化等） */
  onError?: (message: string) => void
}

/** 平面视图控制器 */
export class CadPlanView {
  private readonly container: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.OrthographicCamera
  private readonly contentRoot: THREE.Group
  private readonly gridRoot: THREE.Group
  private readonly resizeObserver: ResizeObserver
  private readonly layerGroups = new Map<string, THREE.Group>()
  private readonly handlers: OutlineDrawHandlers

  /** 轮廓绘制层：墙带参照线、已提交轮廓、草稿段、端点标记 */
  private readonly guideRoot = new THREE.Group()
  private readonly outlineRoot = new THREE.Group()
  private readonly draftRoot = new THREE.Group()
  private readonly markerRoot = new THREE.Group()

  /** 是否处于轮廓绘制模式 */
  private drawingOutline = false
  /** 当前绘制用途：楼板轮廓 / 墙体闭合 */
  private outlinePurpose: OutlinePurpose = 'slab'
  /** 当前绘制工具 */
  private outlineTool: OutlineTool = 'line'
  /** 已落定的段 */
  private draftOutline: SlabOutline = { segments: [] }
  /** 尚未成段的落点：直线 1 点待第二点，圆弧 1–2 点待补足 */
  private pendingPoints: OutlinePoint[] = []
  /** 已提交（校验通过）的轮廓，仅用于回显 */
  private committedOutline: SlabOutline | null = null
  /** 自交冲突段下标，绘制时标红 */
  private conflictSegments: number[] = []
  /** 吸附参照 */
  private guides: OutlineGuides | null = null
  /** 当前光标位置（米）与吸附结果 */
  private hoverPoint: OutlinePoint | null = null
  private hoverSnapped = false

  private pressedButton: number | null = null
  private pressX = 0
  private pressY = 0
  private movedSincePress = false
  private lastClickAt = 0
  private lastClickX = 0
  private lastClickY = 0

  private centerX = 0
  private centerY = 0
  private metersPerPixel = 0.1
  private lastBounds: CadBounds | null = null
  private lastUnitScale = 0.001
  private dragging = false
  private lastPointerX = 0
  private lastPointerY = 0
  private dirty = false
  private frameHandle = 0
  private disposed = false

  constructor(container: HTMLElement, handlers: OutlineDrawHandlers = {}) {
    this.container = container
    this.handlers = handlers
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(BACKGROUND_COLOR, 1)
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000)
    this.camera.position.set(0, 0, 100)
    this.camera.up.set(0, 1, 0)

    this.contentRoot = new THREE.Group()
    this.gridRoot = new THREE.Group()
    this.scene.add(this.gridRoot)
    this.scene.add(this.contentRoot)

    // 轮廓层压在 CAD 线框之上，互不影响显隐
    this.scene.add(this.guideRoot)
    this.scene.add(this.outlineRoot)
    this.scene.add(this.draftRoot)
    this.scene.add(this.markerRoot)

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)
    this.handleResize()
    this.attachInteractions()
  }

  /** 载入图纸并重建全部图层几何 */
  setDrawing(drawing: CadDrawing): void {
    // 换图纸后旧图纸的墙带参照与轮廓都失效，一并清空
    this.drawingOutline = false
    this.outlinePurpose = 'slab'
    this.draftOutline = { segments: [] }
    this.pendingPoints = []
    this.committedOutline = null
    this.conflictSegments = []
    this.guides = null
    this.hoverPoint = null
    this.hoverSnapped = false
    this.renderer.domElement.style.cursor = 'grab'
    this.rebuildOutlineLayer()

    this.clearContent()
    // 线框按「图层 → 颜色」分桶，填充按「图层 → 颜色」收集环组
    const lineBuckets = new Map<string, Map<number, number[]>>()
    const fillBuckets = new Map<string, Map<number, CadPoint[][][]>>()

    for (const entity of drawing.entities) {
      for (const primitive of entity.primitives) {
        if (primitive.kind === 'polyline') {
          let colorBuckets = lineBuckets.get(entity.layer)
          if (!colorBuckets) {
            colorBuckets = new Map<number, number[]>()
            lineBuckets.set(entity.layer, colorBuckets)
          }
          let positions = colorBuckets.get(entity.color)
          if (!positions) {
            positions = []
            colorBuckets.set(entity.color, positions)
          }
          const points = primitive.points
          const edgeCount = primitive.closed ? points.length : points.length - 1
          for (let i = 0; i < edgeCount; i += 1) {
            const a = points[i]
            const b = points[(i + 1) % points.length]
            const ax = a.x * drawing.unitScale
            const ay = a.y * drawing.unitScale
            const bx = b.x * drawing.unitScale
            const by = b.y * drawing.unitScale
            if (ax === bx && ay === by) continue
            positions.push(ax, ay, 0, bx, by, 0)
          }
          continue
        }

        // fill 图元：逐个环组转成独立面片，洞用 Shape.holes 表达
        const loops = primitive.loops.map((loop) =>
          loop.map((point) => ({
            x: point.x * drawing.unitScale,
            y: point.y * drawing.unitScale,
          })),
        )
        if (loops.length === 0 || loops[0].length < 3) continue
        let layerFills = fillBuckets.get(entity.layer)
        if (!layerFills) {
          layerFills = new Map<number, CadPoint[][][]>()
          fillBuckets.set(entity.layer, layerFills)
        }
        let loopSets = layerFills.get(entity.color)
        if (!loopSets) {
          loopSets = []
          layerFills.set(entity.color, loopSets)
        }
        loopSets.push(loops)
      }
    }

    const layerNames = new Set<string>()
    for (const name of lineBuckets.keys()) layerNames.add(name)
    for (const name of fillBuckets.keys()) layerNames.add(name)

    for (const layerName of layerNames) {
      const layerGroup = new THREE.Group()
      layerGroup.name = layerName
      const colorBuckets = lineBuckets.get(layerName)
      if (colorBuckets) {
        for (const [color, positions] of colorBuckets) {
          if (positions.length === 0) continue
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
          const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
          layerGroup.add(new THREE.LineSegments(geometry, material))
        }
      }
      const layerFills = fillBuckets.get(layerName)
      if (layerFills) {
        for (const [color, loopSets] of layerFills) {
          for (const loops of loopSets) {
            layerGroup.add(this.buildFillMesh(loops, color))
          }
        }
      }
      this.layerGroups.set(layerName, layerGroup)
      this.contentRoot.add(layerGroup)
    }

    this.buildGrid(drawing.focusBounds, drawing.unitScale)
    this.lastBounds = drawing.focusBounds
    this.lastUnitScale = drawing.unitScale
    this.fit(drawing.focusBounds, drawing.unitScale)
  }

  /** 用 THREE.Shape 生成一个带洞的半透明填充面片 */
  private buildFillMesh(loops: CadPoint[][], color: number): THREE.Mesh {
    const shape = new THREE.Shape(loops[0].map((point) => new THREE.Vector2(point.x, point.y)))
    for (let i = 1; i < loops.length; i += 1) {
      shape.holes.push(
        new THREE.Path(loops[i].map((point) => new THREE.Vector2(point.x, point.y))),
      )
    }
    const geometry = new THREE.ShapeGeometry(shape)
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: FILL_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.z = FILL_Z_OFFSET
    return mesh
  }

  /** 切换图层显隐 */
  setLayerVisible(layerName: string, visible: boolean): void {
    const group = this.layerGroups.get(layerName)
    if (!group) return
    group.visible = visible
    this.requestRender()
  }

  /** 是否处于地板轮廓绘制模式 */
  get isOutlineDrawing(): boolean {
    return this.drawingOutline
  }

  /** 切换绘制工具（直线段 / 三点圆弧），切换时保留已落定的段 */
  setOutlineTool(tool: OutlineTool): void {
    // 墙体闭合只接受直线段：圆弧会被采样成大量碎墙段，无法与既有墙链稳定成环
    if (this.outlinePurpose === 'wall' && tool === 'arc') return
    this.outlineTool = tool
    // 换工具后残留的弧上点会变成直线段的起点以外的点，直接丢掉未成段的部分
    if (this.pendingPoints.length > 1) this.pendingPoints = this.pendingPoints.slice(0, 1)
    if (this.drawingOutline) this.rebuildOutlineLayer()
  }

  /**
   * 设置墙带参照（绘制时叠加显示并作为吸附目标）。
   * 传 null 清空参照。
   */
  setOutlineGuides(guides: OutlineGuides | null): void {
    this.guides = guides
    if (this.drawingOutline) this.rebuildOutlineLayer()
  }

  /** 同步已提交轮廓的回显（含内环），供外部增删内环后刷新平面图 */
  setCommittedOutline(outline: SlabOutline | null): void {
    this.committedOutline = outline
    this.rebuildOutlineLayer()
  }

  /** 进入绘制模式；已提交的旧轮廓保留显示作为对照 */
  startOutlineDraw(purpose: OutlinePurpose = 'slab'): void {
    this.drawingOutline = true
    this.outlinePurpose = purpose
    if (purpose === 'wall') this.outlineTool = 'line'
    this.draftOutline = { segments: [] }
    this.pendingPoints = []
    this.conflictSegments = []
    this.hoverPoint = null
    this.hoverSnapped = false
    this.renderer.domElement.style.cursor = 'crosshair'
    this.rebuildOutlineLayer()
    this.handlers.onChange?.(0)
  }

  /** 退出绘制模式，丢弃草稿；已提交的轮廓不受影响 */
  cancelOutlineDraw(): void {
    if (!this.drawingOutline) return
    this.drawingOutline = false
    this.outlinePurpose = 'slab'
    this.draftOutline = { segments: [] }
    this.pendingPoints = []
    this.conflictSegments = []
    this.hoverPoint = null
    this.hoverSnapped = false
    this.renderer.domElement.style.cursor = 'grab'
    this.rebuildOutlineLayer()
    this.handlers.onChange?.(0)
  }

  /** 撤销上一个落点 / 段（Backspace） */
  undoOutlinePoint(): void {
    if (!this.drawingOutline) return
    if (this.pendingPoints.length > 1) {
      this.pendingPoints = this.pendingPoints.slice(0, -1)
    } else if (this.draftOutline.segments.length > 0) {
      this.draftOutline = removeLastOutlineSegment(this.draftOutline)
      const end = this.currentEnd()
      this.pendingPoints = end ? [end] : []
    } else {
      this.pendingPoints = []
    }
    this.conflictSegments = []
    this.handlers.onChange?.(this.draftOutline.segments.length)
    this.rebuildOutlineLayer()
  }

  /**
   * 结束当前绘制：楼板外轮廓 / 内环闭合多边形，墙体闭合则提交连接线。
   */
  finishOutline(): void {
    if (!this.drawingOutline) return
    if (this.outlinePurpose === 'wall') {
      this.finishWallClosure()
      return
    }

    const isHole = this.outlinePurpose === 'slab-hole'
    const outline = this.closeDraft(isHole ? '楼板内环' : '地板轮廓')
    if (!outline) return

    const result = validateOutline(outline)
    if (!result.valid) {
      this.conflictSegments = result.conflictSegments
      this.handlers.onError?.(result.message)
      this.rebuildOutlineLayer()
      return
    }

    if (isHole) {
      const failure = this.handlers.onHoleFinish?.(outline)
      if (failure) {
        this.handlers.onError?.(failure)
        return
      }
      this.exitDrawingMode()
      return
    }

    this.committedOutline = outline
    this.exitDrawingMode()
    this.handlers.onFinish?.(outline)
  }

  /**
   * 把草稿补成闭合轮廓：末点与首点不重合时自动补一条闭合直线段。
   * 点数不足或圆弧未补完时给出中文错误并返回 null，调用方停留绘制态。
   */
  private closeDraft(label: string): SlabOutline | null {
    if (this.pendingPoints.length > 1) {
      this.handlers.onError?.('请先补完当前圆弧段（还差 1 个点）')
      return null
    }
    if (this.draftOutline.segments.length < 2) {
      this.handlers.onError?.(`${label}至少需要 3 条段，当前段数不足`)
      return null
    }

    let outline = this.draftOutline
    const lastEnd = outline.segments[outline.segments.length - 1].end
    const firstStart = outline.segments[0].start
    if (distanceOf(lastEnd, firstStart) >= OUTLINE_MERGE_DISTANCE_M) {
      try {
        outline = appendOutlineSegment(outline, createLineSegment(lastEnd, firstStart))
      } catch (error) {
        this.handlers.onError?.(error instanceof Error ? error.message : String(error))
        return null
      }
    }
    return outline
  }

  /**
   * 提交墙体闭合连接线。
   * 与楼板轮廓不同，连接线不补「末点回到首点」的闭合段：闭合环由
   * 既有墙链 + 连接线共同组成，补段反而会把整条连接线覆盖成往返线。
   */
  private finishWallClosure(): void {
    if (this.pendingPoints.length > 1) {
      this.handlers.onError?.('请先补完当前圆弧段（还差 1 个点）')
      return
    }
    if (this.draftOutline.segments.length === 0) {
      this.handlers.onError?.('请先在平面上画出连接线，至少需要一条直线段')
      return
    }

    const points: OutlinePoint[] = []
    for (const segment of this.draftOutline.segments) {
      if (segment.kind !== 'line') {
        this.handlers.onError?.('墙体闭合只支持直线段，请切换为直线段后重画')
        return
      }
      if (points.length === 0) points.push(segment.start)
      points.push(segment.end)
    }

    const failure = this.handlers.onWallFinish?.(points)
    if (failure) {
      this.handlers.onError?.(failure)
      return
    }
    this.exitDrawingMode()
  }

  /** 退出绘制态并丢弃草稿；已提交轮廓不受影响 */
  private exitDrawingMode(): void {
    this.drawingOutline = false
    this.outlinePurpose = 'slab'
    this.draftOutline = { segments: [] }
    this.pendingPoints = []
    this.conflictSegments = []
    this.hoverPoint = null
    this.hoverSnapped = false
    this.renderer.domElement.style.cursor = 'grab'
    this.rebuildOutlineLayer()
  }

  /** 当前段的起点：已有段时取末段终点 */
  private currentEnd(): OutlinePoint | null {
    const { segments } = this.draftOutline
    return segments.length === 0 ? null : segments[segments.length - 1].end
  }

  /** 接受一个落点（已完成吸附） */
  private acceptPoint(point: OutlinePoint): void {
    if (!this.drawingOutline) return

    if (this.pendingPoints.length === 0) {
      const end = this.currentEnd()
      if (end && distanceOf(end, point) < OUTLINE_MERGE_DISTANCE_M) {
        this.handlers.onError?.('新落点与上一段终点重合，请换个位置')
        return
      }
      this.pendingPoints = [point]
      this.rebuildOutlineLayer()
      return
    }

    if (this.outlineTool === 'line') {
      const start = this.pendingPoints[0]
      if (distanceOf(start, point) < OUTLINE_MERGE_DISTANCE_M) {
        this.handlers.onError?.('直线段的起点与终点重合，请换个位置')
        return
      }
      this.appendSegment(createLineSegment(start, point))
      return
    }

    const points = [...this.pendingPoints, point]
    if (points.length < 3) {
      this.pendingPoints = points
      this.rebuildOutlineLayer()
      return
    }
    const [start, through, end] = points
    try {
      this.appendSegment(createArcSegment(start, through, end))
    } catch (error) {
      // 三点共线等非法圆弧：保留前两点，用户可继续点第三点
      this.pendingPoints = [start, through]
      this.handlers.onError?.(error instanceof Error ? error.message : String(error))
      this.rebuildOutlineLayer()
    }
  }

  /** 追加一段并把落点重置为该段终点，保证下一段首尾相接 */
  private appendSegment(segment: OutlineSegment): void {
    try {
      this.draftOutline = appendOutlineSegment(this.draftOutline, segment)
    } catch (error) {
      this.handlers.onError?.(error instanceof Error ? error.message : String(error))
      return
    }
    this.pendingPoints = [segment.end]
    this.conflictSegments = []
    this.handlers.onChange?.(this.draftOutline.segments.length)
    this.rebuildOutlineLayer()
  }

  /** 光标吸附：先找顶点，再找墙带边界 / 中心线上最近的点，阈值按屏幕像素换算 */
  private snapPoint(world: OutlinePoint): { point: OutlinePoint; snapped: boolean } {
    const guides = this.guides
    if (!guides) return { point: world, snapped: false }

    const threshold = SNAP_PIXELS * this.metersPerPixel
    let best = threshold
    let nearest: OutlinePoint | null = null

    const considerVertex = (point: OutlinePoint): void => {
      const distance = distanceOf(point, world)
      if (distance <= best) {
        best = distance
        nearest = { x: point.x, y: point.y }
      }
    }
    for (const band of guides.bands) {
      for (const point of band.points) considerVertex(point)
    }
    for (const line of guides.centerlines) {
      considerVertex(line.a)
      considerVertex(line.b)
    }
    if (nearest) return { point: nearest, snapped: true }

    best = threshold
    const considerSegment = (a: OutlinePoint, b: OutlinePoint): void => {
      const point = closestPointOnSegment(a, b, world)
      const distance = distanceOf(point, world)
      if (distance <= best) {
        best = distance
        nearest = point
      }
    }
    for (const band of guides.bands) {
      const count = band.closed ? band.points.length : band.points.length - 1
      for (let index = 0; index < count; index += 1) {
        considerSegment(band.points[index], band.points[(index + 1) % band.points.length])
      }
    }
    for (const line of guides.centerlines) considerSegment(line.a, line.b)

    if (nearest) return { point: nearest, snapped: true }
    return { point: world, snapped: false }
  }

  /** 预览折线：已落点 + 光标，圆弧工具在三点齐备时预览真实圆弧 */
  private previewPoints(): OutlinePoint[] {
    if (this.pendingPoints.length === 0) return []
    const points = [...this.pendingPoints]
    const hover = this.hoverPoint
    if (!hover) return points
    const last = points[points.length - 1]
    if (this.outlineTool === 'arc' && points.length === 2) {
      try {
        const arc = arcParameters(points[0], points[1], hover)
        const sampled = sampleArc(arc.center, arc.radius, arc.startAngle, arc.sweep, OUTLINE_TOLERANCE_M)
        sampled.push(hover)
        return [points[0], ...sampled]
      } catch {
        // 三点共线时退回折线预览，等用户点出有效的第三点
      }
    }
    if (distanceOf(last, hover) < OUTLINE_MERGE_DISTANCE_M) return points
    return [...points, hover]
  }

  /** 重建轮廓相关的全部图层 */
  private rebuildOutlineLayer(): void {
    this.rebuildGuideLayer()
    this.rebuildDraftLayers()
    this.requestRender()
  }

  /** 墙带参照线：只在参照或绘制模式变化时重建，鼠标移动不重算 */
  private rebuildGuideLayer(): void {
    this.clearGroup(this.guideRoot)
    if (!this.guides) return
    for (const band of this.guides.bands) {
      this.addPolyline(
        this.guideRoot,
        band.points,
        band.closed,
        band.conflict ? CONFLICT_COLOR : GUIDE_COLOR,
        GUIDE_Z,
        0.5,
      )
    }
    for (const line of this.guides.centerlines) {
      this.addPolyline(this.guideRoot, [line.a, line.b], false, GUIDE_COLOR, GUIDE_Z, 0.28)
    }
  }

  /** 已提交轮廓 + 当前草稿 + 端点标记；鼠标移动时只重建这一层 */
  private rebuildDraftLayers(): void {
    this.clearGroup(this.outlineRoot)
    this.clearGroup(this.draftRoot)
    this.clearGroup(this.markerRoot)

    if (this.committedOutline) {
      this.addOutline(this.outlineRoot, this.committedOutline, OUTLINE_COLOR, OUTLINE_Z, [])
    }

    if (!this.drawingOutline) return

    this.addOutline(this.draftRoot, this.draftOutline, DRAFT_COLOR, DRAFT_Z, this.conflictSegments)

    const preview = this.previewPoints()
    if (preview.length >= 2) {
      this.addPolyline(this.draftRoot, preview, false, DRAFT_COLOR, DRAFT_Z, 0.9)
    }

    const markers: OutlinePoint[] = []
    for (const segment of this.draftOutline.segments) {
      markers.push(segment.start, segment.end)
    }
    markers.push(...this.pendingPoints)
    if (markers.length > 0) this.addMarkers(this.markerRoot, markers, DRAFT_COLOR)
    if (this.hoverPoint) {
      this.addMarkers(this.markerRoot, [this.hoverPoint], this.hoverSnapped ? OUTLINE_COLOR : 0xffffff)
    }
  }

  /** 逐段画轮廓；圆弧按 2mm 弦高采样，与楼板几何一致；内环用独立颜色回显 */
  private addOutline(
    group: THREE.Group,
    outline: SlabOutline,
    color: number,
    z: number,
    conflictSegments: number[],
  ): void {
    this.addOutlineLoop(group, outline, color, z, conflictSegments)
    for (const hole of outline.holes ?? []) {
      this.addOutlineLoop(group, hole, HOLE_COLOR, z, [])
    }
  }

  /** 画单条闭合环的全部段 */
  private addOutlineLoop(
    group: THREE.Group,
    outline: SlabOutline,
    color: number,
    z: number,
    conflictSegments: number[],
  ): void {
    outline.segments.forEach((segment, index) => {
      const segmentColor = conflictSegments.includes(index) ? CONFLICT_COLOR : color
      if (segment.kind === 'line') {
        this.addPolyline(group, [segment.start, segment.end], false, segmentColor, z, 0.95)
        return
      }
      const arc = arcParameters(segment.start, segment.through, segment.end)
      const points = sampleArc(arc.center, arc.radius, arc.startAngle, arc.sweep, OUTLINE_TOLERANCE_M)
      points.push(segment.end)
      this.addPolyline(group, points, false, segmentColor, z, 0.95)
    })
  }

  /** 批量画折线（LineSegments），`closed` 时首尾相接 */
  private addPolyline(
    group: THREE.Group,
    points: OutlinePoint[],
    closed: boolean,
    color: number,
    z: number,
    opacity: number,
  ): void {
    if (points.length < 2) return
    const positions: number[] = []
    const count = closed ? points.length : points.length - 1
    for (let index = 0; index < count; index += 1) {
      const a = points[index]
      const b = points[(index + 1) % points.length]
      if (a.x === b.x && a.y === b.y) continue
      positions.push(a.x, a.y, z, b.x, b.y, z)
    }
    if (positions.length === 0) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
    })
    group.add(new THREE.LineSegments(geometry, material))
  }

  /** 端点标记用方点，屏幕像素大小不随缩放变化 */
  private addMarkers(group: THREE.Group, points: OutlinePoint[], color: number): void {
    if (points.length === 0) return
    const positions: number[] = []
    for (const point of points) positions.push(point.x, point.y, MARKER_Z)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color,
      size: 7,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    })
    group.add(new THREE.Points(geometry, material))
  }

  /** 清空一个绘制层的几何与材质 */
  private clearGroup(group: THREE.Group): void {
    group.traverse((object) => {
      if (object instanceof THREE.LineSegments || object instanceof THREE.Points) {
        object.geometry.dispose()
        if (Array.isArray(object.material)) {
          object.material.forEach((material) => material.dispose())
        } else {
          object.material.dispose()
        }
      }
    })
    group.clear()
  }

  /** 适配视图到指定包围盒 */
  fit(bounds: CadBounds, unitScale: number): void {
    const width = (bounds.maxX - bounds.minX) * unitScale
    const height = (bounds.maxY - bounds.minY) * unitScale
    this.centerX = ((bounds.minX + bounds.maxX) / 2) * unitScale
    this.centerY = ((bounds.minY + bounds.maxY) / 2) * unitScale
    const containerWidth = this.container.clientWidth
    const containerHeight = this.container.clientHeight
    const viewWidth = width > 1 ? width * 1.08 : 20
    const viewHeight = height > 1 ? height * 1.08 : 20
    const aspect = containerWidth / containerHeight
    const requiredHeight = viewHeight > viewWidth / aspect ? viewHeight : viewWidth / aspect
    this.metersPerPixel = requiredHeight / containerHeight
    this.updateCamera()
  }

  /** 释放 WebGL 资源 */
  dispose(): void {
    this.disposed = true
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle)
    this.resizeObserver.disconnect()
    this.detachInteractions()
    this.clearContent()
    this.clearGrid()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private handleResize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return
    // 必须让 three 同步写 canvas 的 CSS 尺寸（第三个参数不能传 false）：
    // setPixelRatio 之后绘图缓冲区是 CSS 尺寸的 DPR 倍，而 canvas 的 width/height
    // 属性只决定绘制分辨率、不决定布局尺寸；不写 style 时浏览器按属性像素布局，
    // 画布在 DPR>1 的屏幕上会被撑成 N 倍大小，容器裁掉溢出部分后，相机中心与
    // 光标的换算基准就不再一致，绘制落点会偏离鼠标。
    this.renderer.setSize(width, height)
    this.updateCamera()
  }

  private updateCamera(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return
    const halfWidth = (width * this.metersPerPixel) / 2
    const halfHeight = (height * this.metersPerPixel) / 2
    this.camera.left = -halfWidth
    this.camera.right = halfWidth
    this.camera.top = halfHeight
    this.camera.bottom = -halfHeight
    this.camera.near = 0.1
    this.camera.far = 10000
    this.camera.updateProjectionMatrix()
    this.camera.position.set(this.centerX, this.centerY, 100)
    this.camera.lookAt(this.centerX, this.centerY, 0)
    this.requestRender()
  }

  private buildGrid(bounds: CadBounds, unitScale: number): void {
    this.clearGrid()
    const minX = bounds.minX * unitScale
    const minY = bounds.minY * unitScale
    const maxX = bounds.maxX * unitScale
    const maxY = bounds.maxY * unitScale
    const spanX = maxX - minX
    const spanY = maxY - minY
    if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || spanX <= 0 || spanY <= 0) return

    const startX = Math.floor(minX / GRID_CELL_METERS) * GRID_CELL_METERS
    const startY = Math.floor(minY / GRID_CELL_METERS) * GRID_CELL_METERS
    const endX = Math.ceil(maxX / GRID_CELL_METERS) * GRID_CELL_METERS
    const endY = Math.ceil(maxY / GRID_CELL_METERS) * GRID_CELL_METERS
    const positions: number[] = []
    // 限制网格线数量，避免超大图纸产生海量顶点
    const maxLines = 400
    let lineCount = 0
    for (let x = startX; x <= endX && lineCount < maxLines; x += GRID_CELL_METERS) {
      positions.push(x, startY, 0, x, endY, 0)
      lineCount += 1
    }
    for (let y = startY; y <= endY && lineCount < maxLines; y += GRID_CELL_METERS) {
      positions.push(startX, y, 0, endX, y, 0)
      lineCount += 1
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const material = new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.55 })
    this.gridRoot.add(new THREE.LineSegments(geometry, material))
  }

  private clearContent(): void {
    for (const group of this.layerGroups.values()) {
      group.traverse((object) => {
        if (object instanceof THREE.LineSegments || object instanceof THREE.Mesh) {
          object.geometry.dispose()
          if (Array.isArray(object.material)) {
            object.material.forEach((material) => material.dispose())
          } else {
            object.material.dispose()
          }
        }
      })
      this.contentRoot.remove(group)
    }
    this.layerGroups.clear()
  }

  private clearGrid(): void {
    this.gridRoot.traverse((object) => {
      if (object instanceof THREE.LineSegments) {
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

  private requestRender(): void {
    if (this.dirty || this.disposed) return
    this.dirty = true
    this.frameHandle = requestAnimationFrame(() => {
      this.dirty = false
      this.renderer.render(this.scene, this.camera)
    })
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const offsetX = clientX - rect.left - rect.width / 2
    const offsetY = clientY - rect.top - rect.height / 2
    return {
      x: this.centerX + offsetX * this.metersPerPixel,
      y: this.centerY - offsetY * this.metersPerPixel,
    }
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const before = this.screenToWorld(event.clientX, event.clientY)
    const factor = Math.exp(event.deltaY * 0.0015)
    this.metersPerPixel *= factor
    const after = this.screenToWorld(event.clientX, event.clientY)
    this.centerX += before.x - after.x
    this.centerY += before.y - after.y
    this.updateCamera()
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
    event.preventDefault()
    this.dragging = true
    this.pressedButton = event.button
    this.pressX = event.clientX
    this.pressY = event.clientY
    this.movedSincePress = false
    this.lastPointerX = event.clientX
    this.lastPointerY = event.clientY
    this.renderer.domElement.setPointerCapture(event.pointerId)
    this.renderer.domElement.style.cursor = 'grabbing'
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.drawingOutline) {
      const world = this.screenToWorld(event.clientX, event.clientY)
      const snapped = this.snapPoint(world)
      this.hoverPoint = snapped.point
      this.hoverSnapped = snapped.snapped
      if (!this.dragging) {
        this.rebuildDraftLayers()
        this.requestRender()
      }
    }

    if (!this.dragging) return
    const deltaX = event.clientX - this.lastPointerX
    const deltaY = event.clientY - this.lastPointerY
    this.lastPointerX = event.clientX
    this.lastPointerY = event.clientY
    if (
      Math.abs(event.clientX - this.pressX) + Math.abs(event.clientY - this.pressY) >
      CLICK_MOVE_TOLERANCE
    ) {
      this.movedSincePress = true
    }
    if (deltaX === 0 && deltaY === 0) return
    this.centerX -= deltaX * this.metersPerPixel
    this.centerY += deltaY * this.metersPerPixel
    this.updateCamera()
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const button = this.pressedButton
    const moved = this.movedSincePress
    this.pressedButton = null
    this.movedSincePress = false

    if (this.dragging) {
      this.dragging = false
      if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
        this.renderer.domElement.releasePointerCapture(event.pointerId)
      }
      this.renderer.domElement.style.cursor = this.drawingOutline ? 'crosshair' : 'grab'
    }

    // 拖动是平移而不是落点；pointercancel 不产生落点
    if (event.type === 'pointercancel' || !this.drawingOutline || moved) return

    if (button === 0) {
      const now = performance.now()
      const isDoubleClick =
        now - this.lastClickAt < DOUBLE_CLICK_MS &&
        Math.abs(event.clientX - this.lastClickX) <= CLICK_MOVE_TOLERANCE &&
        Math.abs(event.clientY - this.lastClickY) <= CLICK_MOVE_TOLERANCE
      this.lastClickAt = now
      this.lastClickX = event.clientX
      this.lastClickY = event.clientY

      // 双击结束：楼板轮廓的第二次点击不应再落一个点，先撤掉第一次点击的点；
      // 墙体闭合的第一次点击正是最后一段连接线，直接提交，不能撤销
      if (isDoubleClick) {
        if (this.outlinePurpose === 'wall') {
          this.finishOutline()
          return
        }
        this.undoOutlinePoint()
        this.finishOutline()
        return
      }

      const world = this.screenToWorld(event.clientX, event.clientY)
      const snapped = this.snapPoint(world)
      this.hoverPoint = snapped.point
      this.hoverSnapped = snapped.snapped
      this.acceptPoint(snapped.point)
    }
    // 右键只用于平移视图，不再承担闭合轮廓的操作
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
  }

  private readonly handleDoubleClick = (): void => {
    // 绘制态的双击已经在 pointerup 里处理为闭合
    if (this.drawingOutline) return
    if (!this.lastBounds) return
    this.fit(this.lastBounds, this.lastUnitScale)
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.drawingOutline) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.cancelOutlineDraw()
      this.handlers.onCancel?.()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      this.finishOutline()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      this.undoOutlinePoint()
    }
  }

  private attachInteractions(): void {
    const element = this.renderer.domElement
    element.style.cursor = 'grab'
    element.addEventListener('wheel', this.handleWheel, { passive: false })
    element.addEventListener('pointerdown', this.handlePointerDown)
    element.addEventListener('pointermove', this.handlePointerMove)
    element.addEventListener('pointerup', this.handlePointerUp)
    element.addEventListener('pointercancel', this.handlePointerUp)
    element.addEventListener('contextmenu', this.handleContextMenu)
    element.addEventListener('dblclick', this.handleDoubleClick)
    window.addEventListener('keydown', this.handleKeyDown)
  }

  private detachInteractions(): void {
    const element = this.renderer.domElement
    element.removeEventListener('wheel', this.handleWheel)
    element.removeEventListener('pointerdown', this.handlePointerDown)
    element.removeEventListener('pointermove', this.handlePointerMove)
    element.removeEventListener('pointerup', this.handlePointerUp)
    element.removeEventListener('pointercancel', this.handlePointerUp)
    element.removeEventListener('contextmenu', this.handleContextMenu)
    element.removeEventListener('dblclick', this.handleDoubleClick)
    window.removeEventListener('keydown', this.handleKeyDown)
  }
}

/** 两点距离（米） */
function distanceOf(a: OutlinePoint, b: OutlinePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 线段 ab 上离 p 最近的点（用于吸附到墙带边界） */
function closestPointOnSegment(a: OutlinePoint, b: OutlinePoint, p: OutlinePoint): OutlinePoint {
  const deltaX = b.x - a.x
  const deltaY = b.y - a.y
  const lengthSq = deltaX * deltaX + deltaY * deltaY
  if (lengthSq < 1e-12) return { x: a.x, y: a.y }
  const raw = ((p.x - a.x) * deltaX + (p.y - a.y) * deltaY) / lengthSq
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
  return { x: a.x + deltaX * t, y: a.y + deltaY * t }
}
