import { db, handleError, json, readBody, requireActor, timestamp } from './_attendance-utils.js'

const DEFAULT_PROGRAM_ID = 'club-default'
const COMMON_LIMITS = {
  activity: 200,
  contribution: 200,
  learning: 250,
  change: 250,
  followUp: 200,
}
const MAX_ADDITIONAL_QUESTIONS = 3
const MAX_ADDITIONAL_ANSWER_LENGTH = 300

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

function toIso(value) {
  if (!value) return null
  if (typeof value === 'string') return value
  if (typeof value?.toDate === 'function') return value.toDate().toISOString()
  if (typeof value?.seconds === 'number') return new Date(value.seconds * 1000).toISOString()
  return null
}

function recordId(cycleId, studentUid) {
  return `${clean(cycleId, 160)}__${clean(studentUid, 160)}`.replaceAll('/', '_')
}

function recordRef(clubId, cycleId, studentUid) {
  return db().doc(`schedules/${clubId}/activityRecords/${recordId(cycleId, studentUid)}`)
}

function assignmentId(cycleId, studentUid) {
  return `${clean(cycleId || 'current', 160)}__${clean(studentUid, 160)}`.replaceAll('/', '_')
}

function normalizeQuestions(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : []).map((row) => {
    const id = clean(row?.id, 120)
    const title = clean(row?.title, 120)
    if (!id || !title || seen.has(id)) return null
    seen.add(id)
    return {
      id,
      title,
      helpText: clean(row?.helpText, 240),
      required: row?.required === true,
      active: row?.active !== false,
    }
  }).filter(Boolean)
}

function normalizeRecord(source = {}, fallback = {}) {
  return {
    id: clean(source.id || fallback.id, 320),
    programId: clean(source.programId || fallback.programId, 160),
    cycleId: clean(source.cycleId || fallback.cycleId, 160),
    clubId: clean(source.clubId || fallback.clubId, 160),
    studentUid: clean(source.studentUid || fallback.studentUid, 160),
    studentNo: clean(source.studentNo || fallback.studentNo, 40),
    studentName: clean(source.studentName || fallback.studentName, 120),
    commonAnswers: Object.fromEntries(Object.keys(COMMON_LIMITS).map((key) => [key, clean(source.commonAnswers?.[key], COMMON_LIMITS[key])])),
    additionalAnswers: Object.fromEntries(Object.entries(source.additionalAnswers || {}).map(([key, value]) => [clean(key, 120), clean(value, MAX_ADDITIONAL_ANSWER_LENGTH)]).filter(([key]) => key)),
    questionSnapshot: normalizeQuestions(source.questionSnapshot),
    studentStatus: source.studentStatus === 'submitted' ? 'submitted' : source.studentStatus === 'draft' ? 'draft' : 'unsubmitted',
    teacherStatus: source.teacherStatus === 'completed' ? 'completed' : source.teacherStatus === 'reviewing' ? 'reviewing' : '',
    studentRecordText: clean(source.studentRecordText, 3000),
    studentUpdatedAt: toIso(source.studentUpdatedAt),
    submittedAt: toIso(source.submittedAt),
    teacherUpdatedAt: toIso(source.teacherUpdatedAt),
    reviewedByUid: clean(source.reviewedByUid, 160),
    studentUpdatedAfterReview: source.studentUpdatedAfterReview === true,
  }
}

async function getActorUser(actor) {
  const snapshot = await db().doc(`users/${actor.uid}`).get()
  if (!snapshot.exists) throw Object.assign(new Error('사용자 정보를 찾을 수 없습니다.'), { status: 404 })
  return { uid: snapshot.id, ...snapshot.data() }
}

