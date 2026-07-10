import { isFirebaseEnabled } from '../lib/firebase'

const STORE_KEY = 'app.attendance.demo.v1'
const API_TOKEN_KEY = 'app.attendance.api-token.v1'

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
}

function writeStore(value) {
  localStorage.setItem(STORE_KEY, JSON.stringify(value))
}

function recordKey(clubId, sessionId) {
  return `${clubId}::${sessionId}`
}

function sortRoster(rows) {
  return [...(Array.isArray(rows) ? rows : [])].map((row) => ({
    studentUid: String(row.studentUid || row.uid || '').trim(),
    studentNo: String(row.studentNo || '').trim(),
    name: String(row.name || row.studentName || '').trim(),
  })).filter((row) => row.studentUid).sort((a, b) =>
    a.studentNo.localeCompare(b.studentNo, 'ko', { numeric: true }) || a.name.localeCompare(b.name, 'ko'))
}

function normalizeRecord(record, fallback = {}) {
  const roster = sortRoster(record?.rosterSnapshot || fallback.roster || [])
  const sourceEntries = record?.entries || {}
  return {
    clubId: String(record?.clubId || fallback.clubId || ''),
    sessionId: String(record?.sessionId || fallback.sessionId || ''),
    programId: String(record?.programId || fallback.programId || ''),
    status: record?.status === 'closed' ? 'closed' : 'open',
    rosterSnapshot: roster,
    entries: Object.fromEntries(roster.map((student) => [student.studentUid, {
      status: ['present', 'absent'].includes(sourceEntries[student.studentUid]?.status)
        ? sourceEntries[student.studentUid].status : 'unchecked',
      updatedAt: sourceEntries[student.studentUid]?.updatedAt || null,
      updatedBy: sourceEntries[student.studentUid]?.updatedBy || '',
    }])),
    publicEnabled: record?.publicEnabled === true,
    tokenVersion: Math.max(1, Number(record?.tokenVersion) || 1),
    publicUrl: String(record?.publicUrl || ''),
    updatedAt: record?.updatedAt || null,
  }
}

