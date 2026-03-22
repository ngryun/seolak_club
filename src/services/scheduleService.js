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
import { getUserProfile } from './userService'

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

function normalizeUidList(value) {
  const raw = Array.isArray(value) ? value : [value]
  return Array.from(
    new Set(
      raw
        .map((item) => String(item || '').trim())
        .filter((item) => !!item),
    ),
  )
}

function normalizeFixedStringList(value, size = 0) {
  const raw = Array.isArray(value) ? value : value ? [value] : []
  const normalized = raw.map((item) => String(item || '').trim())
  if (size <= 0) return normalized
  if (normalized.length >= size) return normalized.slice(0, size)
  return [
    ...normalized,
    ...Array.from({ length: size - normalized.length }, () => ''),
  ]
}

export function getClubTeacherUids(club) {
  const teacherUids = normalizeUidList(club?.teacherUids)
  if (teacherUids.length > 0) return teacherUids

  const teacherUid = String(club?.teacherUid || '').trim()
  return teacherUid ? [teacherUid] : []
}

export function isClubTeacher(club, userUid) {
  const targetUid = String(userUid || '').trim()
  if (!targetUid) return false
  return getClubTeacherUids(club).includes(targetUid)
}

function normalizeClub(id, data) {
  const legacy = !data?.clubName && !!data?.school
  const targetGrades = normalizeTargetGrades(data?.targetGrades)
  const teacherUids = getClubTeacherUids(data)
  const teacherNames = normalizeFixedStringList(
    Array.isArray(data?.teacherNames) ? data?.teacherNames : (data?.teacherName ? [data.teacherName] : []),
    teacherUids.length,
  )
  const teacherLoginIds = normalizeFixedStringList(
    Array.isArray(data?.teacherLoginIds) ? data?.teacherLoginIds : (data?.teacherLoginId ? [data.teacherLoginId] : []),
    teacherUids.length,
  )

  return {
    id,
    teacherUid: teacherUids[0] || '',
    teacherUids,
    teacherName: String(teacherNames[0] || data?.teacherName || '').trim(),
    teacherNames,
    teacherLoginId: String(teacherLoginIds[0] || data?.teacherLoginId || '').trim(),
    teacherLoginIds,
    leaderUid: String(data?.leaderUid || '').trim(),
    leaderName: String(data?.leaderName || '').trim(),
    leaderStudentNo: String(data?.leaderStudentNo || '').trim(),
    clubName: String(data?.clubName || data?.school || '').trim(),
    targetGrades: targetGrades.length > 0 ? targetGrades : [1, 2, 3],
    description: String(data?.description || '').trim(),
    room: String(data?.room || data?.region || '').trim(),
    maxMembers: Math.max(0, Math.trunc(toNumber(data?.maxMembers ?? data?.needed, 0))),
    isInterviewSelection: Boolean(data?.isInterviewSelection),
    memberCount: Math.max(0, Math.trunc(toNumber(data?.memberCount ?? data?.applied, 0))),
    randomDrawnRounds: normalizeRandomRounds(data?.randomDrawnRounds),
    createdByUid: String(data?.createdByUid || '').trim(),
    plan: data?.plan || null,
    createdAt: data?.createdAt || null,
    updatedAt: data?.updatedAt || null,
    legacy,
  }
}

function buildDisplayFieldsFromProfiles(teachers, leader) {
  const teacherRows = Array.isArray(teachers) ? teachers : []
  const teacherNames = teacherRows.map((teacher) => String(teacher?.name || '').trim())
  const teacherLoginIds = teacherRows.map((teacher) => String(teacher?.loginId || '').trim())

  return {
    teacherName: String(teacherNames[0] || '').trim(),
    teacherNames,
    teacherLoginId: String(teacherLoginIds[0] || '').trim(),
    teacherLoginIds,
    leaderName: String(leader?.name || '').trim(),
    leaderStudentNo: String(leader?.studentNo || '').trim(),
  }
}

async function resolveClubDisplayFields({ teacherUids = [], leaderUid = '' } = {}) {
  const normalizedTeacherUids = normalizeUidList(teacherUids)
  const [teachers, leader] = await Promise.all([
    Promise.all(normalizedTeacherUids.map((teacherUid) => getUserProfile(teacherUid))),
    leaderUid ? getUserProfile(leaderUid) : Promise.resolve(null),
  ])

  return buildDisplayFieldsFromProfiles(teachers, leader)
}

