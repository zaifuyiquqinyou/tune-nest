import {
  addTargetPlaylistTracks, getCleanupUserId, getPlaylistSnapshotChecked,
  getSongDetailsChecked, getUserPlaylistsChecked, removeSourcePlaylistTracks,
} from '@/api/netease-direct'
import {
  isOrganizeTargetAllowed, recommendExistingPlaylists, resolveOrganizeTargets,
  validateOrganizeRules, validateOrganizeScope,
} from '@/classifier/playlist-organizer'
import type { PlaylistSnapshot } from '@/types/playlist-cleanup'
import type { PlaylistTextTrack } from '@/types/playlist-tools'
import type {
  OrganizeAssignment, OrganizeProgress, OrganizeRule, OrganizeScope,
  PlaylistOrganizePreview, PlaylistOrganizeResult,
} from '@/types/playlist-organize'

const BATCH_SIZE = 100
let organizeRunning = false
const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0
const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, i) => id === b[i])

function preservesOrder(previous: readonly number[], actual: readonly number[]): boolean {
  const original = new Set(previous)
  return sameIds(previous, actual.filter((id) => original.has(id)))
}

function freezeIds(ids: readonly number[]): readonly number[] {
  if (!Array.isArray(ids) || ids.some((id) => !positiveId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('归档计划包含无效或重复 ID，请重新预览')
  }
  return Object.freeze([...ids])
}

function freezeSnapshot(snapshot: PlaylistSnapshot, userId: number): PlaylistSnapshot {
  if (!snapshot || !positiveId(snapshot.id) || snapshot.creatorId !== userId || typeof snapshot.name !== 'string') {
    throw new Error('归档歌单必须属于当前账号，请重新预览')
  }
  return Object.freeze({ ...snapshot, trackIds: freezeIds(snapshot.trackIds) })
}

async function assertUser(userId: number): Promise<void> {
  if (await getCleanupUserId() !== userId) throw new Error('登录账号已变化，已停止归档，请重新登录并预览')
}

/** 仅本次预览缓存详情；失效或不可读的歌曲保留 ID，不使用猜测信息补齐。 */
async function readTracks(
  ids: readonly number[], onProgress?: (progress: OrganizeProgress) => void
): Promise<Map<number, PlaylistTextTrack>> {
  const tracks = new Map<number, PlaylistTextTrack>()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    try {
      for (const song of await getSongDetailsChecked(batch)) {
        tracks.set(song.id, Object.freeze({
          id: song.id, name: song.name, artists: Object.freeze(song.artists.map((artist) => artist.name)),
          album: song.album.name, durationMs: song.duration, detailsAvailable: !!song.name,
        }))
      }
    } catch {
      // 详情失败只能减少推荐依据；成员 ID 继续保留，歌曲不会因此从来源消失。
    }
    for (const id of batch) {
      if (!tracks.has(id)) tracks.set(id, Object.freeze({
        id, name: '', artists: Object.freeze([]), album: '', durationMs: 0, detailsAvailable: false,
      }))
    }
    onProgress?.({ phase: 'details', completed: Math.min(offset + 200, ids.length), total: ids.length })
  }
  return tracks
}

/**
 * 只读加载本人来源及允许的已有目标，读取真实成员和详情后生成多个去向的保守建议。
 * include 仅使用勾选目标，exclude 排除勾选目标；来源和收藏歌单始终不能成为目标。
 * 统计数量差异只提示，未能判定的歌曲不生成默认去向，整个预览不写入在线歌单。
 */
