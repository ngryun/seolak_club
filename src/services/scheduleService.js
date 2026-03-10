import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db, isFirebaseEnabled } from '../lib/firebase'
import { mockSchedules } from './mockData'

const COLLECTION_NAME = 'schedules'
const ROOMS_COLLECTION_NAME = 'clubRooms'
let scheduleStore = [...mockSchedules]
let roomStore = Array.from(
  new Set(
    [...mockSchedules.map((item) => String(item.room || '').trim()), '미정']
      .filter((item) => !!item),
  ),
).map((name, index) => ({
  id: `local-room-${index + 1}`,
  name,
  createdAt: null,
}))

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeTargetGrades(value) {
  const raw = Array.isArray(value) ? value : [value]
  const normalized = raw
    .map((item) => Number(item))
    .filter((item) => item === 1 || item === 2 || item === 3)

  return Array.from(new Set(normalized)).sort((a, b) => a - b)
}

function normalizeRandomRounds(value) {
  const raw = Array.isArray(value) ? value : []
  return Array.from(
    new Set(
      raw
        .map((item) => Number(item))
        .filter((item) => item === 1 || item === 2 || item === 3),
    ),
  ).sort((a, b) => a - b)
}

function normalizeClub(id, data) {
  const legacy = !data?.clubName && !!data?.school
  const targetGrades = normalizeTargetGrades(data?.targetGrades)

  return {
    id,
    teacherUid: String(data?.teacherUid || '').trim(),
    leaderUid: String(data?.leaderUid || '').trim(),
    clubName: String(data?.clubName || data?.school || '').trim(),
    targetGrades: targetGrades.length > 0 ? targetGrades : [1, 2, 3],
    description: String(data?.description || '').trim(),
    room: String(data?.room || data?.region || '').trim(),
    maxMembers: Math.max(0, Math.trunc(toNumber(data?.maxMembers ?? data?.needed, 0))),
    isInterviewSelection: Boolean(data?.isInterviewSelection),
    memberCount: Math.max(0, Math.trunc(toNumber(data?.memberCount ?? data?.applied, 0))),
    randomDrawnRounds: normalizeRandomRounds(data?.randomDrawnRounds),
    createdByUid: String(data?.createdByUid || '').trim(),
    createdAt: data?.createdAt || null,
    updatedAt: data?.updatedAt || null,
    legacy,
  }
}

function normalizeRoom(id, data) {
  const name = String(data?.name || '').trim() || '미정'
  return {
    id,
    name,
    createdAt: data?.createdAt || null,
    updatedAt: data?.updatedAt || null,
  }
}

function sortRooms(rows) {
  return [...rows].sort((a, b) => {
    if (a.name === '미정') return -1
    if (b.name === '미정') return 1
    return String(a.name).localeCompare(String(b.name), 'ko')
  })
}

function sortClubs(rows) {
  return [...rows].sort((a, b) => {
    const left = a.clubName || a.id
    const right = b.clubName || b.id
    return left.localeCompare(right, 'ko')
  })
}

function assertActor(actor) {
  const uid = String(actor?.uid || '').trim()
  const role = String(actor?.role || '').trim()
  const loginId = String(actor?.loginId || '').trim()
  if (!uid || !role) {
    throw new Error('사용자 정보가 필요합니다.')
  }
  return { uid, role, loginId }
}

