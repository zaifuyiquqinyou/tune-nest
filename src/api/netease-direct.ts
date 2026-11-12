import type { Playlist, Song, Artist, Album } from '@/types'
import type { PlaylistSnapshot } from '@/types/playlist-cleanup'
import type { PlaylistSortPlayCount, PlaylistSortSnapshot, PlaylistSortSong } from '@/types/playlist-sort'

const BASE_URL = 'https://music.163.com'

function getCsrf(): string {
  const match = document.cookie.match(/(?:^|;\s*)__csrf=([^;]+)/)
  return match?.[1] || ''
}

async function req<T>(
  path: string,
  params: Record<string, string | number> = {},
  method: 'GET' | 'POST' = 'POST',
  signal?: AbortSignal
): Promise<T> {
  const csrf = getCsrf()
  if (csrf) params['csrf_token'] = csrf

  const url = new URL(`${BASE_URL}${path}`)
  const opts: RequestInit = {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
  }

  if (method === 'POST') {
    opts.body = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()
  } else {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)))
  }

  const res = await fetch(url.toString(), opts)
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function getLoginStatusDirect(): Promise<{ userId: number; nickname: string } | null> {
  try {
    console.info('[TuneNest] checking login, cookie:', document.cookie.substring(0, 100))
    const res = await req<Record<string, unknown>>('/api/w/nuser/account/get')
    console.info('[TuneNest] login API response:', JSON.stringify(res).substring(0, 500))
    // 尝试多种响应格式
    const profile = (res as any)?.data?.profile || (res as any)?.profile || null
    console.info('[TuneNest] parsed profile:', profile)
    return profile
  } catch (err) {
    console.error('[TuneNest] login check error:', err)
    return null
  }
}

export async function getUserPlaylistsDirect(uid: number): Promise<Playlist[]> {
  const res = await req<{ playlist?: Playlist[] }>(
    '/api/user/playlist',
    { uid, limit: 1000, offset: 0 }
  )
  return res.playlist || []
}

export async function getPlaylistDetailDirect(id: number): Promise<Song[]> {
  const res = await req<{
    playlist?: {
      trackIds?: Array<{ id: number }>
      tracks?: Array<{
        id: number; name: string
        ar: Array<{ id: number; name: string }>
        al: { id: number; name: string; publishTime?: number }
        dt: number
      }>
    }
  }>('/api/v6/playlist/detail', { id, n: 100000 })

  const tracks = res.playlist?.tracks || []

  if (tracks.length === 0 && (res.playlist?.trackIds?.length ?? 0) > 0) {
    const ids = res.playlist!.trackIds!.map((t) => t.id)
    const batched: Song[] = []
    for (let i = 0; i < ids.length; i += 1000) {
      const part = await getSongDetailsDirect(ids.slice(i, i + 1000))
      batched.push(...part)
      if (i + 1000 < ids.length) await new Promise((r) => setTimeout(r, 500))
    }
    return batched
  }

  return tracks.map((t) => ({
    id: t.id,
    name: t.name,
    artists: t.ar.map((a): Artist => ({ id: a.id, name: a.name })),
    album: { id: t.al.id, name: t.al.name, publishTime: t.al.publishTime } as Album,
    duration: t.dt,
  }))
}

export async function getSongDetailsDirect(ids: number[]): Promise<Song[]> {
  const c = JSON.stringify(ids.map((id) => ({ id })))
  const res = await req<{
    songs?: Array<{
      id: number; name: string
      ar: Array<{ id: number; name: string }>
      al: { id: number; name: string; publishTime?: number }
      dt: number
    }>
  }>('/api/v3/song/detail', { c })
  return (res.songs || []).map((t) => ({
    id: t.id,
    name: t.name,
    artists: t.ar.map((a): Artist => ({ id: a.id, name: a.name })),
    album: { id: t.al.id, name: t.al.name, publishTime: t.al.publishTime } as Album,
    duration: t.dt,
  }))
}

export async function createPlaylistDirect(name: string): Promise<number> {
  const res = await cleanupRequest<CleanupApiResponse & { id?: number; playlist?: { id?: number } }>(
    '/api/playlist/create',
    { name, privacy: 0, type: 'NORMAL' }
  )
  console.info('[TuneNest] createPlaylist response:', JSON.stringify(res).substring(0, 300))
  const pid = res.id || res.playlist?.id
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
    throw new Error(`创建歌单失败: ${res.code || res.message || JSON.stringify(res).substring(0, 100)}`)
  }
  return pid
}

