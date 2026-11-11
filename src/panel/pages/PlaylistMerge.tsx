import { useState } from 'react'
import { executePlaylistMerge, previewPlaylistMerge } from '@/services/playlist-merge'
import { parsePlaylistText } from '@/utils/playlist-text'
import { usePlaylistList, usePlaylistOperation } from '../hooks/use-playlist-tools'
import type {
  PlaylistMergePlan,
  PlaylistMergeProgress,
  PlaylistMergeResult,
  PlaylistTextDocument,
} from '@/types/playlist-tools'

interface Props {
  uid: number
  onBack: () => void
  onBusyChange: (busy: boolean) => void
}

/** 单个与多个来源共用预览和执行流程，TXT 导入默认只向目标复制。 */
export function PlaylistMerge({ uid, onBack, onBusyChange }: Props) {
  const list = usePlaylistList(uid)
  const operation = usePlaylistOperation(onBusyChange)
  const [mode, setMode] = useState<'online' | 'files'>('online')
  const [sourceIds, setSourceIds] = useState<number[]>([])
  const [documents, setDocuments] = useState<PlaylistTextDocument[]>([])
  const [targetId, setTargetId] = useState<number | null>(null)
  const [move, setMove] = useState(true)
  const [preview, setPreview] = useState<PlaylistMergePlan | null>(null)
  const [outcome, setOutcome] = useState<PlaylistMergeResult | null>(null)
  const [progress, setProgress] = useState<PlaylistMergeProgress | null>(null)
  const [executing, setExecuting] = useState(false)
  const owned = list.playlists.filter((playlist) => playlist.creator.userId === uid)
  const selectedIds = mode === 'online' ? sourceIds : documents.map((document) => document.playlistId)
  const disabled = operation.busy || list.loading || !!list.error
  const buttonClass = 'tn-btn disabled:opacity-50 disabled:cursor-not-allowed'

  const resetPreview = () => {
    setPreview(null)
    setOutcome(null)
    setProgress(null)
    operation.setError(null)
  }

  const changeMode = (nextMode: 'online' | 'files') => {
    if (operation.busyRef.current) return
    setMode(nextMode)
    setSourceIds([])
    setDocuments([])
    setTargetId(null)
    setMove(nextMode === 'online')
    resetPreview()
  }

  /** 任一文件失败则拒绝整次选择，不把未导入的文件静默跳过。 */
  const importFiles = (files: File[]) => operation.run(async () => {
    resetPreview()
    setDocuments([])
    setTargetId(null)
    if (files.length === 0) return
    if (files.some((file) => file.size > 20 * 1024 * 1024) ||
        files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
      throw new Error('单个 TXT 请控制在 20 MB 内，一次导入总量请控制在 100 MB 内')
    }
    const parsed: PlaylistTextDocument[] = []
    for (const file of files) {
      try {
        const document = parsePlaylistText(await file.text())
        if (parsed.some((existing) => existing.playlistId === document.playlistId)) {
          throw new Error('同一个来源歌单只能导入一份备份，请选择需要的版本')
        }
        parsed.push(document)
      } catch (err) {
        throw new Error(file.name + '：' + (err instanceof Error ? err.message : '文件读取失败'))
      }
    }
    setDocuments(parsed)
  })

  const handlePreview = () => operation.run(async () => {
    resetPreview()
    if (!targetId) return
    const input = mode === 'online'
      ? { kind: 'online' as const, playlistIds: sourceIds }
      : { kind: 'files' as const, documents }
    setPreview(await previewPlaylistMerge(uid, targetId, input, move))
  })

  const handleExecute = () => operation.run(async () => {
    if (!preview) return
    const plan = preview
    // 执行后必须重新预览，不能再次点击过期计划。
    setPreview(null)
    setOutcome(null)
    setExecuting(true)
    setProgress({ phase: 'adding', completed: 0, total: plan.missingTargetTrackIds.length })
    try {
      setOutcome(await executePlaylistMerge(plan, setProgress))
    } finally {
      setExecuting(false)
    }
  }, true)

  const removalCount = preview?.sources.reduce((sum, source) => sum + source.removalTrackIds.length, 0) || 0

  return (
    <div>
      <h3 className="text-base font-semibold text-gray-800 mb-2">歌单合并 / 移动</h3>
      <p className="text-sm text-gray-500 mb-3">勾选一个或多个来源，再选择目标歌单。相同歌曲按 ID 去重，目标已有歌曲保留。</p>
      <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-800 mb-4">
        先将所有候选歌曲补齐到目标并核验，再按需从来源移除。保留来源歌单本身；目标只添加歌曲。
      </div>
      {list.loading && <p className="text-sm text-gray-500 mb-3" role="status">正在加载歌单...</p>}
      {list.error && (
        <div className="text-sm text-red-600 mb-3" role="alert">
          <p>{list.error}</p>
          <button className="underline mt-1" disabled={operation.busy}
            onClick={() => { resetPreview(); list.reload() }}>重新加载</button>
        </div>
      )}
      <div className="flex gap-2 mb-4">
        <button className={buttonClass + (mode === 'online' ? ' tn-btn-primary' : ' tn-btn-secondary')}
          disabled={operation.busy} onClick={() => changeMode('online')}>选择在线歌单</button>
        <button className={buttonClass + (mode === 'files' ? ' tn-btn-primary' : ' tn-btn-secondary')}
          disabled={operation.busy} onClick={() => changeMode('files')}>导入 TXT 备份</button>
      </div>
      <p className="text-sm font-semibold text-gray-800 mb-2">来源歌单 · 可多选</p>
      {mode === 'online' ? (
        <div className="max-h-52 overflow-y-auto border border-gray-200 rounded-lg mb-4">
          {!list.loading && !list.error && owned.length === 0 && <p className="text-sm text-gray-500 p-3">没有可选择的自建歌单。</p>}
          {owned.map((playlist) => (
            <label key={playlist.id} className="flex items-start gap-2 p-2 border-b border-gray-100 last:border-0 text-sm">
              <input type="checkbox" className="mt-1" checked={sourceIds.includes(playlist.id)} disabled={disabled}
                onChange={(event) => {
                  if (operation.busyRef.current) return
                  setSourceIds(event.target.checked ? [...sourceIds, playlist.id] : sourceIds.filter((id) => id !== playlist.id))
                  if (targetId === playlist.id) setTargetId(null)
                  resetPreview()
                }} />
              <span className="min-w-0 break-words">{playlist.name}
                <span className="block text-xs text-gray-400">列表统计 {playlist.trackCount} 首 · ID {playlist.id}</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg p-3 mb-4">
          <input aria-label="选择歌单 TXT 备份" type="file" accept=".txt,text/plain" multiple disabled={operation.busy}
            className="text-xs w-full" onChange={(event) => {
              const files = Array.from(event.target.files || [])
              event.target.value = ''
              void importFiles(files)
            }} />
          <p className="text-xs text-gray-500 mt-2">选择本插件导出的一个或多个 TXT，ZIP 请先解压。</p>
          {documents.map((document) => (
            <p key={document.playlistId} className="text-xs text-gray-700 mt-2 break-words">
              {document.playlistName} · {document.songs.length} 首 · ID {document.playlistId}
              <span className="block text-gray-400">导出时间：{new Date(document.exportedAt).toLocaleString()}</span>
            </p>
          ))}
        </div>
      )}
      <label className="block mb-4">
        <span className="block text-sm font-semibold text-green-700 mb-2">目标歌单 · 接收合并歌曲</span>
        <select aria-label="合并目标歌单" className="w-full border border-gray-300 rounded-lg p-2 text-sm bg-white disabled:opacity-50"
          value={targetId ?? ''} disabled={disabled || selectedIds.length === 0}
          onChange={(event) => {
            if (operation.busyRef.current) return
            setTargetId(event.target.value ? Number(event.target.value) : null)
            resetPreview()
          }}>
          <option value="">再选择一个不同的自建歌单</option>
          {owned.filter((playlist) => !selectedIds.includes(playlist.id)).map((playlist) => (
            <option key={playlist.id} value={playlist.id}>{playlist.name} · ID {playlist.id}</option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm mb-2">
        <input type="checkbox" checked={move} disabled={operation.busy} className="mt-1"
          onChange={(event) => {
            if (operation.busyRef.current) return
            setMove(event.target.checked)
            resetPreview()
          }} />
        <span>移动：目标补齐并核验后，从来源移除对应歌曲<span className="block text-xs text-gray-500 mt-1">不勾选时仅复制到目标，来源歌曲保留。</span></span>
      </label>
      {mode === 'files' && (
        <p className="text-xs text-amber-700 mb-3">TXT 默认仅复制。勾选移动时需核对本人在线来源，只移除备份中仍存在于来源的歌曲，备份后新增的歌曲保留。</p>
      )}
      <button className={buttonClass + ' tn-btn-secondary w-full mt-3'}
        disabled={disabled || !targetId || selectedIds.length === 0} onClick={handlePreview}>
        {operation.busy ? executing ? '正在执行并核验...' : '正在读取...' : '预览本次合并'}
      </button>
      {operation.error && <p className="text-sm text-red-600 mt-3" role="alert">{operation.error}</p>}
      {preview && (
        <div className="border border-gray-200 rounded-xl p-3 mt-4">
          <p className="text-sm font-semibold text-green-700 break-words">目标「{preview.target.name}」· ID {preview.target.id}</p>
          <p className="text-xs text-gray-600 mt-1">当前读取 {preview.target.trackIds.length} 首，需新增 {preview.missingTargetTrackIds.length} 首，原有歌曲保留。</p>
          {preview.target.reportedTrackCount !== preview.target.trackIds.length && (
            <p className="text-xs text-amber-700 mt-2">目标统计 {preview.target.reportedTrackCount} 首，实际返回 {preview.target.trackIds.length} 首，本次只按可读取 ID 核验。</p>
          )}
          <ul className="space-y-2 mt-3 text-xs">
            {preview.sources.map((source) => (
              <li key={source.playlistId} className="border-t border-gray-100 pt-2 break-words">
                <span className="font-semibold">来源「{source.name}」· ID {source.playlistId}</span>
                <p>候选 {source.trackIds.length} 首；{preview.move ? '核验后从来源移除 ' + source.removalTrackIds.length + ' 首' : '仅复制，来源保留'}。</p>
                {source.snapshot && <p className="text-gray-500">在线来源读取 {source.snapshot.trackIds.length} 首，本次预计保留 {source.snapshot.trackIds.length - source.removalTrackIds.length} 首。</p>}
                {source.reportedTrackCount !== source.trackIds.length && (
                  <p className="text-amber-700">来源统计 {source.reportedTrackCount} 首，本次候选 {source.trackIds.length} 首，未读取到的歌曲不处理。</p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-gray-700 mt-3">共 {preview.sources.length} 个来源，合并去重后 {preview.incomingTrackIds.length} 首；{preview.move ? '从来源合计移除 ' + removalCount + ' 条记录' : '来源不移除'}。</p>
          <p className="text-xs text-amber-700 mt-2">执行期间请勿在其他页面或客户端修改这些歌单。遇到失败会停止，可重新预览后继续。</p>
          <button className={buttonClass + ' tn-btn-primary w-full mt-3'} disabled={operation.busy} onClick={handleExecute}>
            确认{preview.move ? '移动' : '复制'}到「{preview.target.name}」
          </button>
        </div>
      )}
      {executing && progress && (
        <p className="text-sm text-gray-600 mt-3" role="status">
          {progress.phase === 'adding' ? '正在补齐目标：' + progress.completed + ' / ' + progress.total + ' 首'
            : progress.phase === 'removing' ? '已核验来源移除：' + progress.completed + ' / ' + progress.total + ' 条 · ' + progress.sourceName
              : '正在重新读取并核验最终状态...'}
        </p>
      )}
      {outcome && (
        <div className={'rounded-xl p-3 mt-4 text-sm ' + (outcome.status === 'completed' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800')} role="status">
          <p className="font-semibold">{outcome.message}</p>
          <p className="text-xs mt-2">目标已补入 {outcome.addedCount ?? '未知'} 首；候选中仍缺 {outcome.missingTargetCount ?? '未知'} 首。</p>
          <p className="text-xs mt-1">目标原有歌曲及相对顺序：{outcome.targetPreserved === true ? '已核验保留' : outcome.targetPreserved === false ? '检测到变化' : '未能核验'}。</p>
          <ul className="text-xs mt-2 space-y-1">
            {outcome.sources.map((source) => (
              <li key={source.playlistId} className="break-words">
                「{source.name}」：已移除 {source.removedCount ?? '未知'} 首，待移除 {source.pendingCount ?? '未知'} 首
                {source.remainingCount !== null && '，当前读取剩余 ' + source.remainingCount + ' 首'}
                {source.verified === false && '；检测到额外变化'}
                {source.verified === null && move && '；未能核验在线来源'}。
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className={buttonClass + ' tn-btn-secondary w-full mt-4'} disabled={operation.busy} onClick={onBack}>返回主页</button>
    </div>
  )
}