function assertClubPayload(payload, { requireTeacherUid = false } = {}) {
  const clubName = String(payload?.clubName || '').trim()
  const targetGrades = normalizeTargetGrades(payload?.targetGrades)
  const description = String(payload?.description || '').trim()
  const room = String(payload?.room || '').trim() || '미정'
  const teacherUid = String(payload?.teacherUid || '').trim()
  const leaderUid = String(payload?.leaderUid || '').trim()
  const maxMembers = Math.max(0, Math.trunc(toNumber(payload?.maxMembers, 0)))
  const isInterviewSelection = Boolean(payload?.isInterviewSelection)
  const randomDrawnRounds = normalizeRandomRounds(payload?.randomDrawnRounds)

  if (!clubName) {
    throw new Error('동아리명은 필수입니다.')
  }
  if (targetGrades.length === 0) {
    throw new Error('대상학년은 1, 2, 3 중 최소 1개를 선택해야 합니다.')
  }
  if (maxMembers < 1) {
    throw new Error('동아리 최대인원은 1명 이상이어야 합니다.')
  }
  if (requireTeacherUid && !teacherUid) {
    throw new Error('담당교사 계정 연결이 필요합니다.')
  }

  return {
    clubName,
    targetGrades,
    description,
    room,
    maxMembers,
    isInterviewSelection,
    teacherUid,
    leaderUid,
    randomDrawnRounds,
  }
}

export function canEditClub(club, actor) {
  const uid = String(actor?.uid || '').trim()
  const role = String(actor?.role || '').trim()
  if (!uid) return false
  if (role === 'admin') return true
  return uid === String(club?.teacherUid || '').trim() || uid === String(club?.leaderUid || '').trim()
}

export function canManageSelection(club, actor) {
  const uid = String(actor?.uid || '').trim()
  const role = String(actor?.role || '').trim()
  if (!uid) return false
  if (role === 'admin') return true
  return uid === String(club?.teacherUid || '').trim()
}

export async function listSchedules(options = {}) {
  const includeLegacy = options?.includeLegacy === true

  if (!isFirebaseEnabled()) {
    const rows = scheduleStore.map((item) => normalizeClub(item.id, item))
    const filtered = includeLegacy ? rows : rows.filter((row) => !row.legacy)
    return sortClubs(filtered)
  }

  const schedulesRef = collection(db, COLLECTION_NAME)
  const snapshot = await getDocs(schedulesRef)
  const rows = snapshot.docs.map((row) => normalizeClub(row.id, row.data()))
  const filtered = includeLegacy ? rows : rows.filter((row) => !row.legacy)
  return sortClubs(filtered)
}

export async function getScheduleById(scheduleId) {
  if (!isFirebaseEnabled()) {
    const item = scheduleStore.find((row) => row.id === scheduleId)
    return item ? normalizeClub(item.id, item) : null
  }

  const ref = doc(db, COLLECTION_NAME, scheduleId)
  const snapshot = await getDoc(ref)
  if (!snapshot.exists()) {
    return null
  }
  return normalizeClub(snapshot.id, snapshot.data())
}

export async function listClubRooms() {
  if (!isFirebaseEnabled()) {
    return sortRooms(roomStore)
  }

  const snapshot = await getDocs(collection(db, ROOMS_COLLECTION_NAME))
  const rooms = snapshot.docs.map((row) => normalizeRoom(row.id, row.data()))
  const hasUndecided = rooms.some((row) => row.name === '미정')
  const normalized = hasUndecided
    ? rooms
    : [{ id: 'system-undecided', name: '미정', createdAt: null, updatedAt: null }, ...rooms]
  return sortRooms(normalized)
}

