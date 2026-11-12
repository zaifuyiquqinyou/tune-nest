import type { PlaylistSnapshot } from './playlist-cleanup'
import type { PlaylistOperationStatus, PlaylistTrackFailure } from './playlist-operation'

export interface PlaylistTextTrack {
  readonly id: number
  readonly name: string
  readonly artists: readonly string[]
  readonly album: string
  readonly durationMs: number
  readonly detailsAvailable: boolean
}

/** TXT 的首部记录来源与实际导出条数，每个后续非注释行保存一首歌的 JSON。 */
export interface PlaylistTextDocument {
  readonly version: 1
  readonly platform: 'netease'
  readonly accountId: number
  readonly playlistId: number
  readonly playlistName: string
  readonly ownerId: number
  readonly reportedTrackCount: number
  readonly exportedAt: string
  readonly songs: readonly PlaylistTextTrack[]
}

export interface PlaylistExportFile {
  name: string
  content: string
}

export interface PlaylistExportProgress {
  completed: number
  total: number
  playlistName: string
}

export interface PlaylistExportResult {
  totalCount: number
  exportedCount: number
  songCount: number
  detailsMissingCount: number
  countDifferences: string[]
  failures: string[]
}

/** 文件只能指定候选 ID；移除前必须重新核对在线来源的归属及完整返回顺序。 */
export interface PlaylistMergeSource {
  readonly playlistId: number
  readonly name: string
  readonly trackIds: readonly number[]
  readonly removalTrackIds: readonly number[]
  readonly snapshot: PlaylistSnapshot | null
  readonly reportedTrackCount: number
}

export type PlaylistMergeInput =
  | { kind: 'online'; playlistIds: readonly number[] }
  | { kind: 'files'; documents: readonly PlaylistTextDocument[] }

export interface PlaylistMergePlan {
  readonly userId: number
  readonly move: boolean
  readonly target: PlaylistSnapshot
  readonly sources: readonly PlaylistMergeSource[]
  readonly incomingTrackIds: readonly number[]
  readonly missingTargetTrackIds: readonly number[]
}

export interface PlaylistMergeProgress {
  phase: 'adding' | 'removing' | 'verifying'
  completed: number
  total: number
  sourceName?: string
}

export interface PlaylistMergeSourceResult {
  playlistId: number
  name: string
  removedCount: number | null
  pendingCount: number | null
  remainingCount: number | null
  verified: boolean | null
}

export interface PlaylistMergeResult {
  status: PlaylistOperationStatus
  failedTracks: readonly PlaylistTrackFailure[]
  message: string
  addedCount: number | null
  missingTargetCount: number | null
  targetPreserved: boolean | null
  targetTrackCount: number | null
  sources: PlaylistMergeSourceResult[]
}
