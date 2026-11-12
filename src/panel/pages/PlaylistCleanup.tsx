import { useEffect, useRef, useState } from 'react'
import { getCleanupPlaylists, getSongDetailsDirect } from '@/api/netease-direct'
import { executePlaylistCleanup, previewPlaylistCleanup } from '@/services/playlist-cleanup'
import { PlaylistFailures } from '../components/PlaylistFailures'
import type { Playlist, Song } from '@/types'
import type {
  PlaylistCleanupPlan,
  PlaylistCleanupProgress,
  PlaylistCleanupResult,
} from '@/types/playlist-cleanup'

interface Props {
  uid: number
  onBack: () => void
  onBusyChange: (busy: boolean) => void
}

/** 明确区分待清理的 A 和只读的 B，预览经确认后才允许发起移除。 */
export function PlaylistCleanup({ uid, onBack, onBusyChange }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState<number | null>(null)
  const [referenceId, setReferenceId] = useState<number | null>(null)
  const [preview, setPreview] = useState<PlaylistCleanupPlan | null>(null)
  const [songDetails, setSongDetails] = useState<Map<number, Song>>(new Map())
  const [detailsMissing, setDetailsMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<PlaylistCleanupResult | null>(null)
  const [progress, setProgress] = useState<PlaylistCleanupProgress>({ removedCount: 0, totalCount: 0 })
  const busyRef = useRef(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)
    getCleanupPlaylists(uid)
      .then((ownedPlaylists) => {
        if (active) setPlaylists(ownedPlaylists)
      })
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : '获取歌单失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [uid, reload])

  useEffect(() => () => onBusyChange(false), [onBusyChange])

  useEffect(() => {
    if (!executing) return
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [executing])

  /** 更换任意歌单后丢弃旧预览，避免使用另一组 A/B 的移除清单。 */
  const resetPreview = () => {
    setPreview(null)
    setOutcome(null)
    setSongDetails(new Map())
    setDetailsMissing(false)
    setError(null)
    setProgress({ removedCount: 0, totalCount: 0 })
  }

  /** 同步锁定按钮与上层导航，防止重复点击或执行中切换歌单。 */
  const runOperation = async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      await operation()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重新比对')
      setPreview(null)
    } finally {
      busyRef.current = false
      setExecuting(false)
      setBusy(false)
      onBusyChange(false)
    }
  }

  /** 歌曲详情只补充预览名称；详情缺失时保留对应 ID，不改变清理集合。 */
  const handlePreview = () => runOperation(async () => {
    if (!sourceId || !referenceId) return
    resetPreview()
    const plan = await previewPlaylistCleanup(uid, sourceId, referenceId)
    const details = new Map<number, Song>()
    const matchedIds = new Set(plan.removableTrackIds)
    for (let offset = 0; offset < plan.removableTrackIds.length; offset += 200) {
      try {
        const songs = await getSongDetailsDirect(plan.removableTrackIds.slice(offset, offset + 200))
        for (const song of songs) {
          if (matchedIds.has(song.id)) details.set(song.id, song)
        }
      } catch {
        // 名称读取失败不改变待清理的 ID，后续批次继续补充详情。
      }
    }
    setSongDetails(details)
    setDetailsMissing(details.size !== plan.removableTrackIds.length)
    setPreview(plan)
  })

  const handleExecute = () => runOperation(async () => {
    if (!preview || outcome || preview.removableTrackIds.length === 0) return
    setExecuting(true)
    setProgress({ removedCount: 0, totalCount: preview.removableTrackIds.length })
    const result = await executePlaylistCleanup(preview, setProgress)
    setOutcome(result)
  })

  const disabled = busy || loading || !!loadError
  const buttonClass = 'tn-btn disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <div>
      <h3 className="text-base font-semibold text-gray-800 mb-2">歌单对比清理</h3>
      <p className="text-sm text-gray-500 mb-4">
        从 A 移除已存在于 B 的歌曲，仅在 A 中的歌曲保留。
      </p>
      <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-800 mb-4">
        B 始终只读，不添加、移除、覆盖或重排其中的歌曲。
      </div>

      {loading && <p className="text-sm text-gray-500 mb-3" role="status">正在加载本人创建的歌单...</p>}
      {loadError && (
        <div className="text-sm text-red-600 mb-3" role="alert">
          <p>{loadError}</p>
          <button className="underline mt-1" onClick={() => setReload((value) => value + 1)}>重新加载</button>
        </div>
      )}
      {!loading && !loadError && playlists.length === 0 && (
        <p className="text-sm text-gray-500 mb-3">当前账号没有可选择的自建歌单。</p>
      )}

      <label className="block mb-4">
        <span className="block text-sm font-semibold text-red-700 mb-2">A · 待清理歌单</span>
        <select
          aria-label="A 待清理歌单"
          className="w-full border border-gray-300 rounded-lg p-2 text-sm bg-white disabled:opacity-50"
          value={sourceId ?? ''}
          disabled={disabled}
          onChange={(event) => {
            if (busyRef.current) return
            setSourceId(event.target.value ? Number(event.target.value) : null)
            setReferenceId(null)
            resetPreview()
          }}
        >
          <option value="">先选择需要移除重复歌曲的歌单</option>
          {playlists.map((playlist) => (
            <option key={playlist.id} value={playlist.id}>
              {playlist.name} · {playlist.trackCount} 首 · ID {playlist.id}
            </option>
          ))}
        </select>
        <span className="block text-xs text-gray-400 mt-1">只有这个歌单可能发生歌曲移除。</span>
      </label>

      <label className="block mb-4">
        <span className="block text-sm font-semibold text-green-700 mb-2">B · 对照歌单（只读）</span>
        <select
          aria-label="B 只读对照歌单"
          className="w-full border border-gray-300 rounded-lg p-2 text-sm bg-white disabled:opacity-50"
          value={referenceId ?? ''}
          disabled={disabled || !sourceId}
          onChange={(event) => {
            if (busyRef.current) return
            setReferenceId(event.target.value ? Number(event.target.value) : null)
            resetPreview()
          }}
        >
          <option value="">再选择作为归档依据的歌单</option>
          {playlists.filter((playlist) => playlist.id !== sourceId).map((playlist) => (
            <option key={playlist.id} value={playlist.id}>
              {playlist.name} · {playlist.trackCount} 首 · ID {playlist.id}
            </option>
          ))}
        </select>
      </label>

      <button
        className={buttonClass + ' tn-btn-secondary w-full mb-4'}
        disabled={disabled || !sourceId || !referenceId}
        onClick={handlePreview}
      >
        {busy ? (executing ? '清理与核验中...' : '正在读取并比对...') : (preview ? '重新比对当前歌单' : '预览重复歌曲')}
      </button>

      {error && <p className="text-sm text-red-600 mb-4" role="alert">{error}</p>}

      {preview && (
        <div className="border border-gray-200 rounded-xl p-3 mb-4">
          <p className="text-sm font-semibold text-gray-800 break-words">
            A「{preview.source.name}」：本次读取 {preview.source.trackIds.length} 首
          </p>
          <p className="text-sm text-green-700 mt-1 break-words">
            B「{preview.reference.name}」：本次读取 {preview.reference.trackIds.length} 首，仅用于比对
          </p>
          {[preview.source, preview.reference].map((playlist, index) => (
            playlist.reportedTrackCount !== playlist.trackIds.length && (
              <p key={playlist.id} className="text-xs text-amber-700 mt-2">
                {index === 0 ? 'A' : 'B'}「{playlist.name}」的统计总数为 {playlist.reportedTrackCount} 首，
                实际返回 {playlist.trackIds.length} 首。本次只比对已读取的歌曲，未读取到的歌曲不处理。
              </p>
            )
          ))}
          <p className="text-sm text-gray-600 mt-3">
            已读取的共同歌曲 {preview.removableTrackIds.length} 首，本次从 A 读取的歌曲预计保留{' '}
            {preview.source.trackIds.length - preview.removableTrackIds.length} 首。
          </p>
          {detailsMissing && (
            <p className="text-xs text-amber-700 mt-2">部分歌曲未取得名称，已按歌曲 ID 完整列出。</p>
          )}
          {preview.removableTrackIds.length === 0 ? (
            <p className="text-sm text-green-700 mt-3">本次读取的歌曲中没有发现共同歌曲，无需移除。</p>
          ) : (
            <ul className="max-h-60 overflow-y-auto mt-3" aria-label="本次匹配的共同歌曲">
              {preview.removableTrackIds.map((id) => {
                const song = songDetails.get(id)
                return (
                  <li key={id} className="tn-song-item">
                    <span>{song ? song.name + ' - ' + song.artists.map((artist) => artist.name).join(' / ') : '歌曲 ID ' + id}</span>
                    {song && <span className="block text-xs text-gray-400">ID {id}</span>}
                  </li>
                )
              })}
            </ul>
          )}
          {!outcome && preview.removableTrackIds.length > 0 && (
            <button
              className={buttonClass + ' tn-btn-primary w-full mt-4'}
              disabled={busy}
              onClick={handleExecute}
            >
              {executing ? '正在从 A 移除并核验...' : '确认仅从 A 移除 ' + preview.removableTrackIds.length + ' 首'}
            </button>
          )}
        </div>
      )}

      {executing && (
        <p className="text-sm text-gray-600 mb-4" role="status">
          已逐批核验移除 {progress.removedCount} / {progress.totalCount} 首，请勿在其他客户端同时修改这两个歌单。
        </p>
      )}

      {outcome && (
        <div
          className={'rounded-xl border p-3 mb-4 text-sm ' + (outcome.status === 'completed'
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-amber-200 bg-amber-50 text-amber-900')}
          role="status"
        >
          <p className="font-semibold mb-2">{outcome.status === 'completed' ? '清理完成并通过核验' : outcome.status === 'partial' ? '清理结束，部分歌曲已跳过' : '操作已停止，请核对结果'}</p>
          <p className="break-words">{outcome.message}</p>
          <PlaylistFailures failures={outcome.failedTracks} songName={(id) => songDetails.get(id)?.name} />
          <p className="mt-2">本次读取结果中已不再出现的重复歌曲：{outcome.removedCount ?? '待核验'}</p>
          <p>A 当前可读取：{outcome.remainingTrackCount ?? '待核验'} 首</p>
          <p>本次重复歌曲仍留在 A：{outcome.pendingCount ?? '待核验'} 首</p>
          <p>A 的其他已读取歌曲及顺序：{outcome.sourceVerified === null ? '尚未核验' : (outcome.sourceVerified ? '核验一致' : '检测到变化')}</p>
          <p>B 的已读取歌曲及顺序：{outcome.referenceUnchanged === null ? '尚未核验' : (outcome.referenceUnchanged ? '核验一致' : '检测到变化')}</p>
          {outcome.status === 'stopped' && <p className="mt-2">已停止后续移除；请重新比对后再处理剩余歌曲。</p>}
        </div>
      )}

      <button className={buttonClass + ' tn-btn-secondary w-full'} disabled={busy} onClick={onBack}>
        返回主页
      </button>
    </div>
  )
}
