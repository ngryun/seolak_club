import { isFirebaseEnabled } from '../lib/firebase'
import { listClubMembers, listCurrentCycleApplications } from './applicationService'
import { exportAttendanceData, getAttendanceApiToken } from './attendanceService'
import { getClubTeacherUids, listSchedules } from './scheduleService'

const STORE_KEY = 'app.activity-records.demo.v1'
const COMMON_LIMITS = { activity: 200, contribution: 200, learning: 250, change: 250, followUp: 200 }

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
}

function writeStore(value) {
  localStorage.setItem(STORE_KEY, JSON.stringify(value))
}

function clean(value, max = 10000) {
  return String(value || '').trim().slice(0, max)
}

function parseActivityDateTime(value) {
  const raw = clean(value, 80)
  if (!raw) return Number.NaN
  // datetime-local 값이 남아 있는 구버전 데이터도 한국 시간으로 해석합니다.
  const localMatch = raw.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u)
  const normalized = localMatch ? `${raw.length === 16 ? `${raw}:00` : raw}+09:00` : raw
  return new Date(normalized).getTime()
}

function getWindowState(program) {
  const startAt = clean(program?.activityRecordStartAt, 80)
  const endAt = clean(program?.activityRecordEndAt, 80)
  const start = parseActivityDateTime(startAt)
  const end = parseActivityDateTime(endAt)
  const now = Date.now()
  const configured = Number.isFinite(start) && Number.isFinite(end) && start < end
  return {
    configured,
    open: configured && now >= start && now <= end,
    phase: !configured ? 'unconfigured' : now < start ? 'before' : now > end ? 'closed' : 'open',
    startAt,
    endAt,
  }
}

function assertWindowOpen(program) {
  const state = getWindowState(program)
  if (state.open) return
  if (state.phase === 'before') throw new Error('학생 활동 기록 기간이 아직 시작되지 않았습니다.')
  if (state.phase === 'closed') throw new Error('학생 활동 기록 기간이 종료되었습니다.')
  throw new Error('학생 활동 기록 기간이 설정되지 않았습니다.')
}

function activeQuestions(program) {
  return (Array.isArray(program?.activityRecordQuestions) ? program.activityRecordQuestions : [])
    .filter((row) => row?.active !== false && row?.id && row?.title)
    .slice(0, 3)
    .map((row) => ({
      id: clean(row.id, 120), title: clean(row.title, 120), helpText: clean(row.helpText, 240),
      required: row.required === true, active: true,
    }))
}

function getRecordKey(program, clubId, studentUid) {
  return `${program?.cycleId || program?.id || 'current'}::${clubId}::${studentUid}`
}

function emptyRecord(program, club, member) {
  return {
    id: getRecordKey(program, club.id, member.studentUid),
    programId: program.id,
    cycleId: program.cycleId,
    clubId: club.id,
    studentUid: member.studentUid,
    studentNo: member.studentNo || '',
    studentName: member.name || '',
    commonAnswers: Object.fromEntries(Object.keys(COMMON_LIMITS).map((key) => [key, ''])),
    additionalAnswers: {},
    questionSnapshot: [],
    studentStatus: 'unsubmitted',
    teacherStatus: '',
    studentRecordText: '',
  }
}

async function api(action, payload = {}) {
  const token = getAttendanceApiToken()
  const response = await fetch('/.netlify/functions/activity-record-api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const suffix = response.status === 401 ? ' 로그아웃 후 다시 로그인해주세요.' : ''
    throw new Error(`${data?.error || '학생 활동 기록 서버 요청에 실패했습니다.'}${suffix}`)
  }
  return data
}

async function findLocalStudentContext(program, user) {
  const clubs = (await listSchedules()).filter((club) => club.programId === program.id && !club.legacy)
  const matches = await Promise.all(clubs.map(async (club) => {
    const members = await listClubMembers(club.id)
    const member = members.find((row) => row.studentUid === user.uid)
    return member ? { club, member } : null
  }))
  for (const match of matches) {
    if (match) return match
  }
  return null
}

