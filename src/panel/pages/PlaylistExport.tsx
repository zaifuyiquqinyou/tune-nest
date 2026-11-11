import { useState } from 'react'
import { exportAccountPlaylists } from '@/services/playlist-export'
import { canChoosePlaylistDirectory, choosePlaylistDirectory, downloadPlaylistBackup } from '@/utils/playlist-files'
import { usePlaylistList, usePlaylistOperation } from '../hooks/use-playlist-tools'
import type { PlaylistExportFile, PlaylistExportProgress, PlaylistExportResult } from '@/types/playlist-tools'

interface Props {
  uid: number
  onBack: () => void
  onBusyChange: (busy: boolean) => void
}

/** 目录模式逐个保存 TXT；目录选择不可用时可下载包含相同 TXT 的 ZIP。 */
export function PlaylistExport({ uid, onBack, onBusyChange }: Props) {
  const list = usePlaylistList(uid)
  const operation = usePlaylistOperation(onBusyChange)
  const [method, setMethod] = useState<'directory' | 'zip'>(() => canChoosePlaylistDirectory() ? 'directory' : 'zip')
  const [progress, setProgress] = useState<PlaylistExportProgress | null>(null)
  const [outcome, setOutcome] = useState<PlaylistExportResult | null>(null)
  const [destination, setDestination] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState(false)

  const handleExport = () => operation.run(async () => {
    setOutcome(null)
    setProgress(null)
    setDestination(null)
    setDownloaded(false)
    // 保持点击事件的用户激活状态，目录选择不能放到网络请求之后。
    const directory = method === 'directory' ? await choosePlaylistDirectory() : null
    const files: PlaylistExportFile[] = []
    const result = await exportAccountPlaylists(uid, async (file) => {
      if (directory) await directory.write(file)
      else files.push(file)
    }, setProgress)
    if (directory) {
      setDestination(directory.name)
    } else if (files.length > 0) {
      setDestination(downloadPlaylistBackup(files))
      setDownloaded(true)
    }
    setOutcome(result)
  })

  return (
    <div>
      <h3 className="text-base font-semibold text-gray-800 mb-2">导出所有歌单 TXT</h3>
      <p className="text-sm text-gray-500 mb-3">
        包含当前账号的自建及收藏歌单，每个歌单一个 TXT。每行保留歌曲 ID、歌名、歌手、专辑和时长，可再次导入合并。
      </p>
      <p className="text-xs text-gray-500 mb-4">只导出歌曲清单，不下载音频。缺少歌曲详情时仍保留 ID。</p>
      {list.loading && <p className="text-sm text-gray-500 mb-3" role="status">正在读取歌单列表...</p>}
      {list.error && (
        <div className="text-sm text-red-600 mb-3" role="alert">
          <p>{list.error}</p>
          <button className="underline mt-1" disabled={operation.busy} onClick={list.reload}>重新加载</button>
        </div>
      )}
      {!list.loading && !list.error && (
        <p className="text-sm text-gray-700 mb-4">
          当前列表有 {list.playlists.length} 个歌单（自建 {list.playlists.filter((playlist) => playlist.creator.userId === uid).length} 个）。
          导出时会重新读取。
        </p>
      )}
      <fieldset disabled={operation.busy} className="space-y-3 mb-4">
        <legend className="text-sm font-semibold mb-2">保存方式</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="playlist-export-method" checked={method === 'directory'}
            disabled={!canChoosePlaylistDirectory()}
            onChange={() => { setMethod('directory'); setOutcome(null); operation.setError(null) }} />
          <span>选择本地文件夹<span className="block text-xs text-gray-500 mt-1">在其中新建备份子目录，避免覆盖已有文件。</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="playlist-export-method" checked={method === 'zip'}
            onChange={() => { setMethod('zip'); setOutcome(null); operation.setError(null) }} />
          <span>下载 ZIP<span className="block text-xs text-gray-500 mt-1">解压到本地文件夹后，每个歌单就是一个 TXT；网页无法选择目录时请用此方式。</span></span>
        </label>
      </fieldset>
      <button className="tn-btn tn-btn-primary w-full disabled:opacity-50"
        disabled={operation.busy || list.loading || !!list.error || list.playlists.length === 0} onClick={handleExport}>
        {operation.busy ? '正在导出...' : method === 'directory' ? '选择文件夹并导出全部歌单' : '导出全部歌单为 ZIP'}
      </button>
      {operation.busy && progress && (
        <p className="text-sm text-gray-600 mt-3 break-words" role="status">
          已处理 {progress.completed} / {progress.total} 个歌单：{progress.playlistName}
        </p>
      )}
      {operation.error && <p className="text-sm text-red-600 mt-3" role="alert">{operation.error}</p>}
      {outcome && (
        <div className="border border-gray-200 rounded-xl p-3 mt-4 text-sm" role="status">
          <p className="font-semibold">
            {downloaded ? '已打包' : '已保存'} {outcome.exportedCount} / {outcome.totalCount} 个歌单，共 {outcome.songCount} 条歌曲记录。
          </p>
          {destination && <p className="text-xs text-gray-600 mt-2 break-all">{destination}</p>}
          {downloaded && <p className="text-xs text-gray-600 mt-2">已发起浏览器下载，请确认下载完成后解压；TXT 导入时选择解压后的文件。</p>}
          {outcome.detailsMissingCount > 0 && <p className="text-xs text-amber-700 mt-2">{outcome.detailsMissingCount} 条记录缺少歌曲详情，ID 已保留。</p>}
          {outcome.countDifferences.length > 0 && (
            <div className="text-xs text-amber-700 mt-2">
              <p>以下歌单的统计数与实际可读取 ID 数不同，文件保存本次可读取的歌曲：</p>
              <ul className="list-disc pl-4 mt-1">{outcome.countDifferences.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>
          )}
          {outcome.failures.length > 0 && (
            <div className="text-xs text-red-600 mt-2" role="alert">
              <p>以下歌单未导出成功，可重新导出：</p>
              <ul className="list-disc pl-4 mt-1">{outcome.failures.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      <button className="tn-btn tn-btn-secondary w-full mt-4 disabled:opacity-50" disabled={operation.busy} onClick={onBack}>返回主页</button>
    </div>
  )
}