export async function previewPlaylistOrganize(
  userId: number, sourceId: number, scope: OrganizeScope,
  rules: readonly OrganizeRule[] = [], decisions: readonly OrganizeAssignment[] = [],
  onProgress?: (progress: OrganizeProgress) => void
): Promise<PlaylistOrganizePreview> {
  validateOrganizeScope(scope)
  validateOrganizeRules(rules)
  const frozenScope = Object.freeze({ mode: scope.mode, playlistIds: freezeIds(scope.playlistIds) })
  const frozenRules = rules.map((rule) => Object.freeze({ ...rule }))
  const frozenDecisions = decisions.map((decision) => ({
    songId: decision.songId, targetPlaylistIds: [...decision.targetPlaylistIds],
  }))
  await assertUser(userId)
  const playlists = await getUserPlaylistsChecked(userId)
  const allowed = resolveOrganizeTargets(userId, sourceId, playlists, frozenScope)
  if (allowed.length === 0) throw new Error('当前范围没有可归档的目标，请调整允许或排除的歌单')
  const source = freezeSnapshot(await getPlaylistSnapshotChecked(sourceId), userId)
  const targets: PlaylistSnapshot[] = []
  for (const playlist of allowed) {
    targets.push(freezeSnapshot(await getPlaylistSnapshotChecked(playlist.id), userId))
    onProgress?.({ phase: 'reading', completed: targets.length, total: allowed.length, name: playlist.name })
  }
  const ids = [...new Set([source, ...targets].flatMap((snapshot) => [...snapshot.trackIds]))]
  const details = await readTracks(ids, onProgress)
  await assertUser(userId)
  const tracks = Object.freeze(source.trackIds.map((id) => details.get(id)!))
  const profiles = targets.map((snapshot) => ({ snapshot, tracks: snapshot.trackIds.map((id) => details.get(id)!) }))
  const warnings = [source, ...targets]
    .filter((snapshot) => snapshot.reportedTrackCount !== snapshot.trackIds.length)
    .map((snapshot) => '「' + snapshot.name + '」统计 ' + snapshot.reportedTrackCount +
      ' 首，实际读取 ' + snapshot.trackIds.length + ' 个 ID；仅处理已读取 ID')
  const missing = tracks.filter((track) => !track.detailsAvailable).length
  if (missing) warnings.push('来源有 ' + missing + ' 首缺少详情，仅可按相同 ID 或手工确认归档')
  return Object.freeze({
    userId, scope: frozenScope, source, targets: Object.freeze(targets), tracks,
    recommendations: Object.freeze(recommendExistingPlaylists(tracks, profiles, frozenRules, frozenDecisions)),
    aiTargets: Object.freeze(profiles.map((profile) => Object.freeze({
      id: profile.snapshot.id, name: profile.snapshot.name,
      examples: Object.freeze(profile.tracks.filter((track) => track.detailsAvailable).slice(0, 5).map((track) =>
        Object.freeze({ name: track.name, artists: track.artists, album: track.album }))),
    }))),
    warnings: Object.freeze(warnings),
  })
}

interface ExecutionPlan {
  userId: number
  source: PlaylistSnapshot
  targets: readonly PlaylistSnapshot[]
  assignments: readonly OrganizeAssignment[]
  selectedIds: readonly number[]
  move: boolean
}

/** 固定手工确认后的 ID 分配；规则、AI 和历史偏好均不能越过本次预览的目标范围。 */
function validatePlan(
  preview: PlaylistOrganizePreview, assignments: readonly OrganizeAssignment[], move: boolean
): ExecutionPlan {
  if (!positiveId(preview.userId) || typeof move !== 'boolean') throw new Error('账号或归档方式无效')
  validateOrganizeScope(preview.scope)
  const source = freezeSnapshot(preview.source, preview.userId)
  const targets = preview.targets.map((target) => freezeSnapshot(target, preview.userId))
  freezeIds(targets.map((target) => target.id))
  if (targets.some((target) => !isOrganizeTargetAllowed(preview.scope, source.id, target.id))) {
    throw new Error('归档目标超出本次允许范围或包含来源，请重新预览')
  }
  if (!Array.isArray(assignments) || assignments.length === 0) throw new Error('请至少确认一首歌的归档去向')
  const selectedIds = freezeIds(assignments.map((assignment) => assignment.songId))
  const sourceIds = new Set(source.trackIds)
  const allowedIds = new Set(targets.map((target) => target.id))
  const confirmed = assignments.map((assignment) => {
    const ids = freezeIds(assignment.targetPlaylistIds)
    if (!sourceIds.has(assignment.songId) || ids.length === 0 || ids.some((id) => !allowedIds.has(id))) {
      throw new Error('歌曲或目标超出预览范围，请重新预览并确认')
    }
    return Object.freeze({ songId: assignment.songId, targetPlaylistIds: ids })
  })
  const usedIds = new Set(confirmed.flatMap((assignment) => [...assignment.targetPlaylistIds]))
  return Object.freeze({
    userId: preview.userId, source, move, selectedIds,
    targets: Object.freeze(targets.filter((target) => usedIds.has(target.id))), assignments: Object.freeze(confirmed),
  })
}