function needsClubDisplayBackfill(club) {
  const teacherUids = getClubTeacherUids(club)
  const leaderUid = String(club?.leaderUid || '').trim()
  const teacherNames = normalizeFixedStringList(club?.teacherNames, teacherUids.length)
  const teacherLoginIds = normalizeFixedStringList(club?.teacherLoginIds, teacherUids.length)
  const teacherName = String(club?.teacherName || '').trim()
  const teacherLoginId = String(club?.teacherLoginId || '').trim()
  const leaderName = String(club?.leaderName || '').trim()
  const leaderStudentNo = String(club?.leaderStudentNo || '').trim()

  return (teacherUids.length > 0 && (
    !teacherName
    || !teacherLoginId
    || teacherNames.some((item) => !item)
    || teacherLoginIds.some((item) => !item)
  ))
    || (leaderUid && (!leaderName || !leaderStudentNo))
}

function hasDisplayFieldChanges(club, displayFields) {
  const teacherUids = getClubTeacherUids(club)
  const currentTeacherNames = normalizeFixedStringList(club?.teacherNames, teacherUids.length)
  const nextTeacherNames = normalizeFixedStringList(displayFields?.teacherNames, teacherUids.length)
  const currentTeacherLoginIds = normalizeFixedStringList(club?.teacherLoginIds, teacherUids.length)
  const nextTeacherLoginIds = normalizeFixedStringList(displayFields?.teacherLoginIds, teacherUids.length)

  return String(club?.teacherName || '').trim() !== String(displayFields.teacherName || '').trim()
    || String(club?.teacherLoginId || '').trim() !== String(displayFields.teacherLoginId || '').trim()
    || currentTeacherNames.some((value, index) => value !== nextTeacherNames[index])
    || currentTeacherLoginIds.some((value, index) => value !== nextTeacherLoginIds[index])
    || String(club?.leaderName || '').trim() !== String(displayFields.leaderName || '').trim()
    || String(club?.leaderStudentNo || '').trim() !== String(displayFields.leaderStudentNo || '').trim()
}

function applyLocalClubPatch(clubId, patch) {
  scheduleStore = scheduleStore.map((item) => {
    if (item.id !== clubId) return item
    return {
      ...item,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
  })
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
  const teacherUids = normalizeUidList(payload?.teacherUids ?? payload?.teacherUid)
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
  if (requireTeacherUid && teacherUids.length === 0) {
    throw new Error('담당교사 계정 연결이 필요합니다.')
  }

  return {
    clubName,
    targetGrades,
    description,
    room,
    maxMembers,
    isInterviewSelection,
    teacherUid: teacherUids[0] || '',
    teacherUids,
    leaderUid,
    randomDrawnRounds,
  }
}

export function canEditClub(club, actor) {
  const uid = String(actor?.uid || '').trim()
  const role = String(actor?.role || '').trim()
  if (!uid) return false
  if (role === 'admin') return true
  return isClubTeacher(club, uid) || uid === String(club?.leaderUid || '').trim()
}

export function canManageSelection(club, actor) {
  const uid = String(actor?.uid || '').trim()
  const role = String(actor?.role || '').trim()
  if (!uid) return false
  if (role === 'admin') return true
  return isClubTeacher(club, uid)
}

const _listSchedulesCache = { data: null, ts: 0 }
const LIST_SCHEDULES_TTL = Infinity // 명시적 새로고침/데이터 변경 시만 무효화

export async function listSchedules(options = {}) {
  const includeLegacy = options?.includeLegacy === true
  const forceRefresh = options?.forceRefresh === true

  if (!isFirebaseEnabled()) {
    const rows = scheduleStore.map((item) => normalizeClub(item.id, item))
    const filtered = includeLegacy ? rows : rows.filter((row) => !row.legacy)
    return sortClubs(filtered)
  }

  const now = Date.now()
  if (!forceRefresh && _listSchedulesCache.data && now - _listSchedulesCache.ts < LIST_SCHEDULES_TTL) {
    const filtered = includeLegacy ? _listSchedulesCache.data : _listSchedulesCache.data.filter((row) => !row.legacy)
    return sortClubs(filtered)
  }

  const schedulesRef = collection(db, COLLECTION_NAME)
  const snapshot = await getDocs(schedulesRef)
  const rows = snapshot.docs.map((row) => normalizeClub(row.id, row.data()))
  _listSchedulesCache.data = rows
  _listSchedulesCache.ts = now
  const filtered = includeLegacy ? rows : rows.filter((row) => !row.legacy)
  return sortClubs(filtered)
}

export function invalidateScheduleCache() {
  _listSchedulesCache.data = null
  _listSchedulesCache.ts = 0
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

  const teacherUids = actor.role === 'teacher'
    ? [actor.uid]
    : normalizeUidList(payload?.teacherUids ?? payload?.teacherUid)

  const data = assertClubPayload(
    {
      ...payload,
      teacherUids,
      teacherUid: teacherUids[0] || '',
      randomDrawnRounds: [],
    },
    { requireTeacherUid: true },
  )
  const displayFields = await resolveClubDisplayFields({
    teacherUids: data.teacherUids,
    leaderUid: data.leaderUid,
  })

  const row = {
    ...data,
    teacherUid: data.teacherUids[0] || '',
    ...displayFields,
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

  const nextTeacherUids = actor.role === 'admin'
    ? normalizeUidList(payload?.teacherUids ?? payload?.teacherUid ?? existing.teacherUids ?? existing.teacherUid)
    : getClubTeacherUids(existing)

  const nextPayload = assertClubPayload(
    {
      ...existing,
      ...payload,
      teacherUids: nextTeacherUids,
      teacherUid: nextTeacherUids[0] || '',
      randomDrawnRounds: payload?.randomDrawnRounds ?? existing.randomDrawnRounds,
    },
    { requireTeacherUid: true },
  )
  const displayFields = await resolveClubDisplayFields({
    teacherUids: nextPayload.teacherUids,
    leaderUid: nextPayload.leaderUid,
  })

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
        teacherUid: nextPayload.teacherUids[0] || '',
        ...displayFields,
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
    teacherUid: nextPayload.teacherUids[0] || '',
    ...displayFields,
    updatedAt: serverTimestamp(),
  })

  return getScheduleById(scheduleId)
}

