import {
  getCleanupUserId,
  getPlaylistSnapshotChecked,
  getSongDetailsChecked,
  getUserPlaylistsChecked,
} from '@/api/netease-direct'
import { playlistTextFilename, serializePlaylistText } from '@/utils/playlist-text'
import type { Song } from '@/types'
import type {
  PlaylistExportFile,
  PlaylistExportProgress,
  PlaylistExportResult,
  PlaylistTextDocument,
} from '@/types/playlist-tools'

/**
 * 只读导出账号的自建及收藏歌单，按实际 ID 保留每一条歌曲记录。
 * 详情缺失不丢 ID，个别歌单失败单独报告；本流程不调用任何歌单写接口。
 */
export async function exportAccountPlaylists(
  userId: number,
  write: (file: PlaylistExportFile) => Promise<void>,
  onProgress?: (progress: PlaylistExportProgress) => void
): Promise<PlaylistExportResult> {
  if (await getCleanupUserId() !== userId) throw new Error('登录账号已变化，请重新登录后导出')
  const playlists = await getUserPlaylistsChecked(userId)
  const result: PlaylistExportResult = {
    totalCount: playlists.length,
    exportedCount: 0,
    songCount: 0,
    detailsMissingCount: 0,
    countDifferences: [],
    failures: [],
  }
  const usedNames = new Set<string>()
  const details = new Map<number, Song>()
  const attemptedIds = new Set<number>()
  const exportedAt = new Date().toISOString()
  for (let index = 0; index < playlists.length; index++) {
    const playlist = playlists[index]
    try {
      if (await getCleanupUserId() !== userId) throw new Error('登录账号已变化')
    } catch {
      for (const remaining of playlists.slice(index)) {
        result.failures.push(remaining.name + '：无法确认原登录账号，未继续导出')
      }
      break
    }
    try {
      const snapshot = await getPlaylistSnapshotChecked(playlist.id)
      const missingIds = snapshot.trackIds.filter((id) => !attemptedIds.has(id))
      for (let offset = 0; offset < missingIds.length; offset += 200) {
        const batch = missingIds.slice(offset, offset + 200)
        batch.forEach((id) => attemptedIds.add(id))
        try {
          for (const song of await getSongDetailsChecked(batch)) details.set(song.id, song)
        } catch {
          // 失效歌曲或详情请求失败时仍导出对应 ID，避免备份遗漏成员。
        }
      }
      const songs = snapshot.trackIds.map((id) => {
        const song = details.get(id)
        return {
          id,
          name: song?.name || '',
          artists: song?.artists.map((artist) => artist.name) || [],
          album: song?.album.name || '',
          durationMs: song?.duration || 0,
          detailsAvailable: !!song?.name,
        }
      })
      const document: PlaylistTextDocument = {
        version: 1,
        platform: 'netease',
        accountId: userId,
        playlistId: snapshot.id,
        playlistName: snapshot.name,
        ownerId: snapshot.creatorId,
        reportedTrackCount: snapshot.reportedTrackCount,
        exportedAt,
        songs,
      }
      await write({
        name: playlistTextFilename(snapshot.name, snapshot.id, usedNames),
        content: serializePlaylistText(document),
      })
      result.exportedCount++
      result.songCount += songs.length
      result.detailsMissingCount += songs.filter((song) => !song.detailsAvailable).length
      if (snapshot.reportedTrackCount !== songs.length) {
        result.countDifferences.push(snapshot.name + '：统计 ' + snapshot.reportedTrackCount + ' 首，实际导出 ' + songs.length + ' 首')
      }
    } catch (err) {
      result.failures.push(playlist.name + '：' + (err instanceof Error ? err.message : '导出失败'))
    }
    onProgress?.({ completed: index + 1, total: playlists.length, playlistName: playlist.name })
  }
  return result
}