export async function findPlaylistByName(
  uid: number,
  name: string
): Promise<{ id: number; trackCount: number } | null> {
  const playlists = await getUserPlaylistsDirect(uid)
  const found = playlists.find((p) => p.name === name && p.creator.userId === uid)
  return found ? { id: found.id, trackCount: found.trackCount } : null
}

export async function clearPlaylistTracks(pid: number, trackIds: number[]): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || new Set(trackIds).size !== trackIds.length ||
      trackIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('待替换歌单或歌曲 ID 无效')
  if (trackIds.length === 0) return
  for (let i = 0; i < trackIds.length; i += 100) {
    await cleanupRequest('/api/playlist/manipulate/tracks', {
      op: 'del',
      pid,
      trackIds: JSON.stringify(trackIds.slice(i, i + 100)),
      imme: 'true',
    })
    if (i + 100 < trackIds.length) await new Promise((r) => setTimeout(r, 500))
  }
}

export async function getPlaylistTrackIds(pid: number): Promise<number[]> {
  const res = await req<{
    playlist?: { trackIds?: Array<{ id: number }> }
  }>('/api/v6/playlist/detail', { id: pid, n: 0 })
  return res.playlist?.trackIds?.map((t) => t.id) || []
}

export async function addSongsToPlaylistDirect(pid: number, trackIds: number[]): Promise<void> {
  await req('/api/playlist/manipulate/tracks', {
    op: 'add',
    pid,
    trackIds: JSON.stringify(trackIds),
    imme: 'true',
  })
}

/** 保留业务错误码，避免将网络中断、权限失败与可跳过的单曲拒绝混为一谈。 */
export class NeteaseBusinessError extends Error {
  constructor(readonly code: number | undefined, message: string) {
    super(message)
    this.name = 'NeteaseBusinessError'
  }
}

/** 只识别明确的歌曲级拒绝；登录、权限、风控、容量和未知异常均由上层停止处理。 */
export function isUnavailableSongError(error: unknown): error is NeteaseBusinessError {
  if (!(error instanceof NeteaseBusinessError) || !Number.isInteger(error.code) ||
      [301, 302, 401, 403, 429].includes(error.code!) ||
      /登录|登陆|权限|频繁|验证码|风控|上限|歌单.{0,10}(?:不存在|删除|已满)|请求过多/.test(error.message)) return false
  return /下架|无版权|版权.{0,8}(?:限制|无法|不能)|(?:歌曲|音乐|资源).{0,12}(?:不存在|已删除|已被删除|不可用|无法收藏|不能收藏|无法添加|不能添加|无法移除|不能移除|无法删除|不能删除)/.test(error.message)
}

interface CleanupApiResponse {
  code?: number
  message?: string
  msg?: string
}

/** 清理操作必须确认业务成功；超时只表示结果未知，不表示服务端未执行。 */
async function cleanupRequest<T extends CleanupApiResponse>(
  path: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await req<T>(path, params, 'POST', controller.signal)
    if (!response || response.code !== 200) {
      throw new NeteaseBusinessError(response?.code, response?.message || response?.msg || '网易云接口未返回业务成功结果')
    }
    return response
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('网易云请求超时，请重新读取歌单核对当前状态')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/** 执行清理前重新检查登录账号，防止沿用页面初始化时的过期身份。 */
export async function getCleanupUserId(): Promise<number> {
  const response = await cleanupRequest<CleanupApiResponse & {
    profile?: { userId?: number }
    data?: { profile?: { userId?: number } }
  }>('/api/w/nuser/account/get')
  const userId = (response.data?.profile || response.profile)?.userId
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('无法确认当前登录账号，请重新登录网易云音乐')
  }
  return userId
}

