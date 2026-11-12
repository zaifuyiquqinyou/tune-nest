import {
  addTargetPlaylistTracks,
  getCleanupUserId,
  getPlaylistSnapshotChecked,
  removeSourcePlaylistTracks,
} from '@/api/netease-direct'
import { parsePlaylistText, serializePlaylistText } from '@/utils/playlist-text'
import { mutatePlaylistTracks } from '@/services/playlist-track-mutation'
import type { PlaylistTrackFailure } from '@/types/playlist-operation'
import type { PlaylistSnapshot } from '@/types/playlist-cleanup'
import type {
  PlaylistMergeInput,
  PlaylistMergePlan,
  PlaylistMergeProgress,
  PlaylistMergeResult,
  PlaylistMergeSource,
  PlaylistMergeSourceResult,
} from '@/types/playlist-tools'

const BATCH_SIZE = 100
let mergeRunning = false

function positiveId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0
}

function sameIds(expected: readonly number[], actual: readonly number[]): boolean {
  return expected.length === actual.length && expected.every((id, index) => id === actual[index])
}

/** 添加歌曲允许出现在头部或尾部，原有歌曲之间的相对顺序必须保留。 */
function preservesOrder(previous: readonly number[], actual: readonly number[]): boolean {
  const previousIds = new Set(previous)
  return sameIds(previous, actual.filter((id) => previousIds.has(id)))
}

