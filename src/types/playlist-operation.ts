/** 已确认只影响指定歌曲的失败；来源中的该歌曲应保留，其他歌曲可以继续处理。 */
export interface PlaylistTrackFailure {
  readonly songId: number
  readonly playlistId: number
  readonly playlistName: string
  readonly operation: 'add' | 'remove'
  readonly message: string
  readonly songName?: string
}

export type PlaylistOperationStatus = 'completed' | 'partial' | 'stopped'
