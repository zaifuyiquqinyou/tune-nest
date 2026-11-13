import { useState } from 'react'
import { executePlaylistSort, previewPlaylistSort } from '@/services/playlist-sort'
import { COMBINED_SORT_RULES, PLAYLIST_SORT_LABELS, resolveCombinedSortBasis } from '@/utils/playlist-sort'
import { groupPlaylistTracks } from '@/utils/playlist-group-sort'
import { usePlaylistList, usePlaylistOperation } from '../hooks/use-playlist-tools'
import type {
  PlaylistSortMetric, PlaylistSortOptions, PlaylistSortPlan, PlaylistSortProgress, PlaylistSortResult, PlaylistSortRule,
} from '@/types/playlist-sort'

interface Props {
  uid: number
  onBack: () => void
  onBusyChange: (busy: boolean) => void
}

const buttonClass = 'tn-btn disabled:opacity-50 disabled:cursor-not-allowed'
const fieldClass = 'w-full rounded-lg border border-gray-200 p-2 text-sm bg-white mt-1'

function formatValue(value: number | null, rule: PlaylistSortMetric): string {
  const label = rule === 'added' ? '加入时间' : rule === 'popularity' ? '平台热度'
    : rule === 'plays-all' ? '累计听歌次数' : '最近一周听歌次数'
  if (value === null) return label + '：未知'
  if (rule === 'added') return label + '：' + new Date(value).toLocaleString('zh-CN', { hour12: false })
  return label + '：' + (rule === 'popularity' ? value + ' / 100' : value.toLocaleString('zh-CN') + ' 次')
}

