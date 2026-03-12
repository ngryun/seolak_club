import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db, isFirebaseEnabled } from '../lib/firebase'

const REQUEST_CARDS = 'requestCards'
const REQUEST_CARD_APPLICATIONS = 'requestCardApplications'
const TARGET_ROLES = new Set(['student', 'teacher'])

export const REQUEST_CARD_RESULT = {
  APPLIED: 'applied',
  SELECTED: 'selected',
  NOT_SELECTED: 'not_selected',
}

export const REQUEST_CARD_ADMIN_STATUS = {
  NORMAL: 'normal',
  CANCELLED: 'cancelled',
  SELECTION_CANCELLED: 'selection_cancelled',
}

const REQUEST_CARD_ADMIN_STATUS_VALUES = new Set(Object.values(REQUEST_CARD_ADMIN_STATUS))
let localRequestCards = []
let localRequestCardApplications = []

function nowIso() {
  return new Date().toISOString()
}

function toIsoString(value) {
  if (!value) return null

  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }

  if (typeof value?.toDate === 'function') {
    return value.toDate().toISOString()
  }

  if (typeof value?.seconds === 'number') {
    return new Date(value.seconds * 1000).toISOString()
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }

  return null
}

function toDateValue(value) {
  const iso = toIsoString(value)
  if (!iso) return null
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toPositiveInteger(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.trunc(parsed))
}

function assertActor(actor) {
  const uid = String(actor?.uid || '').trim()
  const role = String(actor?.role || '').trim()
  const loginId = String(actor?.loginId || '').trim()
  const name = String(actor?.name || '').trim()

  if (!uid || !role) {
    throw new Error('사용자 정보가 필요합니다.')
  }

  return {
    uid,
    role,
    loginId,
    name,
    studentNo: String(actor?.studentNo || '').trim(),
  }
}

function normalizeTargetRole(value) {
  const role = String(value || '').trim()
  if (!TARGET_ROLES.has(role)) {
    throw new Error('대상은 학생 또는 교사만 선택할 수 있습니다.')
  }
  return role
}

function readRequestCardAdminStatus(value) {
  const status = String(value || '').trim() || REQUEST_CARD_ADMIN_STATUS.NORMAL
  return REQUEST_CARD_ADMIN_STATUS_VALUES.has(status)
    ? status
    : REQUEST_CARD_ADMIN_STATUS.NORMAL
}

function normalizeRequestCardAdminStatus(value) {
  const status = readRequestCardAdminStatus(value)
  const raw = String(value || '').trim()
  if (raw && status !== raw) {
    throw new Error('신청 카드 상태가 올바르지 않습니다.')
  }
  return status
}

function normalizeRequestCard(id, data) {
  return {
    id,
    title: String(data?.title || '').trim(),
    targetRole: String(data?.targetRole || '').trim(),
    capacity: Math.max(1, toPositiveInteger(data?.capacity, 1)),
    description: String(data?.description || '').trim(),
    startAt: toIsoString(data?.startAt),
    endAt: toIsoString(data?.endAt),
    applicantCount: Math.max(0, toPositiveInteger(data?.applicantCount, 0)),
    selectedCount: Math.max(0, toPositiveInteger(data?.selectedCount, 0)),
    drawExecutedAt: toIsoString(data?.drawExecutedAt),
    drawByUid: String(data?.drawByUid || '').trim(),
    adminStatus: readRequestCardAdminStatus(data?.adminStatus),
    createdByUid: String(data?.createdByUid || '').trim(),
    createdAt: toIsoString(data?.createdAt) || data?.createdAt || null,
    updatedAt: toIsoString(data?.updatedAt) || data?.updatedAt || null,
  }
}

function normalizeRequestCardApplication(id, data) {
  return {
    id,
    cardId: String(data?.cardId || '').trim(),
    applicantUid: String(data?.applicantUid || '').trim(),
    applicantRole: String(data?.applicantRole || '').trim(),
    applicantName: String(data?.applicantName || '').trim(),
    applicantLoginId: String(data?.applicantLoginId || '').trim(),
    applicantStudentNo: String(data?.applicantStudentNo || '').trim(),
    status: String(data?.status || REQUEST_CARD_RESULT.APPLIED).trim() || REQUEST_CARD_RESULT.APPLIED,
    createdAt: toIsoString(data?.createdAt) || data?.createdAt || null,
    updatedAt: toIsoString(data?.updatedAt) || data?.updatedAt || null,
    drawnAt: toIsoString(data?.drawnAt) || data?.drawnAt || null,
  }
}