/** 分页读取账号的自建及收藏歌单，供只读导出使用。 */
export async function getUserPlaylistsChecked(userId: number): Promise<Playlist[]> {
  const playlists: Playlist[] = []
  const seenIds = new Set<number>()
  let offset = 0
  let more = true
  while (more) {
    const response = await cleanupRequest<CleanupApiResponse & {
      playlist?: Playlist[]
      more?: boolean
    }>('/api/user/playlist', { uid: userId, limit: 1000, offset })
    if (!Array.isArray(response.playlist)) {
      throw new Error('歌单列表读取不完整，请重试')
    }
    let freshCount = 0
    for (const playlist of response.playlist) {
      if (!playlist || !Number.isSafeInteger(playlist.id) || playlist.id <= 0 ||
          typeof playlist.name !== 'string' || !playlist.creator) {
        throw new Error('歌单列表包含无效数据，请重试')
      }
      if (seenIds.has(playlist.id)) continue
      seenIds.add(playlist.id)
      freshCount++
      playlists.push(playlist)
    }
    more = response.more === true
    if (more && freshCount === 0) {
      throw new Error('歌单列表分页未返回新数据，请重试')
    }
    offset += response.playlist.length
  }
  return playlists
}

/** 清理和移动的在线来源仅允许选择本人创建的歌单。 */
export async function getCleanupPlaylists(userId: number): Promise<Playlist[]> {
  return (await getUserPlaylistsChecked(userId)).filter((playlist) => playlist.creator.userId === userId)
}

/** 获取备份所需的歌曲详情；无详情的歌曲仍由上层按 ID 保留。 */
export async function getSongDetailsChecked(ids: readonly number[]): Promise<Song[]> {
  if (ids.length === 0) return []
  if (ids.length > 200 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('歌曲详情查询参数无效')
  }
  const response = await cleanupRequest<CleanupApiResponse & {
    songs?: Array<{
      id: number
      name?: string
      ar?: Array<{ id: number; name: string }>
      al?: { id: number; name: string }
      dt?: number
    }>
  }>('/api/v3/song/detail', { c: JSON.stringify(ids.map((id) => ({ id }))) })
  if (!Array.isArray(response.songs)) throw new Error('歌曲详情读取不完整')
  const requested = new Set(ids)
  return response.songs.filter((song) => song && requested.has(song.id)).map((song) => ({
    id: song.id,
    name: typeof song.name === 'string' ? song.name : '',
    artists: Array.isArray(song.ar) ? song.ar.filter((artist) => artist && typeof artist.name === 'string') : [],
    album: { id: song.al?.id || 0, name: typeof song.al?.name === 'string' ? song.al.name : '' },
    duration: typeof song.dt === 'number' && Number.isFinite(song.dt) && song.dt >= 0 ? song.dt : 0,
  }))
}

/** 只向目标补入缺少的歌曲，不允许将任一来源误用作目标或覆盖目标内容。 */
export async function addTargetPlaylistTracks(
  targetId: number,
  sourceIds: readonly number[],
  trackIds: readonly number[]
): Promise<void> {
  if (!Number.isSafeInteger(targetId) || targetId <= 0 || sourceIds.includes(targetId) ||
      sourceIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('合并目标必须是不同于所有来源的有效歌单')
  }
  if (trackIds.length === 0) return
  if (trackIds.length > 100 || new Set(trackIds).size !== trackIds.length ||
      trackIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('本批待添加歌曲 ID 无效')
  }
  await cleanupRequest('/api/playlist/manipulate/tracks', {
    op: 'add',
    pid: targetId,
    trackIds: JSON.stringify(trackIds),
    imme: 'true',
  })
}

/** 比对实际返回的歌曲 ID；统计总数可能过期，不能代替有效 ID 或阻断只读比对。 */
export async function getPlaylistSnapshotChecked(playlistId: number): Promise<PlaylistSnapshot> {
  const response = await cleanupRequest<CleanupApiResponse & {
    playlist?: {
      id?: number
      name?: string
      creator?: { userId?: number }
      trackCount?: number
      trackIds?: Array<{ id: number }>
    }
  }>('/api/v6/playlist/detail', { id: playlistId, n: 0 })
  const playlist = response.playlist
  const creatorId = playlist?.creator?.userId
  if (!playlist || playlist.id !== playlistId || typeof playlist.name !== 'string' ||
      typeof creatorId !== 'number' || !Number.isSafeInteger(creatorId) || creatorId <= 0 ||
      typeof playlist.trackCount !== 'number' || !Number.isSafeInteger(playlist.trackCount) ||
      playlist.trackCount < 0 || !Array.isArray(playlist.trackIds)) {
    throw new Error('歌单信息读取不完整（歌单 ID ' + playlistId + '），无法比对，请重试')
  }
  const trackIds = playlist.trackIds.map((track) => track?.id)
  if (trackIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('歌单「' + playlist.name + '」返回了无效歌曲 ID，无法比对，请重试')
  }
  if (new Set(trackIds).size !== trackIds.length) {
    throw new Error('歌单「' + playlist.name + '」返回了重复歌曲 ID，无法可靠比对，请重试')
  }
  return Object.freeze({
    id: playlistId,
    name: playlist.name,
    creatorId,
    reportedTrackCount: playlist.trackCount,
    trackIds: Object.freeze(trackIds),
  })
}