export async function createClubRoom(name, options = {}) {
  const actor = assertActor(options?.actor)
  if (actor.role !== 'admin' && actor.loginId !== 'admin') {
    throw new Error('동아리실 등록은 관리자만 가능합니다.')
  }

  const normalizedName = String(name || '').trim() || '미정'

  if (!isFirebaseEnabled()) {
    const duplicated = roomStore.some((row) => row.name === normalizedName)
    if (duplicated) {
      throw new Error('이미 등록된 동아리실입니다.')
    }
    const next = {
      id: `local-room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: normalizedName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    roomStore = sortRooms([...roomStore, next])
    return next
  }

  const duplicatedSnap = await getDocs(
    query(collection(db, ROOMS_COLLECTION_NAME), where('name', '==', normalizedName)),
  )
  if (!duplicatedSnap.empty) {
    throw new Error('이미 등록된 동아리실입니다.')
  }

  const created = await addDoc(collection(db, ROOMS_COLLECTION_NAME), {
    name: normalizedName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  return normalizeRoom(created.id, { name: normalizedName })
}

export async function deleteClubRoom(roomId, options = {}) {
  const actor = assertActor(options?.actor)
  if (actor.role !== 'admin' && actor.loginId !== 'admin') {
    throw new Error('동아리실 삭제는 관리자만 가능합니다.')
  }

  const targetId = String(roomId || '').trim()
  if (!targetId || targetId === 'system-undecided') {
    throw new Error('삭제할 수 없는 항목입니다.')
  }

  if (!isFirebaseEnabled()) {
    const target = roomStore.find((row) => row.id === targetId)
    if (!target) {
      throw new Error('동아리실 정보를 찾을 수 없습니다.')
    }
    if (target.name === '미정') {
      throw new Error('미정 항목은 삭제할 수 없습니다.')
    }
    const inUse = scheduleStore.some(
      (row) => String(row?.room || row?.region || '').trim() === target.name,
    )
    if (inUse) {
      throw new Error('사용 중인 동아리실은 삭제할 수 없습니다.')
    }
    roomStore = roomStore.filter((row) => row.id !== targetId)
    return { ok: true }
  }

  const roomRef = doc(db, ROOMS_COLLECTION_NAME, targetId)
  const roomSnap = await getDoc(roomRef)
  if (!roomSnap.exists()) {
    throw new Error('동아리실 정보를 찾을 수 없습니다.')
  }

  const roomName = String(roomSnap.data()?.name || '').trim()
  if (roomName === '미정') {
    throw new Error('미정 항목은 삭제할 수 없습니다.')
  }

  const inUseSnap = await getDocs(
    query(collection(db, COLLECTION_NAME), where('room', '==', roomName)),
  )
  if (!inUseSnap.empty) {
    throw new Error('사용 중인 동아리실은 삭제할 수 없습니다.')
  }

  await deleteDoc(roomRef)
  return { ok: true }
}

export async function createSchedule(payload, options = {}) {
  const actor = assertActor(options?.actor)
  if (actor.role !== 'admin' && actor.role !== 'teacher') {
    throw new Error('동아리 개설은 관리자 또는 교사만 가능합니다.')
  }

  const teacherUid = actor.role === 'teacher'
    ? actor.uid
    : String(payload?.teacherUid || '').trim()

  const data = assertClubPayload(
    {
      ...payload,
      teacherUid,
      randomDrawnRounds: [],
    },
    { requireTeacherUid: true },
  )

  const row = {
    ...data,
    memberCount: 0,
    createdByUid: actor.uid,
  }

  if (!isFirebaseEnabled()) {
    const next = {
      id: String(Date.now()),
      ...row,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    scheduleStore = [...scheduleStore, next]
    return normalizeClub(next.id, next)
  }

  const schedulesRef = collection(db, COLLECTION_NAME)
  const created = await addDoc(schedulesRef, {
    ...row,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  return {
    id: created.id,
    ...normalizeClub(created.id, row),
  }
}

export async function updateSchedule(scheduleId, payload, options = {}) {
  const actor = assertActor(options?.actor)
  const existing = await getScheduleById(scheduleId)
  if (!existing) {
    throw new Error('동아리 정보를 찾을 수 없습니다.')
  }
  if (!canEditClub(existing, actor)) {
    throw new Error('이 동아리의 수정 권한이 없습니다.')
  }

  const nextTeacherUid = actor.role === 'admin'
    ? String(payload?.teacherUid ?? existing.teacherUid).trim()
    : existing.teacherUid

  const nextPayload = assertClubPayload(
    {
      ...existing,
      ...payload,
      teacherUid: nextTeacherUid,
      randomDrawnRounds: payload?.randomDrawnRounds ?? existing.randomDrawnRounds,
    },
    { requireTeacherUid: true },
  )

  const currentMemberCount = Math.max(0, Number(existing.memberCount || 0))
  if (nextPayload.maxMembers < currentMemberCount) {
    throw new Error('동아리 최대인원은 현재 확정 인원보다 작을 수 없습니다.')
  }

  if (!isFirebaseEnabled()) {
    scheduleStore = scheduleStore.map((item) => {
      if (item.id !== scheduleId) return item
      return {
        ...item,
        ...nextPayload,
        memberCount: currentMemberCount,
        updatedAt: new Date().toISOString(),
      }
    })
    const row = scheduleStore.find((item) => item.id === scheduleId)
    return row ? normalizeClub(row.id, row) : null
  }

  const ref = doc(db, COLLECTION_NAME, scheduleId)
  await updateDoc(ref, {
    ...nextPayload,
    updatedAt: serverTimestamp(),
  })

  return getScheduleById(scheduleId)
}

export async function deleteSchedule(scheduleId, options = {}) {
  const actor = assertActor(options?.actor)
  if (actor.role !== 'admin' && actor.loginId !== 'admin') {
    throw new Error('동아리 삭제는 관리자만 가능합니다.')
  }

  if (!isFirebaseEnabled()) {
    scheduleStore = scheduleStore.filter((item) => item.id !== scheduleId)
    return
  }

  const scheduleRef = doc(db, COLLECTION_NAME, scheduleId)
  const membersSnap = await getDocs(collection(db, COLLECTION_NAME, scheduleId, 'members'))
  const studentsSnap = await getDocs(collection(db, COLLECTION_NAME, scheduleId, 'students'))
  const appsByClubSnap = await getDocs(
    query(collection(db, 'applications'), where('clubId', '==', scheduleId)),
  )
  const appsByScheduleSnap = await getDocs(
    query(collection(db, 'applications'), where('scheduleId', '==', scheduleId)),
  )
  const assignmentsSnap = await getDocs(
    query(collection(db, 'recruitmentAssignments'), where('clubId', '==', scheduleId)),
  )
  const draftsSnap = await getDocs(
    query(collection(db, 'applicationDrafts'), where('clubIds', 'array-contains', scheduleId)),
  )

  const refsMap = new Map()
  membersSnap.docs.forEach((row) => refsMap.set(row.ref.path, row.ref))
  studentsSnap.docs.forEach((row) => refsMap.set(row.ref.path, row.ref))
  appsByClubSnap.docs.forEach((row) => refsMap.set(row.ref.path, row.ref))
  appsByScheduleSnap.docs.forEach((row) => refsMap.set(row.ref.path, row.ref))
  assignmentsSnap.docs.forEach((row) => refsMap.set(row.ref.path, row.ref))
  draftsSnap.docs.forEach((row) => refsMap.set(row.ref.path, row.ref))
  refsMap.set(scheduleRef.path, scheduleRef)

  const refs = Array.from(refsMap.values())
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db)
    refs.slice(i, i + 400).forEach((ref) => batch.delete(ref))
    await batch.commit()
  }
}

export async function updateScheduleMemberCount(scheduleId, nextCount) {
  const normalizedCount = Math.max(0, Math.trunc(toNumber(nextCount, 0)))

  if (!isFirebaseEnabled()) {
    scheduleStore = scheduleStore.map((item) => {
      if (item.id !== scheduleId) return item
      return {
        ...item,
        memberCount: normalizedCount,
        updatedAt: new Date().toISOString(),
      }
    })
    return
  }

  await updateDoc(doc(db, COLLECTION_NAME, scheduleId), {
    memberCount: normalizedCount,
    updatedAt: serverTimestamp(),
  })
}

export async function resetScheduleStore() {
  scheduleStore = [...mockSchedules]
  roomStore = Array.from(
    new Set(
      [...mockSchedules.map((item) => String(item.room || '').trim()), '미정']
        .filter((item) => !!item),
    ),
  ).map((name, index) => ({
    id: `local-room-${index + 1}`,
    name,
    createdAt: null,
    updatedAt: null,
  }))
  return scheduleStore.map((item) => normalizeClub(item.id, item))
}
