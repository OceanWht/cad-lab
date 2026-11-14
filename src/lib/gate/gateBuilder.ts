/**
 * 程序化大门构件构建器
 *
 * 生成「贴面门头」：门洞背板、门套、门扇、雨棚、台阶、门头招牌六类构件。
 * 不切割墙体，全部构件以薄板 / 盒体贴在墙面上，作为建筑 Mesh 的子节点，
 * 随建筑移动 / 旋转 / 缩放一起变换。
 *
 * 该模块同时被编辑器与 standalone-engine 引用，禁止依赖 UI 层。
 */
import * as THREE from 'three'
import type { EntranceGateConfig } from '../../shared/types'
import { GATE_JAMB_WIDTH, gateSignCacheKey, type GateSeamFlags } from './gateTypes'
import { acquireGateSignTexture, releaseGateSignTexture } from './gateSignTexture'

/**
 * 建筑局部的墙面框架
 * - `start` / `end`：墙面底边的两个端点（建筑局部坐标，y = 0）
 * - `normal`：外法线（水平单位向量，建筑局部空间）
 * - `horizontalScale`：真实米 → 场景米的水平换算系数（Mercator 各向异性补偿，通常 1/cos(lat)）
 */
export interface GateFaceFrame {
  start: THREE.Vector3
  end: THREE.Vector3
  normal: THREE.Vector3
  horizontalScale: number
}

export interface BuildGateOptions {
  /** 父级非等比缩放的补偿系数（取父级 scale 的倒数） */
  scaleCompensation?: THREE.Vector3
  /**
   * 左右接缝（同一面相邻大门无缝拼接）：
   * 值为共享门柱中心相对本门中心的距离（场景米），null / 缺省表示该侧独立。
   */
  seam?: GateSeamFlags | null
}

const GATE_BACKDROP_COLOR = 0x1c2126

/**
 * 从建筑几何体读取第 faceIndex 个墙面的底边端点与外法线（建筑局部坐标）。
 * 直接使用几何体顶点，避免依赖轮廓环的顶点顺序约定；编辑器与引擎共用。
 */
export function computeGateFaceFrame(mesh: THREE.Mesh, faceIndex: number): GateFaceFrame | null {
  const geo = mesh.geometry as THREE.BufferGeometry | undefined
  const pos = geo?.attributes?.position
  const groups = geo?.groups
  if (!pos || !groups?.length) return null

  let startIdx = -1
  let count = 0
  if (groups.length >= 3) {
    for (const g of groups) {
      if (g.materialIndex === faceIndex + 1) { startIdx = g.start; count = g.count; break }
    }
  }
  if (startIdx < 0) {
    const side = groups[1]
    if (!side) return null
    startIdx = side.start + faceIndex * 6
    count = 6
    if (startIdx + count > side.start + side.count) return null
  }
  if (startIdx < 0 || startIdx + 3 > pos.count) return null

  // 收集该面去重后的顶点，取底边（y 最小）两点作为面端点
  const uniq: THREE.Vector3[] = []
  const seen = new Set<string>()
  let minY = Infinity
  for (let i = startIdx; i < startIdx + count && i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(new THREE.Vector3(x, y, z))
    if (y < minY) minY = y
  }
  const bottom = uniq.filter((p) => Math.abs(p.y - minY) < 1e-3)
  if (bottom.length < 2) return null
  const start = bottom[0].clone()
  const end = bottom[1].clone()
  let maxDist = start.distanceTo(end)
  for (let i = 0; i < bottom.length; i++) {
    for (let j = i + 1; j < bottom.length; j++) {
      const d = bottom[i].distanceTo(bottom[j])
      if (d > maxDist) { maxDist = d; start.copy(bottom[i]); end.copy(bottom[j]) }
    }
  }

  // 三角面法线（已含 rotateX(-90) 的坐标系），取水平分量作为外法线
  const p0 = new THREE.Vector3().fromBufferAttribute(pos, startIdx)
  const p1 = new THREE.Vector3().fromBufferAttribute(pos, startIdx + 1)
  const p2 = new THREE.Vector3().fromBufferAttribute(pos, startIdx + 2)
  const normal = new THREE.Vector3()
    .crossVectors(p1.clone().sub(p0), p2.clone().sub(p0))
    .normalize()
  normal.y = 0
  if (normal.lengthSq() < 1e-6) return null
  normal.normalize()

  start.y = 0
  end.y = 0
  return { start, end, normal, horizontalScale: 1 }
}