async function getProgram(programId) {
  const normalizedId = clean(programId, 160)
  if (!normalizedId) throw Object.assign(new Error('프로그램 정보가 필요합니다.'), { status: 400 })
  const snapshot = await db().doc(`programs/${normalizedId}`).get()
  if (!snapshot.exists) throw Object.assign(new Error('프로그램 정보를 찾을 수 없습니다.'), { status: 404 })
  return { id: snapshot.id, ...snapshot.data(), cycleId: clean(snapshot.data().cycleId || (snapshot.id === DEFAULT_PROGRAM_ID ? 'current' : snapshot.id), 160) }
}

function getWindowState(program) {
  const startAt = clean(program.activityRecordStartAt, 80)
  const endAt = clean(program.activityRecordEndAt, 80)
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
  const windowState = getWindowState(program)
  if (!windowState.open) {
    const message = windowState.phase === 'before'
      ? '학생 활동 기록 기간이 아직 시작되지 않았습니다.'
      : windowState.phase === 'closed'
        ? '학생 활동 기록 기간이 종료되었습니다.'
        : '학생 활동 기록 기간이 설정되지 않았습니다.'
    throw Object.assign(new Error(message), { status: 409 })
  }
  return windowState
}

async function listProgramClubs(programId) {
  // 기본 프로그램은 programId 필드가 없는 과거 문서도 포함해야 해서 전체를 읽고,
  // 그 외 프로그램은 인덱스 쿼리로 해당 수업만 읽습니다.
  const snapshot = programId === DEFAULT_PROGRAM_ID
    ? await db().collection('schedules').get()
    : await db().collection('schedules').where('programId', '==', programId).get()
  return snapshot.docs.map((row) => ({ id: row.id, ...row.data() })).filter((row) => {
    const resolved = clean(row.programId || DEFAULT_PROGRAM_ID, 160)
    return resolved === programId
  })
}

function teacherUids(club) {
  return Array.from(new Set([
    ...(Array.isArray(club?.teacherUids) ? club.teacherUids : []),
    club?.teacherUid,
  ].map((value) => clean(value, 160)).filter(Boolean)))
}

async function findStudentMembership(program, studentUid) {
  // 승인 처리 시 저장되는 배정 문서를 우선 사용합니다. 기존 방식처럼 모든 수업과
  // 모든 수업의 학생 문서를 읽으면 수업 수가 늘어날수록 학생 화면이 느려집니다.
  const assignment = await db().doc(`recruitmentAssignments/${assignmentId(program.cycleId, studentUid)}`).get()
  const assignedClubId = clean(assignment.data()?.clubId, 160)
  if (assignment.exists && assignedClubId) {
    // 활동 기록 문서까지 같은 왕복에서 함께 읽어 학생 화면의 순차 조회를 줄입니다.
    const [clubSnapshot, memberSnapshot, recordSnapshot] = await Promise.all([
      db().doc(`schedules/${assignedClubId}`).get(),
      db().doc(`schedules/${assignedClubId}/members/${studentUid}`).get(),
      recordRef(assignedClubId, program.cycleId, studentUid).get(),
    ])
    if (clubSnapshot.exists && memberSnapshot.exists) {
      const club = { id: clubSnapshot.id, ...clubSnapshot.data() }
      if (clean(club.programId || DEFAULT_PROGRAM_ID, 160) === program.id) {
        return { club, member: { id: memberSnapshot.id, ...memberSnapshot.data() }, recordSnapshot }
      }
    }
  }

  // 배정 문서가 없는 기존 데이터는 학생 UID로 members 컬렉션 그룹을 조회해
  // 레거시 자료도 계속 찾을 수 있도록 보조 경로를 유지합니다.
  try {
    const membershipSnapshot = await db().collectionGroup('members').where('studentUid', '==', studentUid).get()
    const candidates = membershipSnapshot.docs
      .map((memberSnapshot) => ({ memberSnapshot, clubId: memberSnapshot.ref.parent.parent?.id || '' }))
      .filter((row) => row.clubId)
    const clubSnapshots = await Promise.all(candidates.map((row) => db().doc(`schedules/${row.clubId}`).get()))
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const clubSnapshot = clubSnapshots[index]
      if (!clubSnapshot.exists) continue
      const club = { id: clubSnapshot.id, ...clubSnapshot.data() }
      if (clean(club.programId || DEFAULT_PROGRAM_ID, 160) === program.id) {
        return { club, member: { id: candidate.memberSnapshot.id, ...candidate.memberSnapshot.data() } }
      }
    }
    return null
  } catch (error) {
    // collectionGroup 인덱스가 아직 배포되지 않은 환경에서는 기존 조회로 복구합니다.
    console.warn('학생 활동 기록의 빠른 명단 조회를 사용할 수 없어 기존 조회로 복구합니다.', error)
    const clubs = await listProgramClubs(program.id)
    const memberships = await Promise.all(clubs.map(async (club) => {
      const member = await db().doc(`schedules/${club.id}/members/${studentUid}`).get()
      return member.exists ? { club, member: { id: member.id, ...member.data() } } : null
    }))
    return memberships.find(Boolean) || null
  }
}