function sortRequestCards(rows) {
  return [...rows].sort((a, b) => {
    const left = toDateValue(a.startAt)?.getTime() || 0
    const right = toDateValue(b.startAt)?.getTime() || 0
    if (left !== right) return right - left
    return String(a.title || a.id).localeCompare(String(b.title || b.id), 'ko')
  })
}

function shuffleRows(rows) {
  const next = [...rows]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const temp = next[index]
    next[index] = next[randomIndex]
    next[randomIndex] = temp
  }
  return next
}

function buildRequestCardApplicationId(cardId, applicantUid) {
  return `${String(cardId || '').trim()}__${String(applicantUid || '').trim()}`.replaceAll('/', '_')
}

function assertRequestCardPayload(payload) {
  const title = String(payload?.title || '').trim()
  const description = String(payload?.description || '').trim()
  const targetRole = normalizeTargetRole(payload?.targetRole)
  const capacity = Math.max(1, toPositiveInteger(payload?.capacity, 0))
  const startAt = toIsoString(payload?.startAt)
  const endAt = toIsoString(payload?.endAt)

  if (!title) {
    throw new Error('신청 카드 제목은 필수입니다.')
  }
  if (!description) {
    throw new Error('신청 카드 내용은 필수입니다.')
  }
  if (!startAt || !endAt) {
    throw new Error('신청 시작/종료 일시를 모두 입력해주세요.')
  }
  if (new Date(startAt).getTime() >= new Date(endAt).getTime()) {
    throw new Error('신청 종료 일시는 시작 일시보다 뒤여야 합니다.')
  }

  return {
    title,
    description,
    targetRole,
    capacity,
    startAt,
    endAt,
  }
}

function ensureAdmin(actor) {
  const user = assertActor(actor)
  if (user.role !== 'admin') {
    throw new Error('관리자만 사용할 수 있습니다.')
  }
  return user
}

function ensureEligibleApplicant(card, actor) {
  const user = assertActor(actor)
  if (user.role !== 'student' && user.role !== 'teacher' && user.role !== 'admin') {
    throw new Error('학생, 교사, 관리자만 신청할 수 있습니다.')
  }
  const normalizedRole = user.role === 'admin' ? 'teacher' : user.role
  if (normalizedRole !== card.targetRole) {
    throw new Error(card.targetRole === 'student'
      ? '학생 대상 신청 카드입니다.'
      : '교사 대상 신청 카드입니다.')
  }
  return user
}

export function getRequestCardState(card, nowValue = new Date()) {
  const now = toDateValue(nowValue) || new Date()
  const startAt = toDateValue(card?.startAt)
  const endAt = toDateValue(card?.endAt)
  const drawExecutedAt = toDateValue(card?.drawExecutedAt)
  const adminStatus = readRequestCardAdminStatus(card?.adminStatus)
  const configured = !!startAt && !!endAt && startAt.getTime() < endAt.getTime()

  if (adminStatus === REQUEST_CARD_ADMIN_STATUS.CANCELLED) {
    return {
      configured,
      phase: 'cancelled',
      startAt,
      endAt,
      drawExecutedAt,
      canApply: false,
      canDraw: false,
      adminStatus,
    }
  }

  if (adminStatus === REQUEST_CARD_ADMIN_STATUS.SELECTION_CANCELLED) {
    return {
      configured,
      phase: 'selection_cancelled',
      startAt,
      endAt,
      drawExecutedAt,
      canApply: false,
      canDraw: false,
      adminStatus,
    }
  }

  if (!configured) {
    return {
      configured: false,
      phase: 'unconfigured',
      startAt: null,
      endAt: null,
      drawExecutedAt,
      canApply: false,
      canDraw: false,
      adminStatus,
    }
  }

  if (drawExecutedAt) {
    return {
      configured: true,
      phase: 'drawn',
      startAt,
      endAt,
      drawExecutedAt,
      canApply: false,
      canDraw: false,
      adminStatus,
    }
  }

  if (now.getTime() < startAt.getTime()) {
    return {
      configured: true,
      phase: 'before',
      startAt,
      endAt,
      drawExecutedAt: null,
      canApply: false,
      canDraw: false,
      adminStatus,
    }
  }

  if (now.getTime() <= endAt.getTime()) {
    return {
      configured: true,
      phase: 'open',
      startAt,
      endAt,
      drawExecutedAt: null,
      canApply: true,
      canDraw: false,
      adminStatus,
    }
  }

  return {
    configured: true,
    phase: 'closed',
    startAt,
    endAt,
    drawExecutedAt: null,
    canApply: false,
    canDraw: true,
    adminStatus,
  }
}

