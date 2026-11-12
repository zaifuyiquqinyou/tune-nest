import { useEffect, useRef, useState } from 'react'
import { defaultOrganizeExclusions } from '@/classifier/playlist-organizer'
import { validateOrganizeAIOutput } from '@/classifier/organize-ai'
import { executePlaylistOrganize, previewPlaylistOrganize } from '@/services/playlist-organize'
import { loadOrganizePreferences, saveOrganizePreferences } from '@/utils/organize-preferences'
import { loadOrganizeDraft, restoreOrganizeChoices, saveOrganizeDraft } from '@/utils/organize-draft'
import { PlaylistFailures } from '../components/PlaylistFailures'
import { usePlaylistList, usePlaylistOperation } from '../hooks/use-playlist-tools'
import type { ExtensionResponse } from '@/types'
import type {
  OrganizeAssignment, OrganizeCandidate, OrganizePreferences, OrganizeProgress, OrganizeRule,
  PlaylistOrganizePreview, PlaylistOrganizeResult,
} from '@/types/playlist-organize'

interface Props {
  uid: number
  onBack: () => void
  onBusyChange: (busy: boolean) => void
}

const buttonClass = 'tn-btn disabled:opacity-50 disabled:cursor-not-allowed'
const fieldClass = 'w-full rounded-lg border border-gray-200 p-2 text-sm bg-white'
const ruleNames = { artist: '歌手完全匹配', album: '专辑完全匹配', text: '歌名或专辑包含关键词' }

