import { randomUUID } from 'node:crypto'
import { db, handleError, json, readBody, requireActor, storageBucket, timestamp } from './_attendance-utils.js'

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
const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_BYTES = 750 * 1024
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const ATTACHMENT_EXTENSION_TYPES = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
}

function clean(value, max = 10000) {
  return String(value || '').trim().slice(0, max)
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

function publicAttachments(value) {
  return (Array.isArray(value) ? value : []).map((row) => ({
    id: clean(row?.id, 120),
    name: clean(row?.name, 180),
    type: clean(row?.type, 120),
    size: Math.max(0, Number(row?.size) || 0),
    uploadedAt: toIso(row?.uploadedAt) || row?.uploadedAt || null,
  })).filter((row) => row.id)
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
    attachments: publicAttachments(source.attachments),
    studentStatus: source.studentStatus === 'submitted' ? 'submitted' : source.studentStatus === 'draft' ? 'draft' : 'unsubmitted',
    teacherStatus: source.teacherStatus === 'completed' ? 'completed' : source.teacherStatus === 'reviewing' ? 'reviewing' : '',
    observationNote: clean(source.observationNote, 2000),
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
  const start = startAt ? new Date(startAt).getTime() : Number.NaN
  const end = endAt ? new Date(endAt).getTime() : Number.NaN
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
  const snapshot = await db().collection('schedules').get()
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
  const clubs = await listProgramClubs(program.id)
  const memberships = await Promise.all(clubs.map(async (club) => {
    const member = await db().doc(`schedules/${club.id}/members/${studentUid}`).get()
    return member.exists ? { club, member: { id: member.id, ...member.data() } } : null
  }))
  return memberships.find(Boolean) || null
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
  const snapshot = await ref.get()
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

async function studentGet(actorUser, program) {
  const context = await getStudentContext(actorUser, program)
  return {
    eligible: Boolean(context),
    window: getWindowState(program),
    questions: normalizeQuestions(program.activityRecordQuestions).filter((row) => row.active).slice(0, MAX_ADDITIONAL_QUESTIONS),
    club: context ? { id: context.club.id, clubName: clean(context.club.clubName, 160) } : null,
    record: context?.record || null,
  }
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
    attachments: Array.isArray(existingData.attachments) ? existingData.attachments : [],
    ...studentEditPatch(existingData, submitting ? 'submitted' : 'draft'),
    createdAt: existingData.createdAt || timestamp(),
    updatedAt: timestamp(),
  }, { merge: true })
  return studentGet(actorUser, program)
}

