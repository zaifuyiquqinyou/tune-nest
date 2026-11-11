import type { PlaylistExportFile } from '@/types/playlist-tools'

const encoder = new TextEncoder()
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let value = 0xFFFFFFFF
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xFF] ^ (value >>> 8)
  return (value ^ 0xFFFFFFFF) >>> 0
}

/** 使用标准 ZIP 的存储模式和 UTF-8 文件名，不引入压缩依赖或向外部服务发送歌单。 */
export function createPlaylistZip(files: readonly PlaylistExportFile[]): Uint8Array {
  if (files.length > 65535) throw new Error('歌单文件过多，请改用本地目录导出')
  const entries = files.map((file) => ({
    name: encoder.encode(file.name),
    content: encoder.encode(file.content),
    offset: 0,
  }))
  const total = entries.reduce((sum, entry) => sum + 76 + entry.name.length * 2 + entry.content.length, 22)
  if (total > 256 * 1024 * 1024 || entries.some((entry) => entry.name.length > 65535)) {
    throw new Error('备份文件过大，请改用本地目录导出')
  }
  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)
  let offset = 0
  for (const entry of entries) {
    entry.offset = offset
    view.setUint32(offset, 0x04034B50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 0x0800, true)
    view.setUint16(offset + 12, 33, true)
    view.setUint32(offset + 14, crc32(entry.content), true)
    view.setUint32(offset + 18, entry.content.length, true)
    view.setUint32(offset + 22, entry.content.length, true)
    view.setUint16(offset + 26, entry.name.length, true)
    output.set(entry.name, offset + 30)
    output.set(entry.content, offset + 30 + entry.name.length)
    offset += 30 + entry.name.length + entry.content.length
  }
  const directoryOffset = offset
  for (const entry of entries) {
    view.setUint32(offset, 0x02014B50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 20, true)
    view.setUint16(offset + 8, 0x0800, true)
    view.setUint16(offset + 14, 33, true)
    view.setUint32(offset + 16, crc32(entry.content), true)
    view.setUint32(offset + 20, entry.content.length, true)
    view.setUint32(offset + 24, entry.content.length, true)
    view.setUint16(offset + 28, entry.name.length, true)
    view.setUint32(offset + 42, entry.offset, true)
    output.set(entry.name, offset + 46)
    offset += 46 + entry.name.length
  }
  view.setUint32(offset, 0x06054B50, true)
  view.setUint16(offset + 8, entries.length, true)
  view.setUint16(offset + 10, entries.length, true)
  view.setUint32(offset + 12, offset - directoryOffset, true)
  view.setUint32(offset + 16, directoryOffset, true)
  return output
}
