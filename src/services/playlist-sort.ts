import {
  getCleanupUserId, getPlaylistSortPlayCountsChecked, getPlaylistSortSnapshotChecked,
  getPlaylistSortSongsChecked, updatePlaylistTrackOrderChecked, isUnavailableSongError,
  getUserPlaylistsChecked, NeteaseBusinessError,
} from '@/api/netease-direct'
import { resolveCombinedSortBasis, sortPlaylistTracks, validPlaylistSortValue, validatePlaylistSortOptions } from '@/utils/playlist-sort'
import type {
  PlaylistSortOptions, PlaylistSortPlan, PlaylistSortProgress, PlaylistSortResult,
  PlaylistSortSnapshot, PlaylistSortSong, PlaylistSortTrack,
  PlaylistSortPlayCount, PlaylistSortPlayCountSummary,
  PlaylistSortMetric, PlaylistSortMetrics,
  PlaylistSortGrouping,
} from '@/types/playlist-sort'

let sorting = false
const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, i) => id === b[i])

async function assertUser(userId: number): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || await getCleanupUserId() !== userId) {
    throw new Error('登录账号已变化或无法确认，请重新登录并预览')
  }
}

/** 平台统计可能已包含云盘歌曲；若未包含，额外成员数必须恰好等于有效的云盘统计。 */
function hasCompleteTrackCount(snapshot: PlaylistSortSnapshot): boolean {
  const { reportedTrackCount, cloudTrackCount, trackIds } = snapshot
  if (!Number.isSafeInteger(reportedTrackCount) || reportedTrackCount < 0) return false
  const extraCount = trackIds.length - reportedTrackCount
  return extraCount === 0 || (extraCount > 0 && typeof cloudTrackCount === 'number' &&
    Number.isSafeInteger(cloudTrackCount) && cloudTrackCount === extraCount)
}

/** 排序保留完整成员，兼容平台另计云盘数量；其余无法解释的数量差异仍拒绝写入。 */
function copySnapshot(snapshot: PlaylistSortSnapshot, userId: number): PlaylistSortSnapshot {
  if (!snapshot || !Number.isSafeInteger(snapshot.id) || snapshot.id <= 0 || snapshot.creatorId !== userId ||
      typeof snapshot.name !== 'string' || !Array.isArray(snapshot.trackIds) ||
      snapshot.trackIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(snapshot.trackIds).size !== snapshot.trackIds.length ||
      !Array.isArray(snapshot.addedTimes) || snapshot.addedTimes.length !== snapshot.trackIds.length ||
      snapshot.addedTimes.some((value) => !validPlaylistSortValue(value, 'added'))) {
    throw new Error('只能重排本人自建歌单，且歌单信息必须完整，请重新读取')
  }
  if (!hasCompleteTrackCount(snapshot)) {
    throw new Error('歌单统计 ' + snapshot.reportedTrackCount + ' 首，实际读取 ' + snapshot.trackIds.length +
      ' 个 ID，平台云盘统计 ' + (snapshot.cloudTrackCount ?? '未知') +
      ' 首。数量差异无法由云盘统计解释，排序需提交完整成员，本次不写入')
  }
  return Object.freeze({
    ...snapshot, trackIds: Object.freeze([...snapshot.trackIds]), addedTimes: Object.freeze([...snapshot.addedTimes]),
  })
}

/** 单曲详情被拒绝时拆分读取，失败歌曲以未知保留；热度接口整体不可用时仍停止预览。 */
async function readSongs(
  snapshot: PlaylistSortSnapshot, requirePopularity: boolean,
  onProgress?: (progress: PlaylistSortProgress) => void
): Promise<Map<number, PlaylistSortSong>> {
  const songs = new Map<number, PlaylistSortSong>()
  const readBatch = async (ids: readonly number[]): Promise<void> => {
    try {
      for (const song of await getPlaylistSortSongsChecked(ids)) songs.set(song.songId, song)
    } catch (err) {
      if (isUnavailableSongError(err)) {
        if (ids.length > 1) {
          const middle = Math.ceil(ids.length / 2)
          await readBatch(ids.slice(0, middle))
          await readBatch(ids.slice(middle))
        }
      } else if (requirePopularity) throw err
    }
  }
  for (let offset = 0; offset < snapshot.trackIds.length; offset += 200) {
    await readBatch(snapshot.trackIds.slice(offset, offset + 200))
    onProgress?.({ phase: 'details', completed: Math.min(offset + 200, snapshot.trackIds.length), total: snapshot.trackIds.length })
  }
  return songs
}