/** 先只读预览完整顺序，再显式确认写回；任何条件改变或执行结束都使旧预览失效。 */
export function PlaylistSort({ uid, onBack, onBusyChange }: Props) {
  const list = usePlaylistList(uid)
  const operation = usePlaylistOperation(onBusyChange)
  const [playlistId, setPlaylistId] = useState<number | null>(null)
  const [options, setOptions] = useState<PlaylistSortOptions>({ rule: 'added', direction: 'desc', missing: 'last' })
  const [preview, setPreview] = useState<PlaylistSortPlan | null>(null)
  const [outcome, setOutcome] = useState<PlaylistSortResult | null>(null)
  const [progress, setProgress] = useState<PlaylistSortProgress | null>(null)
  const [visibleCount, setVisibleCount] = useState(50)
  const [executing, setExecuting] = useState(false)
  const owned = list.playlists.filter((playlist) => playlist.creator.userId === uid)
  const disabled = operation.busy || list.loading || !!list.error
  const personalCounts = options.rule === 'plays-all' || options.rule === 'plays-week'
  const combined = options.rule === 'combined'
  const classification = options.rule === 'playlist-groups'
  const availableReferences = list.playlists.filter((playlist) => playlist.id !== playlistId)
  const referenceIds = options.referencePlaylistIds || availableReferences.map((playlist) => playlist.id)
  const referenceRank = new Map(referenceIds.map((id, index) => [id, index]))
  const orderedReferences = [...availableReferences].sort((a, b) =>
    (referenceRank.get(a.id) ?? referenceIds.length) - (referenceRank.get(b.id) ?? referenceIds.length))
  const byId = new Map(preview?.tracks.map((track) => [track.songId, track]))
  const placements = preview?.options.rule === 'playlist-groups'
    ? groupPlaylistTracks(preview.tracks, preview.options.referencePlaylistIds || []) : []
  const placementById = new Map(placements.map((item) => [item.songId, item]))
  const referenceNames = new Map(preview?.grouping?.references.map((item) => [item.id, item.name]))
  const combinedBasis = new Map(preview?.options.rule === 'combined'
    ? preview.tracks.map((track) => [track.songId, resolveCombinedSortBasis(track.metrics)]) : [])
  const combinedGroups = [...COMBINED_SORT_RULES, null].map((rule, index) => ({
    label: rule ? PLAYLIST_SORT_LABELS[rule] : '无可用指标，保持原相对顺序',
    count: [...combinedBasis.values()].filter((basis) => basis.groupIndex === index).length,
  }))

  const resetPreview = () => {
    setPreview(null)
    setOutcome(null)
    setProgress(null)
    setVisibleCount(50)
    operation.setError(null)
  }

  const changeOptions = (patch: Partial<PlaylistSortOptions>) => {
    if (operation.busyRef.current) return
    setOptions({ ...options, ...patch, ...(patch.rule === 'combined' || patch.rule === 'playlist-groups'
      ? { direction: 'desc' as const, missing: 'last' as const } : {}) })
    resetPreview()
  }

  const moveReference = (index: number, delta: number) => {
    if (index < 0 || index + delta < 0 || index + delta >= referenceIds.length) return
    const ids = [...referenceIds]
    ;[ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]
    changeOptions({ referencePlaylistIds: ids })
  }

  const handlePreview = () => operation.run(async () => {
    if (!playlistId) throw new Error('请先选择待排序的本人歌单')
    resetPreview()
    setPreview(await previewPlaylistSort(uid, playlistId,
      classification ? { ...options, referencePlaylistIds: referenceIds } : options, setProgress))
    setProgress(null)
  })

  const handleExecute = () => operation.run(async () => {
    if (!preview) return
    setExecuting(true)
    setProgress(null)
    setOutcome(null)
    try {
      setOutcome(await executePlaylistSort(preview, setProgress))
    } finally {
      setPreview(null)
      setProgress(null)
      setExecuting(false)
    }
  }, true)

  return (
    <div>
      <h3 className="text-lg font-bold text-gray-800 mb-2">歌单内歌曲排序</h3>
      <p className="text-xs text-gray-500 mb-4">只重排所选歌单，保留全部歌曲。先核对预览，再确认写入网易云。</p>
      {list.loading && <p className="text-sm text-gray-500 mb-3">正在读取歌单...</p>}
      {list.error && <p className="text-sm text-red-600 mb-3" role="alert">{list.error}</p>}
      <button className={buttonClass + ' tn-btn-secondary w-full mb-3'} disabled={operation.busy || list.loading}
        onClick={() => { if (!operation.busyRef.current) { resetPreview(); list.reload() } }}>重新读取歌单</button>
      <label className="block text-sm font-semibold mb-3">待排序歌单
        <select className={fieldClass} value={playlistId ?? ''} disabled={disabled}
          onChange={(event) => {
            if (operation.busyRef.current) return
            setPlaylistId(event.target.value ? Number(event.target.value) : null)
            setOptions({ ...options, referencePlaylistIds: undefined })
            resetPreview()
          }}>
          <option value="">请选择本人创建的歌单</option>
          {owned.map((playlist) => <option key={playlist.id} value={playlist.id}>
            {playlist.name} · {playlist.trackCount} 首 · ID {playlist.id}
          </option>)}
        </select>
      </label>
      <label className="block text-sm font-semibold mb-3">排序依据
        <select className={fieldClass} value={options.rule} disabled={disabled}
          onChange={(event) => changeOptions({ rule: event.target.value as PlaylistSortRule })}>
          {Object.entries(PLAYLIST_SORT_LABELS).map(([rule, label]) => <option key={rule} value={rule}>{label}</option>)}
          <option value="plays-month" disabled>本人最近一个月次数（暂不可用）</option>
        </select>
      </label>
      {options.rule === 'added' && <p className="text-xs text-gray-500 mb-3">
        使用平台记录的加入时间，手工调整过的现有顺序不会被当作加入顺序。移除后重新加入，平台可能记录为再次加入时间。
      </p>}
      {options.rule === 'popularity' && <p className="text-xs text-gray-500 mb-3">
        使用平台歌曲热度值（0–100），不等同于全网播放次数。多首歌曲同分时保留原相对顺序。
      </p>}
      {classification && <div className="text-xs text-gray-600 mb-3 space-y-2">
        <p>每轮取原顺序中第一首未排定的歌曲，按它的分类歌单优先级接入同类歌曲；同一分类内保留原相对顺序。
          已排定的歌曲不再移动或展开，没有分类标记的歌曲也会保留。</p>
        <p>参考歌单仅用于分类，当前待排序歌单自动排除。默认使用账号中的其他自建及收藏歌单，优先级从上到下；
          可取消“我喜欢”“未分类”等汇总歌单，避免把不同类型合成一大段。</p>
        <p className="font-semibold">分类歌单及优先级 · 已选 {referenceIds.length} 个</p>
        <div className="flex gap-2">
          <button className={buttonClass + ' tn-btn-secondary'} disabled={disabled}
            onClick={() => changeOptions({ referencePlaylistIds: undefined })}>全选并恢复列表顺序</button>
          <button className={buttonClass + ' tn-btn-secondary'} disabled={disabled}
            onClick={() => changeOptions({ referencePlaylistIds: [] })}>全不选</button>
        </div>
        <ol className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-2">
          {orderedReferences.map((playlist) => {
            const rank = referenceRank.get(playlist.id)
            return <li key={playlist.id} className="flex gap-2 items-center">
              <label className="flex gap-2 min-w-0 flex-1 items-start">
                <input type="checkbox" checked={rank !== undefined} disabled={disabled}
                  onChange={(event) => changeOptions({ referencePlaylistIds: event.target.checked
                    ? [...referenceIds, playlist.id] : referenceIds.filter((id) => id !== playlist.id) })} />
                <span className="break-words">{rank !== undefined ? (rank + 1) + '. ' : ''}{playlist.name}
                  <span className="text-gray-400"> · ID {playlist.id}</span></span>
              </label>
              <button className={buttonClass + ' tn-btn-secondary'} disabled={disabled || rank === undefined || rank === 0}
                aria-label={'上移分类 ' + playlist.name} onClick={() => moveReference(rank ?? -1, -1)}>上移</button>
              <button className={buttonClass + ' tn-btn-secondary'} disabled={disabled || rank === undefined || rank === referenceIds.length - 1}
                aria-label={'下移分类 ' + playlist.name} onClick={() => moveReference(rank ?? -1, 1)}>下移</button>
            </li>
          })}
        </ol>
      </div>}
      {combined && <div className="text-xs text-gray-600 mb-3 space-y-1">
        <p className="font-semibold">按以下优先级分成五部分：</p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>周次数大于 0：次数从高到低。</li>
          <li>周次数为 0 或未知、累计次数大于 0：累计次数从高到低。</li>
          <li>前两项为 0 或未知、热度大于 0：热度从高到低。</li>
          <li>前三项为 0 或未知、加入时间已知：最新加入的在前。</li>
          <li>没有可用指标：放在最后，保持原相对顺序。</li>
        </ol>
        <p>0 次、热度 0 和未知均继续使用下一指标。原始数据仍如实显示，同组数值相同则保持原相对顺序。</p>
      </div>}
      {(personalCounts || combined) && <p className="text-xs text-amber-700 mb-3">
        使用当前登录用户的听歌排行次数，平台返回的歌曲数量有限。未进入返回排行的歌曲次数未知，不代表 0 次。暂不支持完整的最近一个月统计。
      </p>}
      {!combined && !classification && <label className="block text-sm font-semibold mb-3">排序方向
        <select className={fieldClass} value={options.direction} disabled={disabled}
          onChange={(event) => changeOptions({ direction: event.target.value as PlaylistSortOptions['direction'] })}>
          <option value="desc">{options.rule === 'added' ? '最近加入的在前' : '数值从高到低'}</option>
          <option value="asc">{options.rule === 'added' ? '最早加入的在前' : '数值从低到高'}</option>
        </select>
      </label>}
      {!combined && !classification && <label className="block text-sm font-semibold mb-3">缺少排序数据的歌曲
        <select className={fieldClass} value={options.missing} disabled={disabled}
          onChange={(event) => changeOptions({ missing: event.target.value as PlaylistSortOptions['missing'] })}>
          <option value="last">放到末尾，保留它们的原相对顺序</option>
          <option value="keep">固定原位置，仅重排有数据的歌曲</option>
        </select>
      </label>}
      <button className={buttonClass + ' tn-btn-primary w-full'} disabled={disabled || !playlistId}
        onClick={handlePreview}>读取数据并预览排序</button>
      {operation.busy && progress && <p className="text-sm text-gray-600 mt-3" role="status">
        {({
          reading: '读取完整歌单', details: '读取歌曲详情', records: '读取本人听歌排行',
          categories: '读取参考歌单并标记分类',
          checking: '检查账号和当前歌单', writing: '提交完整歌曲顺序', verifying: '回读核验顺序及成员',
        })[progress.phase]}{['details', 'records', 'categories'].includes(progress.phase) && '：' + progress.completed + ' / ' + progress.total}
      </p>}
      {operation.error && <p className="text-sm text-red-600 mt-3" role="alert">{operation.error}</p>}
      {preview && (
        <div className="border border-gray-200 rounded-xl p-3 mt-4">
          <p className="text-sm font-semibold break-words">「{preview.playlist.name}」· ID {preview.playlist.id}</p>
          <p className="text-xs text-gray-600 mt-2">共 {preview.tracks.length} 首；
            {preview.options.rule === 'playlist-groups' ? '有分类标记' : '有排序数据'} {preview.knownCount} 首，
            {preview.options.rule === 'playlist-groups' ? '未匹配到分类标记' : preview.options.rule === 'combined' ? '无可用指标' : '未知'} {preview.missingCount} 首。</p>
          {preview.playlist.reportedTrackCount !== preview.tracks.length && <p className="text-xs text-amber-700 mt-2">
            已兼容云盘数量差异：平台统计 {preview.playlist.reportedTrackCount} 首，云盘统计 {preview.playlist.cloudTrackCount} 首；
            本次保留并排序全部 {preview.tracks.length} 首歌曲。
          </p>}
          <p className="text-xs text-gray-600 mt-1">依据：{PLAYLIST_SORT_LABELS[preview.options.rule]}；
            {preview.options.rule === 'playlist-groups' ? '分类优先级优先，同类按原相对顺序；未标记歌曲按轮次保留' : <>
            {preview.options.direction === 'desc' ? '降序' : '升序'}；
            {preview.options.rule === 'combined' ? '无可用指标放末尾' : preview.options.missing === 'last' ? '未知放末尾' : '未知固定原位置'}。
            </>}
          </p>
          {preview.grouping && <div className="text-xs text-gray-600 mt-2 space-y-1">
            <p className="font-semibold">已读取 {preview.grouping.references.length} 个分类歌单；共 {placements.length > 0 ? placements[placements.length - 1].groupIndex + 1 : 0} 段。</p>
            <details><summary className="cursor-pointer">查看本次分类优先级与匹配数量</summary>
              {preview.grouping.references.map((reference, index) => <p key={reference.id} className="mt-1">
                {index + 1}. {reference.name} · ID {reference.id} · 匹配 {reference.matchedTrackIds.length} 首
              </p>)}
            </details>
            {preview.grouping.failures.length > 0 && <div className="text-amber-700" role="alert">
              <p>以下 {preview.grouping.failures.length} 个参考歌单读取失败，已跳过；本次仅按成功读取的分类排序，所有歌曲仍保留。</p>
              {preview.grouping.failures.map((failure) => <p key={failure.id}>{failure.name} · ID {failure.id}：{failure.message}</p>)}
            </div>}
          </div>}
          {preview.options.rule === 'combined' && <div className="text-xs text-gray-600 mt-2 space-y-1">
            <p className="font-semibold">分组结果（每首歌只进入第一个指标大于 0 的组，否则保持原相对顺序放末尾）</p>
            {combinedGroups.map((group, index) => <p key={index}>第 {index + 1} 部分 · {group.label}：{group.count} 首</p>)}
            {preview.combinedPlayCountSummaries && <p className="mt-2">
              周排行返回 {preview.combinedPlayCountSummaries.week.returnedCount} 首，匹配当前歌单 {preview.combinedPlayCountSummaries.week.matchedCount} 首；
              累计排行返回 {preview.combinedPlayCountSummaries.all.returnedCount} 首，匹配 {preview.combinedPlayCountSummaries.all.matchedCount} 首。
            </p>}
          </div>}
          {preview.playCountSummary && <div className="text-xs text-gray-600 mt-2 space-y-1">
            <p>本次{preview.options.rule === 'plays-all' ? '累计' : '最近一周'}听歌排行返回 {preview.playCountSummary.returnedCount} 首，
              其中 {preview.playCountSummary.usableCount} 首有有效次数；与当前歌单匹配 {preview.playCountSummary.matchedCount} 首，
              可按次数排序 {preview.knownCount} 首。</p>
            {preview.playCountSummary.returnedCount === 0
              ? <p className="text-amber-700">平台本次返回的听歌排行为空，未获取到任何歌曲的次数，不能据此认定从未播放。</p>
              : preview.playCountSummary.matchedCount === 0
              ? <p className="text-amber-700">当前歌单的歌曲均未出现在本次返回的排行中；排行不是完整播放历史，所以无法比较它们的次数。</p>
              : preview.knownCount === 0
              ? <p className="text-amber-700">当前歌单有歌曲上榜，但均缺少有效的听歌次数。不能用排行分数代替次数，具体原因见各首歌曲。</p>
              : null}
          </div>}
          {preview.missingCount > 0 && preview.options.rule !== 'playlist-groups' && <p className="text-xs text-amber-700 mt-2">
            {preview.options.rule === 'combined' ? '0 或未知均使用下一指标，无可用指标的歌曲保持原相对顺序，所有歌曲仍保留在当前歌单。'
              : '未知数据不按 0 计算，所有歌曲仍保留在当前歌单。'}{personalCounts && '这只能重排平台返回了可用次数的歌曲，不能还原完整播放历史。'}
          </p>}
          <p className="text-sm font-semibold mt-3">预览新顺序 · {preview.changedCount} 首的位置将变化</p>
          {preview.knownCount === 0 && <p className="text-xs text-amber-700 mt-2">没有可用的排序数据，当前顺序保留，不执行写入。</p>}
          {preview.knownCount > 0 && preview.changedCount === 0 &&
            <p className="text-xs text-green-700 mt-2">当前顺序已经符合所选规则，无需写入；
              {preview.options.rule === 'playlist-groups' ? '已保留各分类内的原相对顺序。' : '相同数值保持原相对顺序。'}</p>}
          <ol className="space-y-2 mt-3">
            {preview.orderedTrackIds.slice(0, visibleCount).map((songId, index) => {
              const track = byId.get(songId)!
              const basis = combinedBasis.get(songId)
              const placement = placementById.get(songId)
              const metricRule = preview.options.rule === 'playlist-groups' ? null : preview.options.rule === 'combined' ? basis!.rule : preview.options.rule
              const groupStarts = basis && (index === 0 || combinedBasis.get(preview.orderedTrackIds[index - 1])?.groupIndex !== basis.groupIndex)
              return <li key={songId} className="border-t border-gray-100 pt-2" data-song-id={songId}>
                {placement?.anchorId === songId && <p className="text-xs font-semibold text-gray-700 bg-gray-50 rounded p-2 mb-2">
                  第 {placement.groupIndex + 1} 段 · 起始歌曲 {track.name || songId}
                </p>}
                {groupStarts && <p className="text-xs font-semibold text-gray-700 bg-gray-50 rounded p-2 mb-2">
                  第 {basis.groupIndex + 1} 部分 · {combinedGroups[basis.groupIndex].label} · {combinedGroups[basis.groupIndex].count} 首
                </p>}
                <div className="flex gap-2 text-xs">
                  <span className="font-semibold text-gray-500 shrink-0">{index + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold break-words">{track.name || '歌曲详情不可用'} <span className="font-normal text-gray-400">ID {songId}</span></p>
                    {track.artists.length > 0 && <p className="text-gray-500 break-words mt-0.5">{track.artists.join(' / ')}</p>}
                    {placement ? <div className="mt-1 text-blue-700">
                      <p className="font-semibold">{placement.playlistId === null ? '本段起始歌曲，按原顺序选取' :
                        '跟随「' + (byId.get(placement.anchorId)?.name || placement.anchorId) + '」· 共同分类：' +
                        referenceNames.get(placement.playlistId) + '（ID ' + placement.playlistId + '）'}</p>
                      <p className="text-gray-500 mt-1">分类标记：{track.playlistTags!.length > 0
                        ? track.playlistTags!.map((id) => (referenceNames.get(id) || '') + '（ID ' + id + '）').join(' → ')
                        : '未匹配到已读取的分类歌单，歌曲保留'}</p>
                    </div> : <p className={'mt-1 font-semibold ' + (track.value === null ? 'text-amber-700' : 'text-blue-700')}>
                      {basis ? '第 ' + (basis.groupIndex + 1) + ' 部分 · ' : '排序依据 · '}
                      {metricRule ? formatValue(track.value, metricRule) : '无可用指标，保持原相对顺序'}</p>}
                    {basis && track.metrics && <details className="text-gray-500 mt-1">
                      <summary className="cursor-pointer">查看四项排序数据</summary>
                      {COMBINED_SORT_RULES.map((rule) => <p key={rule} className="mt-1">{formatValue(track.metrics![rule], rule)}</p>)}
                    </details>}
                    {track.value === null && track.missingReason && <p className="text-amber-700 mt-1">
                      {track.missingReason}{preview.options.rule === 'combined' ? '。' : '；不按 0 计算。'}</p>}
                    <p className="text-gray-500 mt-1">原第 {track.originalPosition} 首
                      {track.originalPosition === index + 1 ? '（位置不变）' : ' → 第 ' + (index + 1) + ' 首'}</p>
                  </div>
                </div>
              </li>
            })}
          </ol>
          {visibleCount < preview.tracks.length && <button className={buttonClass + ' tn-btn-secondary w-full mt-3'}
            disabled={operation.busy} onClick={() => setVisibleCount((count) => count + 50)}>
            继续查看（已显示 {Math.min(visibleCount, preview.tracks.length)} / {preview.tracks.length}）
          </button>}
          <p className="text-xs text-amber-700 mt-3">按本次读取的数据排序。执行期间请勿在其他页面或客户端修改此歌单；失败后会停止并回读，继续操作前需重新预览。</p>
          <button className={buttonClass + ' tn-btn-primary w-full mt-3'} disabled={operation.busy || preview.changedCount === 0}
            onClick={handleExecute}>确认将此顺序写入歌单</button>
        </div>
      )}
      {executing && !progress && <p className="text-sm text-gray-500 mt-3" role="status">正在核对当前歌单...</p>}
      {outcome && (
        <div className={'rounded-xl p-3 mt-4 text-sm ' +
          (outcome.status === 'completed' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800')} role="status">
          <p className="font-semibold">{outcome.message}</p>
          <p className="text-xs mt-2">当前读取 {outcome.currentTrackCount ?? '未知'} 首；
            歌曲成员{outcome.membershipPreserved === true ? '已核验全部保留' : outcome.membershipPreserved === false ? '检测到变化' : '未知'}；
            排序{outcome.orderVerified === true ? '符合预览' : outcome.orderVerified === false ? '未符合预览' : '未知'}。
          </p>
          <p className="text-xs mt-2">若网易云页面仍显示旧顺序，请刷新页面查看。</p>
        </div>
      )}
      <button className={buttonClass + ' tn-btn-secondary w-full mt-4'} disabled={operation.busy} onClick={onBack}>返回主页</button>
    </div>
  )
}
