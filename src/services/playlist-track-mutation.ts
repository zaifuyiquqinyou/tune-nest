import { getCleanupUserId, getPlaylistSnapshotChecked, isUnavailableSongError } from '@/api/netease-direct'
import type { PlaylistSnapshot } from '@/types/playlist-cleanup'
import type { PlaylistTrackFailure } from '@/types/playlist-operation'

interface MutationOptions {
  readonly userId: number
  readonly playlist: PlaylistSnapshot
  readonly expectedIds: readonly number[]
  readonly trackIds: readonly number[]
  readonly operation: 'add' | 'remove'
  readonly write: (ids: readonly number[]) => Promise<void>
  readonly beforeWrite?: () => Promise<void>
  readonly afterWrite?: () => Promise<void>
  readonly onVerified: (ids: readonly number[]) => void
  readonly onFailure: (failure: PlaylistTrackFailure) => void
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, i) => id === b[i])

/** 只允许本次指定 ID 的增加或移除；原有其他成员、顺序、名称和归属出现变化即停止。 */
function verifyMutation(
  options: MutationOptions, previous: readonly number[], attempted: readonly number[], current: PlaylistSnapshot
): void {
  const original = new Set(previous)
  const batch = new Set(attempted)
  const sameOwner = current.id === options.playlist.id && current.creatorId === options.userId && current.name === options.playlist.name
  const valid = options.operation === 'add'
    ? current.trackIds.every((id) => original.has(id) || batch.has(id)) &&
      sameIds(previous, current.trackIds.filter((id) => original.has(id)))
    : current.trackIds.every((id) => original.has(id)) &&
      sameIds(previous.filter((id) => !batch.has(id)), current.trackIds.filter((id) => !batch.has(id))) &&
      sameIds(previous.filter((id) => current.trackIds.includes(id)), current.trackIds)
  if (!sameOwner || !valid) throw new Error('歌单「' + options.playlist.name + '」出现非预期的成员、顺序或归属变化，已停止后续写入')
}

/**
 * 执行一批歌曲并回读实际变化。明确的单曲业务拒绝会拆分定位，跳过失败 ID 后继续。
 * 请求成功但部分 ID 未生效时记录这些 ID；网络中断、权限及未知错误不重试。
 * 每次拆分前后仍检查账号及调用方的来源／目标约束，确认成功的 ID 不会重复提交。
 */
export async function mutatePlaylistTracks(options: MutationOptions): Promise<void> {
  let expected = options.expectedIds
  const validIds = (ids: readonly number[]) => Array.isArray(ids) && new Set(ids).size === ids.length &&
    ids.every((id) => Number.isSafeInteger(id) && id > 0)
  if (!Number.isSafeInteger(options.userId) || options.userId <= 0 || options.playlist.creatorId !== options.userId ||
      !validIds(expected) || !validIds(options.trackIds) || options.trackIds.length > 100 ||
      !['add', 'remove'].includes(options.operation) ||
      options.trackIds.some((id) => options.operation === 'add' ? expected.includes(id) : !expected.includes(id))) {
    throw new Error('歌曲处理范围无效，未执行写入')
  }
  const attempt = async (ids: readonly number[]): Promise<void> => {
    if (!ids.length) return
    await options.beforeWrite?.()
    const before = await getPlaylistSnapshotChecked(options.playlist.id)
    if (before.creatorId !== options.userId || before.name !== options.playlist.name || !sameIds(expected, before.trackIds)) {
      throw new Error('歌单「' + options.playlist.name + '」已变化，请重新读取后继续')
    }
    if (await getCleanupUserId() !== options.userId) throw new Error('登录账号已变化，已停止后续写入')
    let rejection: string | null = null
    let fatalError: unknown
    let writeFailed = false
    try {
      await options.write(ids)
    } catch (err) {
      if (isUnavailableSongError(err)) rejection = err.message
      else { writeFailed = true; fatalError = err }
    }
    const current = await getPlaylistSnapshotChecked(options.playlist.id)
    verifyMutation(options, expected, ids, current)
    expected = current.trackIds
    options.onVerified(expected)
    await options.afterWrite?.()
    // 未知错误仍停止；回读只为报告已经发生的变化，绝不据此自动重试。
    if (writeFailed) throw fatalError
    const members = new Set(expected)
    const pending = ids.filter((id) => options.operation === 'add' ? !members.has(id) : members.has(id))
    if (!pending.length) return
    if (rejection && ids.length > 1 && pending.length > 1) {
      const middle = Math.ceil(pending.length / 2)
      await attempt(pending.slice(0, middle))
      await new Promise((resolve) => setTimeout(resolve, 500))
      await attempt(pending.slice(middle))
      return
    }
    // 已确认仅剩一个失败 ID，或成功响应中有明确未生效的 ID，无需重复写入试探。
    for (const songId of pending) options.onFailure({
      songId, playlistId: options.playlist.id, playlistName: options.playlist.name, operation: options.operation,
      message: rejection || (options.operation === 'add' ? '平台未实际加入该歌曲，已跳过并保留来源' : '平台未实际移除该歌曲，已保留并继续'),
    })
  }
  await attempt(options.trackIds)
}