async function authorizeTeacher(actorUser, clubId, programId) {
  const snapshot = await db().doc(`schedules/${clean(clubId, 160)}`).get()
  if (!snapshot.exists) throw Object.assign(new Error('수업 정보를 찾을 수 없습니다.'), { status: 404 })
  const club = { id: snapshot.id, ...snapshot.data() }
  if (clean(club.programId || DEFAULT_PROGRAM_ID, 160) !== programId) {
    throw Object.assign(new Error('프로그램과 수업 정보가 일치하지 않습니다.'), { status: 400 })
  }
  const isAdmin = actorUser.role === 'admin' || actorUser.loginId === 'admin'
  if (!isAdmin && (!['teacher', 'homeroom'].includes(actorUser.role) || !teacherUids(club).includes(actorUser.uid))) {
    throw Object.assign(new Error('이 수업의 학생 활동 기록 권한이 없습니다.'), { status: 403 })
  }
  return club
}

function validateStudentAnswers(body, program, submitting) {
  const commonAnswers = Object.fromEntries(Object.entries(COMMON_LIMITS).map(([key, max]) => [key, clean(body.commonAnswers?.[key], max)]))
  if (submitting) {
    const missing = Object.entries(commonAnswers).find(([, value]) => !value)
    if (missing) throw Object.assign(new Error('공통 활동 기록 5개 항목을 모두 작성해주세요.'), { status: 400 })
  }
  const activeQuestions = normalizeQuestions(program.activityRecordQuestions).filter((row) => row.active).slice(0, MAX_ADDITIONAL_QUESTIONS)
  const additionalAnswers = Object.fromEntries(activeQuestions.map((question) => [question.id, clean(body.additionalAnswers?.[question.id], MAX_ADDITIONAL_ANSWER_LENGTH)]))
  if (submitting) {
    const missingQuestion = activeQuestions.find((question) => question.required && !additionalAnswers[question.id])
    if (missingQuestion) throw Object.assign(new Error(`추가 질문 '${missingQuestion.title}'에 답변해주세요.`), { status: 400 })
  }
  return { commonAnswers, additionalAnswers, activeQuestions }
}

function studentEditPatch(existing, status) {
  const hadTeacherReview = existing?.teacherStatus === 'reviewing' || existing?.teacherStatus === 'completed'
  return {
    studentStatus: status,
    studentUpdatedAt: timestamp(),
    ...(status === 'submitted' ? { submittedAt: timestamp() } : {}),
    ...(hadTeacherReview ? { teacherStatus: 'reviewing', studentUpdatedAfterReview: true } : {}),
  }
}