/** 共享材质池：同风格同配色的门套 / 门扇 / 玻璃材质复用，引用计数归零时释放 */
interface SharedMaterialEntry {
  mat: THREE.MeshStandardMaterial
  refs: number
}

const sharedMaterials = new Map<string, SharedMaterialEntry>()

function acquireMaterial(key: string, factory: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const hit = sharedMaterials.get(key)
  if (hit) {
    hit.refs++
    return hit.mat
  }
  const mat = factory()
  mat.userData = { ...(mat.userData ?? {}), __gateSharedMaterial: key }
  sharedMaterials.set(key, { mat, refs: 1 })
  return mat
}

/** 释放一组大门占用的共享材质（由宿主对象的销毁流程调用） */
export function releaseGateMaterials(keys: string[]): void {
  for (const key of new Set(keys)) {
    const entry = sharedMaterials.get(key)
    if (!entry) continue
    entry.refs--
    if (entry.refs > 0) continue
    entry.mat.dispose()
    sharedMaterials.delete(key)
  }
}

/** 释放大门 Group 持有的共享资源（材质 + 招牌贴图） */
export function releaseGateGroupResources(group: THREE.Object3D): void {
  const matKeys = (group.userData as any)?.__gateMaterialKeys as string[] | undefined
  if (matKeys?.length) releaseGateMaterials(matKeys)
  const signKey = String((group.userData as any)?.__gateSignTextureKey ?? '')
  if (signKey) releaseGateSignTexture(signKey)
}

function makeStandard(color: string, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness })
}

/** 门扇玻璃：颜色与选择器一致（不透明着色 + 低粗糙度玻璃高光），避免透明混色导致偏色 */
function makeGlass(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.14,
    metalness: 0.05,
  })
}

function addBox(
  parent: THREE.Object3D,
  material: THREE.Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
  mesh.position.set(x, y, z)
  parent.add(mesh)
  return mesh
}

/** 单扇「纯玻璃 + 金属包边」门扇：金属外框内嵌整块玻璃 */
function buildFramedGlassLeaf(
  parent: THREE.Object3D,
  cx: number,
  leafW: number,
  leafH: number,
  z: number,
  frameMat: THREE.Material,
  glassMat: THREE.Material,
): void {
  const border = 0.07
  // 金属门框：四边包边留出通透门洞，玻璃内嵌后能看穿门后
  addBox(parent, frameMat, border, leafH, 0.06, cx - leafW / 2 + border / 2, leafH / 2, z)
  addBox(parent, frameMat, border, leafH, 0.06, cx + leafW / 2 - border / 2, leafH / 2, z)
  addBox(parent, frameMat, leafW, border, 0.06, cx, border / 2, z)
  addBox(parent, frameMat, leafW, border, 0.06, cx, leafH - border / 2, z)
  addBox(
    parent,
    glassMat,
    Math.max(0.1, leafW - border * 2),
    Math.max(0.1, leafH - border * 2),
    0.02,
    cx,
    leafH / 2,
    z + 0.01,
  )
}

/** 门扇：双开（两扇纯玻璃门，金属框架包边） */
function buildDoubleLeaves(
  parent: THREE.Object3D,
  width: number,
  height: number,
  frameMat: THREE.Material,
  glassMat: THREE.Material,
): void {
  const leafW = Math.max(0.3, width / 2 - 0.04)
  const leafH = Math.max(0.6, height - 0.04)
  for (const sign of [-1, 1]) {
    const cx = sign * (width / 4)
    buildFramedGlassLeaf(parent, cx, leafW, leafH, 0.13, frameMat, glassMat)
  }
}

