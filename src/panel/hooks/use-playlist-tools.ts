import { useEffect, useRef, useState } from 'react'
import { getUserPlaylistsChecked } from '@/api/netease-direct'
import type { Playlist } from '@/types'

/** 导出可列出收藏歌单；页面自行将可修改目标限制为本人创建的歌单。 */
export function usePlaylistList(userId: number) {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    getUserPlaylistsChecked(userId)
      .then((items) => { if (active) setPlaylists(items) })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : '歌单读取失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [userId, revision])
  return { playlists, loading, error, reload: () => setRevision((value) => value + 1) }
}

/** 同步锁定任务及上层导航；有写入的操作期间提示用户不要离开页面。 */
export function usePlaylistOperation(onBusyChange: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  useEffect(() => () => onBusyChange(false), [onBusyChange])
  useEffect(() => {
    if (!writing) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [writing])
  const run = async (operation: () => Promise<void>, hasWrites = false) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setWriting(hasWrites)
    setError(null)
    onBusyChange(true)
    try {
      await operation()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重新读取后重试')
    } finally {
      busyRef.current = false
      setBusy(false)
      setWriting(false)
      onBusyChange(false)
    }
  }
  return { busy, busyRef, error, setError, run }
}
