import { useCallback, useEffect, useState } from 'react'
import {
  listNotifications,
  markAllAsRead,
  markAsRead,
} from '../services/notificationService'

export function useNotifications(uid) {
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(false)

  const unreadCount = notifications.filter((n) => !n.read).length

  // 앱 진입(uid 변경) 시 1회만 로드 — 주기적 폴링/onSnapshot 없음
  useEffect(() => {
    if (!uid) {
      setNotifications([])
      return
    }

    let active = true
    setLoading(true)

    listNotifications(uid)
      .then((items) => {
        if (active) {
          setNotifications(items)
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  }, [uid])

  // 벨 아이콘 클릭 등 사용자 명시 액션 시 호출
  const refresh = useCallback(async () => {
    if (!uid) return
    try {
      const items = await listNotifications(uid)
      setNotifications(items)
    } catch {
      // ignore
    }
  }, [uid])

  const handleMarkAsRead = useCallback(async (notificationId) => {
    await markAsRead(notificationId)
    setNotifications((prev) =>
      prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
    )
  }, [])

  const handleMarkAllAsRead = useCallback(async () => {
    if (!uid) return
    await markAllAsRead(uid)
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
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