/** 门扇：自动平移（两扇错位玻璃，金属框架包边 + 上下轨道） */
function buildSlidingLeaves(
  parent: THREE.Object3D,
  width: number,
  height: number,
  frameMat: THREE.Material,
  glassMat: THREE.Material,
): void {
  const leafW = Math.max(0.4, width / 2 + 0.05)
  const leafH = Math.max(0.6, height - 0.06)
  // 左右两扇在 z 轴错位，形成平移门的前后层
  buildFramedGlassLeaf(parent, -width / 4, leafW, leafH, 0.12, frameMat, glassMat)
  buildFramedGlassLeaf(parent, width / 4, leafW, leafH, 0.19, frameMat, glassMat)
  // 上轨 / 地槛：自动移门的金属轨道
  addBox(parent, frameMat, width * 0.98, 0.09, 0.12, 0, height - 0.04, 0.16)
  addBox(parent, frameMat, width * 0.98, 0.06, 0.12, 0, 0.03, 0.16)
}

/** 门扇：卷帘（整幅金属帘 + 密集横向分条 + 导轨 / 底梁） */
function buildRollerLeaf(
  parent: THREE.Object3D,
  width: number,
  height: number,
  doorMat: THREE.Material,
  frameMat: THREE.Material,
): void {
  const leafW = Math.max(0.6, width - 0.04)
  const leafH = Math.max(0.6, height - 0.04)
  addBox(parent, doorMat, leafW, leafH, 0.06, 0, leafH / 2, 0.13)
  const slats = 9
  for (let i = 1; i < slats; i++) {
    const y = leafH * (i / slats)
    addBox(parent, frameMat, leafW + 0.02, 0.035, 0.045, 0, y, 0.175)
  }
  // 底梁 + 左右导轨：让卷帘门一眼区别于玻璃门
  addBox(parent, frameMat, leafW + 0.04, 0.24, 0.09, 0, 0.12, 0.18)
  for (const sign of [-1, 1]) {
    addBox(parent, frameMat, 0.1, height, 0.12, sign * (width / 2 + 0.05), height / 2, 0.1)
  }
}

/**
 * 构建大门 Group（建筑局部坐标）
 * 返回 null 表示参数不可渲染（宽高非法）。
 */