async function getStudentContext(actorUser, program) {
  if (actorUser.role !== 'student') throw Object.assign(new Error('학생 계정만 활동 기록을 작성할 수 있습니다.'), { status: 403 })
  const membership = await findStudentMembership(program, actorUser.uid)
  if (!membership) return null
  const { club, member } = membership
  const ref = recordRef(club.id, program.cycleId, actorUser.uid)
  const snapshot = membership.recordSnapshot || await ref.get()
  const fallback = {
    id: ref.id,
    programId: program.id,
    cycleId: program.cycleId,
    clubId: club.id,
    studentUid: actorUser.uid,
    studentNo: member.studentNo || actorUser.studentNo,
    studentName: member.name || actorUser.name,
  }
  return { club, member, ref, snapshot, record: normalizeRecord(snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : {}, fallback) }
}

function studentResult(program, context) {
  return {
    eligible: Boolean(context),
    window: getWindowState(program),
    questions: normalizeQuestions(program.activityRecordQuestions).filter((row) => row.active).slice(0, MAX_ADDITIONAL_QUESTIONS),
    club: context ? { id: context.club.id, clubName: clean(context.club.clubName, 160) } : null,
    record: context?.record || null,
  }
}

async function studentGet(actorUser, program) {
  const context = await getStudentContext(actorUser, program)
  return studentResult(program, context)
}

async function studentSave(actorUser, program, body) {
  assertWindowOpen(program)
  const context = await getStudentContext(actorUser, program)
  if (!context) throw Object.assign(new Error('이 프로그램의 확정 참여 명단에서 학생을 찾을 수 없습니다.'), { status: 403 })
  const submitting = body.mode === 'submit'
  const { commonAnswers, additionalAnswers, activeQuestions } = validateStudentAnswers(body, program, submitting)
  const existingData = context.snapshot.exists ? context.snapshot.data() : {}
  const snapshotMap = new Map(normalizeQuestions(existingData.questionSnapshot).map((row) => [row.id, row]))
  activeQuestions.forEach((row) => snapshotMap.set(row.id, row))
  await context.ref.set({
    programId: program.id,
    cycleId: program.cycleId,
    clubId: context.club.id,
    studentUid: actorUser.uid,
    studentNo: clean(context.member.studentNo || actorUser.studentNo, 40),
    studentName: clean(context.member.name || actorUser.name, 120),
    commonAnswers,
    additionalAnswers: { ...(existingData.additionalAnswers || {}), ...additionalAnswers },
    questionSnapshot: [...snapshotMap.values()],
    ...studentEditPatch(existingData, submitting ? 'submitted' : 'draft'),
    createdAt: existingData.createdAt || timestamp(),
    updatedAt: timestamp(),
  }, { merge: true })
  context.record = normalizeRecord({
    id: context.snapshot.id,
    ...existingData,
    programId: program.id,
    cycleId: program.cycleId,
    clubId: context.club.id,
    studentUid: actorUser.uid,
    studentNo: clean(context.member.studentNo || actorUser.studentNo, 40),
    studentName: clean(context.member.name || actorUser.name, 120),
    commonAnswers,
    additionalAnswers: { ...(existingData.additionalAnswers || {}), ...additionalAnswers },
    questionSnapshot: [...snapshotMap.values()],
    ...studentEditPatch(existingData, submitting ? 'submitted' : 'draft'),
  }, { id: context.snapshot.id || context.ref.id, programId: program.id, cycleId: program.cycleId, clubId: context.club.id, studentUid: actorUser.uid })
  return studentResult(program, context)
}

// 출결 요약은 편집 화면에서 선택된 학생만 필요하므로, 학급 전체 entries를 읽는 대신
// 해당 학생의 문서 경로만 세션 수만큼 직접 조회합니다.
async function attendanceSummary(actorUser, program, body) {
  const club = await authorizeTeacher(actorUser, body.clubId, program.id)
  const studentUid = clean(body.studentUid, 160)
  if (!studentUid) throw Object.assign(new Error('학생 정보가 필요합니다.'), { status: 400 })
  const sessions = (Array.isArray(program.attendanceSchedule) ? program.attendanceSchedule : []).filter((row) => row?.active !== false && row?.id)
  const summary = { present: 0, absent: 0, unchecked: 0, total: sessions.length }
  const snapshots = await Promise.all(sessions.map((session) => db().doc(`schedules/${club.id}/attendanceSessions/${session.id}/entries/${studentUid}`).get()))
  for (const snapshot of snapshots) {
    const status = snapshot.exists ? snapshot.data().status : 'unchecked'
    if (status === 'present') summary.present += 1
    else if (status === 'absent') summary.absent += 1
    else summary.unchecked += 1
  }
  return summary
}

