/**
 * DXF 输入归一化。
 *
 * 之所以需要这一层：libredwg-web@0.8.6 在读取 R2018（$ACADVER=AC1032）DXF 时，
 * 会把所有字符串截断成 1 个字符，导致图层名、块名丢失、模型空间实体数为 0。
 * 实测把版本标记降为 AC1015 后可正确解析本项目的样本图纸。
 *
 * 另外，不少中文 DXF 实际是 UTF-8 编码，但 $DWGCODEPAGE 仍声明为 ANSI_936，
 * libredwg 会按 GBK 解码而产生乱码；这里按字节真实编码改写声明。
 *
 * 所有改写都只针对 ASCII 标记，并在结果中返回说明，便于界面透明展示。
 */

/** 字节数组转「一字符=一字节」的二进制字符串（避免 windows-1252 对 0x80-0x9F 的改写） */
export function bytesToBinaryString(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let result = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    result += String.fromCharCode(...chunk)
  }
  return result
}

/** 二进制字符串还原为字节数组 */
export function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/** 是否为合法 UTF-8（用于判断 DXF 的真实编码） */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** 是否包含非 ASCII 字节（纯英文图纸无需改写 codepage） */
function hasNonAsciiByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] >= 0x80) return true
  }
  return false
}

const ACADVER_PATTERN = /\$ACADVER(\r?\n\s*1\r?\n)AC1032/
const DWGCODEPAGE_PATTERN = /\$DWGCODEPAGE(\r?\n\s*3\r?\n)([^\r\n]+)/

/** DXF 归一化结果 */
export interface DxfNormalizeResult {
  bytes: Uint8Array
  notes: string[]
}

/**
 * 归一化 DXF 字节流：
 * 1. R2018 版本标记降级到 AC1015（规避字符串截断缺陷）；
 * 2. 实际为 UTF-8 的图纸，把 $DWGCODEPAGE 改写为 UTF-8。
 */
export function normalizeDxfBytes(input: Uint8Array): DxfNormalizeResult {
  const notes: string[] = []
  let text = bytesToBinaryString(input)
  let modified = false

  if (ACADVER_PATTERN.test(text)) {
    text = text.replace(ACADVER_PATTERN, '$ACADVER$1AC1015')
    notes.push('DXF 版本为 AC1032（R2018），解析器存在字符串截断问题，已按 AC1015 兼容模式读取。')
    modified = true
  }

  const utf8 = isValidUtf8(input) && hasNonAsciiByte(input)
  if (utf8) {
    const match = DWGCODEPAGE_PATTERN.exec(text)
    if (match) {
      const declared = match[2].trim().toUpperCase()
      if (declared !== 'UTF-8' && declared !== 'UTF8') {
        text = text.replace(DWGCODEPAGE_PATTERN, '$DWGCODEPAGE$1UTF-8')
        notes.push(`图纸实际编码为 UTF-8，但声明为 ${match[2].trim()}，已按 UTF-8 读取图层与块名称。`)
        modified = true
      }
    }
  }

  if (!modified) return { bytes: input, notes }
  return { bytes: binaryStringToBytes(text), notes }
}

/** 判断文件头是否为 DXF（ASCII 文本以 0/SECTION 或注释开头） */
export function looksLikeDxf(bytes: Uint8Array): boolean {
  const head = bytesToBinaryString(bytes.subarray(0, 64)).toUpperCase()
  return head.includes('SECTION') || head.includes('ACADVER') || head.trimStart().startsWith('0')
}

/** 按扩展名与文件头推断格式 */
export function detectCadFileType(fileName: string, bytes: Uint8Array): 'DXF' | 'DWG' {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.dxf')) return 'DXF'
  if (lower.endsWith('.dwg')) return 'DWG'
  return looksLikeDxf(bytes) ? 'DXF' : 'DWG'
}
