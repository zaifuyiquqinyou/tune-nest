import { createPlaylistZip } from './playlist-zip'
import type { PlaylistExportFile } from '@/types/playlist-tools'

interface WritableTextFile {
  write(content: string): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

interface ExportDirectory {
  readonly name: string
  getDirectoryHandle(name: string, options?: { create: boolean }): Promise<ExportDirectory>
  getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<WritableTextFile> }>
}

type DirectoryPicker = (options: { mode: 'readwrite' }) => Promise<ExportDirectory>

export interface PlaylistDirectoryWriter {
  name: string
  write(file: PlaylistExportFile): Promise<void>
}

/** 文件选择必须由点击事件直接触发，不能等远端歌单读取完成后再请求。 */
export function canChoosePlaylistDirectory(): boolean {
  return typeof (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker === 'function'
}

/** 在选定目录内创建新的备份子目录，避免覆盖用户已有文件。 */
export async function choosePlaylistDirectory(): Promise<PlaylistDirectoryWriter> {
  const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  if (!picker) throw new Error('当前网页不支持选择目录，请改用 ZIP 下载')
  let root: ExportDirectory
  try {
    root = await picker.call(window, { mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('已取消目录选择，未开始导出')
    throw new Error('当前网页无法打开目录选择器，请改用 ZIP 下载，解压后即为各歌单 TXT')
  }
  const base = 'TuneNest-歌单备份-' + new Date().toISOString().replace(/[:.]/g, '-')
  let directory: ExportDirectory | null = null
  let directoryName = base
  for (let index = 0; index < 100; index++) {
    directoryName = base + (index ? '-' + index : '')
    try {
      await root.getDirectoryHandle(directoryName)
    } catch (err) {
      if (!(err instanceof DOMException) || err.name !== 'NotFoundError') throw err
      directory = await root.getDirectoryHandle(directoryName, { create: true })
      break
    }
  }
  if (!directory) throw new Error('无法创建新的备份目录，请重试')
  const destination = directory
  return {
    name: root.name + '/' + directoryName,
    async write(file) {
      const handle = await destination.getFileHandle(file.name, { create: true })
      const writable = await handle.createWritable()
      try {
        await writable.write(file.content)
        await writable.close()
      } catch (err) {
        await writable.abort().catch(() => {})
        throw err
      }
    },
  }
}

/** 一个 ZIP 包内保存所有 TXT，避免网页连续下载多个文件受到浏览器限制。 */
export function downloadPlaylistBackup(files: readonly PlaylistExportFile[]): string {
  const bytes = createPlaylistZip(files)
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const filename = 'TuneNest-歌单备份-' + new Date().toISOString().replace(/[:.]/g, '-') + '.zip'
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.hidden = true
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return filename
}