/** 预览保留明确去向的多选，并默认选择依据充分且领先的推断首选；AI 建议仍需手工确认。 */
export function PlaylistOrganize({ uid, onBack, onBusyChange }: Props) {
  const list = usePlaylistList(uid)
  const operation = usePlaylistOperation(onBusyChange)
  const initializedUser = useRef<number | null>(null)
  const selectionSource = useRef<number | null>(null)
  const [keepChoices, setKeepChoices] = useState(true)
  const [preferences, setPreferences] = useState<OrganizePreferences | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<PlaylistOrganizePreview | null>(null)
  const [selected, setSelected] = useState<Record<number, number[]>>({})
  const [aiCandidates, setAICandidates] = useState<Record<number, OrganizeCandidate[]>>({})
  const [outcome, setOutcome] = useState<PlaylistOrganizeResult | null>(null)
  const [progress, setProgress] = useState<OrganizeProgress | null>(null)
  const [move, setMove] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [filter, setFilter] = useState<'all' | 'pending' | 'selected'>('all')
  const [ruleKind, setRuleKind] = useState<OrganizeRule['kind']>('artist')
  const [ruleValue, setRuleValue] = useState('')
  const [ruleTarget, setRuleTarget] = useState('')
  const [aiErrors, setAIErrors] = useState<{ songId: number; name: string; message: string }[]>([])
  const owned = list.playlists.filter((playlist) => playlist.creator.userId === uid)
  const ready = initializedUser.current === uid && !!preferences
  const disabled = operation.busy || list.loading || !!list.error || !ready
  const scopeIds = preferences ? preferences.mode === 'include' ? preferences.includedIds : preferences.excludedIds : []
  const eligible = owned.filter((playlist) => playlist.id !== preferences?.sourceId &&
    (preferences?.mode === 'include' ? scopeIds.includes(playlist.id) : !scopeIds.includes(playlist.id)))
  const assignments: OrganizeAssignment[] = preview?.tracks.filter((track) => selected[track.id]?.length > 0)
    .map((track) => ({ songId: track.id, targetPlaylistIds: selected[track.id] })) || []
  const pendingAI = preview?.tracks.filter((track) => track.detailsAvailable && !selected[track.id]?.length) || []

  useEffect(() => {
    if (list.loading || list.error || initializedUser.current === uid) return
    let active = true
    const initialize = async () => {
      const ownedPlaylists = list.playlists.filter((playlist) => playlist.creator.userId === uid)
      const sourceMatches = ownedPlaylists.filter((playlist) => playlist.name === '未分类')
      let saved: OrganizePreferences | null = null
      let warning: string | null = null
      try { saved = await loadOrganizePreferences(uid) } catch (err) {
        warning = (err instanceof Error ? err.message : '归档设置读取失败') + '；本次使用默认设置，请检查后重新保存'
      }
      if (!active) return
      initializedUser.current = uid
      selectionSource.current = null
      setSelected({})
      setPreview(null)
      setPreferences(saved || {
        version: 1, sourceId: sourceMatches.length === 1 ? sourceMatches[0].id : null,
        mode: 'include', includedIds: [], excludedIds: defaultOrganizeExclusions(ownedPlaylists),
        rules: [], decisions: [],
      })
      setNotice(warning)
    }
    void initialize()
    return () => { active = false }
  }, [uid, list.loading, list.error, list.playlists])

  const resetPreview = () => {
    setPreview(null)
    setAICandidates({})
    setAIErrors([])
    setOutcome(null)
    setProgress(null)
    operation.setError(null)
  }

  const changePreferences = (patch: Partial<OrganizePreferences>) => {
    if (operation.busyRef.current || !preferences) return
    if (patch.sourceId !== undefined && patch.sourceId !== preferences.sourceId) {
      selectionSource.current = null
      setSelected({})
    }
    setPreferences({ ...preferences, ...patch })
    resetPreview()
  }

  const toggleScope = (id: number) => {
    if (!preferences) return
    const next = scopeIds.includes(id) ? scopeIds.filter((item) => item !== id) : [...scopeIds, id]
    changePreferences(preferences.mode === 'include' ? { includedIds: next } : { excludedIds: next })
  }

  /** 设置保存失败不阻止只读预览，在线执行结果也不受本地存储失败影响。 */
  const persist = async (next: OrganizePreferences) => {
    try {
      await saveOrganizePreferences(uid, next)
      setNotice('归档范围和个人规则已保存到当前账号的本机设置')
    } catch (err) {
      setNotice('本机设置未保存：' + (err instanceof Error ? err.message : '存储失败') + '；本次仍可按当前界面操作')
    }
  }

  const handlePreview = () => operation.run(async () => {
    if (!preferences?.sourceId) throw new Error('请先选择来源歌单')
    resetPreview()
    const next = await previewPlaylistOrganize(uid, preferences.sourceId,
      { mode: preferences.mode, playlistIds: scopeIds }, preferences.rules, preferences.decisions, setProgress)
    let saved: readonly OrganizeAssignment[] = []
    if (keepChoices) {
      if (selectionSource.current === next.source.id) {
        saved = Object.entries(selected).map(([id, targets]) => ({ songId: Number(id), targetPlaylistIds: targets }))
      } else {
        try { saved = await loadOrganizeDraft(uid, next.source.id) } catch (err) {
          setNotice('上次勾选读取失败：' + (err instanceof Error ? err.message : '存储失败'))
        }
      }
    }
    setSelected(restoreOrganizeChoices(next, saved))
    selectionSource.current = next.source.id
    setPreview(next)
    setFilter('all')
    setProgress(null)
    try { await saveOrganizePreferences(uid, preferences) } catch {
      setNotice('归档设置未保存；当前勾选仍可使用')
    }
  })

  const toggleDestination = (songId: number, targetId: number) => {
    if (operation.busyRef.current) return
    setSelected((previous) => {
      const ids = previous[songId] || []
      return { ...previous, [songId]: ids.includes(targetId) ? ids.filter((id) => id !== targetId) : [...ids, targetId] }
    })
  }

  const addRule = () => {
    if (operation.busyRef.current || !preferences || ruleValue.trim().length < 2 ||
        !eligible.some((playlist) => playlist.id === Number(ruleTarget))) return
    changePreferences({ rules: [...preferences.rules, {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2), kind: ruleKind,
      value: ruleValue.trim(), targetPlaylistId: Number(ruleTarget),
    }] })
    setRuleValue('')
  }

  /** AI 仅补充未选歌曲的待确认候选，绝不修改已经勾选的去向。 */
  const handleAI = () => operation.run(async () => {
    if (!preview) return
    setAIErrors([])
    const failures: { songId: number; name: string; message: string }[] = []
    for (let offset = 0; offset < pendingAI.length; offset += 10) {
      const input = { songs: pendingAI.slice(offset, offset + 10), targets: preview.aiTargets }
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'SUGGEST_EXISTING_PLAYLISTS', data: input,
        }) as ExtensionResponse
        if (!response?.success) throw new Error(response?.error || 'AI 建议读取失败')
        const suggestions = validateOrganizeAIOutput(response.data, input)
        setAICandidates((previous) => {
          const next = { ...previous }
          for (const suggestion of suggestions) {
            next[suggestion.songId] = suggestion.targetPlaylistIds.map((playlistId) => ({
              playlistId, certain: false, reason: 'AI 待确认：' + suggestion.reason, score: null, defaultSelected: false,
            }))
          }
          return next
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AI 建议读取失败'
        // 配置和服务限制影响所有批次，不反复请求；已有建议和手工选择仍然保留。
        const unavailable = /API Key|HTTP (?:400|401|402|403|429)|已在插件设置中关闭|AI 建议输入无效/.test(message)
        for (const song of unavailable ? pendingAI.slice(offset) : input.songs) {
          failures.push({ songId: song.id, name: song.name, message })
        }
        setAIErrors([...failures])
        if (unavailable) break
      }
      setProgress({ phase: 'ai', completed: Math.min(offset + 10, pendingAI.length), total: pendingAI.length })
    }
  })

  /** 执行前保存勾选；仅记录已核验完成的去向，未完成歌曲重新预览时恢复原选择。 */
  const handleExecute = () => operation.run(async () => {
    if (!preview || !preferences) return
    setExecuting(true)
    setProgress(null)
    setOutcome(null)
    const choices = preview.tracks.map((track) => ({ songId: track.id, targetPlaylistIds: selected[track.id] || [] }))
    const saveChoices = async (pending: readonly OrganizeAssignment[]) => {
      try {
        await saveOrganizeDraft(uid, preview.source.id, pending)
        setNotice('勾选已保存在本机；重新分析时可恢复未完成歌曲的去向')
      } catch {
        setNotice('勾选暂未保存到本机，请保留当前页面；重新分析仍会保留当前勾选')
      }
    }
    try {
      await saveChoices(choices)
      const next = await executePlaylistOrganize(preview, assignments, move, setProgress)
      setOutcome(next)
      const completed = new Set(next.completedSongIds)
      const pending = choices.map((item) => completed.has(item.songId) ? { ...item, targetPlaylistIds: [] } : item)
      setSelected(Object.fromEntries(pending.map((item) => [item.songId, [...item.targetPlaylistIds]])))
      if (completed.size > 0) {
        const decisions = new Map(preferences.decisions.map((decision) => [decision.songId, decision]))
        for (const assignment of assignments) {
          if (completed.has(assignment.songId)) decisions.set(assignment.songId, assignment)
        }
        const saved = { ...preferences, decisions: [...decisions.values()].slice(-5000) }
        setPreferences(saved)
        await persist(saved)
      }
      await saveChoices(pending)
    } finally {
      setPreview(null)
      setAICandidates({})
      setExecuting(false)
      list.reload()
    }
  }, true)

  const visibleTracks = preview?.tracks.filter((track) => filter === 'all' ||
    (filter === 'selected' ? !!selected[track.id]?.length : !selected[track.id]?.length)) || []

  return (
    <div>
      <h3 className="text-lg font-bold text-gray-800 mb-2">整理到已有歌单</h3>
      <p className="text-xs text-gray-500 mb-4">一首歌可归档到多个已有歌单。明确依据或充分领先的首选默认勾选，其余保留在来源等待确认。</p>
      {(list.loading || !ready && !list.error) && <p className="text-sm text-gray-500">正在读取歌单和本机设置...</p>}
      {list.error && <p role="alert" className="text-sm text-red-600">{list.error}</p>}
      <button className={buttonClass + ' tn-btn-secondary w-full mb-3'} disabled={operation.busy || list.loading}
        onClick={() => { if (!operation.busyRef.current) { resetPreview(); list.reload() } }}>重新读取歌单</button>
      {preferences && (
        <>
          <label className="block text-sm font-semibold mb-3">来源歌单
            <select className={fieldClass + ' mt-1'} value={preferences.sourceId ?? ''} disabled={disabled}
              onChange={(event) => changePreferences({ sourceId: event.target.value ? Number(event.target.value) : null })}>
              <option value="">请选择要整理的自建歌单</option>
              {owned.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name} · {playlist.trackCount} 首 · ID {playlist.id}</option>)}
            </select>
          </label>
          <fieldset disabled={disabled} className="border border-gray-200 rounded-xl p-3 mb-3">
            <legend className="text-sm font-semibold px-1">允许归档的目标范围</legend>
            <label className="flex items-start gap-2 text-sm mb-2">
              <input type="radio" name="organize-mode" checked={preferences.mode === 'include'} className="mt-1"
                onChange={() => changePreferences({ mode: 'include' })} />
              <span>选择允许的歌单<span className="block text-xs text-gray-500">只有勾选的歌单可以接收歌曲。</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm mb-3">
              <input type="radio" name="organize-mode" checked={preferences.mode === 'exclude'} className="mt-1"
                onChange={() => changePreferences({ mode: 'exclude' })} />
              <span>选择不允许的歌单<span className="block text-xs text-gray-500">勾选的是排除项，其余自建歌单可接收歌曲。</span></span>
            </label>
            <p className="text-xs font-semibold mb-2">{preferences.mode === 'include' ? '以下勾选＝允许归档' : '以下勾选＝禁止归档'}；来源始终排除</p>
            <div className="max-h-48 overflow-y-auto space-y-2">
              {owned.filter((playlist) => playlist.id !== preferences.sourceId).map((playlist) => (
                <label key={playlist.id} className="flex items-start gap-2 text-xs break-words">
                  <input type="checkbox" className="mt-0.5" checked={scopeIds.includes(playlist.id)} onChange={() => toggleScope(playlist.id)} />
                  <span>{playlist.name} · ID {playlist.id}</span>
                </label>
              ))}
            </div>
            <button className="text-xs text-gray-500 underline mt-2" onClick={() =>
              changePreferences(preferences.mode === 'include' ? { includedIds: [] } : { excludedIds: [] })}>清空本模式勾选</button>
            <p className="text-xs text-green-700 mt-2">本次允许 {eligible.length} 个目标：{eligible.map((playlist) => playlist.name).join('、') || '尚未选择'}</p>
            {preferences.mode === 'include' && scopeIds.some((id) => !owned.some((playlist) => playlist.id === id)) &&
              <p className="text-xs text-amber-700 mt-2">保存的允许项中有失效歌单，请清空后重新选择。</p>}
          </fieldset>
          <details className="border border-gray-200 rounded-xl p-3 mb-3">
            <summary className="text-sm font-semibold cursor-pointer">个人归档规则（{preferences.rules.length} 条）</summary>
            <p className="text-xs text-gray-500 mt-2">明确规则会默认勾选。例如“歌手完全匹配：董真 → 贞惜有你”。被排除的目标不启用规则。</p>
            <div className="space-y-2 mt-2">
              {preferences.rules.map((rule) => (
                <div key={rule.id} className="text-xs border-b border-gray-100 pb-2">
                  <span>{ruleNames[rule.kind]}「{rule.value}」 → {owned.find((playlist) => playlist.id === rule.targetPlaylistId)?.name || 'ID ' + rule.targetPlaylistId}
                    {!eligible.some((playlist) => playlist.id === rule.targetPlaylistId) && '（当前范围不启用）'}</span>
                  <button className="ml-2 text-red-600" disabled={disabled} onClick={() =>
                    changePreferences({ rules: preferences.rules.filter((item) => item.id !== rule.id) })}>移除规则</button>
                </div>
              ))}
            </div>
            <select className={fieldClass + ' mt-2'} value={ruleKind} disabled={disabled}
              onChange={(event) => setRuleKind(event.target.value as OrganizeRule['kind'])} aria-label="规则匹配方式">
              {Object.entries(ruleNames).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}
            </select>
            <input className={fieldClass + ' mt-2'} value={ruleValue} maxLength={200} disabled={disabled}
              onChange={(event) => setRuleValue(event.target.value)} placeholder="输入明确的歌手、专辑或关键词，至少 2 字" aria-label="规则匹配内容" />
            <select className={fieldClass + ' mt-2'} value={ruleTarget} disabled={disabled}
              onChange={(event) => setRuleTarget(event.target.value)} aria-label="规则目标歌单">
              <option value="">选择本次允许的目标</option>
              {eligible.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name} · ID {playlist.id}</option>)}
            </select>
            <button className={buttonClass + ' tn-btn-secondary w-full mt-2'}
              disabled={disabled || preferences.rules.length >= 200 || ruleValue.trim().length < 2 ||
                !eligible.some((playlist) => playlist.id === Number(ruleTarget))} onClick={addRule}>添加个人规则</button>
          </details>
          <button className={buttonClass + ' tn-btn-secondary w-full mb-2'} disabled={disabled}
            onClick={() => operation.run(() => persist(preferences))}>保存范围和个人规则</button>
          {notice && <p role="status" className="text-xs text-amber-700 mb-3">{notice}</p>}
          <label className="flex items-center gap-2 text-xs mb-3">
            <input type="checkbox" checked={keepChoices} disabled={disabled} onChange={(event) => setKeepChoices(event.target.checked)} />
            重新分析时保留上次勾选（包括“保留原地”）
          </label>
          <button className={buttonClass + ' tn-btn-primary w-full'} disabled={disabled || !preferences.sourceId || eligible.length === 0}
            onClick={handlePreview}>分析并预览归档建议</button>
        </>
      )}
      {operation.busy && progress && <p role="status" className="text-sm text-gray-600 mt-3">
        {({ reading: '读取目标歌单', details: '读取歌曲详情', ai: '补充 AI 建议', adding: '补齐目标歌曲', removing: '核验来源移除', verifying: '核验最终状态' })[progress.phase]}
        {progress.total > 0 && '：' + progress.completed + ' / ' + progress.total}{progress.name && ' · ' + progress.name}
      </p>}
      {operation.error && <p role="alert" className="text-sm text-red-600 mt-3">{operation.error}</p>}
      {preview && (
        <div className="mt-4">
          <p className="text-sm font-semibold">来源「{preview.source.name}」· ID {preview.source.id} · 实际读取 {preview.tracks.length} 首</p>
          <details className="text-xs text-gray-600 mt-2">
            <summary className="cursor-pointer">已固定 {preview.targets.length} 个允许目标（{preview.scope.mode === 'include' ? '允许模式' : '排除模式'}）</summary>
            <p className="mt-1 break-words">{preview.targets.map((target) => target.name + '（' + target.id + '）').join('、')}</p>
          </details>
          {preview.warnings.map((warning) => <p key={warning} className="text-xs text-amber-700 mt-2">{warning}</p>)}
          <p className="text-xs text-gray-500 mt-3">明确依据可默认多选；其余按推荐强度排序，样本充分、达到 75 分且领先次选至少 15 分时默认选首项。推荐分用于比较候选，不代表正确率；AI 建议仍需手工勾选。</p>
          <button className={buttonClass + ' tn-btn-secondary w-full mt-3'} disabled={operation.busy || pendingAI.length === 0}
            onClick={handleAI}>AI 补充未选歌曲的建议（需手工勾选）</button>
          <p className="text-xs text-gray-400 mt-1">可选：向已配置的 DeepSeek 发送待确认歌曲及允许目标的名称、样例。没有 API Key 也可使用本地规则和手工确认。</p>
          {aiErrors.length > 0 && <details className="text-xs text-amber-700 mt-2" open>
            <summary>有 {aiErrors.length} 首未获得 AI 建议，当前勾选和来源歌曲保留</summary>
            <ul className="mt-2 max-h-48 overflow-y-auto space-y-1">{aiErrors.map((item) =>
              <li key={item.songId}>{item.name} · ID {item.songId}：{item.message}</li>)}</ul>
          </details>}
          <label className="block text-xs mt-3">筛选预览
            <select className={fieldClass + ' mt-1'} value={filter} disabled={operation.busy}
              onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="all">全部歌曲</option><option value="selected">已选择去向</option><option value="pending">未选择，保留原地</option>
            </select>
          </label>
          <div className="mt-2 space-y-3">
            {visibleTracks.map((track) => {
              const recommendation = preview.recommendations.find((item) => item.songId === track.id)!
              const candidates = new Map(recommendation.candidates.map((candidate) => [candidate.playlistId, candidate]))
              for (const candidate of aiCandidates[track.id] || []) {
                if (!candidates.has(candidate.playlistId)) candidates.set(candidate.playlistId, candidate)
              }
              for (const targetId of selected[track.id] || []) {
                if (!candidates.has(targetId)) candidates.set(targetId, { playlistId: targetId, certain: false, reason: '手工指定', score: null, defaultSelected: false })
              }
              return (
                <div key={track.id} className="rounded-xl border border-gray-200 p-3">
                  <p className="text-sm font-semibold break-words">{track.name || '详情不可用'} <span className="font-normal text-xs text-gray-400">ID {track.id}</span></p>
                  <p className="text-xs text-gray-500 mt-1 break-words">{track.artists.join(' / ')}{track.album && ' · ' + track.album}</p>
                  {recommendation.warning && <p className="text-xs text-amber-700 mt-1">{recommendation.warning}</p>}
                  <p className="text-xs text-gray-500 mt-1">分析结论：{recommendation.selectionReason}</p>
                  {[...candidates.values()].map((candidate) => (
                    <label key={candidate.playlistId} className="flex items-start gap-2 mt-2 text-xs">
                      <input type="checkbox" className="mt-0.5" disabled={operation.busy}
                        checked={selected[track.id]?.includes(candidate.playlistId) || false}
                        onChange={() => toggleDestination(track.id, candidate.playlistId)} />
                      <span><span className="font-semibold">{preview.targets.find((target) => target.id === candidate.playlistId)?.name} · ID {candidate.playlistId}</span>
                        {candidate.score !== null && <span className="block text-blue-700 mt-0.5">
                          {candidate.certain ? '明确依据' : candidate.defaultSelected ? '首选建议' : '待确认'} · 推荐分 {candidate.score}
                        </span>}
                        <span className="block text-gray-500 mt-0.5">{candidate.reason}</span></span>
                    </label>
                  ))}
                  <select className={fieldClass + ' mt-2'} disabled={operation.busy} value="" aria-label={'为歌曲 ' + track.id + ' 添加归档去向'}
                    onChange={(event) => { if (event.target.value) toggleDestination(track.id, Number(event.target.value)) }}>
                    <option value="">手工添加其他去向...</option>
                    {preview.targets.filter((target) => !selected[track.id]?.includes(target.id)).map((target) =>
                      <option key={target.id} value={target.id}>{target.name} · ID {target.id}</option>)}
                  </select>
                  <p className="text-xs text-gray-500 mt-2">{selected[track.id]?.length ? '已选 ' + selected[track.id].length + ' 个去向' : '未选择去向，保留原地'}
                    <button className="ml-2 underline" disabled={operation.busy} onClick={() => {
                      if (!operation.busyRef.current) setSelected((previous) => ({ ...previous, [track.id]: [] }))
                    }}>保留原地</button></p>
                </div>
              )
            })}
          </div>
          <label className="flex items-start gap-2 text-sm mt-4">
            <input type="checkbox" className="mt-1" checked={move} disabled={operation.busy}
              onChange={(event) => { if (!operation.busyRef.current) setMove(event.target.checked) }} />
            <span>全部选定目标核验成功后，从来源移除<span className="block text-xs text-gray-500 mt-1">取消则仅复制，来源歌曲保留。</span></span>
          </label>
          <p className="text-sm font-semibold mt-3">将{move ? '归档并移除' : '复制'} {assignments.length} 首；{preview.tracks.length - assignments.length} 首不参与，保留原地。</p>
          <p className="text-xs text-amber-700 mt-2">单首失败会跳过并汇总，该歌保留在来源；只有该歌全部选定目标确认成功才移除。请勿同时修改相关歌单。重新分析会保留未完成歌曲的勾选。</p>
          <button className={buttonClass + ' tn-btn-primary w-full mt-3'} disabled={operation.busy || assignments.length === 0}
            onClick={handleExecute}>确认{move ? '归档并从来源移除' : '仅复制'} {assignments.length} 首</button>
        </div>
      )}
      {executing && !progress && <p role="status" className="text-sm text-gray-500 mt-3">正在检查来源和全部选定目标...</p>}
      {outcome && (
        <div role="status" className={'rounded-xl p-3 mt-4 text-sm ' + (outcome.status === 'completed' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800')}>
          <p className="font-semibold">{outcome.message}</p>
          <PlaylistFailures failures={outcome.failedTracks} />
          <p className="text-xs mt-2">来源已移除 {outcome.removedCount ?? '未知'} 首，当前读取剩余 {outcome.sourceRemainingCount ?? '未知'} 首；{outcome.leftUntouchedCount} 首未参与。</p>
          <p className="text-xs mt-1">来源其余内容及顺序：{outcome.sourceVerified === true ? '核验通过' : outcome.sourceVerified === false ? '检测到其他变化' : '未能核验'}。</p>
          {outcome.targets.map((target) => <p key={target.id} className="text-xs mt-2 break-words">
            「{target.name}」新增 {target.addedCount ?? '未知'} 首，仍缺 {target.missingCount ?? '未知'} 首；
            原有歌曲及相对顺序{target.originalPreserved === true ? '已保留' : target.originalPreserved === false ? '出现变化' : '未知'}；
            最终状态{target.verified === true ? '已核验' : target.verified === false ? '未通过核验' : '未知'}。
          </p>)}
        </div>
      )}
      <button className={buttonClass + ' tn-btn-secondary w-full mt-4'} disabled={operation.busy} onClick={onBack}>返回主页</button>
    </div>
  )
}
