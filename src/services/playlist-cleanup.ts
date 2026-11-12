import {
  getCleanupUserId,
  getPlaylistSnapshotChecked,
  removeSourcePlaylistTracks,
} from '@/api/netease-direct'
import { mutatePlaylistTracks } from '@/services/playlist-track-mutation'
import type { PlaylistTrackFailure } from '@/types/playlist-operation'
import type {
  PlaylistCleanupPlan,
  PlaylistCleanupProgress,
  PlaylistCleanupResult,
  PlaylistSnapshot,
} from '@/types/playlist-cleanup'

const BATCH_SIZE = 100
let cleanupRunning = false

/** 比较完整的歌曲顺序，避免仅以数量相同判断歌单未变化。 */
function sameTrackIds(expected: readonly number[], actual: readonly number[]): boolean {
  return expected.length === actual.length && expected.every((id, index) => id === actual[index])
}

/** 为本次执行复制并冻结角色与歌曲列表，后续界面变更不能重定向移除目标。 */
function freezeSnapshot(snapshot: PlaylistSnapshot): PlaylistSnapshot {
  return Object.freeze({ ...snapshot, trackIds: Object.freeze([...snapshot.trackIds]) })
}

function assertDifferentPlaylists(sourceId: number, referenceId: number): void {
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 ||
      !Number.isSafeInteger(referenceId) || referenceId <= 0 || sourceId === referenceId) {
    throw new Error('请选择两个不同的歌单：A 待清理，B 只读对照')
  }
}

/** 登录账号必须仍与生成预览时相同；只能清理该账号自己创建的 A。 */
async function assertCurrentUser(userId: number): Promise<void> {
  if (await getCleanupUserId() !== userId) {
    throw new Error('登录账号已变化，已停止清理，请重新登录并比对')
  }
}

/**
 * 只读生成清理预览：确认当前账号与 A 的归属，按 A/B 实际返回的有效 ID 计算交集。
 * 歌曲名称和分类标签均不参与比对，B 的歌曲始终不进入写入流程。
 */
export async function previewPlaylistCleanup(
  userId: number,
  sourceId: number,
  referenceId: number
): Promise<PlaylistCleanupPlan> {
  assertDifferentPlaylists(sourceId, referenceId)
  await assertCurrentUser(userId)
  const [source, reference] = await Promise.all([
    getPlaylistSnapshotChecked(sourceId),
    getPlaylistSnapshotChecked(referenceId),
  ])
  if (source.creatorId !== userId) {
    throw new Error('只能清理当前账号自己创建的歌单 A')
  }
  const referenceIds = new Set(reference.trackIds)
  return Object.freeze({
    userId,
    source,
    reference,
    removableTrackIds: Object.freeze(source.trackIds.filter((id) => referenceIds.has(id))),
  })
}

/** 拒绝过期或被改写的清理计划，待移除集合必须严格等于预览 A/B 的交集。 */
function copyValidatedPlan(preview: PlaylistCleanupPlan): PlaylistCleanupPlan {
  const source = freezeSnapshot(preview.source)
  const reference = freezeSnapshot(preview.reference)
  assertDifferentPlaylists(source.id, reference.id)
  if (source.creatorId !== preview.userId) {
    throw new Error('清理计划中的歌单 A 不属于当前账号，请重新比对')
  }
  const referenceIds = new Set(reference.trackIds)
  const removableTrackIds = source.trackIds.filter((id) => referenceIds.has(id))
  if (!sameTrackIds(removableTrackIds, preview.removableTrackIds)) {
    throw new Error('待移除歌曲与歌单交集不一致，请重新比对')
  }
  return Object.freeze({
    userId: preview.userId,
    source,
    reference,
    removableTrackIds: Object.freeze(removableTrackIds),
  })
}

/** 每批前后核对已读取的 ID；A 只能发生预期移除，B 的 ID 与顺序必须保持一致。 */
async function assertPlaylistState(
  plan: PlaylistCleanupPlan,
  expectedSourceIds: readonly number[]
): Promise<void> {
  const [source, reference] = await Promise.all([
    getPlaylistSnapshotChecked(plan.source.id),
    getPlaylistSnapshotChecked(plan.reference.id),
  ])
  if (reference.creatorId !== plan.reference.creatorId || reference.name !== plan.reference.name ||
      !sameTrackIds(plan.reference.trackIds, reference.trackIds)) {
    throw new Error('对照歌单 B 的歌曲或顺序已变化，已停止后续清理，请重新比对')
  }
  if (source.creatorId !== plan.userId || source.name !== plan.source.name || !sameTrackIds(expectedSourceIds, source.trackIds)) {
    throw new Error('歌单 A 的内容与预期不一致，已停止后续清理，请重新比对')
  }
}