async function teacherList(actorUser, program, options = {}) {
  if (!['admin', 'teacher', 'homeroom'].includes(actorUser.role) && actorUser.loginId !== 'admin') {
    throw Object.assign(new Error('담당교사 또는 관리자만 학생 활동 기록을 볼 수 있습니다.'), { status: 403 })
  }
  const allClubs = await listProgramClubs(program.id)
  const clubs = actorUser.role === 'admin' || actorUser.loginId === 'admin'
    ? allClubs
    : allClubs.filter((club) => teacherUids(club).includes(actorUser.uid))
  const clubSummaries = clubs.map((club) => ({ id: club.id, clubName: clean(club.clubName, 160) }))
  if (options.metaOnly) return { window: getWindowState(program), clubs: clubSummaries, rows: [] }
  const clubId = clean(options.clubId, 160)
  let targetClubs = clubs
  if (clubId) {
    targetClubs = clubs.filter((club) => club.id === clubId)
    if (targetClubs.length === 0) throw Object.assign(new Error('이 수업의 학생 활동 기록 권한이 없습니다.'), { status: 403 })
  }
  let applicationQuery = db().collection('applications').where('cycleId', '==', program.cycleId)
  if (clubId) applicationQuery = applicationQuery.where('clubId', '==', clubId)
  const applicationSnapshot = await applicationQuery.get()
  const applicationMap = new Map(applicationSnapshot.docs.filter((row) => row.data().status === 'approved').map((row) => {
    const value = row.data()
    return [`${clean(value.clubId, 160)}::${clean(value.studentUid, 160)}`, value]
  }))
  const rows = (await Promise.all(targetClubs.map(async (club) => {
    const [memberSnapshot, recordSnapshot] = await Promise.all([
      db().collection(`schedules/${club.id}/members`).get(),
      db().collection(`schedules/${club.id}/activityRecords`).where('cycleId', '==', program.cycleId).get(),
    ])
    const recordMap = new Map(recordSnapshot.docs.map((row) => [clean(row.data().studentUid, 160), { id: row.id, ...row.data() }]))
    const clubRows = []
    for (const memberDoc of memberSnapshot.docs) {
      const member = { id: memberDoc.id, ...memberDoc.data() }
      const studentUid = clean(member.studentUid || memberDoc.id, 160)
      const rawRecord = recordMap.get(studentUid) || {}
      const record = normalizeRecord(rawRecord, {
        id: recordId(program.cycleId, studentUid),
        programId: program.id,
        cycleId: program.cycleId,
        clubId: club.id,
        studentUid,
        studentNo: member.studentNo,
        studentName: member.name,
      })
      if (record.studentStatus !== 'submitted') {
        record.commonAnswers = Object.fromEntries(Object.keys(COMMON_LIMITS).map((key) => [key, '']))
        record.additionalAnswers = {}
        record.questionSnapshot = []
      }
      const application = applicationMap.get(`${club.id}::${studentUid}`) || {}
      clubRows.push({
        ...record,
        clubName: clean(club.clubName, 160),
        application: {
          careerGoal: clean(application.careerGoal, 100),
          applyReason: clean(application.applyReason, 100),
          wantedActivity: clean(application.wantedActivity, 100),
        },
      })
    }
    return clubRows
  }))).flat()
  rows.sort((left, right) => left.clubName.localeCompare(right.clubName, 'ko') || left.studentNo.localeCompare(right.studentNo, 'ko', { numeric: true }))
  return { window: getWindowState(program), clubs: clubSummaries, rows }
}