async function assertSnapshot(original: PlaylistSnapshot, expectedIds: readonly number[]): Promise<void> {
  const current = await getPlaylistSnapshotChecked(original.id)
  if (current.creatorId !== original.creatorId || current.name !== original.name || !sameIds(expectedIds, current.trackIds)) {
    throw new Error('歌单「' + original.name + '」的内容、顺序、名称或归属已变化，已停止后续写入，请重新预览')
  }
}

async function assertAllTargets(plan: ExecutionPlan, expected: ReadonlyMap<number, readonly number[]>): Promise<void> {
  for (const target of plan.targets) {
    const ids = expected.get(target.id)!
    await assertSnapshot(target, ids)
    const members = new Set(ids)
    if (plan.assignments.some((assignment) => assignment.targetPlaylistIds.includes(target.id) && !members.has(assignment.songId))) {
      throw new Error('仍有歌曲未完整进入全部选定目标，来源不会继续移除')
    }
  }
}

/** 核对本批仅增加指定 ID，允许头部或尾部插入，但保留原歌曲之间的相对顺序。 */
async function verifyAdded(
  target: PlaylistSnapshot, previous: readonly number[], batch: readonly number[]
): Promise<readonly number[]> {
  const current = await getPlaylistSnapshotChecked(target.id)
  const expected = new Set([...previous, ...batch])
  if (current.creatorId !== target.creatorId || current.name !== target.name ||
      current.trackIds.length !== expected.size || current.trackIds.some((id) => !expected.has(id)) ||
      !preservesOrder(previous, current.trackIds)) {
    throw new Error('未能核验歌曲完整加入「' + target.name + '」，已停止，来源尚未开始移除')
  }
  return current.trackIds
}

/** 不重试写入或删除目标以回滚；回读实际成员，任何无法读取的结果均显示未知。 */
async function readOutcome(
  plan: ExecutionPlan, expected: ReadonlyMap<number, readonly number[]>, failure: string | null
): Promise<PlaylistOrganizeResult> {
  const reads = await Promise.allSettled([getPlaylistSnapshotChecked(plan.source.id),
    ...plan.targets.map((target) => getPlaylistSnapshotChecked(target.id))])
  let accountVerified = false
  try { accountVerified = await getCleanupUserId() === plan.userId } catch { /* 未知账号不能报完整成功。 */ }
  const source = reads[0].status === 'fulfilled' ? reads[0].value : null
  const currentSourceIds = source ? new Set(source.trackIds) : null
  const removed = currentSourceIds ? new Set(plan.selectedIds.filter((id) => !currentSourceIds.has(id))) : null
  const sourceVerified = source && removed ? source.creatorId === plan.userId && source.name === plan.source.name &&
    sameIds(plan.move ? plan.source.trackIds.filter((id) => !removed.has(id)) : plan.source.trackIds, source.trackIds) : null
  const targets = plan.targets.map((target, index) => {
    const read = reads[index + 1]
    const current = read.status === 'fulfilled' ? read.value : null
    const ids = current ? new Set(current.trackIds) : null
    const assigned = plan.assignments.filter((assignment) => assignment.targetPlaylistIds.includes(target.id)).map((item) => item.songId)
    const originalPreserved = current ? current.creatorId === plan.userId && preservesOrder(target.trackIds, current.trackIds) : null
    return {
      id: target.id, name: target.name,
      addedCount: ids ? assigned.filter((id) => !target.trackIds.includes(id) && ids.has(id)).length : null,
      missingCount: ids ? assigned.filter((id) => !ids.has(id)).length : null,
      originalPreserved,
      verified: current ? originalPreserved === true && current.name === target.name &&
        sameIds(expected.get(target.id)!, current.trackIds) : null,
    }
  })
  const completed = !failure && accountVerified && sourceVerified === true &&
    removed?.size === (plan.move ? plan.selectedIds.length : 0) &&
    targets.every((target) => target.verified === true && target.missingCount === 0)
  return {
    status: completed ? 'completed' : 'stopped',
    message: completed
      ? plan.move ? '归档完成，已核验全部目标及来源移除；未选中的歌曲保留原地' : '复制完成，已核验全部目标；来源保留'
      : (failure || '最终状态未通过完整核验') + '。已停止后续写入；已加入目标的歌曲保留，请重新预览后继续' +
        (!accountVerified ? '；无法确认原登录账号' : ''),
    selectedCount: plan.selectedIds.length, leftUntouchedCount: plan.source.trackIds.length - plan.selectedIds.length,
    removedCount: removed?.size ?? null, sourceRemainingCount: source?.trackIds.length ?? null,
    sourceVerified, targets,
  }
}

