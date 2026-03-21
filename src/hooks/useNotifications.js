import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listNotifications,
  markAllAsRead,
  markAsRead,
  subscribeNotifications,
} from '../services/notificationService'
import { isFirebaseEnabled } from '../lib/firebase'

const POLL_INTERVAL = 30_000 // 30 seconds for non-Firebase mode

export function useNotifications(uid) {
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(false)
  const unsubRef = useRef(null)

  const unreadCount = notifications.filter((n) => !n.read).length

  useEffect(() => {
    if (!uid) {
      setNotifications([])
      return undefined
    }

    if (isFirebaseEnabled()) {
      // Real-time listener via Firestore onSnapshot
      setLoading(true)
      unsubRef.current = subscribeNotifications(uid, (items) => {
        setNotifications(items)
        setLoading(false)
      })
      return () => {
        if (unsubRef.current) unsubRef.current()
      }
    }

    // Demo mode: poll periodically
    let active = true

    async function poll() {
      if (!active) return
      try {
        const items = await listNotifications(uid)
        if (active) setNotifications(items)
      } catch {
        // ignore polling errors
      }
    }

    poll()
    const intervalId = setInterval(poll, POLL_INTERVAL)

    return () => {
      active = false
      clearInterval(intervalId)
    }
  }, [uid])

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
