import type { Playlist, Song, Artist, Album } from '@/types'
import type { PlaylistSnapshot } from '@/types/playlist-cleanup'

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
  const res = await req<Record<string, any>>(
    '/api/playlist/create',
    { name, privacy: 0, type: 'NORMAL' }
  )
  console.info('[TuneNest] createPlaylist response:', JSON.stringify(res).substring(0, 300))
  const pid = res.id || res.playlist?.id
  if (!pid) {
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
  if (trackIds.length === 0) return
  for (let i = 0; i < trackIds.length; i += 100) {
    await req('/api/playlist/manipulate/tracks', {
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
      throw new Error(response?.message || response?.msg || '网易云接口未返回业务成功结果')
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

/** 仅列出当前账号创建的歌单，分页读取时拒绝重复页或空的后续页。 */
export async function getCleanupPlaylists(userId: number): Promise<Playlist[]> {
  const ownedPlaylists: Playlist[] = []
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
      if (playlist.creator.userId === userId) ownedPlaylists.push(playlist)
    }
    more = response.more === true
    if (more && freshCount === 0) {
      throw new Error('歌单列表分页未返回新数据，请重试')
    }
    offset += response.playlist.length
  }
  return ownedPlaylists
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