export function buildGateGroup(
  config: EntranceGateConfig,
  frame: GateFaceFrame,
  options: BuildGateOptions = {},
): THREE.Group | null {
  const hScale = Number.isFinite(frame.horizontalScale) && frame.horizontalScale > 0 ? frame.horizontalScale : 1
  const dir = new THREE.Vector3().subVectors(frame.end, frame.start)
  dir.y = 0
  const faceLen = dir.length()
  if (!Number.isFinite(faceLen) || faceLen < 1e-4) return null
  dir.normalize()

  const normal = frame.normal.clone()
  normal.y = 0
  if (normal.lengthSq() < 1e-6) return null
  normal.normalize()

  // 面长（真实米）内截断门宽：留 0.4m 余量
  const faceLenTrue = faceLen / hScale
  const widthTrue = Math.max(1, Math.min(config.width, Math.max(1, faceLenTrue - 0.4)))
  const heightTrue = Math.max(1.5, config.height)
  const width = widthTrue * hScale
  const height = heightTrue
  const canopyDepth = Math.max(0, config.canopyDepth) * hScale
  const steps = Math.max(0, Math.min(3, Math.round(config.steps)))

  const t = Math.max(0, Math.min(1, Number.isFinite(config.offsetT) ? config.offsetT : 0.5))
  const center = new THREE.Vector3().copy(frame.start).addScaledVector(dir, faceLen * t)
  center.y = 0

  // 左右接缝：相邻门共用一根门柱，雨棚 / 台阶在接缝侧齐平续接
  const seamLeft = options.seam?.left ?? null
  const seamRight = options.seam?.right ?? null
  const jambW = GATE_JAMB_WIDTH

  const group = new THREE.Group()
  group.name = `entranceGate_${config.faceIndex}`
  group.position.copy(center)
  group.rotation.y = Math.atan2(normal.x, normal.z)
  group.userData.isEntranceGate = true
  group.userData.gateFaceIndex = config.faceIndex
  group.userData.gateCacheKey = config.signText
  if (options.scaleCompensation) {
    group.scale.copy(options.scaleCompensation)
  }

  const emissive = Math.max(0, Math.min(1, config.emissiveIntensity))
  const emissiveKey = emissive > 0 ? emissive.toFixed(2) : '0'
  const metalRaw = Number(config.frameMetalness)
  const frameMetalness = Number.isFinite(metalRaw) ? Math.max(0, Math.min(1, metalRaw)) : 0.32
  const frameMat = acquireMaterial(`frame|${config.frameColor}|${frameMetalness.toFixed(2)}`, () =>
    makeStandard(config.frameColor, 0.45, frameMetalness))
  const doorMat = acquireMaterial(`door|${config.doorColor}|${emissiveKey}`, () => {
    const m = makeStandard(config.doorColor, 0.5, 0.3)
    if (emissive > 0) {
      m.emissive = new THREE.Color(config.doorColor)
      m.emissiveIntensity = emissive * 0.35
    }
    return m
  })
  // ★ 纯玻璃门的门扇就是玻璃：玻璃色调由「门扇色」(doorColor) 控制
  const glassMat = acquireMaterial(`glass|${config.doorColor}|${emissiveKey}`, () => {
    const m = makeGlass(config.doorColor)
    if (emissive > 0) {
      m.emissive = new THREE.Color(config.doorColor)
      m.emissiveIntensity = emissive * 0.6
    }
    return m
  })
  const backdropMat = acquireMaterial('backdrop', () => new THREE.MeshStandardMaterial({
    color: GATE_BACKDROP_COLOR,
    roughness: 0.95,
    metalness: 0,
  }))
  group.userData.__gateMaterialKeys = [
    `frame|${config.frameColor}|${frameMetalness.toFixed(2)}`,
    `door|${config.doorColor}|${emissiveKey}`,
    `glass|${config.doorColor}|${emissiveKey}`,
    'backdrop',
  ]

  // 1) 门洞背板：外扩 0.1m，遮住门后窗格
  addBox(group, backdropMat, width + 0.2, height + 0.2, 0.04, 0, (height + 0.2) / 2, 0.03)

  // 2) 门套：左右立柱 + 上横梁
  // 右侧立柱始终绘制（接缝侧即共享门柱）；左侧仅在本门独立时绘制
  const jambH = height + 0.14
  if (seamLeft == null) {
    addBox(group, frameMat, jambW, jambH, 0.16, -(width / 2 + jambW / 2), jambH / 2, 0.09)
  }
  addBox(group, frameMat, jambW, jambH, 0.16, seamRight ?? (width / 2 + jambW / 2), jambH / 2, 0.09)
  // 上横梁：接缝侧裁剪到共享门柱中心，避免与相邻门的横梁共面重叠
  const lintelLeft = seamLeft ?? -(width / 2 + jambW)
  const lintelRight = seamRight ?? width / 2 + jambW
  addBox(group, frameMat, Math.max(0.4, lintelRight - lintelLeft), 0.18, 0.16, (lintelLeft + lintelRight) / 2, height + 0.09, 0.09)

  // 3) 门扇：双开 / 自动移门默认「纯玻璃门 + 金属框架」，工厂为金属卷帘
  if (config.doorType === 'sliding') {
    buildSlidingLeaves(group, width, height, frameMat, glassMat)
  } else if (config.doorType === 'roller') {
    buildRollerLeaf(group, width, height, doorMat, frameMat)
  } else {
    buildDoubleLeaves(group, width, height, frameMat, glassMat)
  }

  // 4) 雨棚：接缝侧与相邻门齐平续接，独立侧保留外挑与收边
  if (canopyDepth > 0.05) {
    const isHospital = config.style === 'hospital'
    const overhang = isHospital ? 0.6 : 0.3
    const leftEdge = seamLeft ?? -(width / 2 + overhang)
    const rightEdge = seamRight ?? width / 2 + overhang
    const canopyW = Math.max(0.5, rightEdge - leftEdge)
    const canopyX = (leftEdge + rightEdge) / 2
    const canopyD = canopyDepth + (isHospital ? 0.4 : 0)
    const canopyY = height + 0.34
    const canopy = addBox(group, frameMat, canopyW, isHospital ? 0.14 : 0.1, canopyD, canopyX, canopyY, canopyD / 2 + 0.12)
    if (config.style === 'residential') {
      // 居民楼：小坡雨棚，绕 X 轴轻微下倾
      canopy.rotation.x = -0.16
    }
    addBox(group, frameMat, canopyW, 0.16, 0.06, canopyX, canopyY - 0.06, canopyD + 0.12)
    // 雨棚收边：仅独立侧
    if (seamLeft == null) {
      addBox(group, frameMat, 0.06, 0.14, canopyD, leftEdge, canopyY - 0.04, canopyD / 2 + 0.12)
    }
    if (seamRight == null) {
      addBox(group, frameMat, 0.06, 0.14, canopyD, rightEdge, canopyY - 0.04, canopyD / 2 + 0.12)
    }
    if (isHospital) {
      // 医院：加大门头雨棚 —— 外沿加厚檐口 + 两侧落地立柱 + 底面灯带
      addBox(group, frameMat, canopyW, 0.3, 0.12, canopyX, canopyY - 0.12, canopyD + 0.1)
      const postH = Math.max(1, canopyY - 0.14)
      if (seamLeft == null) {
        addBox(group, frameMat, 0.16, postH, 0.16, leftEdge + 0.2, postH / 2, canopyD - 0.06)
      }
      if (seamRight == null) {
        addBox(group, frameMat, 0.16, postH, 0.16, rightEdge - 0.2, postH / 2, canopyD - 0.06)
      }
      addBox(group, glassMat, Math.max(0.2, canopyW - 0.5), 0.04, Math.max(0.1, canopyD - 0.35), canopyX, canopyY - 0.1, canopyD / 2 + 0.12)
    }
  }

  // 5) 台阶：由外向内逐级升高；接缝侧与相邻门对接不重叠
  const stepLeft = seamLeft ?? -(width / 2 + 0.2)
  const stepRight = seamRight ?? width / 2 + 0.2
  const stepW = Math.max(0.4, stepRight - stepLeft)
  const stepX = (stepLeft + stepRight) / 2
  for (let i = 0; i < steps; i++) {
    const stepH = 0.15 * (i + 1)
    const z = 0.12 + 0.3 * (steps - i - 0.5)
    addBox(group, frameMat, stepW, stepH, 0.3, stepX, stepH / 2, z)
  }

  // 6) 门头招牌
  const signTex = acquireGateSignTexture(config)
  if (signTex) {
    const signW = Math.min(width * 0.82, 4.5 * hScale)
    const signH = signW * canvasHeightRatio(signTex.image as HTMLCanvasElement)
    const signY = height + (canopyDepth > 0.05 ? 0.72 : 0.55)
    addBox(group, backdropMat, signW + 0.08, signH + 0.08, 0.06, 0, signY, 0.11)
    const signMat = new THREE.MeshStandardMaterial({
      map: signTex,
      roughness: 0.6,
      metalness: 0.05,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: emissive > 0 ? signTex : null,
      emissiveIntensity: emissive > 0 ? emissive : 0,
    })
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(signW, signH), signMat)
    plane.position.set(0, signY, 0.145)
    group.add(plane)
    group.userData.__gateSignTextureKey = gateSignCacheKey(config)
  }

  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!(mesh as any).isMesh) return
    mesh.userData.isEntranceGate = true
    mesh.userData.gateFaceIndex = config.faceIndex
    mesh.castShadow = false
    mesh.receiveShadow = false
  })

  return group
}

/** 招牌 Canvas 高宽比（用于保持贴图比例） */
function canvasHeightRatio(canvas: HTMLCanvasElement): number {
  if (!canvas.width) return 0.25
  return canvas.height / canvas.width
}
