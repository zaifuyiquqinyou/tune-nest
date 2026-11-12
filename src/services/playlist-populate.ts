import { addTargetPlaylistTracks, clearPlaylistTracks, getCleanupUserId, getPlaylistSnapshotChecked } from '@/api/netease-direct'
import { mutatePlaylistTracks } from '@/services/playlist-track-mutation'
import type { PlaylistOperationStatus, PlaylistTrackFailure } from '@/types/playlist-operation'

interface PopulateResult {
  readonly status: PlaylistOperationStatus
  readonly message: string
  readonly failedTracks: readonly PlaylistTrackFailure[]
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, i) => id === b[i])

/**
 * 分类结果先补入并回读目标，单曲失败跳过并汇总。
 * 替换模式只有在全部新歌曲已存在时才移除旧歌；缺歌时保留全部旧歌，避免先清空造成丢失。
 * 未知写入结果或额外变化停止后续写入，由调用方停止剩余歌单任务。
 */
export async function populatePlaylistChecked(
  userId: number, playlistId: number, trackIds: readonly number[], replace: boolean
): Promise<PopulateResult> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Array.isArray(trackIds) ||
      !trackIds.length || trackIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('分类歌曲 ID 无效')
  const desired = new Set(trackIds)
  const snapshot = await getPlaylistSnapshotChecked(playlistId)
  if (snapshot.creatorId !== userId || await getCleanupUserId() !== userId) throw new Error('账号或目标歌单归属已变化，请重新读取')
  let expected = snapshot.trackIds
  const failedTracks: PlaylistTrackFailure[] = []
  let failure: string | null = null
  try {
    const missing = [...desired].filter((id) => !expected.includes(id))
    for (let offset = 0; offset < missing.length; offset += 100) {
      await mutatePlaylistTracks({
        userId, playlist: snapshot, expectedIds: expected, trackIds: missing.slice(offset, offset + 100), operation: 'add',
        write: (ids) => addTargetPlaylistTracks(playlistId, [], ids),
        onVerified: (ids) => { expected = ids }, onFailure: (item) => { failedTracks.push(item) },
      })
      if (offset + 100 < missing.length) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    // 任何新歌未加入都保留旧歌；这是一次未完成的替换，不能把部分加入当作完整替换。
    if (replace && [...desired].every((id) => expected.includes(id))) {
      const obsolete = snapshot.trackIds.filter((id) => !desired.has(id))
      for (let offset = 0; offset < obsolete.length; offset += 100) {
        await mutatePlaylistTracks({
          userId, playlist: snapshot, expectedIds: expected, trackIds: obsolete.slice(offset, offset + 100), operation: 'remove',
          write: (ids) => clearPlaylistTracks(playlistId, [...ids]),
          onVerified: (ids) => { expected = ids }, onFailure: (item) => { failedTracks.push(item) },
        })
        if (offset + 100 < obsolete.length) await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : '写入结果未知'
  }
  try {
    const current = await getPlaylistSnapshotChecked(playlistId)
    if (await getCleanupUserId() !== userId || current.creatorId !== userId || current.name !== snapshot.name ||
        !sameIds(expected, current.trackIds)) throw new Error('目标最终状态未通过核验')
  } catch (err) {
    failure ||= err instanceof Error ? err.message : '最终状态读取失败'
  }
  return {
    status: failure ? 'stopped' : failedTracks.length ? 'partial' : 'completed',
    failedTracks,
    message: failure ? failure + '；已停止后续歌单写入，已加入的歌曲保留'
      : failedTracks.length ? '本歌单处理结束，部分歌曲已跳过' +
        (replace && failedTracks.some((item) => item.operation === 'add') ? '；新歌未全部补齐，旧歌全部保留，未完成替换' : '')
      : replace ? '替换完成并通过核验' : '添加完成并通过核验',
  }
}
