import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  where,
} from 'firebase/firestore'
import { appConfig } from '../config/appConfig'
import { db, isFirebaseEnabled } from '../lib/firebase'

const COLLECTION = 'users'
const APPLICATIONS = 'applications'
const SCHEDULES = 'schedules'
const VALID_ROLES = new Set(['admin', 'teacher', 'student'])
const AUTH_LOGIN_DOMAIN = String(appConfig.authLoginDomain || 'seolak.local').trim() || 'seolak.local'
export const DEFAULT_ADMIN_LOGIN_ID = 'admin'
const LEGACY_DEFAULT_ADMIN_PASSWORD = 'admin'
export const DEFAULT_ADMIN_PASSWORD = String(appConfig.defaultAdminPassword || 'Seolak#2026!').trim() || 'Seolak#2026!'
const ACCOUNT_HEADERS = [
  '아이디(교사명/학생학번)',
  '비밀번호',
  '이름',
  '역할',
  '학번(5자리 숫자)',
  '이메일',
  '과목',
]
const ACCOUNT_HEADER_MAP = {
  아이디: 'loginId',
  '아이디(교사명/학번)': 'loginId',
  '아이디(교사명/학생학번)': 'loginId',
  '교사명/학번': 'loginId',
  ID: 'loginId',
  id: 'loginId',
  비밀번호: 'password',
  PASSWORD: 'password',
  password: 'password',
  이름: 'name',
  NAME: 'name',
  name: 'name',
  역할: 'role',
  ROLE: 'role',
  role: 'role',
  학번: 'studentNo',
  '학번(5자리 숫자)': 'studentNo',
  STUDENT_NO: 'studentNo',
  studentNo: 'studentNo',
  이메일: 'email',
  EMAIL: 'email',
  email: 'email',
  학교: 'school',
  SCHOOL: 'school',
  school: 'school',
  전화번호: 'phone',
  PHONE: 'phone',
  phone: 'phone',
  과목: 'subject',
  SUBJECT: 'subject',
  subject: 'subject',
}

const localUsers = new Map()
let xlsxModulePromise = null

async function getXlsx() {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import('xlsx')
  }
  const mod = await xlsxModulePromise
  if (mod && mod.utils) return mod
  return mod.default
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase()
  if (value === '관리자') return 'admin'
  if (value === '교사') return 'teacher'
  if (value === '학생') return 'student'
  if (VALID_ROLES.has(value)) return value
  return 'student'
}

function normalizeLoginId(loginId) {
  return String(loginId || '').trim()
}

