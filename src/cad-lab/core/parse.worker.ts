/**
 * CAD 解析 Worker：在独立线程里加载 libredwg.wasm，避免解析阻塞界面。
 *
 * 主线程只负责把 ArrayBuffer 发进来，Worker 返回与 DOM 无关的 CadDrawing IR。
 */

import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web'
import { buildDrawing } from './buildDrawing'
import { normalizeDxfBytes } from './dxfNormalize'
import type { CadParseRequest, CadParseResponse } from './types'

/** Worker 作用域的最小类型声明，避免引入 webworker lib 影响主工程 tsconfig */
interface CadWorkerScope {
  onmessage: ((event: MessageEvent<CadParseRequest>) => void) | null
  postMessage: (message: CadParseResponse) => void
}

const scope = self as unknown as CadWorkerScope

type LibredwgInstance = Awaited<ReturnType<typeof LibreDwg.create>>

let libredwgPromise: Promise<LibredwgInstance> | null = null

/** 复用同一个 WASM 实例，第二次解析不再重复加载 */
function getLibredwg(wasmDir: string): Promise<LibredwgInstance> {
  if (!libredwgPromise) libredwgPromise = LibreDwg.create(wasmDir)
  return libredwgPromise
}

/** 从异常中提取可读消息 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function handleRequest(request: CadParseRequest): Promise<void> {
  const started = performance.now()
  try {
    const libredwg = await getLibredwg(request.wasmDir)
    const notes: string[] = []
    let payload: string | ArrayBuffer = request.buffer

    if (request.fileType === 'DXF') {
      const normalized = normalizeDxfBytes(new Uint8Array(request.buffer))
      notes.push(...normalized.notes)
      const bytes = normalized.bytes
      payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }

    const fileType = request.fileType === 'DXF' ? Dwg_File_Type.DXF : Dwg_File_Type.DWG
    const pointer = libredwg.dwg_read_data(payload, fileType)
    if (pointer === undefined || pointer === 0) {
      throw new Error('libredwg 无法读取该文件，请确认图纸未加密或损坏。')
    }

    // convert 之后 DwgDatabase 已与原生内存解耦，可以立即释放
    const database = libredwg.convert(pointer)
    libredwg.dwg_free(pointer)

    const drawing = buildDrawing(database, {
      fileName: request.fileName,
      fileType: request.fileType,
      parseMs: Math.round(performance.now() - started),
      notes,
    })
    scope.postMessage({ id: request.id, ok: true, drawing })
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, error: errorMessage(error) })
  }
}

scope.onmessage = (event: MessageEvent<CadParseRequest>) => {
  void handleRequest(event.data)
}