export async function listRequestCards() {
  if (!isFirebaseEnabled()) {
    return sortRequestCards(localRequestCards.map((row) => normalizeRequestCard(row.id, row)))
  }

  const snapshot = await getDocs(collection(db, REQUEST_CARDS))
  const rows = snapshot.docs.map((row) => normalizeRequestCard(row.id, row.data()))
  return sortRequestCards(rows)
}

export async function getRequestCardById(cardId) {
  const targetId = String(cardId || '').trim()
  if (!targetId) return null

  if (!isFirebaseEnabled()) {
    const row = localRequestCards.find((item) => item.id === targetId)
    return row ? normalizeRequestCard(row.id, row) : null
  }

  const snapshot = await getDoc(doc(db, REQUEST_CARDS, targetId))
  if (!snapshot.exists()) return null
  return normalizeRequestCard(snapshot.id, snapshot.data())
}

export async function createRequestCard(payload, options = {}) {
  const actor = ensureAdmin(options?.actor)
  const data = assertRequestCardPayload(payload)

  if (!isFirebaseEnabled()) {
    const id = `local-request-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = nowIso()
    const next = {
      id,
      ...data,
      applicantCount: 0,
      selectedCount: 0,
      drawExecutedAt: null,
      drawByUid: '',
      adminStatus: REQUEST_CARD_ADMIN_STATUS.NORMAL,
      createdByUid: actor.uid,
      createdAt: now,
      updatedAt: now,
    }
    localRequestCards = sortRequestCards([...localRequestCards, next])
    return normalizeRequestCard(id, next)
  }

  const created = doc(collection(db, REQUEST_CARDS))
  await setDoc(created, {
    ...data,
    applicantCount: 0,
    selectedCount: 0,
    drawExecutedAt: null,
    drawByUid: '',
    adminStatus: REQUEST_CARD_ADMIN_STATUS.NORMAL,
    createdByUid: actor.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return getRequestCardById(created.id)
}

export async function updateRequestCard(cardId, payload, options = {}) {
  ensureAdmin(options?.actor)
  const targetId = String(cardId || '').trim()
  if (!targetId) {
    throw new Error('수정할 신청 카드가 없습니다.')
  }

  const existing = await getRequestCardById(targetId)
  if (!existing) {
    throw new Error('신청 카드를 찾을 수 없습니다.')
  }
  if (existing.drawExecutedAt) {
    throw new Error('추첨이 끝난 신청 카드는 수정할 수 없습니다.')
  }

  const data = assertRequestCardPayload({
    ...existing,
    ...payload,
  })

  if (existing.applicantCount > 0 && data.targetRole !== existing.targetRole) {
    throw new Error('이미 신청자가 있는 카드는 대상을 변경할 수 없습니다.')
  }

  if (!isFirebaseEnabled()) {
    const now = nowIso()
    localRequestCards = localRequestCards.map((row) => {
      if (row.id !== targetId) return row
      return {
        ...row,
        ...data,
        updatedAt: now,
      }
    })
    return getRequestCardById(targetId)
  }

  await updateDoc(doc(db, REQUEST_CARDS, targetId), {
    ...data,
    updatedAt: serverTimestamp(),
  })
  return getRequestCardById(targetId)
}

export async function setRequestCardAdminStatus(cardId, nextStatus, options = {}) {
  ensureAdmin(options?.actor)
  const targetId = String(cardId || '').trim()
  if (!targetId) {
    throw new Error('상태를 변경할 신청 카드가 없습니다.')
  }

  const existing = await getRequestCardById(targetId)
  if (!existing) {
    throw new Error('신청 카드를 찾을 수 없습니다.')
  }

  const adminStatus = normalizeRequestCardAdminStatus(nextStatus)

  if (existing.drawExecutedAt && adminStatus === REQUEST_CARD_ADMIN_STATUS.CANCELLED) {
    throw new Error('결과가 확정된 카드는 폐강 대신 선정취소 상태를 사용해주세요.')
  }

  if (!isFirebaseEnabled()) {
    const now = nowIso()
    localRequestCards = localRequestCards.map((row) => {
      if (row.id !== targetId) return row
      return {
        ...row,
        adminStatus,
        updatedAt: now,
      }
    })
    return getRequestCardById(targetId)
  }

  await updateDoc(doc(db, REQUEST_CARDS, targetId), {
    adminStatus,
    updatedAt: serverTimestamp(),
  })
  return getRequestCardById(targetId)
}

export async function deleteRequestCard(cardId, options = {}) {
  ensureAdmin(options?.actor)
  const targetId = String(cardId || '').trim()
  if (!targetId) {
    throw new Error('삭제할 신청 카드가 없습니다.')
  }

  const existing = await getRequestCardById(targetId)
  if (!existing) {
    throw new Error('신청 카드를 찾을 수 없습니다.')
  }
  if (existing.drawExecutedAt) {
    throw new Error('추첨이 끝난 신청 카드는 삭제할 수 없습니다.')
  }

  if (!isFirebaseEnabled()) {
    localRequestCards = localRequestCards.filter((row) => row.id !== targetId)
    localRequestCardApplications = localRequestCardApplications.filter((row) => row.cardId !== targetId)
    return { ok: true }
  }

  const appsSnapshot = await getDocs(
    query(collection(db, REQUEST_CARD_APPLICATIONS), where('cardId', '==', targetId)),
  )

  const refs = [doc(db, REQUEST_CARDS, targetId), ...appsSnapshot.docs.map((row) => row.ref)]
  for (let index = 0; index < refs.length; index += 400) {
    const batch = writeBatch(db)
    refs.slice(index, index + 400).forEach((ref) => batch.delete(ref))
    await batch.commit()
  }
  return { ok: true }
}

export async function listRequestCardApplicationsByCard(cardId) {
  const targetId = String(cardId || '').trim()
  if (!targetId) return []

  if (!isFirebaseEnabled()) {
    return localRequestCardApplications
      .filter((row) => row.cardId === targetId)
      .map((row) => normalizeRequestCardApplication(row.id, row))
      .sort((a, b) => {
        const left = toDateValue(a.createdAt)?.getTime() || 0
        const right = toDateValue(b.createdAt)?.getTime() || 0
        return left - right
      })
  }

  const snapshot = await getDocs(
    query(collection(db, REQUEST_CARD_APPLICATIONS), where('cardId', '==', targetId)),
  )
  return snapshot.docs
    .map((row) => normalizeRequestCardApplication(row.id, row.data()))
    .sort((a, b) => {
      const left = toDateValue(a.createdAt)?.getTime() || 0
      const right = toDateValue(b.createdAt)?.getTime() || 0
      return left - right
    })
}

export async function listRequestCardApplicationsByApplicant(applicantUid) {
  const targetUid = String(applicantUid || '').trim()
  if (!targetUid) return []

  if (!isFirebaseEnabled()) {
    return localRequestCardApplications
      .filter((row) => row.applicantUid === targetUid)
      .map((row) => normalizeRequestCardApplication(row.id, row))
  }

  const snapshot = await getDocs(
    query(collection(db, REQUEST_CARD_APPLICATIONS), where('applicantUid', '==', targetUid)),
  )
  return snapshot.docs.map((row) => normalizeRequestCardApplication(row.id, row.data()))
}

export async function applyToRequestCard(payload) {
  const targetCardId = String(payload?.cardId || '').trim()
  if (!targetCardId) {
    throw new Error('신청할 카드를 선택해주세요.')
  }

  const existingCard = await getRequestCardById(targetCardId)
  if (!existingCard) {
    throw new Error('신청 카드를 찾을 수 없습니다.')
  }

  const actor = ensureEligibleApplicant(existingCard, payload?.actor)
  const state = getRequestCardState(existingCard)
  if (!state.canApply) {
    throw new Error('현재는 신청할 수 없는 카드입니다.')
  }

  const applicationId = buildRequestCardApplicationId(targetCardId, actor.uid)

  if (!isFirebaseEnabled()) {
    const duplicated = localRequestCardApplications.some((row) => row.id === applicationId)
    if (duplicated) {
      throw new Error('이미 신청했습니다.')
    }

    const now = nowIso()
    localRequestCardApplications = [
      ...localRequestCardApplications,
      {
        id: applicationId,
        cardId: targetCardId,
        applicantUid: actor.uid,
        applicantRole: actor.role,
        applicantName: actor.name || actor.loginId || '신청자',
        applicantLoginId: actor.loginId,
        applicantStudentNo: actor.studentNo,
        status: REQUEST_CARD_RESULT.APPLIED,
        createdAt: now,
        updatedAt: now,
        drawnAt: null,
      },
    ]
    localRequestCards = localRequestCards.map((row) => {
      if (row.id !== targetCardId) return row
      return {
        ...row,
        applicantCount: Math.max(0, toPositiveInteger(row.applicantCount, 0)) + 1,
        updatedAt: now,
      }
    })
    const created = localRequestCardApplications.find((row) => row.id === applicationId)
    return normalizeRequestCardApplication(applicationId, created)
  }

  await runTransaction(db, async (tx) => {
    const cardRef = doc(db, REQUEST_CARDS, targetCardId)
    const appRef = doc(db, REQUEST_CARD_APPLICATIONS, applicationId)
    const [cardSnap, appSnap] = await Promise.all([tx.get(cardRef), tx.get(appRef)])

    if (!cardSnap.exists()) {
      throw new Error('신청 카드를 찾을 수 없습니다.')
    }
    if (appSnap.exists()) {
      throw new Error('이미 신청했습니다.')
    }

    const card = normalizeRequestCard(cardSnap.id, cardSnap.data())
    ensureEligibleApplicant(card, actor)
    const liveState = getRequestCardState(card)
    if (!liveState.canApply) {
      throw new Error('현재는 신청할 수 없는 카드입니다.')
    }

    tx.set(appRef, {
      cardId: targetCardId,
      applicantUid: actor.uid,
      applicantRole: actor.role,
      applicantName: actor.name || actor.loginId || '신청자',
      applicantLoginId: actor.loginId,
      applicantStudentNo: actor.studentNo,
      status: REQUEST_CARD_RESULT.APPLIED,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      drawnAt: null,
    })
    tx.update(cardRef, {
      applicantCount: Math.max(0, toPositiveInteger(card.applicantCount, 0)) + 1,
      updatedAt: serverTimestamp(),
    })
  })

  const created = await getDoc(doc(db, REQUEST_CARD_APPLICATIONS, applicationId))
  return normalizeRequestCardApplication(created.id, created.data())
}

export async function cancelRequestCardApplication(payload) {
  const targetCardId = String(payload?.cardId || '').trim()
  const actor = assertActor(payload?.actor)
  if (!targetCardId) {
    throw new Error('취소할 신청 카드가 없습니다.')
  }

  const applicationId = buildRequestCardApplicationId(targetCardId, actor.uid)

  if (!isFirebaseEnabled()) {
    const card = await getRequestCardById(targetCardId)
    if (!card) {
      throw new Error('신청 카드를 찾을 수 없습니다.')
    }
    const state = getRequestCardState(card)
    if (state.phase !== 'open') {
      throw new Error('신청 기간 중에만 취소할 수 있습니다.')
    }

    const existing = localRequestCardApplications.find((row) => row.id === applicationId)
    if (!existing) {
      throw new Error('신청 내역이 없습니다.')
    }

    localRequestCardApplications = localRequestCardApplications.filter((row) => row.id !== applicationId)
    localRequestCards = localRequestCards.map((row) => {
      if (row.id !== targetCardId) return row
      return {
        ...row,
        applicantCount: Math.max(0, toPositiveInteger(row.applicantCount, 0) - 1),
        updatedAt: nowIso(),
      }
    })
    return { ok: true }
  }

  await runTransaction(db, async (tx) => {
    const cardRef = doc(db, REQUEST_CARDS, targetCardId)
    const appRef = doc(db, REQUEST_CARD_APPLICATIONS, applicationId)
    const [cardSnap, appSnap] = await Promise.all([tx.get(cardRef), tx.get(appRef)])

    if (!cardSnap.exists()) {
      throw new Error('신청 카드를 찾을 수 없습니다.')
    }
    if (!appSnap.exists()) {
      throw new Error('신청 내역이 없습니다.')
    }

    const card = normalizeRequestCard(cardSnap.id, cardSnap.data())
    const application = normalizeRequestCardApplication(appSnap.id, appSnap.data())
    const state = getRequestCardState(card)
    if (state.phase !== 'open') {
      throw new Error('신청 기간 중에만 취소할 수 있습니다.')
    }
    if (application.applicantUid !== actor.uid) {
      throw new Error('본인 신청만 취소할 수 있습니다.')
    }
    if (application.status !== REQUEST_CARD_RESULT.APPLIED) {
      throw new Error('이미 추첨이 진행되어 취소할 수 없습니다.')
    }

    tx.delete(appRef)
    tx.update(cardRef, {
      applicantCount: Math.max(0, toPositiveInteger(card.applicantCount, 0) - 1),
      updatedAt: serverTimestamp(),
    })
  })

  return { ok: true }
}

export async function drawRequestCardWinners(payload) {
  const actor = ensureAdmin(payload?.actor)
  const targetCardId = String(payload?.cardId || '').trim()
  if (!targetCardId) {
    throw new Error('추첨할 신청 카드가 없습니다.')
  }

  const card = await getRequestCardById(targetCardId)
  if (!card) {
    throw new Error('신청 카드를 찾을 수 없습니다.')
  }
  const state = getRequestCardState(card)
  if (state.phase !== 'closed') {
    throw new Error('신청 기간 종료 후에만 추첨할 수 있습니다.')
  }

  const applications = await listRequestCardApplicationsByCard(targetCardId)
  const selectedRows = shuffleRows(applications).slice(0, Math.min(card.capacity, applications.length))
  const selectedIds = new Set(selectedRows.map((row) => row.id))

  if (!isFirebaseEnabled()) {
    const now = nowIso()
    localRequestCardApplications = localRequestCardApplications.map((row) => {
      if (row.cardId !== targetCardId) return row
      return {
        ...row,
        status: selectedIds.has(row.id) ? REQUEST_CARD_RESULT.SELECTED : REQUEST_CARD_RESULT.NOT_SELECTED,
        drawnAt: now,
        updatedAt: now,
      }
    })
    localRequestCards = localRequestCards.map((row) => {
      if (row.id !== targetCardId) return row
      return {
        ...row,
        selectedCount: selectedRows.length,
        drawExecutedAt: now,
        drawByUid: actor.uid,
        updatedAt: now,
      }
    })
    return {
      selectedCount: selectedRows.length,
      applicantCount: applications.length,
    }
  }

  const liveCardRef = doc(db, REQUEST_CARDS, targetCardId)
  const liveCardSnap = await getDoc(liveCardRef)
  if (!liveCardSnap.exists()) {
    throw new Error('신청 카드를 찾을 수 없습니다.')
  }
  const liveCard = normalizeRequestCard(liveCardSnap.id, liveCardSnap.data())
  if (liveCard.drawExecutedAt) {
    throw new Error('이미 추첨이 끝난 카드입니다.')
  }

  await updateDoc(liveCardRef, {
    selectedCount: selectedRows.length,
    drawExecutedAt: serverTimestamp(),
    drawByUid: actor.uid,
    updatedAt: serverTimestamp(),
  })

  for (let index = 0; index < applications.length; index += 400) {
    const batch = writeBatch(db)
    applications.slice(index, index + 400).forEach((row) => {
      batch.update(doc(db, REQUEST_CARD_APPLICATIONS, row.id), {
        status: selectedIds.has(row.id) ? REQUEST_CARD_RESULT.SELECTED : REQUEST_CARD_RESULT.NOT_SELECTED,
        drawnAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    })
    await batch.commit()
  }

  return {
    selectedCount: selectedRows.length,
    applicantCount: applications.length,
  }
}