/**
 * 仅从 A 移除一批明确指定的歌曲；B 的 ID 只用于阻止误写。
 * 业务返回失败或请求中断时交由清理服务重新读取，不自动重试写操作。
 */
export async function removeSourcePlaylistTracks(
  sourcePlaylistId: number,
  protectedPlaylistId: number,
  trackIds: readonly number[]
): Promise<void> {
  if (!Number.isSafeInteger(sourcePlaylistId) || sourcePlaylistId <= 0 ||
      !Number.isSafeInteger(protectedPlaylistId) || protectedPlaylistId <= 0 ||
      sourcePlaylistId === protectedPlaylistId) {
    throw new Error('待清理歌单 A 与只读对照歌单 B 必须是两个不同的有效歌单')
  }
  if (trackIds.length === 0) return
  if (trackIds.length > 100 || new Set(trackIds).size !== trackIds.length ||
      trackIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('本批待移除歌曲 ID 无效，已停止清理')
  }
  await cleanupRequest('/api/playlist/manipulate/tracks', {
    op: 'del',
    pid: sourcePlaylistId,
    trackIds: JSON.stringify(trackIds),
    imme: 'true',
  })
}

export interface PlayRecordItem {
  playCount: number
  score: number
  song: Song
}

export async function getPlayRecordDirect(
  uid: number,
  type: 0 | 1 = 0
): Promise<PlayRecordItem[]> {
  const res = await req<Record<string, any>>(
    '/api/v1/play/record',
    { uid, type }
  )

  const rawList: Array<{ playCount: number; score: number; song: any }> =
    type === 0 ? res.allData || [] : res.weekData || []

  return rawList.map((item) => ({
    playCount: item.playCount,
    score: item.score,
    song: {
      id: item.song.id,
      name: item.song.name,
      artists: (item.song.ar || []).map((a: any): Artist => ({ id: a.id, name: a.name })),
      album: {
        id: item.song.al?.id,
        name: item.song.al?.name,
        publishTime: item.song.al?.publishTime,
      } as Album,
      duration: item.song.dt,
    },
  }))
}

/** 排序独立读取完整成员及加入时间，不改变导出、清理等功能对统计数量差异的处理。 */
export async function getPlaylistSortSnapshotChecked(playlistId: number): Promise<PlaylistSortSnapshot> {
  if (!Number.isSafeInteger(playlistId) || playlistId <= 0) throw new Error('请选择有效的待排序歌单')
  const response = await cleanupRequest<CleanupApiResponse & {
    playlist?: {
      id?: number; name?: string; creator?: { userId?: number }; trackCount?: number; cloudTrackCount?: number
      trackIds?: Array<{ id: number; at?: number }>
    }
  }>('/api/v6/playlist/detail', { id: playlistId, n: 0 })
  const playlist = response.playlist
  const creatorId = playlist?.creator?.userId
  if (!playlist || playlist.id !== playlistId || typeof playlist.name !== 'string' ||
      typeof creatorId !== 'number' || !Number.isSafeInteger(creatorId) || creatorId <= 0 ||
      typeof playlist.trackCount !== 'number' || !Number.isSafeInteger(playlist.trackCount) ||
      playlist.trackCount < 0 || !Array.isArray(playlist.trackIds)) {
    throw new Error('歌单信息或完整成员读取失败，无法安全排序，请重新读取')
  }
  const ids = playlist.trackIds.map((track) => track?.id)
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error('歌单返回了无效或重复歌曲 ID，无法安全排序')
  }
  return Object.freeze({
    id: playlistId, name: playlist.name, creatorId, reportedTrackCount: playlist.trackCount,
    cloudTrackCount: typeof playlist.cloudTrackCount === 'number' && Number.isSafeInteger(playlist.cloudTrackCount) &&
      playlist.cloudTrackCount >= 0 ? playlist.cloudTrackCount : null,
    trackIds: Object.freeze(ids),
    addedTimes: Object.freeze(playlist.trackIds.map((track) =>
      typeof track.at === 'number' && Number.isSafeInteger(track.at) && track.at > 0 &&
      track.at <= 8640000000000000 ? track.at : null)),
  })
}