function freezeTracks(tracks: readonly PlaylistSortTrack[]): readonly PlaylistSortTrack[] {
  return Object.freeze(tracks.map((track) => Object.freeze({
    ...track, artists: Object.freeze([...track.artists]),
    ...(track.metrics ? { metrics: Object.freeze({ ...track.metrics }) } : {}),
    ...(track.playlistTags ? { playlistTags: Object.freeze([...track.playlistTags]) } : {}),
  })))
}

function freezeOptions(options: PlaylistSortOptions): PlaylistSortOptions {
  return Object.freeze({ ...options,
    ...(options.referencePlaylistIds ? { referencePlaylistIds: Object.freeze([...options.referencePlaylistIds]) } : {}),
  })
}

/** 固定参考分类的交集与读取失败项，核对标记来自所选参考歌单，不能把目标自身当作分类。 */
function copyGrouping(
  grouping: PlaylistSortGrouping | null, playlist: PlaylistSortSnapshot,
  options: PlaylistSortOptions, tracks: readonly PlaylistSortTrack[]
): PlaylistSortGrouping | null {
  if (options.rule !== 'playlist-groups') return null
  const ids = options.referencePlaylistIds
  if (!ids || ids.includes(playlist.id) || !grouping || !Array.isArray(grouping.references) || !Array.isArray(grouping.failures)) {
    throw new Error('分类排序缺少有效的参考歌单，请重新预览')
  }
  const selected = new Set(ids)
  const seen = new Set<number>()
  const tags = new Map(playlist.trackIds.map((id) => [id, [] as number[]]))
  for (const reference of grouping.references) {
    if (!reference || !selected.has(reference.id) || seen.has(reference.id) || typeof reference.name !== 'string' ||
        !Array.isArray(reference.matchedTrackIds) || new Set(reference.matchedTrackIds).size !== reference.matchedTrackIds.length ||
        reference.matchedTrackIds.some((id: number) => !tags.has(id))) throw new Error('分类歌单交集无效，请重新预览')
    seen.add(reference.id)
    for (const id of reference.matchedTrackIds) tags.get(id)!.push(reference.id)
  }
  const successful = new Set(seen)
  for (const failure of grouping.failures) {
    if (!failure || !selected.has(failure.id) || seen.has(failure.id) || typeof failure.name !== 'string' ||
        typeof failure.message !== 'string') throw new Error('分类歌单读取结果无效，请重新预览')
    seen.add(failure.id)
  }
  if (seen.size !== ids.length || !sameIds(ids.filter((id) => successful.has(id)), grouping.references.map((item) => item.id)) ||
      tracks.some((track) => !Array.isArray(track.playlistTags) || !sameIds(track.playlistTags, tags.get(track.songId) || []))) {
    throw new Error('歌曲分类标记与参考歌单不一致，请重新预览')
  }
  return Object.freeze({
    references: Object.freeze(grouping.references.map((item) => Object.freeze({
      ...item, matchedTrackIds: Object.freeze([...item.matchedTrackIds]),
    }))),
    failures: Object.freeze(grouping.failures.map((item) => Object.freeze({ ...item }))),
  })
}

