/**
 * 解析 Worker 的主线程封装。
 * 只负责消息往返与错误转换，不包含任何 CAD 业务逻辑。
 */

import type { CadDrawing, CadParseRequest, CadParseResponse } from './types'

interface PendingRequest {
  resolve: (drawing: CadDrawing) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, PendingRequest>()

function rejectAll(message: string): void {
  for (const request of pending.values()) request.reject(new Error(message))
  pending.clear()
}

function getWorker(): Worker {
  if (worker) return worker
  const created = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<CadParseResponse>) => {
    const message = event.data
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.drawing)
    else request.reject(new Error(message.error))
  }
  created.onerror = (event: ErrorEvent) => {
    rejectAll(event.message || 'CAD 解析 Worker 异常退出')
    created.terminate()
    if (worker === created) worker = null
  }
  worker = created
  return created
}

/** 把 WASM 目录解析为绝对 URL：Worker 内 locateFile 以 Worker 脚本为基准 */
export function resolveWasmDir(): string {
  return new URL(`${import.meta.env.BASE_URL}wasm/`, window.location.href).href
}

/** 解析 DWG / DXF 文件，返回可渲染的 IR */
export function parseCadFile(file: File, wasmDir: string): Promise<CadDrawing> {
  const id = nextRequestId
  nextRequestId += 1
  return new Promise<CadDrawing>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    void file.arrayBuffer().then(
      (buffer) => {
        const request: CadParseRequest = {
          id,
          fileName: file.name,
          fileType: file.name.toLowerCase().endsWith('.dwg') ? 'DWG' : 'DXF',
          buffer,
          wasmDir,
        }
        getWorker().postMessage(request)
      },
      (error: unknown) => {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** 释放 Worker（组件卸载时调用） */
export function disposeCadParser(): void {
  rejectAll('CAD 解析已取消')
  if (worker) {
    worker.terminate()
    worker = null
  }
}