function validateAnswers(program, commonAnswers, additionalAnswers, submitting) {
  const common = Object.fromEntries(Object.entries(COMMON_LIMITS).map(([key, max]) => [key, clean(commonAnswers?.[key], max)]))
  if (submitting && Object.values(common).some((value) => !value)) {
    throw new Error('공통 활동 기록 5개 항목을 모두 작성해주세요.')
  }
  const questions = activeQuestions(program)
  const additional = Object.fromEntries(questions.map((row) => [row.id, clean(additionalAnswers?.[row.id], 300)]))
  const missing = submitting ? questions.find((row) => row.required && !additional[row.id]) : null
  if (missing) throw new Error(`추가 질문 '${missing.title}'에 답변해주세요.`)
  return { common, additional, questions }
}

export async function getStudentActivityRecord({ program, user }) {
  if (isFirebaseEnabled()) return api('student-get', { programId: program.id })
  const context = await findLocalStudentContext(program, user)
  if (!context) return { eligible: false, window: getWindowState(program), questions: activeQuestions(program), club: null, record: null }
  const store = readStore()
  const key = getRecordKey(program, context.club.id, user.uid)
  const record = store.records?.[key] || emptyRecord(program, context.club, context.member)
  return {
    eligible: true,
    window: getWindowState(program),
    questions: activeQuestions(program),
    club: { id: context.club.id, clubName: context.club.clubName },
    record,
  }
}

export async function saveStudentActivityRecord({ program, user, commonAnswers, additionalAnswers, mode = 'draft' }) {
  if (isFirebaseEnabled()) return api('student-save', { programId: program.id, commonAnswers, additionalAnswers, mode })
  assertWindowOpen(program)
  const context = await findLocalStudentContext(program, user)
  if (!context) throw new Error('이 프로그램의 확정 참여 명단에서 학생을 찾을 수 없습니다.')
  const submitting = mode === 'submit'
  const validated = validateAnswers(program, commonAnswers, additionalAnswers, submitting)
  const store = readStore()
  const key = getRecordKey(program, context.club.id, user.uid)
  const existing = store.records?.[key] || emptyRecord(program, context.club, context.member)
  const snapshotMap = new Map((existing.questionSnapshot || []).map((row) => [row.id, row]))
  validated.questions.forEach((row) => snapshotMap.set(row.id, row))
  const now = new Date().toISOString()
  const reviewed = ['reviewing', 'completed'].includes(existing.teacherStatus)
  const next = {
    ...existing,
    commonAnswers: validated.common,
    additionalAnswers: { ...(existing.additionalAnswers || {}), ...validated.additional },
    questionSnapshot: [...snapshotMap.values()],
    studentStatus: submitting ? 'submitted' : 'draft',
    studentUpdatedAt: now,
    ...(submitting ? { submittedAt: now } : {}),
    ...(reviewed ? { teacherStatus: 'reviewing', studentUpdatedAfterReview: true } : {}),
    updatedAt: now,
  }
  store.records = { ...(store.records || {}), [key]: next }
  writeStore(store)
  return getStudentActivityRecord({ program, user })
}

function localAttendanceSummary(attendanceRecords, program, clubId, studentUid) {
  const sessions = (program.attendanceSchedule || []).filter((row) => row.active !== false && row.id)
  const recordMap = new Map((attendanceRecords || []).filter((row) => row.clubId === clubId).map((row) => [row.sessionId, row]))
  return sessions.reduce((acc, session) => {
    const status = recordMap.get(session.id)?.entries?.[studentUid]?.status || 'unchecked'
    acc[status === 'present' ? 'present' : status === 'absent' ? 'absent' : 'unchecked'] += 1
    return acc
  }, { present: 0, absent: 0, unchecked: 0, total: sessions.length })
}