function createPlan(
  userId: number, playlist: PlaylistSortSnapshot, options: PlaylistSortOptions, tracks: readonly PlaylistSortTrack[],
  playCountSummary: PlaylistSortPlayCountSummary | null = null,
  combinedPlayCountSummaries: PlaylistSortPlan['combinedPlayCountSummaries'] = null,
  grouping: PlaylistSortGrouping | null = null
): PlaylistSortPlan {
  const fixedGrouping = copyGrouping(grouping, playlist, options, tracks)
  const orderedTrackIds = sortPlaylistTracks(tracks, options)
  const originalIds = new Set(playlist.trackIds)
  if (orderedTrackIds.length !== playlist.trackIds.length || new Set(orderedTrackIds).size !== originalIds.size ||
      orderedTrackIds.some((id) => !originalIds.has(id))) throw new Error('排序结果未完整保留原歌单成员，本次不允许写入')
  const knownCount = tracks.filter((track) => options.rule === 'playlist-groups' ? track.playlistTags!.length > 0 : track.value !== null).length
  return Object.freeze({
    userId, playlist, options: freezeOptions(options), tracks: freezeTracks(tracks), orderedTrackIds,
    knownCount, missingCount: tracks.length - knownCount,
    changedCount: orderedTrackIds.filter((id, index) => playlist.trackIds[index] !== id).length,
    playCountSummary: playCountSummary ? Object.freeze({ ...playCountSummary }) : null,
    combinedPlayCountSummaries: combinedPlayCountSummaries ? Object.freeze({
      week: Object.freeze({ ...combinedPlayCountSummaries.week }), all: Object.freeze({ ...combinedPlayCountSummaries.all }),
    }) : null,
    grouping: fixedGrouping,
  })
}

/** 区分未上榜与次数未提供，让预览说明为什么某首歌不能参与数值比较。 */
function describeMissingSortValue(rule: PlaylistSortMetric, record?: PlaylistSortPlayCount): string {
  if (rule === 'added') return '平台未返回有效的加入时间'
  if (rule === 'popularity') return '平台未返回有效的歌曲热度'
  if (!record) return '该歌曲未出现在本次返回的' + (rule === 'plays-all' ? '累计' : '最近一周') + '听歌排行中'
  if (record.unavailableReason === 'score-only') return '已在本次排行中，但平台只返回排行分数，未提供听歌次数'
  if (record.unavailableReason === 'invalid') return '已在本次排行中，但平台返回的次数不是有效的非负整数'
  return '已在本次排行中，但平台未返回听歌次数'
}

function summarizePlayCounts(records: readonly PlaylistSortPlayCount[], trackIds: readonly number[]): PlaylistSortPlayCountSummary {
  const members = new Set(trackIds)
  return {
    returnedCount: records.length, usableCount: records.filter((record) => record.playCount !== null).length,
    matchedCount: records.filter((record) => members.has(record.songId)).length,
  }
}

/**
 * 分别读取周排行与累计排行，结合热度和加入时间确定每首歌的首个大于 0 的指标。
 * 0 或未知均使用下一指标，无可用指标仍保留原成员；整个指标接口读取失败则停止预览。
 */
async function previewCombinedSort(
  userId: number, playlist: PlaylistSortSnapshot, options: PlaylistSortOptions,
  songs: ReadonlyMap<number, PlaylistSortSong>, onProgress?: (progress: PlaylistSortProgress) => void
): Promise<PlaylistSortPlan> {
  onProgress?.({ phase: 'records', completed: 0, total: 2 })
  const week = await getPlaylistSortPlayCountsChecked(userId, 'week')
  onProgress?.({ phase: 'records', completed: 1, total: 2 })
  const all = await getPlaylistSortPlayCountsChecked(userId, 'all')
  onProgress?.({ phase: 'records', completed: 2, total: 2 })
  const weekCounts = new Map(week.map((record) => [record.songId, record.playCount]))
  const allCounts = new Map(all.map((record) => [record.songId, record.playCount]))
  const tracks = playlist.trackIds.map((songId, index): PlaylistSortTrack => {
    const song = songs.get(songId)
    const metrics: PlaylistSortMetrics = {
      'plays-week': weekCounts.get(songId) ?? null, 'plays-all': allCounts.get(songId) ?? null,
      popularity: song?.popularity ?? null, added: playlist.addedTimes[index],
    }
    const basis = resolveCombinedSortBasis(metrics)
    return {
      songId, name: song?.name || '', artists: song?.artists || [], originalPosition: index + 1,
      value: basis.value, metrics,
      missingReason: basis.rule === null ? '周次数、累计次数和热度均为 0 或未知，且加入时间未知，保留原相对顺序' : undefined,
    }
  })
  await assertUser(userId)
  return createPlan(userId, playlist, options, tracks, null, {
    week: summarizePlayCounts(week, playlist.trackIds), all: summarizePlayCounts(all, playlist.trackIds),
  })
}

