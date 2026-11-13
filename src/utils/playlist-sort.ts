import type { PlaylistSortMetric, PlaylistSortMetrics, PlaylistSortOptions, PlaylistSortTrack } from '@/types/playlist-sort'
import { groupPlaylistTracks } from './playlist-group-sort'

export const PLAYLIST_SORT_LABELS = {
  added: '加入歌单的时间',
  popularity: '平台歌曲热度',
  'plays-all': '本人累计听歌排行次数',
  'plays-week': '本人最近一周听歌排行次数',
  combined: '组合排序：周次数 → 累计次数 → 热度 → 加入时间',
  'playlist-groups': '按已有歌单分类聚拢（适合“最近”）',
} as const

export const COMBINED_SORT_RULES: readonly PlaylistSortMetric[] = Object.freeze(['plays-week', 'plays-all', 'popularity', 'added'])

export function validatePlaylistSortOptions(options: PlaylistSortOptions): void {
  if (!options || !Object.prototype.hasOwnProperty.call(PLAYLIST_SORT_LABELS, options.rule) ||
      !['asc', 'desc'].includes(options.direction) || !['last', 'keep'].includes(options.missing) ||
      (['combined', 'playlist-groups'].includes(options.rule) && (options.direction !== 'desc' || options.missing !== 'last'))) {
    throw new Error('排序规则、方向或缺失数据处理方式无效，请重新预览')
  }
  if (options.referencePlaylistIds !== undefined && (!Array.isArray(options.referencePlaylistIds) ||
      new Set(options.referencePlaylistIds).size !== options.referencePlaylistIds.length ||
      options.referencePlaylistIds.some((id) => !Number.isSafeInteger(id) || id <= 0))) {
    throw new Error('分类歌单优先级无效，请重新预览')
  }
}

export function validPlaylistSortValue(value: unknown, rule: PlaylistSortMetric): value is number | null {
  if (value === null) return true
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false
  if (rule === 'added') return Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000
  if (rule === 'popularity') return value <= 100
  return Number.isSafeInteger(value)
}

/** 按第一个大于 0 的指标分组；0 和未知均使用下一指标，无可用指标时进入最后一组。 */
export function resolveCombinedSortBasis(metrics: PlaylistSortMetrics | undefined): {
  rule: PlaylistSortMetric | null; groupIndex: number; value: number | null
} {
  if (!metrics || COMBINED_SORT_RULES.some((rule) => !validPlaylistSortValue(metrics[rule], rule))) {
    throw new Error('组合排序缺少完整有效的四项指标，请重新读取歌单')
  }
  const index = COMBINED_SORT_RULES.findIndex((rule) => metrics[rule] !== null && metrics[rule]! > 0)
  const rule = index < 0 ? null : COMBINED_SORT_RULES[index]
  return { rule, groupIndex: index < 0 ? COMBINED_SORT_RULES.length : index, value: rule ? metrics[rule] : null }
}

/**
 * 只重排已有成员；同值保留原顺序，缺失数据可稳定放到末尾或固定在原位置。
 * 单项规则保留显式 0 与未知的区别；原始指标始终不把未知转换成 0。
 * 组合规则在前面指标为 0 或未知时启用下一指标，各组降序，同值与无可用指标仍稳定排序。
 */
export function sortPlaylistTracks(
  tracks: readonly PlaylistSortTrack[], options: PlaylistSortOptions
): readonly number[] {
  validatePlaylistSortOptions(options)
  if (options.rule === 'playlist-groups') {
    if (!Array.isArray(tracks)) throw new Error('分类排序歌曲数据无效，请重新预览')
    return Object.freeze(groupPlaylistTracks(tracks, options.referencePlaylistIds || []).map((item) => item.songId))
  }
  const rule = options.rule
  if (!Array.isArray(tracks) || new Set(tracks.map((track) => track?.songId)).size !== tracks.length ||
      tracks.some((track, index) => !track || !Number.isSafeInteger(track.songId) || track.songId <= 0 ||
        track.originalPosition !== index + 1 ||
        (rule !== 'combined' && !validPlaylistSortValue(track.value, rule)))) {
    throw new Error('歌曲排序数据无效，请重新读取歌单')
  }
  if (options.rule === 'combined') {
    const grouped = tracks.map((track) => {
      const basis = resolveCombinedSortBasis(track.metrics)
      if (track.value !== basis.value) throw new Error('组合排序的比较值与原始指标不一致，请重新预览')
      return { track, ...basis }
    })
    grouped.sort((a, b) => a.groupIndex - b.groupIndex ||
      (a.value === null ? 0 : b.value! - a.value) || a.track.originalPosition - b.track.originalPosition)
    return Object.freeze(grouped.map((item) => item.track.songId))
  }
  const direction = options.direction === 'asc' ? 1 : -1
  const known = tracks.filter((track) => track.value !== null).sort((a, b) =>
    direction * (a.value! - b.value!) || a.originalPosition - b.originalPosition)
  if (options.missing === 'last') {
    return Object.freeze([...known, ...tracks.filter((track) => track.value === null)].map((track) => track.songId))
  }
  let index = 0
  return Object.freeze(tracks.map((track) => track.value === null ? track.songId : known[index++].songId))
}