export async function backfillScheduleDisplayFields(options = {}) {
  const rows = Array.isArray(options?.clubs)
    ? options.clubs.map((club) => normalizeClub(club.id, club))
    : await listSchedules({ includeLegacy: true })

  const targets = rows.filter((club) => !club.legacy && needsClubDisplayBackfill(club))
  if (targets.length === 0) {
    return { updatedCount: 0 }
  }

  if (!isFirebaseEnabled()) {
    let updatedCount = 0
    for (const club of targets) {
      const teacherUids = getClubTeacherUids(club)
      const displayFields = await resolveClubDisplayFields({
        teacherUids,
        leaderUid: club.leaderUid,
      })
      if (!hasDisplayFieldChanges(club, displayFields)) continue
      applyLocalClubPatch(club.id, {
        teacherUid: teacherUids[0] || '',
        teacherUids,
        ...displayFields,
      })
      updatedCount += 1
    }
    return { updatedCount }
  }

  let updatedCount = 0
  const patches = []
  for (const club of targets) {
    const teacherUids = getClubTeacherUids(club)
    const displayFields = await resolveClubDisplayFields({
      teacherUids,
      leaderUid: club.leaderUid,
    })
    if (!hasDisplayFieldChanges(club, displayFields)) continue
    patches.push({ clubId: club.id, teacherUids, displayFields })
  }

  for (let index = 0; index < patches.length; index += 400) {
    const batch = writeBatch(db)
    const chunk = patches.slice(index, index + 400)
    chunk.forEach(({ clubId, teacherUids, displayFields }) => {
      batch.update(doc(db, COLLECTION_NAME, clubId), {
        teacherUid: teacherUids[0] || '',
        teacherUids,
        ...displayFields,
        updatedAt: serverTimestamp(),
      })
      updatedCount += 1
    })
    await batch.commit()
  }

  return { updatedCount }
}