function safeFileName(value) {
  return clean(value, 180).replace(/[\\/:*?"<>|]/gu, '_') || 'attachment'
}

function resolveAttachmentType(fileName, fileType) {
  const provided = clean(fileType, 120)
  if (ALLOWED_ATTACHMENT_TYPES.has(provided)) return provided
  const extension = String(fileName || '').split('.').pop()?.toLowerCase() || ''
  return ATTACHMENT_EXTENSION_TYPES[extension] || ''
}

async function uploadAttachment(actorUser, program, body) {
  assertWindowOpen(program)
  const context = await getStudentContext(actorUser, program)
  if (!context) throw Object.assign(new Error('이 프로그램의 확정 참여 명단에서 학생을 찾을 수 없습니다.'), { status: 403 })
  const existing = context.snapshot.exists ? context.snapshot.data() : {}
  const attachments = Array.isArray(existing.attachments) ? existing.attachments : []
  if (attachments.length >= MAX_ATTACHMENTS) throw Object.assign(new Error(`첨부파일은 최대 ${MAX_ATTACHMENTS}개까지 등록할 수 있습니다.`), { status: 400 })
  const name = safeFileName(body.fileName)
  const type = resolveAttachmentType(name, body.fileType)
  if (!type) throw Object.assign(new Error('PDF, 문서, 발표자료, 엑셀 또는 이미지 파일만 첨부할 수 있습니다.'), { status: 400 })
  const data = Buffer.from(String(body.base64 || ''), 'base64')
  if (!data.length || data.length > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('첨부파일은 개당 750KB 이하여야 합니다.'), { status: 400 })
  const id = randomUUID()
  const storagePath = `activity-records/${program.id}/${program.cycleId}/${context.club.id}/${actorUser.uid}/${id}-${name}`
  await storageBucket().file(storagePath).save(data, { resumable: false, contentType: type, metadata: { cacheControl: 'private, max-age=0, no-store' } })
  const nextAttachments = [...attachments, { id, name, type, size: data.length, storagePath, uploadedAt: new Date().toISOString() }]
  await context.ref.set({
    programId: program.id,
    cycleId: program.cycleId,
    clubId: context.club.id,
    studentUid: actorUser.uid,
    studentNo: clean(context.member.studentNo || actorUser.studentNo, 40),
    studentName: clean(context.member.name || actorUser.name, 120),
    attachments: nextAttachments,
    ...studentEditPatch(existing, 'draft'),
    createdAt: existing.createdAt || timestamp(),
    updatedAt: timestamp(),
  }, { merge: true })
  return studentGet(actorUser, program)
}

async function removeAttachment(actorUser, program, body) {
  assertWindowOpen(program)
  const context = await getStudentContext(actorUser, program)
  if (!context || !context.snapshot.exists) throw Object.assign(new Error('학생 활동 기록을 찾을 수 없습니다.'), { status: 404 })
  const existing = context.snapshot.data()
  const attachments = Array.isArray(existing.attachments) ? existing.attachments : []
  const target = attachments.find((row) => clean(row.id, 120) === clean(body.attachmentId, 120))
  if (!target) throw Object.assign(new Error('첨부파일을 찾을 수 없습니다.'), { status: 404 })
  await storageBucket().file(target.storagePath).delete({ ignoreNotFound: true })
  await context.ref.set({
    attachments: attachments.filter((row) => clean(row.id, 120) !== clean(body.attachmentId, 120)),
    ...studentEditPatch(existing, 'draft'),
    updatedAt: timestamp(),
  }, { merge: true })
  return studentGet(actorUser, program)
}

async function downloadAttachment(actorUser, program, body) {
  const clubId = clean(body.clubId, 160)
  const studentUid = clean(body.studentUid, 160)
  if (actorUser.role === 'student') {
    if (actorUser.uid !== studentUid) throw Object.assign(new Error('본인의 첨부파일만 열 수 있습니다.'), { status: 403 })
    const clubSnapshot = await db().doc(`schedules/${clubId}`).get()
    if (!clubSnapshot.exists || clean(clubSnapshot.data().programId || DEFAULT_PROGRAM_ID, 160) !== program.id) {
      throw Object.assign(new Error('프로그램과 수업 정보가 일치하지 않습니다.'), { status: 400 })
    }
    const membership = await db().doc(`schedules/${clubId}/members/${studentUid}`).get()
    if (!membership.exists) throw Object.assign(new Error('확정 참여 정보를 찾을 수 없습니다.'), { status: 403 })
  } else {
    await authorizeTeacher(actorUser, clubId, program.id)
  }
  const ref = recordRef(clubId, program.cycleId, studentUid)
  const snapshot = await ref.get()
  if (!snapshot.exists) throw Object.assign(new Error('학생 활동 기록을 찾을 수 없습니다.'), { status: 404 })
  const target = (snapshot.data().attachments || []).find((row) => clean(row.id, 120) === clean(body.attachmentId, 120))
  if (!target) throw Object.assign(new Error('첨부파일을 찾을 수 없습니다.'), { status: 404 })
  const [buffer] = await storageBucket().file(target.storagePath).download()
  return { name: target.name, type: target.type, base64: buffer.toString('base64') }
}

async function attendanceSummaries(program, clubId, studentUids) {
  const sessions = (Array.isArray(program.attendanceSchedule) ? program.attendanceSchedule : []).filter((row) => row?.active !== false && row?.id)
  const summaries = new Map(studentUids.map((uid) => [uid, { present: 0, absent: 0, unchecked: 0, total: sessions.length }]))
  const entrySnapshots = await Promise.all(sessions.map((session) => db().collection(`schedules/${clubId}/attendanceSessions/${session.id}/entries`).get()))
  for (const entrySnapshot of entrySnapshots) {
    const statusMap = new Map(entrySnapshot.docs.map((row) => [row.id, row.data().status]))
    for (const studentUid of studentUids) {
      const result = summaries.get(studentUid)
      const status = statusMap.get(studentUid) || 'unchecked'
      if (status === 'present') result.present += 1
      else if (status === 'absent') result.absent += 1
      else result.unchecked += 1
    }
  }
  return summaries
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
    const studentUids = memberSnapshot.docs.map((row) => clean(row.data().studentUid || row.id, 160))
    const clubAttendance = await attendanceSummaries(program, club.id, studentUids)
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
        record.attachments = []
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
        attendance: clubAttendance.get(studentUid) || { present: 0, absent: 0, unchecked: 0, total: 0 },
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
    observationNote: clean(body.observationNote, 2000),
    studentRecordText,
    teacherStatus,
    teacherUpdatedAt: timestamp(),
    reviewedByUid: actorUser.uid,
    studentUpdatedAfterReview: false,
    createdAt: existing.createdAt || timestamp(),
    updatedAt: timestamp(),
  }, { merge: true })
  return teacherList(actorUser, program, { clubId: club.id })
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
    const actorUser = await getActorUser(actor)
    const body = await readBody(req)
    if (body.action === 'export') return json({ records: await exportRecords(actorUser) })
    const program = await getProgram(body.programId)
    if (body.action === 'student-get') return json(await studentGet(actorUser, program))
    if (body.action === 'student-save') return json(await studentSave(actorUser, program, body))
    if (body.action === 'upload-attachment') return json(await uploadAttachment(actorUser, program, body))
    if (body.action === 'remove-attachment') return json(await removeAttachment(actorUser, program, body))
    if (body.action === 'download-attachment') return json(await downloadAttachment(actorUser, program, body))
    if (body.action === 'teacher-list') return json(await teacherList(actorUser, program, { clubId: body.clubId, metaOnly: body.metaOnly === true }))
    if (body.action === 'teacher-save') return json(await teacherSave(actorUser, program, body))
    return json({ error: '지원하지 않는 작업입니다.' }, 400)
  } catch (error) {
    return handleError(error)
  }
}