function toBase64Url(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function isValidStudentNo(value) {
  return /^\d{5}$/.test(String(value || '').trim())
}

async function sha256Hex(value) {
  if (typeof crypto === 'undefined' || !crypto?.subtle) {
    return value
  }

  const source = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', source)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function hashPassword(loginId, password) {
  const id = normalizeLoginId(loginId).toLowerCase()
  return sha256Hex(`${id}::${String(password || '')}`)
}

async function verifyPassword(account, password) {
  const rawPassword = String(password || '')
  if (!rawPassword) return false

  if (account?.passwordHash) {
    const expected = await hashPassword(account.loginId, rawPassword)
    return expected === String(account.passwordHash)
  }

  if (account?.password != null) {
    return String(account.password) === rawPassword
  }

  return false
}

export function buildAuthEmailFromLoginId(loginId) {
  const normalized = normalizeLoginId(loginId)
  if (!normalized) {
    throw new Error('아이디는 필수입니다.')
  }

  const encoded = toBase64Url(normalized)
  return `id_${encoded}@${AUTH_LOGIN_DOMAIN}`
}

function normalizeUser(uid, data, { includeSecret = false } = {}) {
  const base = {
    uid,
    loginId: normalizeLoginId(data.loginId),
    email: String(data.email || '').trim(),
    name: String(data.name || '').trim(),
    school: String(data.school || '').trim(),
    phone: String(data.phone || '').trim(),
    subject: String(data.subject || '').trim(),
    studentNo: String(data.studentNo || '').trim(),
    role: normalizeRole(data.role),
    passwordChangedAt: data.passwordChangedAt || null,
    lastLoginAt: data.lastLoginAt || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  }

  if (!includeSecret) return base
  return {
    ...base,
    password: String(data.password || ''),
    passwordHash: String(data.passwordHash || ''),
  }
}

function getLocalUsers() {
  return Array.from(localUsers.values())
}

function randomLocalId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function randomFirebaseId() {
  return doc(collection(db, COLLECTION)).id
}

function findLocalByLoginId(loginId) {
  const normalized = normalizeLoginId(loginId)
  if (!normalized) return null
  return getLocalUsers().find((item) => item.loginId === normalized) || null
}

function toAccountPayload(payload) {
  const loginId = normalizeLoginId(payload.loginId || payload.id || payload.studentNo)
  const role = normalizeRole(payload.role)
  const account = {
    loginId,
    password: String(payload.password || ''),
    role,
    name: String(payload.name || '').trim(),
    email: String(payload.email || '').trim(),
    school: String(payload.school || '').trim(),
    phone: String(payload.phone || '').trim(),
    subject: String(payload.subject || '').trim(),
    studentNo: String(payload.studentNo || '').trim(),
  }

  if (!account.loginId) {
    throw new Error('아이디는 필수입니다.')
  }

  if (!account.password) {
    throw new Error('비밀번호는 필수입니다.')
  }

  if (role === 'teacher' && !account.name) {
    account.name = loginId
  }

  if (role === 'student') {
    if (!account.studentNo) account.studentNo = loginId
    if (!isValidStudentNo(account.studentNo)) {
      throw new Error(`학생 계정(${loginId})의 학번은 5자리 숫자여야 합니다.`)
    }
    if (!account.name) {
      throw new Error(`학생 계정(${loginId})은 이름이 필요합니다.`)
    }
  }

  if (role === 'admin' && !account.name) {
    account.name = '관리자'
  }

  return account
}

function toProfilePayload(payload) {
  const loginId = normalizeLoginId(payload.loginId)
  const role = normalizeRole(payload.role)
  const studentNo = role === 'student'
    ? String(payload.studentNo || loginId).trim()
    : String(payload.studentNo || '').trim()

  if (role === 'student' && !isValidStudentNo(studentNo)) {
    throw new Error('학생 학번은 5자리 숫자여야 합니다.')
  }

  return {
    uid: String(payload.uid || '').trim(),
    loginId,
    email: String(payload.email || '').trim(),
    name: String(payload.name || '').trim(),
    school: String(payload.school || '').trim(),
    phone: String(payload.phone || '').trim(),
    subject: String(payload.subject || '').trim(),
    studentNo,
    role,
  }
}

export async function ensureDefaultAdminAccount() {
  const adminPayload = {
    uid: 'admin',
    loginId: DEFAULT_ADMIN_LOGIN_ID,
    password: DEFAULT_ADMIN_PASSWORD,
    email: '',
    name: '관리자',
    school: '',
    phone: '',
    subject: '',
    studentNo: '',
    role: 'admin',
  }

  if (!isFirebaseEnabled()) {
    const existing = findLocalByLoginId(DEFAULT_ADMIN_LOGIN_ID)
    if (!existing) {
      localUsers.set(adminPayload.uid, {
        ...adminPayload,
        passwordHash: '',
      })
    }
    return normalizeUser(adminPayload.uid, adminPayload)
  }

  return bootstrapDefaultAdminIfNeeded()
}

export async function bootstrapDefaultAdminIfNeeded() {
  const loginId = DEFAULT_ADMIN_LOGIN_ID

  if (!isFirebaseEnabled()) {
    return ensureDefaultAdminAccount()
  }

  const existing = await findUserByLoginId(loginId, { includeSecret: true })
  const desiredPasswordHash = await hashPassword(loginId, DEFAULT_ADMIN_PASSWORD)
  const legacyPasswordHash = await hashPassword(loginId, LEGACY_DEFAULT_ADMIN_PASSWORD)
  if (existing) {
    const patch = {}
    if (existing.role !== 'admin') {
      patch.role = 'admin'
    }
    if (appConfig.defaultAdminPasswordFromEnv) {
      // If admin password is explicitly set in .env, sync to that value.
      if (existing.passwordHash !== desiredPasswordHash) {
        patch.passwordHash = desiredPasswordHash
      }
    } else if (!existing.passwordHash) {
      patch.passwordHash = desiredPasswordHash
    } else if (
      existing.passwordHash === legacyPasswordHash
      && DEFAULT_ADMIN_PASSWORD !== LEGACY_DEFAULT_ADMIN_PASSWORD
    ) {
      // Upgrade known weak default admin password hash automatically.
      patch.passwordHash = desiredPasswordHash
    }

    if (Object.keys(patch).length > 0) {
      await updateDoc(doc(db, COLLECTION, existing.uid), {
        ...patch,
        updatedAt: serverTimestamp(),
      })
      return getUserProfile(existing.uid)
    }
    return normalizeUser(existing.uid, existing)
  }

  const uid = randomFirebaseId()
  const profile = {
    uid,
    loginId,
    passwordHash: desiredPasswordHash,
    email: '',
    name: '관리자',
    school: '',
    phone: '',
    subject: '',
    studentNo: '',
    role: 'admin',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }

  await setDoc(doc(db, COLLECTION, uid), profile)
  return normalizeUser(uid, profile)
}

export async function findUserByLoginId(loginId, { includeSecret = false } = {}) {
  const normalized = normalizeLoginId(loginId)
  if (!normalized) return null

  if (!isFirebaseEnabled()) {
    const user = findLocalByLoginId(normalized)
    if (!user) return null
    return normalizeUser(user.uid, user, { includeSecret })
  }

  const usersRef = collection(db, COLLECTION)
  const snapshot = await getDocs(query(usersRef, where('loginId', '==', normalized), limit(1)))
  if (snapshot.empty) return null
  const row = snapshot.docs[0]
  return normalizeUser(row.id, row.data(), { includeSecret })
}

export async function signInWithLoginId(loginId, password) {
  const normalizedId = normalizeLoginId(loginId)
  const rawPassword = String(password || '')
  if (!normalizedId || !rawPassword) {
    throw new Error('아이디와 비밀번호를 입력해주세요.')
  }

  if (isFirebaseEnabled()) {
    await bootstrapDefaultAdminIfNeeded()
  } else {
    await ensureDefaultAdminAccount()
  }

  const user = await findUserByLoginId(normalizedId, { includeSecret: true })
  if (!user) {
    throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.')
  }
  if (!user.passwordHash && !user.password) {
    throw new Error('해당 계정은 비밀번호가 설정되지 않았습니다. 관리자에게 비밀번호 초기화를 요청해주세요.')
  }

  const ok = await verifyPassword(user, rawPassword)
  if (!ok) {
    throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.')
  }

  return normalizeUser(user.uid, user)
}

export async function recordLastLogin(uid) {
  if (!uid) return
  const now = new Date().toISOString()

  if (!isFirebaseEnabled()) {
    const existing = localUsers.get(uid)
    if (existing) {
      existing.lastLoginAt = now
    }
    return
  }

  try {
    const ref = doc(db, COLLECTION, uid)
    await updateDoc(ref, { lastLoginAt: now })
  } catch {
    // 로그인 기록 실패는 무시
  }
}

export async function createUserAccount(payload) {
  const account = toAccountPayload(payload)

  const duplicated = await findUserByLoginId(account.loginId)
  if (duplicated) {
    throw new Error(`이미 사용 중인 아이디입니다: ${account.loginId}`)
  }

  if (!isFirebaseEnabled()) {
    const uid = String(payload.uid || '').trim() || randomLocalId()
    const passwordHash = await hashPassword(account.loginId, account.password)
    const next = {
      uid,
      ...account,
      passwordHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    localUsers.set(uid, next)
    return normalizeUser(uid, next)
  }

  const uid = String(payload.uid || '').trim() || randomFirebaseId()
  const passwordHash = await hashPassword(account.loginId, account.password)
  const profileData = {
    uid,
    loginId: account.loginId,
    email: account.email,
    name: account.name,
    school: account.school,
    phone: account.phone,
    subject: account.subject,
    studentNo: account.studentNo,
    role: account.role,
    passwordHash,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }

  await setDoc(doc(db, COLLECTION, uid), profileData)
  return normalizeUser(uid, profileData)
}

export async function createUsersBatch(accounts) {
  const rows = Array.isArray(accounts) ? accounts : []
  const created = []
  const failed = []

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    try {
      const user = await createUserAccount(row)
      created.push(user)
    } catch (error) {
      failed.push({
        row: i + 2,
        loginId: row?.loginId || row?.studentNo || '',
        reason: error instanceof Error ? error.message : '계정 생성 실패',
      })
    }
  }

  return { created, failed }
}

export async function downloadUserAccountTemplate() {
  const XLSX = await getXlsx()
  const sampleRows = [
    ACCOUNT_HEADERS,
    ['김교사', 'teacher123', '김교사', '교사', '', '', '국어'],
    ['20912', 'student123', '홍길동', '학생', '20912', '', ''],
  ]
  const ws = XLSX.utils.aoa_to_sheet(sampleRows)
  ws['!cols'] = [
    { wch: 16 },
    { wch: 14 },
    { wch: 12 },
    { wch: 10 },
    { wch: 12 },
    { wch: 24 },
    { wch: 12 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '회원계정')
  XLSX.writeFile(wb, '회원계정_양식.xlsx')
}

export async function parseUserAccountExcel(file) {
  try {
    const XLSX = await getXlsx()
    const buffer = await file.arrayBuffer()
    const data = new Uint8Array(buffer)
    const wb = XLSX.read(data, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })

    return rows
      .map((row) => {
        const mapped = {}
        for (const [key, value] of Object.entries(row)) {
          const normalizedKey = String(key || '').trim()
          const targetKey = ACCOUNT_HEADER_MAP[normalizedKey]
          if (!targetKey) continue
          if (mapped[targetKey] != null && String(mapped[targetKey]).trim() !== '') continue
          mapped[targetKey] = String(value ?? '').trim()
        }

        const normalizedRole = normalizeRole(mapped.role)
        const loginId = normalizeLoginId(mapped.loginId || mapped.studentNo)
        return {
          loginId,
          password: String(mapped.password || ''),
          name: String(mapped.name || '').trim(),
          role: normalizedRole,
          studentNo: normalizedRole === 'student'
            ? String(mapped.studentNo || loginId).trim()
            : String(mapped.studentNo || '').trim(),
          email: String(mapped.email || '').trim(),
          school: String(mapped.school || '').trim(),
          phone: String(mapped.phone || '').trim(),
          subject: String(mapped.subject || '').trim(),
        }
      })
      .filter((row) => row.loginId && row.password)
  } catch {
    throw new Error('엑셀 파일을 읽는 데 실패했습니다.')
  }
}

export async function upsertUserProfile(profile) {
  const payload = toProfilePayload(profile)
  if (!payload.uid) {
    throw new Error('사용자 UID가 필요합니다.')
  }

  if (!isFirebaseEnabled()) {
    const localPassword = String(profile.password || '')
    const existing = localUsers.get(payload.uid) || {}
    const next = {
      ...existing,
      ...payload,
      password: localPassword || existing.password || '',
      passwordHash: existing.passwordHash || '',
    }
    localUsers.set(payload.uid, next)
    return normalizeUser(payload.uid, next)
  }

  const ref = doc(db, COLLECTION, payload.uid)
  const snapshot = await getDoc(ref)

  if (!snapshot.exists()) {
    const password = String(profile.password || '').trim()
    const passwordHash = password && payload.loginId
      ? await hashPassword(payload.loginId, password)
      : ''

    await setDoc(ref, {
      ...payload,
      passwordHash,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    return normalizeUser(payload.uid, payload)
  }

  await updateDoc(ref, {
    name: payload.name,
    school: payload.school,
    phone: payload.phone,
    subject: payload.subject,
    updatedAt: serverTimestamp(),
  })

  return getUserProfile(payload.uid)
}

export async function getUserProfile(uid) {
  if (!isFirebaseEnabled()) {
    const local = localUsers.get(uid) || null
    if (!local) return null
    return normalizeUser(uid, local)
  }

  const ref = doc(db, COLLECTION, uid)
  const snapshot = await getDoc(ref)
  if (!snapshot.exists()) {
    return null
  }

  return normalizeUser(snapshot.id, snapshot.data())
}

const _listUsersCache = { data: null, ts: 0 }
const LIST_USERS_TTL = 30_000 // 30초 캐시

export async function listUsers({ forceRefresh = false } = {}) {
  if (!isFirebaseEnabled()) {
    return getLocalUsers().map((item) => normalizeUser(item.uid, item))
  }

  const now = Date.now()
  if (!forceRefresh && _listUsersCache.data && now - _listUsersCache.ts < LIST_USERS_TTL) {
    return _listUsersCache.data
  }

  const usersRef = collection(db, COLLECTION)
  const snapshot = await getDocs(usersRef)
  const rows = snapshot.docs.map((item) => normalizeUser(item.id, item.data()))
  const sorted = rows.sort((a, b) => {
    const left = a.loginId || a.email || a.uid
    const right = b.loginId || b.email || b.uid
    return left.localeCompare(right, 'ko')
  })
  _listUsersCache.data = sorted
  _listUsersCache.ts = now
  return sorted
}

export function invalidateUserCache() {
  _listUsersCache.data = null
  _listUsersCache.ts = 0
}

export async function updateUserRole(uid, role) {
  if (!isFirebaseEnabled()) {
    const existing = localUsers.get(uid) || { uid, email: '', name: '' }
    const next = { ...existing, role: normalizeRole(role) }
    localUsers.set(uid, next)
    return normalizeUser(uid, next)
  }

  const ref = doc(db, COLLECTION, uid)
  await updateDoc(ref, {
    role: normalizeRole(role),
    updatedAt: serverTimestamp(),
  })

  return getUserProfile(uid)
}

export async function updateUserByAdmin(uid, patch = {}) {
  const targetUid = String(uid || '').trim()
  if (!targetUid) {
    throw new Error('수정할 사용자 UID가 필요합니다.')
  }

  const payload = {}
  if (patch.name != null) payload.name = String(patch.name || '').trim()
  if (patch.email != null) payload.email = String(patch.email || '').trim()
  if (patch.school != null) payload.school = String(patch.school || '').trim()
  if (patch.phone != null) payload.phone = String(patch.phone || '').trim()
  if (patch.subject != null) payload.subject = String(patch.subject || '').trim()
  if (patch.studentNo != null) payload.studentNo = String(patch.studentNo || '').trim()
  if (patch.role != null) payload.role = normalizeRole(patch.role)

  if (Object.keys(payload).length === 0) {
    throw new Error('변경할 항목이 없습니다.')
  }

  if (!isFirebaseEnabled()) {
    const existing = localUsers.get(targetUid)
    if (!existing) {
      throw new Error('대상 계정을 찾을 수 없습니다.')
    }

    const nextRole = payload.role || normalizeRole(existing.role)
    const nextStudentNo = payload.studentNo != null ? payload.studentNo : existing.studentNo
    if (nextRole === 'student' && !isValidStudentNo(nextStudentNo)) {
      throw new Error('학생 학번은 5자리 숫자여야 합니다.')
    }

    const next = { ...existing, ...payload }
    localUsers.set(targetUid, next)
    return normalizeUser(targetUid, next)
  }

  const ref = doc(db, COLLECTION, targetUid)
  const existing = await getDoc(ref)
  if (!existing.exists()) {
    throw new Error('대상 계정을 찾을 수 없습니다.')
  }

  const existingData = existing.data()
  const nextRole = payload.role || normalizeRole(existingData.role)
  const nextStudentNo = payload.studentNo != null ? payload.studentNo : String(existingData.studentNo || '')
  if (nextRole === 'student' && !isValidStudentNo(nextStudentNo)) {
    throw new Error('학생 학번은 5자리 숫자여야 합니다.')
  }

  await updateDoc(ref, {
    ...payload,
    updatedAt: serverTimestamp(),
  })

  return getUserProfile(targetUid)
}

export async function resetUserPasswordByAdmin(uid, nextPassword) {
  const targetUid = String(uid || '').trim()
  const password = String(nextPassword || '')
  if (!targetUid) {
    throw new Error('비밀번호를 초기화할 사용자 UID가 필요합니다.')
  }
  if (!password) {
    throw new Error('비밀번호를 입력해주세요.')
  }

  if (!isFirebaseEnabled()) {
    const existing = localUsers.get(targetUid)
    if (!existing) {
      throw new Error('대상 계정을 찾을 수 없습니다.')
    }
    const passwordHash = await hashPassword(existing.loginId, password)
    localUsers.set(targetUid, {
      ...existing,
      password,
      passwordHash,
    })
    return { ok: true }
  }

  const ref = doc(db, COLLECTION, targetUid)
  const snapshot = await getDoc(ref)
  if (!snapshot.exists()) {
    throw new Error('대상 계정을 찾을 수 없습니다.')
  }

  const loginId = String(snapshot.data()?.loginId || '')
  if (!loginId) {
    throw new Error('대상 계정의 아이디 정보가 없습니다.')
  }

  const passwordHash = await hashPassword(loginId, password)
  await updateDoc(ref, {
    passwordHash,
    updatedAt: serverTimestamp(),
  })
  return { ok: true }
}

export async function resetStudentPasswordsByAdmin(nextPassword) {
  const password = String(nextPassword || '')
  if (!password) {
    throw new Error('비밀번호를 입력해주세요.')
  }

  if (!isFirebaseEnabled()) {
    let count = 0
    for (const [uid, existing] of localUsers.entries()) {
      if (normalizeRole(existing?.role) !== 'student') continue
      const passwordHash = await hashPassword(existing.loginId, password)
      localUsers.set(uid, {
        ...existing,
        password,
        passwordHash,
      })
      count += 1
    }

    if (count === 0) {
      throw new Error('초기화할 학생 계정이 없습니다.')
    }

    return { count }
  }

  const snapshot = await getDocs(query(collection(db, COLLECTION), where('role', '==', 'student')))
  if (snapshot.empty) {
    throw new Error('초기화할 학생 계정이 없습니다.')
  }

  const docs = snapshot.docs.filter((item) => String(item.data()?.loginId || '').trim())
  if (docs.length === 0) {
    throw new Error('초기화할 학생 계정이 없습니다.')
  }

  const chunkSize = 400
  for (let index = 0; index < docs.length; index += chunkSize) {
    const batch = writeBatch(db)
    const chunk = docs.slice(index, index + chunkSize)

    for (const item of chunk) {
      const loginId = String(item.data()?.loginId || '').trim()
      const passwordHash = await hashPassword(loginId, password)
      batch.update(item.ref, {
        passwordHash,
        updatedAt: serverTimestamp(),
      })
    }

    await batch.commit()
  }

  return { count: docs.length }
}

export async function updateMyPassword(uid, currentPassword, nextPassword) {
  const targetUid = String(uid || '').trim()
  const current = String(currentPassword || '')
  const next = String(nextPassword || '')

  if (!targetUid) {
    throw new Error('사용자 UID가 필요합니다.')
  }
  if (!current || !next) {
    throw new Error('현재 비밀번호와 새 비밀번호를 모두 입력해주세요.')
  }
  if (next.length < 6) {
    throw new Error('새 비밀번호는 6자 이상으로 입력해주세요.')
  }
  if (current === next) {
    throw new Error('현재 비밀번호와 다른 비밀번호를 입력해주세요.')
  }

  if (!isFirebaseEnabled()) {
    const existing = localUsers.get(targetUid)
    if (!existing) {
      throw new Error('사용자 정보를 찾을 수 없습니다.')
    }

    const account = normalizeUser(targetUid, existing, { includeSecret: true })
    const ok = await verifyPassword(account, current)
    if (!ok) {
      throw new Error('현재 비밀번호가 올바르지 않습니다.')
    }

    const passwordHash = await hashPassword(account.loginId, next)
    const nowIso = new Date().toISOString()
    localUsers.set(targetUid, {
      ...existing,
      password: next,
      passwordHash,
      passwordChangedAt: nowIso,
      updatedAt: nowIso,
    })
    return { ok: true }
  }

  const ref = doc(db, COLLECTION, targetUid)
  const snapshot = await getDoc(ref)
  if (!snapshot.exists()) {
    throw new Error('사용자 정보를 찾을 수 없습니다.')
  }

  const account = normalizeUser(snapshot.id, snapshot.data(), { includeSecret: true })
  if (!account.loginId) {
    throw new Error('로그인 아이디 정보가 없습니다.')
  }

  const ok = await verifyPassword(account, current)
  if (!ok) {
    throw new Error('현재 비밀번호가 올바르지 않습니다.')
  }

  const passwordHash = await hashPassword(account.loginId, next)
  await updateDoc(ref, {
    passwordHash,
    passwordChangedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return { ok: true }
}

export async function deleteUserByAdmin(uid) {
  const targetUid = String(uid || '').trim()
  if (!targetUid) {
    throw new Error('삭제할 사용자 UID가 필요합니다.')
  }

  if (!isFirebaseEnabled()) {
    localUsers.delete(targetUid)
    return { ok: true, removedApplications: 0, removedMembers: 0 }
  }

  const userRef = doc(db, COLLECTION, targetUid)
  const userSnap = await getDoc(userRef)
  if (!userSnap.exists()) {
    throw new Error('대상 계정을 찾을 수 없습니다.')
  }

  const userData = userSnap.data()
  const role = normalizeRole(userData?.role)

  const schedulesSnap = await getDocs(collection(db, SCHEDULES))
  const schedules = schedulesSnap.docs.map((row) => ({ id: row.id, ...row.data() }))

  const ownerClubs = schedules.filter((row) => {
    const teacherUids = Array.isArray(row.teacherUids)
      ? row.teacherUids.map((item) => String(item || '').trim()).filter((item) => !!item)
      : []
    return teacherUids.length > 0
      ? teacherUids.includes(targetUid)
      : String(row.teacherUid || '').trim() === targetUid
  })
  if (ownerClubs.length > 0) {
    const preview = ownerClubs.slice(0, 3).map((row) => row.clubName || row.id).join(', ')
    throw new Error(`담당교사로 연결된 동아리가 있습니다. 먼저 담당교사를 변경해주세요. (${preview})`)
  }

  const leaderClubs = schedules.filter((row) => String(row.leaderUid || '').trim() === targetUid)
  if (leaderClubs.length > 0) {
    const preview = leaderClubs.slice(0, 3).map((row) => row.clubName || row.id).join(', ')
    throw new Error(`동아리장으로 연결된 동아리가 있습니다. 먼저 동아리장을 변경해주세요. (${preview})`)
  }

  let removedApplications = 0
  let removedMembers = 0

  if (role === 'student') {
    const appSnap = await getDocs(
      query(collection(db, APPLICATIONS), where('studentUid', '==', targetUid)),
    )
    removedApplications = appSnap.size

    for (let i = 0; i < appSnap.docs.length; i += 450) {
      const batch = writeBatch(db)
      appSnap.docs.slice(i, i + 450).forEach((row) => batch.delete(row.ref))
      await batch.commit()
    }

    for (const schedule of schedules) {
      const scheduleRef = doc(db, SCHEDULES, schedule.id)
      const memberRef = doc(db, SCHEDULES, schedule.id, 'members', targetUid)

      const memberSnapshot = await getDoc(memberRef)
      if (!memberSnapshot.exists()) continue

      let removed = false
      await runTransaction(db, async (tx) => {
        const scheduleSnap = await tx.get(scheduleRef)
        if (!scheduleSnap.exists()) return

        const currentCount = Number(scheduleSnap.data()?.memberCount || 0)
        tx.delete(memberRef)
        tx.update(scheduleRef, {
          memberCount: Math.max(0, currentCount - 1),
          updatedAt: serverTimestamp(),
        })
        removed = true
      })
      if (removed) {
        removedMembers += 1
      }
    }
  }

  await deleteDoc(userRef)
  return { ok: true, removedApplications, removedMembers }
}

export async function updateMyProfile(uid, profile) {
  const patch = {}
  if (profile?.name != null) patch.name = String(profile.name || '').trim()
  if (profile?.school != null) patch.school = String(profile.school || '').trim()
  if (profile?.phone != null) patch.phone = String(profile.phone || '').trim()
  if (profile?.subject != null) patch.subject = String(profile.subject || '').trim()

  if (Object.keys(patch).length === 0) {
    throw new Error('변경할 항목이 없습니다.')
  }

  if (!isFirebaseEnabled()) {
    const existing = localUsers.get(uid) || { uid, email: '', role: 'student' }
    const next = { ...existing, ...patch }
    localUsers.set(uid, next)
    return normalizeUser(uid, next)
  }

  const ref = doc(db, COLLECTION, uid)
  await updateDoc(ref, {
    ...patch,
    updatedAt: serverTimestamp(),
  })

  return getUserProfile(uid)
}
