import { useCallback, useEffect, useState } from 'react'
import {
  listNotifications,
  markAllAsRead,
  markAsRead,
} from '../services/notificationService'

export function useNotifications(uid) {
  const [result, setResult] = useState({ uid: '', items: [] })
  const notifications = result.uid === uid ? result.items : []
  const loading = Boolean(uid) && result.uid !== uid

  const unreadCount = notifications.filter((n) => !n.read).length

  // 앱 진입(uid 변경) 시 1회만 로드 — 주기적 폴링/onSnapshot 없음
  useEffect(() => {
    if (!uid) return undefined

    let active = true

    listNotifications(uid)
      .then((items) => {
        if (active) {
          setResult({ uid, items })
        }
      })
      .catch(() => {
        if (active) setResult({ uid, items: [] })
      })

    return () => { active = false }
  }, [uid])

  // 벨 아이콘 클릭 등 사용자 명시 액션 시 호출
  const refresh = useCallback(async () => {
    if (!uid) return
    try {
      const items = await listNotifications(uid)
      setResult({ uid, items })
    } catch {
      // ignore
    }
  }, [uid])

  const handleMarkAsRead = useCallback(async (notificationId) => {
    await markAsRead(notificationId)
    setResult((prev) => ({
      ...prev,
      items: prev.items.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
    }))
  }, [])

  const handleMarkAllAsRead = useCallback(async () => {
    if (!uid) return
    await markAllAsRead(uid)
    setResult((prev) => ({
      ...prev,
      items: prev.items.map((n) => ({ ...n, read: true })),
    }))
  }, [uid])

  return {
    notifications,
    unreadCount,
    loading,
    refresh,
    markAsRead: handleMarkAsRead,
    markAllAsRead: handleMarkAllAsRead,
  }
}