/**
 * 固定用户确认的多个去向，检查实时来源和目标，先补齐并核验所有目标，再分批移除来源。
 * 每次来源移除前后均核验所有目标；失败立即停止，只回读实际状态，不重试或回滚目标。
 * 平台没有跨歌单事务，外部并发只能在核验时发现；目标从不接收清空、覆盖或删除请求。
 */
export async function executePlaylistOrganize(
  preview: PlaylistOrganizePreview, assignments: readonly OrganizeAssignment[], move: boolean,
  onProgress?: (progress: OrganizeProgress) => void
): Promise<PlaylistOrganizeResult> {
  if (organizeRunning) throw new Error('已有归档正在执行，请等待完成')
  const plan = validatePlan(preview, assignments, move)
  organizeRunning = true
  const expected = new Map(plan.targets.map((target) => [target.id, target.trackIds]))
  let expectedSource = plan.source.trackIds
  let failure: string | null = null
  try {
    try {
      await assertUser(plan.userId)
      await assertSnapshot(plan.source, expectedSource)
      for (const target of plan.targets) await assertSnapshot(target, target.trackIds)
      const missing = new Map(plan.targets.map((target) => [target.id,
        plan.assignments.filter((assignment) => assignment.targetPlaylistIds.includes(target.id) &&
          !target.trackIds.includes(assignment.songId)).map((assignment) => assignment.songId)]))
      const total = [...missing.values()].reduce((sum, ids) => sum + ids.length, 0)
      let added = 0
      // 所有目标全部补齐之前，任何分支都不能移除来源歌曲。
      for (const target of plan.targets) {
        const ids = missing.get(target.id)!
        for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
          await assertSnapshot(plan.source, expectedSource)
          await assertSnapshot(target, expected.get(target.id)!)
          await assertUser(plan.userId)
          const batch = ids.slice(offset, offset + BATCH_SIZE)
          await addTargetPlaylistTracks(target.id, [plan.source.id], batch)
          expected.set(target.id, await verifyAdded(target, expected.get(target.id)!, batch))
          added += batch.length
          onProgress?.({ phase: 'adding', completed: added, total, name: target.name })
          if (added < total) await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      await assertAllTargets(plan, expected)
      await assertSnapshot(plan.source, expectedSource)
      if (plan.move) {
        for (let offset = 0; offset < plan.selectedIds.length; offset += BATCH_SIZE) {
          await assertSnapshot(plan.source, expectedSource)
          await assertAllTargets(plan, expected)
          await assertUser(plan.userId)
          const batch = plan.selectedIds.slice(offset, offset + BATCH_SIZE)
          await removeSourcePlaylistTracks(plan.source.id, plan.targets[0].id, batch)
          const removed = new Set(batch)
          expectedSource = expectedSource.filter((id) => !removed.has(id))
          await assertSnapshot(plan.source, expectedSource)
          await assertAllTargets(plan, expected)
          onProgress?.({ phase: 'removing', completed: offset + batch.length, total: plan.selectedIds.length })
          if (offset + BATCH_SIZE < plan.selectedIds.length) await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      await assertUser(plan.userId)
    } catch (err) {
      failure = err instanceof Error ? err.message : '归档请求失败，已停止后续写入'
    }
    onProgress?.({ phase: 'verifying', completed: 0, total: 0 })
    return await readOutcome(plan, expected, failure)
  } finally {
    organizeRunning = false
  }
}
