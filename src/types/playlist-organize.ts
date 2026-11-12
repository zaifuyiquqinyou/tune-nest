import type { PlaylistSnapshot } from './playlist-cleanup'
import type { PlaylistOperationStatus, PlaylistTrackFailure } from './playlist-operation'
import type { PlaylistTextTrack } from './playlist-tools'

/** include 只接收勾选目标；exclude 接收未被排除的本人歌单，来源始终排除。 */
export interface OrganizeScope {
  readonly mode: 'include' | 'exclude'
  readonly playlistIds: readonly number[]
}

export interface OrganizeRule {
  readonly id: string
  readonly kind: 'artist' | 'album' | 'text'
  readonly value: string
  readonly targetPlaylistId: number
}

export interface OrganizeAssignment {
  readonly songId: number
  readonly targetPlaylistIds: readonly number[]
}

export interface OrganizePreferences {
  version: 1
  sourceId: number | null
  mode: 'include' | 'exclude'
  includedIds: number[]
  excludedIds: number[]
  rules: OrganizeRule[]
  decisions: OrganizeAssignment[]
}

export interface OrganizeCandidate {
  readonly playlistId: number
  readonly certain: boolean
  readonly reason: string
  /** 本地推荐强度用于比较候选，不代表正确率；AI 和手工去向没有本地分数。 */
  readonly score: number | null
  readonly defaultSelected: boolean
}

export interface OrganizeRecommendation {
  readonly songId: number
  readonly candidates: readonly OrganizeCandidate[]
  readonly warning: string | null
  readonly selectionReason: string
}

export interface OrganizeProfile {
  readonly snapshot: PlaylistSnapshot
  readonly tracks: readonly PlaylistTextTrack[]
}

/** 预览固定可用目标及在线快照；勾选结果另外提交，不能改变该范围。 */
export interface PlaylistOrganizePreview {
  readonly userId: number
  readonly scope: OrganizeScope
  readonly source: PlaylistSnapshot
  readonly targets: readonly PlaylistSnapshot[]
  readonly tracks: readonly PlaylistTextTrack[]
  readonly recommendations: readonly OrganizeRecommendation[]
  readonly aiTargets: readonly OrganizeAITarget[]
  readonly warnings: readonly string[]
}

export interface OrganizeAITarget {
  readonly id: number
  readonly name: string
  readonly examples: readonly { name: string; artists: readonly string[]; album: string }[]
}

export interface OrganizeAIInput {
  readonly songs: readonly PlaylistTextTrack[]
  readonly targets: readonly OrganizeAITarget[]
}

export interface OrganizeAIOutput {
  readonly songId: number
  readonly targetPlaylistIds: readonly number[]
  readonly reason: string
}

export interface OrganizeProgress {
  phase: 'reading' | 'details' | 'ai' | 'adding' | 'removing' | 'verifying'
  completed: number
  total: number
  name?: string
}

export interface OrganizeTargetResult {
  id: number
  name: string
  addedCount: number | null
  missingCount: number | null
  originalPreserved: boolean | null
  verified: boolean | null
}

/** 数量来自重新读取的 ID；无法核验的字段保留 null。 */
export interface PlaylistOrganizeResult {
  status: PlaylistOperationStatus
  failedTracks: readonly PlaylistTrackFailure[]
  message: string
  completedSongIds: readonly number[]
  selectedCount: number
  leftUntouchedCount: number
  removedCount: number | null
  sourceRemainingCount: number | null
  sourceVerified: boolean | null
  targets: OrganizeTargetResult[]
}