async function api(endpoint, action, payload = {}, options = {}) {
  const token = options.publicToken || sessionStorage.getItem(API_TOKEN_KEY) || ''
  const response = await fetch(`/.netlify/functions/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error || '출석부 서버 요청에 실패했습니다.')
  return data
}

export async function createAttendanceApiSession(loginId, password) {
  if (!isFirebaseEnabled()) return ''
  const data = await api('attendance-auth', 'login', { loginId, password })
  sessionStorage.setItem(API_TOKEN_KEY, data.token)
  return data.token
}

export function clearAttendanceApiSession() {
  try { sessionStorage.removeItem(API_TOKEN_KEY) } catch { /* noop */ }
}

export function hasAttendanceApiSession() {
  return !isFirebaseEnabled() || !!sessionStorage.getItem(API_TOKEN_KEY)
}

export async function getAttendanceRecord({ program, club, session, roster = [] }) {
  if (isFirebaseEnabled()) {
    return api('attendance-api', 'get', {
      programId: program.id, clubId: club.id, sessionId: session.id,
    })
  }
  const store = readStore()
  const key = recordKey(club.id, session.id)
  const current = normalizeRecord(store.records?.[key], {
    programId: program.id, clubId: club.id, sessionId: session.id, roster,
  })
  store.records = { ...(store.records || {}), [key]: current }
  writeStore(store)
  return current
}

export async function saveAttendanceRecord({ program, club, session, entries, actor }) {
  if (isFirebaseEnabled()) {
    return api('attendance-api', 'save', {
      programId: program.id, clubId: club.id, sessionId: session.id, entries,
    })
  }
  const store = readStore()
  const key = recordKey(club.id, session.id)
  const current = normalizeRecord(store.records?.[key], {
    programId: program.id, clubId: club.id, sessionId: session.id,
  })
  for (const student of current.rosterSnapshot) {
    const status = entries?.[student.studentUid]
    if (!['present', 'absent', 'unchecked'].includes(status)) continue
    current.entries[student.studentUid] = {
      status,
      updatedAt: new Date().toISOString(),
      updatedBy: actor?.uid || 'public',
    }
  }
  current.updatedAt = new Date().toISOString()
  store.records = { ...(store.records || {}), [key]: current }
  writeStore(store)
  return current
}

export async function syncAttendanceRoster({ program, club, session, roster }) {
  if (isFirebaseEnabled()) {
    return api('attendance-api', 'sync-roster', {
      programId: program.id, clubId: club.id, sessionId: session.id,
    })
  }
  const store = readStore()
  const key = recordKey(club.id, session.id)
  const previous = normalizeRecord(store.records?.[key], {
    programId: program.id, clubId: club.id, sessionId: session.id,
  })
  if (Object.values(previous.entries).some((entry) => entry.status !== 'unchecked')) {
    throw new Error('출결 입력이 시작된 회차는 명단을 동기화할 수 없습니다.')
  }
  const next = normalizeRecord({ ...previous, rosterSnapshot: roster, entries: {} }, previous)
  store.records = { ...(store.records || {}), [key]: next }
  writeStore(store)
  return next
}

export async function setAttendancePin({ programId, pin }) {
  if (!/^\d{4,8}$/u.test(String(pin || ''))) throw new Error('PIN은 숫자 4~8자리로 입력해주세요.')
  if (isFirebaseEnabled()) return api('attendance-api', 'set-pin', { programId, pin })
  const store = readStore()
  store.programPins = { ...(store.programPins || {}), [programId]: String(pin) }
  writeStore(store)
  return { ok: true }
}

function makeDemoToken(payload) {
  const raw = JSON.stringify(payload)
  return btoa(unescape(encodeURIComponent(raw))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function readDemoToken(token) {
  try {
    const normalized = token.replaceAll('-', '+').replaceAll('_', '/')
    return JSON.parse(decodeURIComponent(escape(atob(normalized))))
  } catch { throw new Error('유효하지 않은 QR 링크입니다.') }
}

export async function configurePublicAttendance({ program, club, session, enabled, rotate = false }) {
  if (isFirebaseEnabled()) {
    return api('attendance-api', 'configure-public', {
      programId: program.id, clubId: club.id, sessionId: session.id, enabled, rotate,
    })
  }
  const store = readStore()
  if (enabled && !store.programPins?.[program.id]) throw new Error('관리자가 먼저 프로그램 QR PIN을 설정해야 합니다.')
  const key = recordKey(club.id, session.id)
  const current = normalizeRecord(store.records?.[key], {
    programId: program.id, clubId: club.id, sessionId: session.id,
  })
  if (rotate) current.tokenVersion += 1
  current.publicEnabled = enabled === true
  const token = makeDemoToken({ c: club.id, s: session.id, p: program.id, v: current.tokenVersion })
  current.publicUrl = `${window.location.origin}/attendance/public/${token}`
  store.records = { ...(store.records || {}), [key]: current }
  writeStore(store)
  return current
}

export async function setAttendanceSessionStatus({ program, club, session, status }) {
  const nextStatus = status === 'closed' ? 'closed' : 'open'
  if (isFirebaseEnabled()) return api('attendance-api', 'set-status', {
    programId: program.id, clubId: club.id, sessionId: session.id, status: nextStatus,
  })
  const store = readStore(); const key = recordKey(club.id, session.id)
  const current = normalizeRecord(store.records?.[key], { programId: program.id, clubId: club.id, sessionId: session.id })
  current.status = nextStatus
  if (nextStatus === 'closed') current.publicEnabled = false
  store.records = { ...(store.records || {}), [key]: current }; writeStore(store)
  return current
}

export async function unlockPublicAttendance(token, pin) {
  if (isFirebaseEnabled()) return api('attendance-public', 'unlock', { token, pin })
  const payload = readDemoToken(token)
  const store = readStore()
  const current = normalizeRecord(store.records?.[recordKey(payload.c, payload.s)])
  if (!current.clubId || !current.publicEnabled || current.tokenVersion !== payload.v || current.status === 'closed') {
    throw new Error('중지되었거나 종료된 출석 링크입니다.')
  }
  if (!store.programPins?.[payload.p] || store.programPins[payload.p] !== String(pin)) {
    throw new Error('PIN이 올바르지 않습니다.')
  }
  return { record: current, editToken: pin }
}

export async function savePublicAttendance(token, editToken, entries) {
  if (isFirebaseEnabled()) return api('attendance-public', 'save', { token, editToken, entries })
  const payload = readDemoToken(token)
  const store = readStore()
  if (store.programPins?.[payload.p] !== String(editToken)) throw new Error('PIN 인증이 만료되었습니다.')
  const key = recordKey(payload.c, payload.s)
  const current = normalizeRecord(store.records?.[key])
  if (!current.publicEnabled || current.tokenVersion !== payload.v || current.status === 'closed') {
    throw new Error('중지되었거나 종료된 출석 링크입니다.')
  }
  for (const student of current.rosterSnapshot) {
    const status = entries?.[student.studentUid]
    if (!['present', 'absent', 'unchecked'].includes(status)) continue
    current.entries[student.studentUid] = { status, updatedAt: new Date().toISOString(), updatedBy: 'public-qr' }
  }
  current.updatedAt = new Date().toISOString()
  store.records[key] = current
  writeStore(store)
  return current
}

export async function exportAttendanceData() {
  if (isFirebaseEnabled()) return api('attendance-api', 'export')
  const records = Object.values(readStore().records || {})
  return { records }
}
