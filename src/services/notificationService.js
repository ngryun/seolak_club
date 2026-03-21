import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db, isFirebaseEnabled } from '../lib/firebase'

const COLLECTION_NAME = 'notifications'

export const NOTIFICATION_TYPE = {
  REQUEST_CARD_CREATED: 'request_card_created',
  REQUEST_CARD_SELECTED: 'request_card_selected',
  REQUEST_CARD_NOT_SELECTED: 'request_card_not_selected',
  APPLICATION_APPROVED: 'application_approved',
  APPLICATION_REJECTED: 'application_rejected',
  SCHEDULE_CREATED: 'schedule_created',
}

const TYPE_META = {
  [NOTIFICATION_TYPE.REQUEST_CARD_CREATED]: { icon: '📋', label: '새 신청카드' },
  [NOTIFICATION_TYPE.REQUEST_CARD_SELECTED]: { icon: '🎉', label: '당첨' },
  [NOTIFICATION_TYPE.REQUEST_CARD_NOT_SELECTED]: { icon: '😔', label: '미선정' },
  [NOTIFICATION_TYPE.APPLICATION_APPROVED]: { icon: '✅', label: '승인' },
  [NOTIFICATION_TYPE.APPLICATION_REJECTED]: { icon: '❌', label: '반려' },
  [NOTIFICATION_TYPE.SCHEDULE_CREATED]: { icon: '🏫', label: '새 동아리' },
}

export function getNotificationMeta(type) {
  return TYPE_META[type] || { icon: '🔔', label: '알림' }
}

let localNotifications = []
let nextLocalId = 1

function nowIso() {
  return new Date().toISOString()
}

function normalizeDoc(docData, id) {
  const toIso = (v) => {
    if (!v) return null
    if (typeof v === 'string') return v
    if (typeof v?.toDate === 'function') return v.toDate().toISOString()
    if (typeof v?.seconds === 'number') return new Date(v.seconds * 1000).toISOString()
    return null
  }

  return {
    id,
    recipientUid: docData.recipientUid || '',
    type: docData.type || '',
    title: docData.title || '',
    message: docData.message || '',
    relatedId: docData.relatedId || '',
    read: !!docData.read,
    createdAt: toIso(docData.createdAt) || nowIso(),
  }
}

// ─── Create ───

export async function createNotification({ recipientUid, type, title, message, relatedId }) {
  if (!recipientUid || !type) return null

  if (isFirebaseEnabled()) {
    const ref = await addDoc(collection(db, COLLECTION_NAME), {
      recipientUid,
      type,
      title: title || '',
      message: message || '',
      relatedId: relatedId || '',
      read: false,
      createdAt: serverTimestamp(),
    })
    return ref.id
  }

  const id = `local-notif-${nextLocalId++}`
  localNotifications.push({
    id,
    recipientUid,
    type,
    title: title || '',
    message: message || '',
    relatedId: relatedId || '',
    read: false,
    createdAt: nowIso(),
  })
  return id
}

export async function createNotificationBatch(items) {
  if (!Array.isArray(items) || items.length === 0) return

  if (isFirebaseEnabled()) {
    const batch = writeBatch(db)
    for (const item of items) {
      if (!item.recipientUid || !item.type) continue
      const ref = doc(collection(db, COLLECTION_NAME))
      batch.set(ref, {
        recipientUid: item.recipientUid,
        type: item.type,
        title: item.title || '',
        message: item.message || '',
        relatedId: item.relatedId || '',
        read: false,
        createdAt: serverTimestamp(),
      })
    }
    await batch.commit()
    return
  }

  for (const item of items) {
    if (!item.recipientUid || !item.type) continue
    const id = `local-notif-${nextLocalId++}`
    localNotifications.push({
      id,
      recipientUid: item.recipientUid,
      type: item.type,
      title: item.title || '',
      message: item.message || '',
      relatedId: item.relatedId || '',
      read: false,
      createdAt: nowIso(),
    })
  }
}

// ─── Read ───

export async function listNotifications(uid) {
  if (!uid) return []

  if (isFirebaseEnabled()) {
    const q = query(
      collection(db, COLLECTION_NAME),
      where('recipientUid', '==', uid),
      orderBy('createdAt', 'desc'),
    )
    const snapshot = await getDocs(q)
    return snapshot.docs.map((d) => normalizeDoc(d.data(), d.id))
  }

  return localNotifications
    .filter((n) => n.recipientUid === uid)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
}

export function subscribeNotifications(uid, callback) {
  if (!uid) return () => {}

  if (isFirebaseEnabled()) {
    const q = query(
      collection(db, COLLECTION_NAME),
      where('recipientUid', '==', uid),
      orderBy('createdAt', 'desc'),
    )
    return onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((d) => normalizeDoc(d.data(), d.id))
      callback(items)
    })
  }

  // Demo mode: just return current list immediately
  callback(
    localNotifications
      .filter((n) => n.recipientUid === uid)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
  )
  return () => {}
}

// ─── Update ───

export async function markAsRead(notificationId) {
  if (!notificationId) return

  if (isFirebaseEnabled()) {
    await updateDoc(doc(db, COLLECTION_NAME, notificationId), { read: true })
    return
  }

  const item = localNotifications.find((n) => n.id === notificationId)
  if (item) item.read = true
}

export async function markAllAsRead(uid) {
  if (!uid) return

  if (isFirebaseEnabled()) {
    const q = query(
      collection(db, COLLECTION_NAME),
      where('recipientUid', '==', uid),
      where('read', '==', false),
    )
    const snapshot = await getDocs(q)
    if (snapshot.empty) return
    const batch = writeBatch(db)
    snapshot.docs.forEach((d) => batch.update(d.ref, { read: true }))
    await batch.commit()
    return
  }

  localNotifications.forEach((n) => {
    if (n.recipientUid === uid) n.read = true
  })
}

// ─── Delete ───

export async function deleteNotification(notificationId) {
  if (!notificationId) return

  if (isFirebaseEnabled()) {
    await deleteDoc(doc(db, COLLECTION_NAME, notificationId))
    return
  }

  localNotifications = localNotifications.filter((n) => n.id !== notificationId)
}