function copyIds(ids: readonly number[]): readonly number[] {
  if (!Array.isArray(ids) || ids.some((id) => !positiveId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('合并计划包含无效或重复歌曲 ID，请重新预览')
  }
  return Object.freeze([...ids])
}

function copySnapshot(snapshot: PlaylistSnapshot): PlaylistSnapshot {
  if (!positiveId(snapshot.id) || !positiveId(snapshot.creatorId)) {
    throw new Error('合并计划中的歌单信息无效，请重新预览')
  }
  return Object.freeze({ ...snapshot, trackIds: copyIds(snapshot.trackIds) })
}

async function assertCurrentUser(userId: number): Promise<void> {
  if (await getCleanupUserId() !== userId) {
    throw new Error('登录账号已变化，已停止合并，请重新登录并预览')
  }
}

function assertPlaylistRoles(userId: number, targetId: number, sourceIds: readonly number[]): void {
  if (!positiveId(userId) || !positiveId(targetId) || sourceIds.length === 0 ||
      sourceIds.some((id) => !positiveId(id)) || new Set(sourceIds).size !== sourceIds.length ||
      sourceIds.includes(targetId)) {
    throw new Error('请选择一个或多个不同的来源歌单，目标歌单不能同时作为来源')
  }
}

/** 固定来源内容；备份移动只移除备份和当前来源共有的 ID，保留备份后新增的歌。 */
function freezeSource(
  playlistId: number,
  name: string,
  trackIds: readonly number[],
  snapshot: PlaylistSnapshot | null,
  reportedTrackCount: number,
  move: boolean
): PlaylistMergeSource {
  const currentIds = new Set(snapshot?.trackIds)
  return Object.freeze({
    playlistId,
    name,
    trackIds: copyIds(trackIds),
    removalTrackIds: Object.freeze(move ? trackIds.filter((id) => currentIds.has(id)) : []),
    snapshot: snapshot ? copySnapshot(snapshot) : null,
    reportedTrackCount,
  })
}

/**
 * 只读生成单个或多个来源的合并预览，去重后只向本人目标歌单补入缺少的 ID。
 * 在线来源必须属于本人；TXT 默认可仅复制，移动时还须核对备份账号及在线来源归属。
 */
export async function previewPlaylistMerge(
  userId: number,
  targetId: number,
  input: PlaylistMergeInput,
  move: boolean
): Promise<PlaylistMergePlan> {
  const documents = input.kind === 'files'
    ? input.documents.map((document) => parsePlaylistText(serializePlaylistText(document)))
    : []
  const sourceIds = input.kind === 'online' ? input.playlistIds : documents.map((doc) => doc.playlistId)
  assertPlaylistRoles(userId, targetId, sourceIds)
  await assertCurrentUser(userId)
  const target = await getPlaylistSnapshotChecked(targetId)
  if (target.creatorId !== userId) throw new Error('合并目标必须是当前账号自己创建的歌单')
  const sources: PlaylistMergeSource[] = []
  if (input.kind === 'online') {
    for (const sourceId of sourceIds) {
      const snapshot = await getPlaylistSnapshotChecked(sourceId)
      if (snapshot.creatorId !== userId) throw new Error('在线来源必须是当前账号自己创建的歌单')
      sources.push(freezeSource(sourceId, snapshot.name, snapshot.trackIds, snapshot, snapshot.reportedTrackCount, move))
    }
  } else {
    for (const document of documents) {
      let snapshot: PlaylistSnapshot | null = null
      if (move) {
        if (document.accountId !== userId || document.ownerId !== userId) {
          throw new Error('移动 TXT 来源时，备份账号和歌单创建人都必须是当前账号；其他备份请使用仅复制')
        }
        snapshot = await getPlaylistSnapshotChecked(document.playlistId)
        if (snapshot.creatorId !== userId) throw new Error('TXT 对应的在线来源不属于当前账号，不能移除歌曲')
      }
      sources.push(freezeSource(
        document.playlistId, document.playlistName, document.songs.map((song) => song.id),
        snapshot, document.reportedTrackCount, move
      ))
    }
  }
  await assertCurrentUser(userId)
  const incomingTrackIds = [...new Set(sources.flatMap((source) => [...source.trackIds]))]
  const targetIds = new Set(target.trackIds)
  return Object.freeze({
    userId,
    move,
    target,
    sources: Object.freeze(sources),
    incomingTrackIds: Object.freeze(incomingTrackIds),
    missingTargetTrackIds: Object.freeze(incomingTrackIds.filter((id) => !targetIds.has(id))),
  })
}

/** 执行前重新计算全部集合，避免预览角色或待移除范围被界面改写。 */
function copyValidatedPlan(preview: PlaylistMergePlan): PlaylistMergePlan {
  const target = copySnapshot(preview.target)
  assertPlaylistRoles(preview.userId, target.id, preview.sources.map((source) => source.playlistId))
  if (typeof preview.move !== 'boolean' || target.creatorId !== preview.userId) {
    throw new Error('合并目标归属或操作类型无效，请重新预览')
  }
  const sources = preview.sources.map((source) => {
    if ((source.snapshot && (source.snapshot.id !== source.playlistId || source.snapshot.creatorId !== preview.userId)) ||
        (preview.move && !source.snapshot)) {
      throw new Error('合并来源缺少本人在线歌单的有效快照，请重新预览')
    }
    const copied = freezeSource(
      source.playlistId, source.name, source.trackIds, source.snapshot, source.reportedTrackCount, preview.move
    )
    if (!sameIds(copied.removalTrackIds, source.removalTrackIds)) {
      throw new Error('待移除歌曲超出备份与在线来源的交集，请重新预览')
    }
    return copied
  })
  const incomingTrackIds = [...new Set(sources.flatMap((source) => [...source.trackIds]))]
  const targetIds = new Set(target.trackIds)
  const missingTargetTrackIds = incomingTrackIds.filter((id) => !targetIds.has(id))
  if (!sameIds(incomingTrackIds, preview.incomingTrackIds) || !sameIds(missingTargetTrackIds, preview.missingTargetTrackIds)) {
    throw new Error('合并歌曲与预览不一致，请重新预览')
  }
  return Object.freeze({
    userId: preview.userId, move: preview.move, target, sources: Object.freeze(sources),
    incomingTrackIds: Object.freeze(incomingTrackIds), missingTargetTrackIds: Object.freeze(missingTargetTrackIds),
  })
}

async function assertTarget(plan: PlaylistMergePlan, expectedIds: readonly number[]): Promise<PlaylistSnapshot> {
  const target = await getPlaylistSnapshotChecked(plan.target.id)
  if (target.creatorId !== plan.userId || target.name !== plan.target.name || !sameIds(expectedIds, target.trackIds)) {
    throw new Error('目标歌单的内容、顺序或归属已变化，已停止后续写入，请重新预览')
  }
  return target
}

async function assertSource(plan: PlaylistMergePlan, source: PlaylistMergeSource, expectedIds: readonly number[]): Promise<void> {
  const current = await getPlaylistSnapshotChecked(source.playlistId)
  if (current.creatorId !== plan.userId || current.name !== source.snapshot?.name || !sameIds(expectedIds, current.trackIds)) {
    throw new Error('来源歌单「' + source.name + '」与预览不一致，已停止后续写入，请重新预览')
  }
}

async function assertAllSources(plan: PlaylistMergePlan): Promise<void> {
  for (const source of plan.sources) {
    if (source.snapshot) await assertSource(plan, source, source.snapshot.trackIds)
  }
}

/** 读取实际来源状态，未知结果用 null 表示；允许的变化仅是本次候选歌曲移除。 */
function sourceResult(
  source: PlaylistMergeSource, current: PlaylistSnapshot | null, userId: number, expectedIds: readonly number[]
): PlaylistMergeSourceResult {
  const base = { playlistId: source.playlistId, name: source.name }
  if (!source.snapshot) {
    return { ...base, removedCount: 0, pendingCount: 0, remainingCount: null, verified: null }
  }
  if (!current) {
    return { ...base, removedCount: null, pendingCount: null, remainingCount: null, verified: null }
  }
  const currentIds = new Set(current.trackIds)
  const removedIds = new Set(source.removalTrackIds.filter((id) => !currentIds.has(id)))
  return {
    ...base,
    removedCount: removedIds.size,
    pendingCount: source.removalTrackIds.length - removedIds.size,
    remainingCount: current.trackIds.length,
    verified: current.creatorId === userId &&
      current.name === source.snapshot.name && sameIds(expectedIds, current.trackIds),
  }
}

/** 不按请求次数报成功；写入结果不确定时仅重新读取，绝不自动重试或回滚目标。 */
async function readMergeResult(
  plan: PlaylistMergePlan,
  expectedTargetIds: readonly number[],
  expectedSources: ReadonlyMap<number, readonly number[]>, failedTracks: readonly PlaylistTrackFailure[],
  failure: string | null
): Promise<PlaylistMergeResult> {
  const [targetRead, ...sourceReads] = await Promise.allSettled([
    getPlaylistSnapshotChecked(plan.target.id),
    ...plan.sources.map((source) => source.snapshot ? getPlaylistSnapshotChecked(source.playlistId) : Promise.resolve(null)),
  ])
  let accountVerified = false
  try { accountVerified = await getCleanupUserId() === plan.userId } catch { /* 无法确认账号时不报告完成。 */ }
  const target = targetRead.status === 'fulfilled' ? targetRead.value : null
  const currentTargetIds = target ? new Set(target.trackIds) : null
  const targetPreserved = target ? target.creatorId === plan.userId && preservesOrder(plan.target.trackIds, target.trackIds) : null
  const missingTargetCount = currentTargetIds ? plan.incomingTrackIds.filter((id) => !currentTargetIds.has(id)).length : null
  const sources = plan.sources.map((source, index) => {
    const read = sourceReads[index]
    return sourceResult(source, read.status === 'fulfilled' ? read.value : null, plan.userId, expectedSources.get(source.playlistId)!)
  })
  const failedAddIds = new Set(failedTracks.filter((item) => item.operation === 'add').map((item) => item.songId))
  const missingKnown = !!currentTargetIds && plan.incomingTrackIds.every((id) => currentTargetIds.has(id) || failedAddIds.has(id))
  const verifiedSources = sources.every((source, index) => !plan.sources[index].snapshot || source.verified === true)
  const pendingKnown = plan.sources.every((source, index) => {
    if (!source.snapshot) return true
    const read = sourceReads[index]
    if (read.status !== 'fulfilled' || !read.value) return false
    return source.removalTrackIds.every((id) => !read.value!.trackIds.includes(id) || failedAddIds.has(id) ||
      failedTracks.some((item) => item.operation === 'remove' && item.playlistId === source.playlistId && item.songId === id))
  })
  const finished = !failure && accountVerified && !!target && target.name === plan.target.name &&
    sameIds(expectedTargetIds, target.trackIds) && targetPreserved === true && verifiedSources && missingKnown && pendingKnown
  const completed = finished && missingTargetCount === 0 && sources.every((source) => source.pendingCount === 0)
  let message = completed
    ? plan.move ? '移动完成，已核验目标歌曲和来源移除结果；来源歌单保留' : '复制合并完成，已核验目标歌曲；来源未作移除'
    : finished ? '本次处理结束，已跳过 ' + new Set(failedTracks.map((item) => item.songId)).size + ' 首未完成歌曲；这些歌曲保留在来源，其余歌曲已处理'
    : (failure || '合并结果未通过完整核验，已停止后续写入')
  if (!finished) {
    if (targetPreserved === false) message += '；目标原有歌曲或相对顺序发生变化，请手动核对'
    if (!target || sources.some((source, index) => plan.sources[index].snapshot && source.verified === null)) {
      message += '；部分状态读取失败，请重新预览，勿按请求次数判断成功'
    }
    if (sources.some((source) => source.verified === false)) message += '；来源出现预期移除以外的变化'
    message += '。已加入目标的歌曲会保留，可重新预览后继续'
  }
  return {
    status: completed ? 'completed' : finished ? 'partial' : 'stopped',
    failedTracks,
    message,
    addedCount: currentTargetIds ? plan.missingTargetTrackIds.filter((id) => currentTargetIds.has(id)).length : null,
    missingTargetCount,
    targetPreserved,
    targetTrackCount: target?.trackIds.length ?? null,
    sources,
  }
}

/**
 * 补入目标并核验实际成员，单曲失败记录后继续；仅移除已确认存在于目标的来源歌曲。
 * 多个来源共用目标快照，拆分定位失败歌曲时也核对账号和内容；未知结果或额外变化停止写入。
 */
export async function executePlaylistMerge(
  preview: PlaylistMergePlan,
  onProgress?: (progress: PlaylistMergeProgress) => void
): Promise<PlaylistMergeResult> {
  if (mergeRunning) throw new Error('已有歌单合并正在执行，请等待完成')
  const plan = copyValidatedPlan(preview)
  mergeRunning = true
  let expectedTargetIds = plan.target.trackIds
  const expectedSources = new Map(plan.sources.map((source) => [source.playlistId, source.snapshot?.trackIds || []]))
  const failedTracks: PlaylistTrackFailure[] = []
  let failure: string | null = null
  try {
    try {
      await assertCurrentUser(plan.userId)
      await assertTarget(plan, expectedTargetIds)
      await assertAllSources(plan)
      for (let offset = 0; offset < plan.missingTargetTrackIds.length; offset += BATCH_SIZE) {
        const batch = plan.missingTargetTrackIds.slice(offset, offset + BATCH_SIZE)
        await mutatePlaylistTracks({
          userId: plan.userId, playlist: plan.target, expectedIds: expectedTargetIds, trackIds: batch, operation: 'add',
          write: (ids) => addTargetPlaylistTracks(plan.target.id, plan.sources.map((source) => source.playlistId), ids),
          beforeWrite: () => assertAllSources(plan), afterWrite: () => assertAllSources(plan),
          onVerified: (current) => { expectedTargetIds = current }, onFailure: (item) => { failedTracks.push(item) },
        })
        onProgress?.({ phase: 'adding', completed: offset + batch.length, total: plan.missingTargetTrackIds.length })
        if (offset + BATCH_SIZE < plan.missingTargetTrackIds.length) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      await assertAllSources(plan)
      await assertTarget(plan, expectedTargetIds)
      const confirmedTargetIds = new Set(expectedTargetIds)
      const ready = new Map(plan.sources.map((source) => [source.playlistId,
        source.removalTrackIds.filter((id) => confirmedTargetIds.has(id))]))
      const totalRemovals = [...ready.values()].reduce((sum, ids) => sum + ids.length, 0)
      let processed = 0
      for (const source of plan.sources) {
        const ids = ready.get(source.playlistId)!
        for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
          const batch = ids.slice(offset, offset + BATCH_SIZE)
          await mutatePlaylistTracks({
            userId: plan.userId, playlist: source.snapshot!, expectedIds: expectedSources.get(source.playlistId)!,
            trackIds: batch, operation: 'remove', write: (part) => removeSourcePlaylistTracks(source.playlistId, plan.target.id, part),
            beforeWrite: async () => { await assertTarget(plan, expectedTargetIds) },
            afterWrite: async () => { await assertTarget(plan, expectedTargetIds) },
            onVerified: (current) => { expectedSources.set(source.playlistId, current) }, onFailure: (item) => { failedTracks.push(item) },
          })
          processed += batch.length
          onProgress?.({ phase: 'removing', completed: processed, total: totalRemovals, sourceName: source.name })
          if (processed < totalRemovals) await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      await assertCurrentUser(plan.userId)
    } catch (err) {
      failure = err instanceof Error ? err.message : '合并请求失败，已停止后续写入'
    }
    onProgress?.({ phase: 'verifying', completed: 0, total: 0 })
    return await readMergeResult(plan, expectedTargetIds, expectedSources, failedTracks, failure)
  } finally {
    mergeRunning = false
  }
}