/**
 * 按参考歌单优先级读取完整成员并标记交集，再从原顺序逐段聚拢同类歌曲。
 * 参考歌单只读；个别参考读取失败会列明并跳过，登录或限流异常停止预览，任何歌曲都不会因此省略。
 */
async function previewPlaylistGroups(
  userId: number, playlist: PlaylistSortSnapshot, options: PlaylistSortOptions,
  songs: ReadonlyMap<number, PlaylistSortSong>, onProgress?: (progress: PlaylistSortProgress) => void
): Promise<PlaylistSortPlan> {
  const available = (await getUserPlaylistsChecked(userId)).filter((item) => item.id !== playlist.id)
  const byId = new Map(available.map((item) => [item.id, item]))
  const ids = options.referencePlaylistIds || available.map((item) => item.id)
  if (ids.some((id) => !byId.has(id))) throw new Error('参考歌单包含当前歌单或已不在账号列表中，请重新选择')
  const references: PlaylistSortGrouping['references'][number][] = []
  const failures: PlaylistSortGrouping['failures'][number][] = []
  const tags = new Map(playlist.trackIds.map((id) => [id, [] as number[]]))
  onProgress?.({ phase: 'categories', completed: 0, total: ids.length })
  for (const id of ids) {
    try {
      const snapshot = await getPlaylistSortSnapshotChecked(id)
      if (!hasCompleteTrackCount(snapshot)) throw new Error('参考歌单的成员数量不完整，本次不使用该分类')
      const members = new Set(snapshot.trackIds)
      const matchedTrackIds = playlist.trackIds.filter((songId) => members.has(songId))
      references.push({ id, name: snapshot.name, matchedTrackIds })
      for (const songId of matchedTrackIds) tags.get(songId)!.push(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : '参考歌单读取失败'
      if ((err instanceof NeteaseBusinessError && [301, 302, 401, 429].includes(err.code!)) ||
          /Request failed:\s*(?:401|429)\b|登录|登陆|验证码|风控|频繁|请求过多/.test(message)) throw err
      failures.push({ id, name: byId.get(id)!.name, message })
    }
    onProgress?.({ phase: 'categories', completed: references.length + failures.length, total: ids.length })
  }
  const tracks = playlist.trackIds.map((songId, index): PlaylistSortTrack => {
    const song = songs.get(songId)
    return { songId, name: song?.name || '', artists: song?.artists || [], originalPosition: index + 1,
      value: null, playlistTags: tags.get(songId)!,
    }
  })
  await assertUser(userId)
  return createPlan(userId, playlist, { ...options, referencePlaylistIds: ids }, tracks, null, null, { references, failures })
}

/**
 * 只读生成完整歌单的新顺序：校验本人归属和成员完整性，加载指定指标，稳定排序并固定预览。
 * 加入时间来自成员 at，热度来自 pop，次数仅来自本人指定期间的听歌排行。
 * 组合模式依次按周次数、累计次数、热度、加入时间分组；单项模式保留原有规则。
 * 分类聚拢模式使用其他歌单的成员交集，以原顺序中的未排定歌曲为起点逐段排列。
 * 缺失数据始终保留歌曲，不推测时间、不填充播放 0 次；任何接口失败都不会触发在线写入。
 */
export async function previewPlaylistSort(
  userId: number, playlistId: number, options: PlaylistSortOptions,
  onProgress?: (progress: PlaylistSortProgress) => void
): Promise<PlaylistSortPlan> {
  validatePlaylistSortOptions(options)
  const fixedOptions = freezeOptions(options)
  await assertUser(userId)
  onProgress?.({ phase: 'reading', completed: 0, total: 1 })
  const playlist = copySnapshot(await getPlaylistSortSnapshotChecked(playlistId), userId)
  const songs = await readSongs(playlist, fixedOptions.rule === 'popularity' || fixedOptions.rule === 'combined', onProgress)
  if (fixedOptions.rule === 'combined') return previewCombinedSort(userId, playlist, fixedOptions, songs, onProgress)
  if (fixedOptions.rule === 'playlist-groups') return previewPlaylistGroups(userId, playlist, fixedOptions, songs, onProgress)
  const singleRule = fixedOptions.rule
  const counts = new Map<number, PlaylistSortPlayCount>()
  let playCountSummary: PlaylistSortPlayCountSummary | null = null
  if (fixedOptions.rule === 'plays-all' || fixedOptions.rule === 'plays-week') {
    onProgress?.({ phase: 'records', completed: 0, total: 1 })
    const records = await getPlaylistSortPlayCountsChecked(userId, fixedOptions.rule === 'plays-all' ? 'all' : 'week')
    for (const record of records) counts.set(record.songId, record)
    playCountSummary = summarizePlayCounts(records, playlist.trackIds)
  }
  const tracks = playlist.trackIds.map((songId, index): PlaylistSortTrack => {
    const song = songs.get(songId)
    const record = counts.get(songId)
    const value = singleRule === 'added' ? playlist.addedTimes[index]
      : singleRule === 'popularity' ? song?.popularity ?? null : record?.playCount ?? null
    return {
      songId, name: song?.name || '', artists: song?.artists || [], originalPosition: index + 1,
      value, missingReason: value === null ? describeMissingSortValue(singleRule, record) : undefined,
    }
  })
  await assertUser(userId)
  return createPlan(userId, playlist, fixedOptions, tracks, playCountSummary)
}

/** 重新计算预览，拒绝成员变化和排序结果篡改；执行期间只使用独立的不可变副本。 */
function copyPlan(preview: PlaylistSortPlan): PlaylistSortPlan {
  if (!preview || !Number.isSafeInteger(preview.userId) || preview.userId <= 0) throw new Error('排序账号无效，请重新预览')
  const playlist = copySnapshot(preview.playlist, preview.userId)
  validatePlaylistSortOptions(preview.options)
  if (!Array.isArray(preview.tracks) || preview.tracks.length !== playlist.trackIds.length ||
      preview.tracks.some((track, index) => !track || track.songId !== playlist.trackIds[index] ||
        typeof track.name !== 'string' || !Array.isArray(track.artists) || track.artists.some((artist: unknown) => typeof artist !== 'string') ||
        (preview.options.rule === 'added' && track.value !== playlist.addedTimes[index]) ||
        (preview.options.rule === 'combined' && track.metrics?.added !== playlist.addedTimes[index]))) {
    throw new Error('排序歌曲与完整歌单不一致，请重新预览')
  }
  const plan = createPlan(preview.userId, playlist, preview.options, preview.tracks, null, null, preview.grouping)
  if (!Array.isArray(preview.orderedTrackIds) || !sameIds(plan.orderedTrackIds, preview.orderedTrackIds) ||
      plan.knownCount !== preview.knownCount || plan.missingCount !== preview.missingCount || plan.changedCount !== preview.changedCount) {
    throw new Error('排序结果与预览规则不一致，请重新预览')
  }
  return plan
}

async function assertUnchanged(plan: PlaylistSortPlan): Promise<void> {
  const current = copySnapshot(await getPlaylistSortSnapshotChecked(plan.playlist.id), plan.userId)
  if (current.name !== plan.playlist.name || !sameIds(current.trackIds, plan.playlist.trackIds) ||
      current.addedTimes.some((value, index) => value !== plan.playlist.addedTimes[index])) {
    throw new Error('歌单内容、顺序、名称或加入时间已变化，已停止，请重新预览')
  }
}

/** 回读实际成员与顺序，失败或结果未知时不自动再次写入，也不尝试删后重建。 */
async function readResult(plan: PlaylistSortPlan, failure: string | null): Promise<PlaylistSortResult> {
  const reads = await Promise.allSettled([getPlaylistSortSnapshotChecked(plan.playlist.id), getCleanupUserId()])
  const current = reads[0].status === 'fulfilled' ? reads[0].value : null
  const accountVerified = reads[1].status === 'fulfilled' ? reads[1].value === plan.userId : null
  const original = new Set(plan.playlist.trackIds)
  const completeSnapshot = !!current && hasCompleteTrackCount(current)
  const membershipPreserved = completeSnapshot && current ? current.creatorId === plan.userId &&
    current.trackIds.length === original.size && current.trackIds.every((id) => original.has(id)) : null
  const orderVerified = completeSnapshot && current ? membershipPreserved === true && sameIds(current.trackIds, plan.orderedTrackIds) : null
  const completed = !failure && accountVerified === true && current?.name === plan.playlist.name &&
    completeSnapshot && membershipPreserved === true && orderVerified === true
  let message = completed
    ? plan.changedCount > 0 ? '排序完成，已核验歌曲成员全部保留、顺序符合预览' : '当前顺序已符合规则，无需修改'
    : (failure || '当前顺序未通过完整核验') + '。已停止，未自动重试或回滚，请重新读取核对'
  if (!completed && orderVerified === true) message += '；回读顺序已符合预览，但本次请求或账号状态未完整确认'
  if (membershipPreserved === false) message += '；检测到歌曲成员或归属变化，请核对歌单'
  if (!current) message += '；歌单回读失败，当前状态未知'
  if (current && !completeSnapshot) {
    message += '；回读统计 ' + current.reportedTrackCount + ' 首、实际 ' + current.trackIds.length +
      ' 个 ID、平台云盘统计 ' + (current.cloudTrackCount ?? '未知') + ' 首，完整成员和顺序未能核验'
  }
  return {
    status: completed ? 'completed' : 'stopped', message, membershipPreserved, orderVerified,
    accountVerified, currentTrackCount: current?.trackIds.length ?? null,
  }
}

/**
 * 校验冻结预览和当前账号，重新核对完整歌单后，一次提交原成员的完整排列并回读核验。
 * 不增删歌曲、不分批替换；请求中断或业务失败只回读，不盲目重试写操作。
 * 平台无条件更新接口不能锁住其他客户端，执行期间的外部修改只能在核验时发现。
 */
export async function executePlaylistSort(
  preview: PlaylistSortPlan, onProgress?: (progress: PlaylistSortProgress) => void
): Promise<PlaylistSortResult> {
  if (sorting) throw new Error('已有歌单排序正在执行，请等待完成')
  const plan = copyPlan(preview)
  sorting = true
  let failure: string | null = null
  try {
    try {
      onProgress?.({ phase: 'checking', completed: 0, total: 1 })
      await assertUser(plan.userId)
      await assertUnchanged(plan)
      await assertUser(plan.userId)
      if (plan.changedCount > 0) {
        onProgress?.({ phase: 'writing', completed: 0, total: 1 })
        await updatePlaylistTrackOrderChecked(plan.playlist.id, plan.playlist.trackIds, plan.orderedTrackIds)
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : '排序请求失败，当前结果未确认'
    }
    onProgress?.({ phase: 'verifying', completed: 0, total: 1 })
    return await readResult(plan, failure)
  } finally {
    sorting = false
  }
}
