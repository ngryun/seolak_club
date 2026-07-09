import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { db, isFirebaseEnabled } from '../lib/firebase'

const COLLECTION_NAME = 'programs'

// 프로그램 개념 도입 전의 기존 데이터(동아리)는 이 기본 프로그램에 귀속됩니다.
export const DEFAULT_PROGRAM_ID = 'club-default'
// 기존 recruitmentCycles 문서 ID. 기본 프로그램만 이 값을 유지하고, 새 프로그램은 programId를 cycleId로 사용합니다.
export const DEFAULT_CYCLE_ID = 'current'
export const MAX_PREFERENCE_COUNT = 3

const PROGRAM_STATUS = new Set(['active', 'archived'])

function buildDefaultProgramData() {
  return {
    name: '동아리',
    cycleId: DEFAULT_CYCLE_ID,
    unitLabel: '동아리',
    preferenceCount: MAX_PREFERENCE_COUNT,
    features: {
      leader: true,
      plan: true,
      room: true,
      interview: true,
    },
    targetClasses: [],
    status: 'active',
    sortOrder: 0,
    createdByUid: '',
  }
}

let localPrograms = [{
  id: DEFAULT_PROGRAM_ID,
  ...buildDefaultProgramData(),
  createdAt: null,
  updatedAt: null,
}]

function toPreferenceCount(value, fallback = MAX_PREFERENCE_COUNT) {
  const parsed = Math.trunc(Number(value))
  if (parsed >= 1 && parsed <= MAX_PREFERENCE_COUNT) return parsed
  return fallback
}

function normalizeFeatures(value, fallback = true) {
  return {
    leader: typeof value?.leader === 'boolean' ? value.leader : fallback,
    plan: typeof value?.plan === 'boolean' ? value.plan : fallback,
    room: typeof value?.room === 'boolean' ? value.room : fallback,
    interview: typeof value?.interview === 'boolean' ? value.interview : fallback,
  }
}

function normalizeClassKey(value) {
  const matched = String(value || '').trim().match(/^([1-3])-0*([1-9]\d?)$/u)
  if (!matched) return ''
  return `${Number(matched[1])}-${Number(matched[2])}`
}

function sortClassKeys(values) {
  return [...values].sort((left, right) => {
    const [leftGrade, leftClass] = left.split('-').map(Number)
    const [rightGrade, rightClass] = right.split('-').map(Number)
    return leftGrade - rightGrade || leftClass - rightClass
  })
}

export function normalizeProgramTargetClasses(value) {
  const rows = Array.isArray(value) ? value : []
  return sortClassKeys(Array.from(new Set(rows.map(normalizeClassKey).filter(Boolean))))
}

export function getStudentClassKey(studentNo) {
  const raw = String(studentNo || '').trim()
  if (!/^\d{5}$/u.test(raw)) return ''
  const grade = Number(raw[0])
  const classNo = Number(raw.slice(1, 3))
  if (grade < 1 || grade > 3 || classNo < 1) return ''
  return `${grade}-${classNo}`
}

export function isStudentEligibleForProgram(program, studentNo) {
  const targets = normalizeProgramTargetClasses(program?.targetClasses)
  if (targets.length === 0) return true
  const classKey = getStudentClassKey(studentNo)
  return !!classKey && targets.includes(classKey)
}

export function normalizeProgram(id, data) {
  const status = PROGRAM_STATUS.has(String(data?.status || '').trim())
    ? String(data.status).trim()
    : 'active'

  return {
    id,
    name: String(data?.name || '').trim() || '이름 없는 프로그램',
    cycleId: String(data?.cycleId || '').trim() || (id === DEFAULT_PROGRAM_ID ? DEFAULT_CYCLE_ID : id),
    unitLabel: String(data?.unitLabel || '').trim() || '동아리',
    preferenceCount: toPreferenceCount(data?.preferenceCount),
    features: normalizeFeatures(data?.features),
    // 비어 있으면 전체 학급, 값이 있으면 해당 학급 학생만 신청할 수 있습니다.
    targetClasses: normalizeProgramTargetClasses(data?.targetClasses),
    status,
    // 학생 화면 노출 여부. false면 학생에게는 스위처·신청 화면에서 숨겨짐 (관리자·교사는 계속 접근 가능)
    studentVisible: data?.studentVisible !== false,
    sortOrder: Number.isFinite(Number(data?.sortOrder)) ? Number(data.sortOrder) : 0,
    roomLabel: String(data?.roomLabel || '').trim(),
    leaderLabel: String(data?.leaderLabel || '').trim(),
    createdByUid: String(data?.createdByUid || '').trim(),
    createdAt: data?.createdAt || null,
    updatedAt: data?.updatedAt || null,
  }
}