/** 热度使用歌曲详情 pop，保留 0；详情或指标缺失用 null 表示，不用其他分数替代。 */
export async function getPlaylistSortSongsChecked(ids: readonly number[]): Promise<PlaylistSortSong[]> {
  if (!Array.isArray(ids) || ids.length > 200 || new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('排序歌曲详情查询参数无效')
  if (ids.length === 0) return []
  const response = await cleanupRequest<CleanupApiResponse & {
    songs?: Array<{ id: number; name?: string; ar?: Array<{ name?: string }>; pop?: number }>
  }>('/api/v3/song/detail', { c: JSON.stringify(ids.map((id) => ({ id }))) })
  if (!Array.isArray(response.songs)) throw new Error('未能读取歌曲详情及热度，请重新预览')
  const requested = new Set(ids)
  const songs = response.songs.filter((song) => song && requested.has(song.id))
  if (new Set(songs.map((song) => song.id)).size !== songs.length) throw new Error('歌曲详情返回重复 ID，无法确定热度')
  return songs.map((song) => Object.freeze({
    songId: song.id, name: typeof song.name === 'string' ? song.name : '',
    artists: Object.freeze(Array.isArray(song.ar)
      ? song.ar.filter((artist) => artist && typeof artist.name === 'string').map((artist) => artist.name!) : []),
    popularity: typeof song.pop === 'number' && Number.isFinite(song.pop) && song.pop >= 0 && song.pop <= 100 ? song.pop : null,
  }))
}

/** 读取指定期间的真实次数，兼容整数文本；保留未返回次数的原因，score 不能代替次数。 */
export async function getPlaylistSortPlayCountsChecked(
  userId: number, period: 'all' | 'week'
): Promise<readonly PlaylistSortPlayCount[]> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !['all', 'week'].includes(period)) {
    throw new Error('听歌排行的账号或统计范围无效')
  }
  const response = await cleanupRequest<CleanupApiResponse & {
    allData?: Array<{ song?: { id?: number }; playCount?: unknown; score?: unknown }>
    weekData?: Array<{ song?: { id?: number }; playCount?: unknown; score?: unknown }>
  }>('/api/v1/play/record', { uid: userId, type: period === 'all' ? 0 : 1 })
  const records = period === 'all' ? response.allData : response.weekData
  if (!Array.isArray(records)) throw new Error('平台未返回所选时间范围的听歌排行，无法按次数排序')
  const ids = records.map((item) => item?.song?.id)
  if (ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length) throw new Error('听歌排行包含无效或重复歌曲 ID，无法确定次数')
  return Object.freeze(records.map((item): PlaylistSortPlayCount => {
    const rawCount = typeof item.playCount === 'string' && /^\d+$/.test(item.playCount.trim())
      ? Number(item.playCount.trim()) : item.playCount
    const playCount = typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : null
    const unavailableReason = playCount !== null ? null : item.playCount == null
      ? item.score != null ? 'score-only' : 'missing' : 'invalid'
    return Object.freeze({ songId: item.song!.id!, playCount, unavailableReason })
  }))
}

/** 一次提交完整 ID 排列，只更新顺序；禁止分批替换、遗漏成员、增加歌曲或删后重加。 */
export async function updatePlaylistTrackOrderChecked(
  playlistId: number, originalIds: readonly number[], orderedIds: readonly number[]
): Promise<void> {
  const validIds = (ids: readonly number[]) => Array.isArray(ids) &&
    ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length
  const original = new Set(Array.isArray(originalIds) ? originalIds : [])
  if (!Number.isSafeInteger(playlistId) || playlistId <= 0 || !validIds(originalIds) || !validIds(orderedIds) ||
      originalIds.length !== orderedIds.length || orderedIds.some((id) => !original.has(id))) {
    throw new Error('排序必须包含当前歌单的全部歌曲，且不能增加、遗漏或重复 ID')
  }
  if (originalIds.every((id, index) => id === orderedIds[index])) return
  await cleanupRequest('/api/playlist/manipulate/tracks', {
    pid: playlistId, trackIds: JSON.stringify(orderedIds), op: 'update',
  })
}