export async function syncClubDisplayFieldsForUser(userUid) {
  const targetUid = String(userUid || '').trim()
  if (!targetUid) {
    return { updatedCount: 0 }
  }

  if (!isFirebaseEnabled()) {
    const targets = scheduleStore
      .map((item) => normalizeClub(item.id, item))
      .filter((club) => isClubTeacher(club, targetUid) || String(club?.leaderUid || '').trim() === targetUid)

    let updatedCount = 0
    for (const club of targets) {
      const teacherUids = getClubTeacherUids(club)
      const displayFields = await resolveClubDisplayFields({
        teacherUids,
        leaderUid: club.leaderUid,
      })
      if (!hasDisplayFieldChanges(club, displayFields)) continue
      applyLocalClubPatch(club.id, {
        teacherUid: teacherUids[0] || '',
        teacherUids,
        ...displayFields,
      })
      updatedCount += 1
    }
    return { updatedCount }
  }

  const clubsMap = new Map()
  const teacherSnap = await getDocs(
    query(collection(db, COLLECTION_NAME), where('teacherUids', 'array-contains', targetUid)),
  )
  teacherSnap.docs.forEach((row) => clubsMap.set(row.id, normalizeClub(row.id, row.data())))

  const legacyTeacherSnap = await getDocs(
    query(collection(db, COLLECTION_NAME), where('teacherUid', '==', targetUid)),
  )
  legacyTeacherSnap.docs.forEach((row) => {
    if (!clubsMap.has(row.id)) {
      clubsMap.set(row.id, normalizeClub(row.id, row.data()))
    }
  })

  const leaderSnap = await getDocs(
    query(collection(db, COLLECTION_NAME), where('leaderUid', '==', targetUid)),
  )
  leaderSnap.docs.forEach((row) => {
    if (!clubsMap.has(row.id)) {
      clubsMap.set(row.id, normalizeClub(row.id, row.data()))
    }
  })

  const patches = []
  for (const club of clubsMap.values()) {
    const teacherUids = getClubTeacherUids(club)
    const displayFields = await resolveClubDisplayFields({
      teacherUids,
      leaderUid: club.leaderUid,
    })
    if (!hasDisplayFieldChanges(club, displayFields)) continue
    patches.push({ clubId: club.id, teacherUids, displayFields })
  }

  for (let index = 0; index < patches.length; index += 400) {
    const batch = writeBatch(db)
    patches.slice(index, index + 400).forEach(({ clubId, teacherUids, displayFields }) => {
      batch.update(doc(db, COLLECTION_NAME, clubId), {
        teacherUid: teacherUids[0] || '',
        teacherUids,
        ...displayFields,
        updatedAt: serverTimestamp(),
      })
    })
    await batch.commit()
  }

  return { updatedCount: patches.length }
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

export async function updateClubPlan(scheduleId, planPayload, options = {}) {
  const actor = options?.actor
  if (!actor?.uid) throw new Error('로그인이 필요합니다.')

  const club = await getScheduleById(scheduleId)
  if (!club) throw new Error('동아리를 찾을 수 없습니다.')
  if (!canEditClub(club, actor)) {
    throw new Error('동아리 계획을 수정할 권한이 없습니다.')
  }

  const lessonCount = Math.max(1, Math.trunc(toNumber(planPayload?.lessonCount, 28)))
  const overview = String(planPayload?.overview || '').slice(0, 200)
  const rawActivities = Array.isArray(planPayload?.activities) ? planPayload.activities : []
  const activities = Array.from({ length: lessonCount }, (_, i) => ({
    lesson: i + 1,
    content: String(rawActivities[i]?.content || '').trim(),
  }))
  const hasVolunteer = Boolean(planPayload?.hasVolunteer)
  const volunteerHours = hasVolunteer ? Math.max(0, Math.trunc(toNumber(planPayload?.volunteerHours, 0))) : 0
  const budgetItems = (Array.isArray(planPayload?.budgetItems) ? planPayload.budgetItems : [])
    .filter((row) => String(row?.item || '').trim())
    .map((row) => ({
      item: String(row.item || '').trim(),
      unitPrice: Math.max(0, Math.trunc(toNumber(row.unitPrice, 0))),
    }))

  const planStatus = String(planPayload?.planStatus || 'draft')
  const validStatuses = new Set(['draft', 'submitted'])
  const plan = {
    lessonCount,
    overview,
    activities,
    hasVolunteer,
    volunteerHours,
    budgetItems,
    planStatus: validStatuses.has(planStatus) ? planStatus : 'draft',
    updatedAt: new Date().toISOString(),
  }

  if (!isFirebaseEnabled()) {
    scheduleStore = scheduleStore.map((item) => {
      if (item.id !== scheduleId) return item
      return { ...item, plan, updatedAt: new Date().toISOString() }
    })
    invalidateScheduleCache()
    return plan
  }

  const ref = doc(db, COLLECTION_NAME, scheduleId)
  await updateDoc(ref, { plan, updatedAt: serverTimestamp() })
  invalidateScheduleCache()
  return plan
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