export function getProgramLabels(program) {
  const unit = String(program?.unitLabel || '').trim() || '동아리'
  const isClubLike = unit === '동아리'
  return {
    unit,
    room: String(program?.roomLabel || '').trim() || (isClubLike ? '동아리실' : '활동 장소'),
    leader: String(program?.leaderLabel || '').trim() || (isClubLike ? '동아리장' : '대표 학생'),
  }
}

function sortPrograms(rows) {
  return [...rows].sort((a, b) => {
    if (a.id === DEFAULT_PROGRAM_ID && b.id !== DEFAULT_PROGRAM_ID) return -1
    if (b.id === DEFAULT_PROGRAM_ID && a.id !== DEFAULT_PROGRAM_ID) return 1
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return String(a.name).localeCompare(String(b.name), 'ko')
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

function assertAdmin(actor) {
  const normalized = assertActor(actor)
  if (normalized.role !== 'admin' && normalized.loginId !== 'admin') {
    throw new Error('프로그램 관리는 관리자만 가능합니다.')
  }
  return normalized
}

function assertProgramPayload(payload) {
  const name = String(payload?.name || '').trim()
  if (!name) {
    throw new Error('프로그램 이름은 필수입니다.')
  }

  return {
    name,
    unitLabel: String(payload?.unitLabel || '').trim() || '동아리',
    preferenceCount: toPreferenceCount(payload?.preferenceCount),
    features: normalizeFeatures(payload?.features),
    targetClasses: normalizeProgramTargetClasses(payload?.targetClasses),
    studentVisible: payload?.studentVisible !== false,
    roomLabel: String(payload?.roomLabel || '').trim(),
    leaderLabel: String(payload?.leaderLabel || '').trim(),
    sortOrder: Number.isFinite(Number(payload?.sortOrder)) ? Number(payload.sortOrder) : 0,
  }
}

function normalizeProgramNameKey(value) {
  return String(value || '').trim().normalize('NFKC').toLocaleLowerCase('ko')
}

const _listProgramsCache = { data: null, ts: 0 }

export function invalidateProgramCache() {
  _listProgramsCache.data = null
  _listProgramsCache.ts = 0
}

export async function listPrograms(options = {}) {
  const includeArchived = options?.includeArchived === true
  const forceRefresh = options?.forceRefresh === true

  if (!isFirebaseEnabled()) {
    const rows = localPrograms.map((item) => normalizeProgram(item.id, item))
    const filtered = includeArchived ? rows : rows.filter((row) => row.status === 'active')
    return sortPrograms(filtered)
  }

  if (!forceRefresh && _listProgramsCache.data) {
    const cached = includeArchived
      ? _listProgramsCache.data
      : _listProgramsCache.data.filter((row) => row.status === 'active')
    return sortPrograms(cached)
  }

  const snapshot = await getDocs(collection(db, COLLECTION_NAME))
  const rows = snapshot.docs.map((row) => normalizeProgram(row.id, row.data()))
  _listProgramsCache.data = rows
  _listProgramsCache.ts = Date.now()
  const filtered = includeArchived ? rows : rows.filter((row) => row.status === 'active')
  return sortPrograms(filtered)
}

export async function getProgramById(programId) {
  const targetId = String(programId || '').trim() || DEFAULT_PROGRAM_ID

  if (!isFirebaseEnabled()) {
    const item = localPrograms.find((row) => row.id === targetId)
    return item ? normalizeProgram(item.id, item) : null
  }

  const cached = _listProgramsCache.data?.find((row) => row.id === targetId)
  if (cached) return cached

  const snapshot = await getDoc(doc(db, COLLECTION_NAME, targetId))
  if (!snapshot.exists()) return null
  return normalizeProgram(snapshot.id, snapshot.data())
}

// 프로그램 컬렉션이 비어 있으면 기존 동아리 데이터를 대표하는 기본 프로그램을 생성합니다. (멱등)
export async function ensureDefaultProgram() {
  if (!isFirebaseEnabled()) {
    if (!localPrograms.some((row) => row.id === DEFAULT_PROGRAM_ID)) {
      localPrograms = [{
        id: DEFAULT_PROGRAM_ID,
        ...buildDefaultProgramData(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, ...localPrograms]
    }
    return normalizeProgram(DEFAULT_PROGRAM_ID, localPrograms.find((row) => row.id === DEFAULT_PROGRAM_ID))
  }

  const ref = doc(db, COLLECTION_NAME, DEFAULT_PROGRAM_ID)
  const snapshot = await getDoc(ref)
  if (snapshot.exists()) {
    return normalizeProgram(snapshot.id, snapshot.data())
  }

  const data = buildDefaultProgramData()
  await setDoc(ref, {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  invalidateProgramCache()
  return normalizeProgram(DEFAULT_PROGRAM_ID, data)
}

export async function createProgram(payload, options = {}) {
  const actor = assertAdmin(options?.actor)
  const data = assertProgramPayload(payload)

  if (!isFirebaseEnabled()) {
    const id = `local-program-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const next = {
      id,
      ...data,
      cycleId: id,
      status: 'active',
      createdByUid: actor.uid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    localPrograms = [...localPrograms, next]
    return normalizeProgram(next.id, next)
  }

  const ref = doc(collection(db, COLLECTION_NAME))
  const row = {
    ...data,
    cycleId: ref.id,
    status: 'active',
    createdByUid: actor.uid,
  }
  await setDoc(ref, {
    ...row,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  invalidateProgramCache()
  return normalizeProgram(ref.id, row)
}

export async function createProgramsBatch(programs, options = {}) {
  const actor = assertAdmin(options?.actor)
  const rows = Array.isArray(programs) ? programs : []
  const existing = await listPrograms({ includeArchived: true, forceRefresh: true })
  const usedNames = new Set(existing.map((row) => normalizeProgramNameKey(row.name)))
  const created = []
  const failed = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const sourceRow = Number(row?.sourceRow) || index + 2
    try {
      if (row?.importError) {
        throw new Error(String(row.importError))
      }

      const data = assertProgramPayload(row)
      const nameKey = normalizeProgramNameKey(data.name)
      if (usedNames.has(nameKey)) {
        throw new Error('같은 이름의 프로그램이 이미 있습니다.')
      }

      const program = await createProgram(data, { actor })
      created.push(program)
      usedNames.add(nameKey)
    } catch (error) {
      failed.push({
        row: sourceRow,
        name: String(row?.name || '').trim(),
        reason: error instanceof Error ? error.message : '프로그램 생성 실패',
      })
    }
  }

  return { created, failed }
}

export async function updateProgram(programId, payload, options = {}) {
  assertAdmin(options?.actor)
  const existing = await getProgramById(programId)
  if (!existing) {
    throw new Error('프로그램 정보를 찾을 수 없습니다.')
  }

  const data = assertProgramPayload({ ...existing, ...payload })
  const status = PROGRAM_STATUS.has(String(payload?.status || '').trim())
    ? String(payload.status).trim()
    : existing.status

  // cycleId는 신청/선발 데이터의 스코프 키이므로 변경을 허용하지 않습니다.
  const patch = { ...data, status }

  if (!isFirebaseEnabled()) {
    localPrograms = localPrograms.map((item) => {
      if (item.id !== existing.id) return item
      return { ...item, ...patch, updatedAt: new Date().toISOString() }
    })
    const row = localPrograms.find((item) => item.id === existing.id)
    return normalizeProgram(row.id, row)
  }

  await updateDoc(doc(db, COLLECTION_NAME, existing.id), {
    ...patch,
    updatedAt: serverTimestamp(),
  })
  invalidateProgramCache()
  return getProgramById(existing.id)
}

// 새 모집 시작(사이클 회전) 전용. 일반 수정 경로에서는 cycleId 변경을 허용하지 않습니다.
export async function setProgramCycleId(programId, nextCycleId, options = {}) {
  assertAdmin(options?.actor)
  const existing = await getProgramById(programId)
  if (!existing) {
    throw new Error('프로그램 정보를 찾을 수 없습니다.')
  }
  const cycleId = String(nextCycleId || '').trim()
  if (!cycleId) {
    throw new Error('새 사이클 ID가 필요합니다.')
  }

  if (!isFirebaseEnabled()) {
    localPrograms = localPrograms.map((item) => {
      if (item.id !== existing.id) return item
      return { ...item, cycleId, updatedAt: new Date().toISOString() }
    })
    return normalizeProgram(existing.id, localPrograms.find((item) => item.id === existing.id))
  }

  await updateDoc(doc(db, COLLECTION_NAME, existing.id), {
    cycleId,
    updatedAt: serverTimestamp(),
  })
  invalidateProgramCache()
  return getProgramById(existing.id)
}

export async function archiveProgram(programId, options = {}) {
  const existing = await getProgramById(programId)
  if (existing?.id === DEFAULT_PROGRAM_ID && options?.allowDefault !== true) {
    throw new Error('기본 동아리 프로그램은 보관할 수 없습니다.')
  }
  return updateProgram(programId, { status: 'archived' }, options)
}

export async function restoreProgram(programId, options = {}) {
  return updateProgram(programId, { status: 'active' }, options)
}

export async function resetProgramStore() {
  localPrograms = [{
    id: DEFAULT_PROGRAM_ID,
    ...buildDefaultProgramData(),
    createdAt: null,
    updatedAt: null,
  }]
  invalidateProgramCache()
  return localPrograms.map((item) => normalizeProgram(item.id, item))
}
