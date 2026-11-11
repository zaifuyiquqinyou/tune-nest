import type { PlaylistTextDocument, PlaylistTextTrack } from '@/types/playlist-tools'

const MAGIC = '# TuneNest Playlist TXT v1'
const positiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** 一首歌只占一个物理行；JSON 转义可完整保留歌名中的换行、制表符和引号。 */
export function serializePlaylistText(document: PlaylistTextDocument): string {
  const { songs, ...metadata } = document
  return '\uFEFF' + [
    MAGIC,
    '# ' + JSON.stringify({ ...metadata, songCount: songs.length }),
    '# 每个 JSON 行依次包含歌曲 ID、歌名、歌手、专辑、时长及详情可用状态。',
    ...songs.map((song) => JSON.stringify(song)),
    '',
  ].join('\r\n')
}

/** 严格检查版本、来源和行数，截断文件或无效 ID 不会进入合并计划。 */
export function parsePlaylistText(text: string): PlaylistTextDocument {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0] !== MAGIC || !lines[1]?.startsWith('# ')) {
    throw new Error('不是受支持的 TuneNest 歌单 TXT，请使用本插件导出的文件')
  }
  let metadata: Record<string, unknown>
  try {
    metadata = JSON.parse(lines[1].slice(2))
  } catch {
    throw new Error('歌单 TXT 的来源信息不是有效 JSON')
  }
  if (!metadata || metadata.version !== 1 || metadata.platform !== 'netease' ||
      !positiveId(metadata.accountId) || !positiveId(metadata.playlistId) || !positiveId(metadata.ownerId) ||
      typeof metadata.playlistName !== 'string' || typeof metadata.exportedAt !== 'string' ||
      !Number.isFinite(Date.parse(metadata.exportedAt)) ||
      typeof metadata.reportedTrackCount !== 'number' || !Number.isSafeInteger(metadata.reportedTrackCount) ||
      metadata.reportedTrackCount < 0 || typeof metadata.songCount !== 'number' ||
      !Number.isSafeInteger(metadata.songCount) || metadata.songCount < 0) {
    throw new Error('歌单 TXT 的版本、来源或歌曲条数无效')
  }
  const songs: PlaylistTextTrack[] = []
  const seenIds = new Set<number>()
  for (let index = 2; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) continue
    let song: PlaylistTextTrack
    try {
      song = JSON.parse(line)
    } catch {
      throw new Error('歌单 TXT 第 ' + (index + 1) + ' 行不是有效 JSON')
    }
    if (!song || !positiveId(song.id) || typeof song.name !== 'string' ||
        !Array.isArray(song.artists) || song.artists.some((name) => typeof name !== 'string') ||
        typeof song.album !== 'string' || !Number.isFinite(song.durationMs) || song.durationMs < 0 ||
        typeof song.detailsAvailable !== 'boolean' || seenIds.has(song.id)) {
      throw new Error('歌单 TXT 第 ' + (index + 1) + ' 行的歌曲 ID 或详情无效、重复')
    }
    seenIds.add(song.id)
    songs.push(Object.freeze({ ...song, artists: Object.freeze([...song.artists]) }))
  }
  if (songs.length !== metadata.songCount) {
    throw new Error('歌单 TXT 记录 ' + metadata.songCount + ' 首，实际解析 ' + songs.length + ' 首，文件可能被截断')
  }
  return Object.freeze({
    version: 1,
    platform: 'netease',
    accountId: metadata.accountId,
    playlistId: metadata.playlistId,
    playlistName: metadata.playlistName,
    ownerId: metadata.ownerId,
    reportedTrackCount: metadata.reportedTrackCount,
    exportedAt: metadata.exportedAt,
    songs: Object.freeze(songs),
  })
}

/** 保留有效歌单名；Windows 禁用名称、字符和清洗后的同名文件加以区分。 */
export function playlistTextFilename(name: string, playlistId: number, usedNames: Set<string>): string {
  let base = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[ .]+$/g, '')
  base = Array.from(base || '未命名歌单').slice(0, 80).join('')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = '_' + base
  let filename = base + '.txt'
  let suffix = 0
  while (usedNames.has(filename.toLocaleLowerCase())) {
    filename = base + ' (' + playlistId + (suffix ? '-' + suffix : '') + ').txt'
    suffix++
  }
  usedNames.add(filename.toLocaleLowerCase())
  return filename
}