async function teacherSave(actorUser, program, body) {
  const club = await authorizeTeacher(actorUser, body.clubId, program.id)
  const studentUid = clean(body.studentUid, 160)
  const member = await db().doc(`schedules/${club.id}/members/${studentUid}`).get()
  if (!member.exists) throw Object.assign(new Error('확정 참여 학생을 찾을 수 없습니다.'), { status: 404 })
  const ref = recordRef(club.id, program.cycleId, studentUid)
  const snapshot = await ref.get()
  const existing = snapshot.exists ? snapshot.data() : {}
  const teacherStatus = body.teacherStatus === 'completed' ? 'completed' : 'reviewing'
  const studentRecordText = clean(body.studentRecordText, 3000)
  if (teacherStatus === 'completed' && existing.studentStatus !== 'submitted') {
    throw Object.assign(new Error('학생이 활동 기록을 제출한 뒤 작성 완료로 처리할 수 있습니다.'), { status: 409 })
  }
  if (teacherStatus === 'completed' && !studentRecordText) {
    throw Object.assign(new Error('생활기록부 작성 내용을 입력해주세요.'), { status: 400 })
  }
  await ref.set({
    programId: program.id,
    cycleId: program.cycleId,
    clubId: club.id,
    studentUid,
    studentNo: clean(member.data().studentNo, 40),
    studentName: clean(member.data().name, 120),
    studentRecordText,
    teacherStatus,
    teacherUpdatedAt: timestamp(),
    reviewedByUid: actorUser.uid,
    studentUpdatedAfterReview: false,
    createdAt: existing.createdAt || timestamp(),
    updatedAt: timestamp(),
  }, { merge: true })
  // 전체 목록을 다시 만드는 대신 저장된 학생의 레코드만 돌려주고 화면에서 그 행만 교체합니다.
  const record = normalizeRecord({
    ...existing,
    programId: program.id,
    cycleId: program.cycleId,
    clubId: club.id,
    studentUid,
    studentNo: clean(member.data().studentNo, 40),
    studentName: clean(member.data().name, 120),
    studentRecordText,
    teacherStatus,
    teacherUpdatedAt: new Date().toISOString(),
    reviewedByUid: actorUser.uid,
    studentUpdatedAfterReview: false,
  }, { id: ref.id })
  if (record.studentStatus !== 'submitted') {
    record.commonAnswers = Object.fromEntries(Object.keys(COMMON_LIMITS).map((key) => [key, '']))
    record.additionalAnswers = {}
    record.questionSnapshot = []
  }
  return { record: { ...record, clubName: clean(club.clubName, 160) } }
}

async function exportRecords(actorUser) {
  if (actorUser.role !== 'admin' && actorUser.loginId !== 'admin') {
    throw Object.assign(new Error('관리자만 활동 기록을 백업할 수 있습니다.'), { status: 403 })
  }
  const snapshot = await db().collectionGroup('activityRecords').get()
  return snapshot.docs.map((row) => normalizeRecord({ id: row.id, ...row.data() }))
}

export default async (req) => {
  try {
    const actor = requireActor(req)
    const body = await readBody(req)
    if (body.action === 'export') return json({ records: await exportRecords(await getActorUser(actor)) })
    const [actorUser, program] = await Promise.all([getActorUser(actor), getProgram(body.programId)])
    if (body.action === 'student-get') return json(await studentGet(actorUser, program))
    if (body.action === 'student-save') return json(await studentSave(actorUser, program, body))
    if (body.action === 'teacher-list') return json(await teacherList(actorUser, program, { clubId: body.clubId, metaOnly: body.metaOnly === true }))
    if (body.action === 'teacher-save') return json(await teacherSave(actorUser, program, body))
    if (body.action === 'attendance-summary') return json(await attendanceSummary(actorUser, program, body))
    return json({ error: '지원하지 않는 작업입니다.' }, 400)
  } catch (error) {
    return handleError(error)
  }
}
