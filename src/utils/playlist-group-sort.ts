import type { PlaylistSortPlacement, PlaylistSortTrack } from '@/types/playlist-sort'

/**
 * 依原顺序选取未排定的起始歌曲，按其歌单标记优先级依次接入同类歌曲。
 * 同一标记内保持原相对顺序，已接入歌曲不再作为起始歌曲展开，未匹配歌曲也逐一保留。
 */
export function groupPlaylistTracks(
  tracks: readonly PlaylistSortTrack[], referencePlaylistIds: readonly number[]
): readonly PlaylistSortPlacement[] {
  if (!Array.isArray(tracks)) throw new Error('分类排序歌曲数据无效，请重新预览')
  if (!Array.isArray(referencePlaylistIds) || new Set(referencePlaylistIds).size !== referencePlaylistIds.length ||
      referencePlaylistIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('分类歌单优先级无效，请重新预览')
  }
  const priority = new Map(referencePlaylistIds.map((id, index) => [id, index]))
  const buckets = new Map<number, PlaylistSortTrack[]>()
  const members = new Set<number>()
  for (const [index, track] of tracks.entries()) {
    if (!track || !Number.isSafeInteger(track.songId) || track.songId <= 0 || members.has(track.songId) ||
        track.originalPosition !== index + 1 || track.value !== null || !Array.isArray(track.playlistTags)) {
      throw new Error('分类排序歌曲数据无效，请重新预览')
    }
    members.add(track.songId)
    let previous = -1
    for (const id of track.playlistTags) {
      const rank = priority.get(id)
      if (rank === undefined || rank <= previous) throw new Error('歌曲分类标记与歌单优先级不一致，请重新预览')
      previous = rank
      const bucket = buckets.get(id) || []
      bucket.push(track)
      buckets.set(id, bucket)
    }
  }
  const placed = new Set<number>()
  const placements: PlaylistSortPlacement[] = []
  let groupIndex = 0
  for (const anchor of tracks) {
    if (placed.has(anchor.songId)) continue
    placed.add(anchor.songId)
    placements.push(Object.freeze({ songId: anchor.songId, anchorId: anchor.songId, playlistId: null, groupIndex }))
    for (const playlistId of anchor.playlistTags!) {
      for (const track of buckets.get(playlistId) || []) {
        if (placed.has(track.songId)) continue
        placed.add(track.songId)
        placements.push(Object.freeze({ songId: track.songId, anchorId: anchor.songId, playlistId, groupIndex }))
      }
      // 此分类的所有成员均已排定，后续无需重复扫描。
      buckets.delete(playlistId)
    }
    groupIndex++
  }
  return Object.freeze(placements)
}
