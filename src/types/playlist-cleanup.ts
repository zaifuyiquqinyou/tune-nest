import type { PlaylistOperationStatus, PlaylistTrackFailure } from './playlist-operation'

/** 保留接口实际返回的歌曲顺序，统计总数仅作读取范围提示。 */
export interface PlaylistSnapshot {
  readonly id: number
  readonly name: string
  readonly creatorId: number
  readonly reportedTrackCount: number
  readonly trackIds: readonly number[]
}

/** A 为唯一允许移除歌曲的歌单，B 始终作为只读对照。 */
export interface PlaylistCleanupPlan {
  readonly userId: number
  readonly source: PlaylistSnapshot
  readonly reference: PlaylistSnapshot
  readonly removableTrackIds: readonly number[]
}

export interface PlaylistCleanupProgress {
  removedCount: number
  totalCount: number
}

/** 无法重新读取时返回 null，避免将未知状态显示为成功。 */
export interface PlaylistCleanupResult {
  status: PlaylistOperationStatus
  failedTracks: readonly PlaylistTrackFailure[]
  message: string
  removedCount: number | null
  remainingTrackCount: number | null
  pendingCount: number | null
  sourceVerified: boolean | null
  referenceUnchanged: boolean | null
}