export async function listTeacherActivityRecords({ program, actor, clubId = '', metaOnly = false }) {
  if (isFirebaseEnabled()) {
    return api('teacher-list', {
      programId: program.id,
      ...(clubId ? { clubId } : {}),
      ...(metaOnly ? { metaOnly: true } : {}),
    })
  }
  const clubs = await listSchedules()
  const allowedClubs = clubs.filter((club) => club.programId === program.id && !club.legacy && (actor.role === 'admin' || getClubTeacherUids(club).includes(actor.uid)))
  const clubSummaries = allowedClubs.map((club) => ({ id: club.id, clubName: club.clubName }))
  if (metaOnly) return { window: getWindowState(program), clubs: clubSummaries, rows: [] }
  const targetClubs = clubId ? allowedClubs.filter((club) => club.id === clubId) : allowedClubs
  if (clubId && targetClubs.length === 0) throw new Error('이 수업의 학생 활동 기록 권한이 없습니다.')
  const applications = await listCurrentCycleApplications({ program })
  const store = readStore()
  const rows = []
  for (const club of targetClubs) {
    const members = await listClubMembers(club.id)
    for (const member of members) {
      const key = getRecordKey(program, club.id, member.studentUid)
      const record = store.records?.[key] || emptyRecord(program, club, member)
      const submittedRecord = record.studentStatus === 'submitted'
        ? record
        : { ...record, commonAnswers: Object.fromEntries(Object.keys(COMMON_LIMITS).map((key) => [key, ''])), additionalAnswers: {}, questionSnapshot: [] }
      const application = applications.find((row) => row.clubId === club.id && row.studentUid === member.studentUid) || {}
      rows.push({
        ...submittedRecord,
        clubName: club.clubName,
        application: { careerGoal: application.careerGoal || '', applyReason: application.applyReason || '', wantedActivity: application.wantedActivity || '' },
      })
    }
  }
  rows.sort((left, right) => left.clubName.localeCompare(right.clubName, 'ko') || left.studentNo.localeCompare(right.studentNo, 'ko', { numeric: true }))
  return { window: getWindowState(program), clubs: clubSummaries, rows }
}

export async function saveTeacherActivityRecord({ program, actor, clubId, studentUid, studentRecordText, teacherStatus }) {
  if (isFirebaseEnabled()) return api('teacher-save', { programId: program.id, clubId, studentUid, studentRecordText, teacherStatus })
  const current = await listTeacherActivityRecords({ program, actor, clubId })
  const row = current.rows.find((item) => item.clubId === clubId && item.studentUid === studentUid)
  if (!row) throw new Error('확정 참여 학생을 찾을 수 없습니다.')
  if (teacherStatus === 'completed' && row.studentStatus !== 'submitted') throw new Error('학생이 활동 기록을 제출한 뒤 작성 완료로 처리할 수 있습니다.')
  if (teacherStatus === 'completed' && !clean(studentRecordText, 3000)) throw new Error('생활기록부 작성 내용을 입력해주세요.')
  const store = readStore()
  const key = getRecordKey(program, clubId, studentUid)
  const existing = store.records?.[key] || emptyRecord(program, { id: clubId }, { studentUid, studentNo: row.studentNo, name: row.studentName })
  const now = new Date().toISOString()
  const next = { ...existing, studentRecordText: clean(studentRecordText, 3000), teacherStatus: teacherStatus === 'completed' ? 'completed' : 'reviewing', teacherUpdatedAt: now, reviewedByUid: actor.uid, studentUpdatedAfterReview: false, updatedAt: now }
  store.records = { ...(store.records || {}), [key]: next }
  writeStore(store)
  // 서버와 동일하게 저장된 학생의 레코드만 반환합니다. 미제출 학생의 임시 답변은 노출하지 않습니다.
  const masked = next.studentStatus === 'submitted'
    ? next
    : { ...next, commonAnswers: Object.fromEntries(Object.keys(COMMON_LIMITS).map((field) => [field, ''])), additionalAnswers: {}, questionSnapshot: [] }
  return { record: { ...masked, clubName: row.clubName } }
}

// 출결 요약은 편집 화면에서 선택된 학생만 필요할 때 개별 조회합니다.
export async function getTeacherActivityAttendanceSummary({ program, clubId, studentUid }) {
  if (isFirebaseEnabled()) return api('attendance-summary', { programId: program.id, clubId, studentUid })
  const attendanceData = await exportAttendanceData()
  return localAttendanceSummary(attendanceData.records, program, clubId, studentUid)
}

export async function exportActivityRecordData() {
  if (isFirebaseEnabled()) return api('export')
  const records = Object.values(readStore().records || {})
  return { records }
}
