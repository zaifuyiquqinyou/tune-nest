import type { PlaylistTrackFailure } from '@/types/playlist-operation'

interface Props {
  failures: readonly PlaylistTrackFailure[]
  songName?: (id: number) => string | undefined
}

/** 各类批量歌单操作共用失败清单，ID 始终显示，缺少详情也能定位到歌曲。 */
export function PlaylistFailures({ failures, songName }: Props) {
  if (!failures.length) return null
  return <details className="mt-3 text-xs" open>
    <summary className="cursor-pointer font-semibold">未完成歌曲 {new Set(failures.map((item) => item.songId)).size} 首（已跳过，详见下方）</summary>
    <ul className="space-y-2 mt-2 max-h-64 overflow-y-auto">
      {failures.map((item, index) => <li key={item.operation + ':' + item.playlistId + ':' + item.songId + ':' + index} className="break-words">
        <p className="font-semibold">{item.songName || songName?.(item.songId) || '歌曲详情不可用'} · ID {item.songId}</p>
        <p>{item.operation === 'add' ? '加入' : '移除'}「{item.playlistName}」失败：{item.message}</p>
      </li>)}
    </ul>
  </details>
}