/** 重新读取实际结果；无法核验时保留未知状态，不用请求成功次数代替移除数量。 */
async function readCleanupResult(
  plan: PlaylistCleanupPlan,
  expectedSourceIds: readonly number[],
  failedTracks: readonly PlaylistTrackFailure[],
  failure: string | null
): Promise<PlaylistCleanupResult> {
  const [sourceRead, referenceRead] = await Promise.allSettled([
    getPlaylistSnapshotChecked(plan.source.id),
    getPlaylistSnapshotChecked(plan.reference.id),
  ])
  const referenceUnchanged = referenceRead.status === 'fulfilled'
    ? referenceRead.value.creatorId === plan.reference.creatorId && referenceRead.value.name === plan.reference.name &&
      sameTrackIds(plan.reference.trackIds, referenceRead.value.trackIds)
    : null
  let removedCount: number | null = null
  let remainingTrackCount: number | null = null
  let pendingCount: number | null = null
  let sourceVerified: boolean | null = null
  if (sourceRead.status === 'fulfilled') {
    const source = sourceRead.value
    const currentIds = new Set(source.trackIds)
    const removedIds = new Set(plan.removableTrackIds.filter((id) => !currentIds.has(id)))
    removedCount = removedIds.size
    pendingCount = plan.removableTrackIds.length - removedCount
    remainingTrackCount = source.trackIds.length
    sourceVerified = source.creatorId === plan.userId && source.name === plan.source.name &&
      sameTrackIds(expectedSourceIds, source.trackIds)
  }
  let accountVerified = false
  try { accountVerified = await getCleanupUserId() === plan.userId } catch { /* 无法确认账号时不报告完成。 */ }
  const failedIds = new Set(failedTracks.map((item) => item.songId))
  const pendingKnown = expectedSourceIds.every((id) => !plan.removableTrackIds.includes(id) || failedIds.has(id))
  const finished = !failure && accountVerified && sourceVerified === true && referenceUnchanged === true && pendingKnown
  const completed = finished && pendingCount === 0
  let message = completed
    ? '本次清理完成，已核验 A/B 可读取歌曲的内容与顺序'
    : finished ? '本次清理结束，已跳过 ' + failedIds.size + ' 首移除失败的歌曲，仍保留在 A；其余歌曲已处理，B 保持不变'
    : failure || '清理结果未通过完整核验，已停止后续清理'
  if (!finished) {
    if (referenceUnchanged === false) {
      message += '；检测到 B 的歌曲或顺序变化，本功能不会对 B 进行恢复或其他写入'
    }
    if (sourceVerified === false) message += '；A 中存在预期移除以外的变化'
    if (sourceRead.status === 'rejected' || referenceRead.status === 'rejected') {
      message += '；部分歌单未能重新读取，结果尚未全部核验，请重新比对'
    } else if (!failure && pendingCount !== 0) {
      message = '仍有待移除歌曲存在于 A，已停止清理，请重新比对'
    }
  }
  return {
    status: completed ? 'completed' : finished ? 'partial' : 'stopped',
    failedTracks,
    message,
    removedCount,
    remainingTrackCount,
    pendingCount,
    sourceVerified,
    referenceUnchanged,
  }
}

/**
 * 固定 A/B 角色后分批仅从 A 移除交集，每批前后核验内容与顺序。
 * 明确的单曲移除失败记录后继续；未知结果或额外变化停止写入，B 始终只读。
 */
export async function executePlaylistCleanup(
  preview: PlaylistCleanupPlan,
  onProgress?: (progress: PlaylistCleanupProgress) => void
): Promise<PlaylistCleanupResult> {
  if (cleanupRunning) throw new Error('已有歌单清理正在执行，请等待完成')
  const plan = copyValidatedPlan(preview)
  cleanupRunning = true
  let failure: string | null = null
  let expectedSourceIds = plan.source.trackIds
  const failedTracks: PlaylistTrackFailure[] = []
  try {
    try {
      await assertCurrentUser(plan.userId)
      await assertPlaylistState(plan, expectedSourceIds)
      for (let offset = 0; offset < plan.removableTrackIds.length; offset += BATCH_SIZE) {
        const batch = plan.removableTrackIds.slice(offset, offset + BATCH_SIZE)
        // 移除目标始终来自被冻结的 A，B 仅作为误写保护参数。
        await mutatePlaylistTracks({
          userId: plan.userId, playlist: plan.source, expectedIds: expectedSourceIds, trackIds: batch, operation: 'remove',
          write: (ids) => removeSourcePlaylistTracks(plan.source.id, plan.reference.id, ids),
          beforeWrite: () => assertPlaylistState(plan, expectedSourceIds),
          afterWrite: () => assertPlaylistState(plan, expectedSourceIds),
          onVerified: (current) => { expectedSourceIds = current }, onFailure: (item) => { failedTracks.push(item) },
        })
        onProgress?.({
          removedCount: plan.source.trackIds.length - expectedSourceIds.length,
          totalCount: plan.removableTrackIds.length,
        })
        if (offset + BATCH_SIZE < plan.removableTrackIds.length) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : '清理请求失败，已停止后续写入'
    }
    return await readCleanupResult(plan, expectedSourceIds, failedTracks, failure)
  } finally {
    cleanupRunning = false
  }
}
