import type { PlaylistSnapshot } from './playlist-cleanup'

export type PlaylistSortMetric = 'added' | 'popularity' | 'plays-all' | 'plays-week'
export type PlaylistSortRule = PlaylistSortMetric | 'combined' | 'playlist-groups'
export type PlaylistSortMetrics = Readonly<Record<PlaylistSortMetric, number | null>>

export interface PlaylistSortOptions {
  readonly rule: PlaylistSortRule
  readonly direction: 'asc' | 'desc'
  readonly missing: 'last' | 'keep'
  /** 分类歌单的优先级顺序；未指定时读取账号歌单列表并排除当前目标。 */
  readonly referencePlaylistIds?: readonly number[]
}

/** 加入时间与 trackIds 逐项对应，未返回有效时间时为 null，不能用当前顺序推测。 */
export interface PlaylistSortSnapshot extends PlaylistSnapshot {
  readonly addedTimes: readonly (number | null)[]
  /** 平台单独返回的云盘歌曲数量，缺失或无效时为 null。 */
  readonly cloudTrackCount: number | null
}

export interface PlaylistSortSong {
  readonly songId: number
  readonly name: string
  readonly artists: readonly string[]
  readonly popularity: number | null
}

/** 只保存平台返回的次数；未上榜或只有 score 时均不能当作播放 0 次。 */
export interface PlaylistSortPlayCount {
  readonly songId: number
  readonly playCount: number | null
  readonly unavailableReason: 'missing' | 'score-only' | 'invalid' | null
}

/** 只用于说明当前排行的覆盖范围，不参与在线歌单写入。 */
export interface PlaylistSortPlayCountSummary {
  readonly returnedCount: number
  readonly usableCount: number
  readonly matchedCount: number
}

export interface PlaylistSortTrack {
  readonly songId: number
  readonly name: string
  readonly artists: readonly string[]
  readonly originalPosition: number
  readonly value: number | null
  readonly missingReason?: string
  /** 组合排序保留四项原始指标，执行时重新确定所属分组及实际比较值。 */
  readonly metrics?: PlaylistSortMetrics
  /** 按参考歌单优先级排列的所属歌单 ID，不包含当前待排序歌单。 */
  readonly playlistTags?: readonly number[]
}

export interface PlaylistSortGrouping {
  /** 只保存参考歌单与待排序歌单的交集，参考歌单始终只读。 */
  readonly references: readonly {
    readonly id: number
    readonly name: string
    readonly matchedTrackIds: readonly number[]
  }[]
  readonly failures: readonly { readonly id: number; readonly name: string; readonly message: string }[]
}

export interface PlaylistSortPlacement {
  readonly songId: number
  readonly anchorId: number
  readonly playlistId: number | null
  readonly groupIndex: number
}

export interface PlaylistSortPlan {
  readonly userId: number
  readonly playlist: PlaylistSortSnapshot
  readonly options: PlaylistSortOptions
  readonly tracks: readonly PlaylistSortTrack[]
  readonly orderedTrackIds: readonly number[]
  readonly knownCount: number
  readonly missingCount: number
  readonly changedCount: number
  readonly playCountSummary: PlaylistSortPlayCountSummary | null
  readonly combinedPlayCountSummaries: Readonly<Record<'week' | 'all', PlaylistSortPlayCountSummary>> | null
  readonly grouping: PlaylistSortGrouping | null
}

export interface PlaylistSortProgress {
  phase: 'reading' | 'details' | 'records' | 'categories' | 'checking' | 'writing' | 'verifying'
  completed: number
  total: number
}

/** 结果来自写入后回读；无法读取时为 null，不将请求成功等同于顺序生效。 */
export interface PlaylistSortResult {
  status: 'completed' | 'stopped'
  message: string
  membershipPreserved: boolean | null
  orderVerified: boolean | null
  accountVerified: boolean | null
  currentTrackCount: number | null
}
