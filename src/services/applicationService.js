import {
  collection,
  deleteDoc,
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
import {
  canManageSelection,
  deleteSchedule,
  getClubTeacherUids,
  getScheduleById,
  listSchedules,
  updateSchedule,
  updateScheduleMemberCount,
} from './scheduleService'
import { getUserProfile } from './userService'

const APPLICATIONS = 'applications'
const DRAFTS = 'applicationDrafts'
const CYCLES = 'recruitmentCycles'
const CYCLE_DOC_ID = 'current'
const MEMBERS_SUBCOLLECTION = 'members'
const ASSIGNMENTS = 'recruitmentAssignments'
const LEADER_AUTO_SOURCE = 'leader_auto'
const ADMIN_FORCE_SOURCE = 'admin_force'

const STATUS = {
  WAITING: 'waiting_round',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
}

const REJECT_REASON = {
  MANUAL: 'manual',
  RANDOM_UNSELECTED: 'random_unselected',
  HIGHER_CHOICE: 'higher_choice_assigned',
  FINAL_CLOSED: 'final_round_closed',
  ROUND_INELIGIBLE: 'round_ineligible',
  APPROVAL_REVOKED: 'approval_revoked',
  LEADER_ASSIGNED: 'leader_assigned',
  ADMIN_FORCE_ASSIGNED: 'admin_force_assigned',
}

let localApplications = []
let localDrafts = new Map()
let localCycle = {
  id: CYCLE_DOC_ID,
  currentRound: 1,
  status: 'open',
  preAssignmentStartAt: null,
  preAssignmentEndAt: null,
  submissionStartAt: null,
  submissionEndAt: null,
  submissionFinalizedAt: null,
  updatedAt: new Date().toISOString(),
}
const localMembersByClub = new Map()
let cycleCache = null
let cyclePromise = null

function nowIso() {
  return new Date().toISOString()
}

function cloneCycle(cycle) {
  return cycle ? { ...cycle } : null
}

function setCycleCache(nextCycle) {
  cycleCache = nextCycle ? { ...nextCycle } : null
  cyclePromise = null
  return cloneCycle(cycleCache)
}

function readProfileFromCache(profilesByUid, uid) {
  if (!profilesByUid || !uid) return null
  if (profilesByUid instanceof Map) {
    return profilesByUid.get(uid) || null
  }
  return profilesByUid[uid] || null
}

function toRound(value, fallback = 1) {
  const parsed = Number(value)
  if (parsed === 1 || parsed === 2 || parsed === 3) return parsed
  return fallback
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

function normalizeCycle(data) {
  return {
    id: CYCLE_DOC_ID,
    currentRound: toRound(data?.currentRound, 1),
    status: data?.status === 'closed' ? 'closed' : 'open',
    preAssignmentStartAt: toIsoString(data?.preAssignmentStartAt),
    preAssignmentEndAt: toIsoString(data?.preAssignmentEndAt),
    submissionStartAt: toIsoString(data?.submissionStartAt),
    submissionEndAt: toIsoString(data?.submissionEndAt),
    submissionFinalizedAt: toIsoString(data?.submissionFinalizedAt),
    updatedAt: toIsoString(data?.updatedAt) || data?.updatedAt || null,
  }
}

function normalizeApplication(id, data) {
  return {
    id,
    cycleId: String(data?.cycleId || CYCLE_DOC_ID),
    studentUid: String(data?.studentUid || '').trim(),
    studentNo: String(data?.studentNo || '').trim(),
    studentName: String(data?.studentName || '').trim(),
    clubId: String(data?.clubId || '').trim(),
    preferenceRank: toRound(data?.preferenceRank, 1),
    careerGoal: String(data?.careerGoal || '').trim(),
    applyReason: String(data?.applyReason || '').trim(),
    wantedActivity: String(data?.wantedActivity || '').trim(),
    status: String(data?.status || STATUS.WAITING),
    rejectReason: String(data?.rejectReason || '').trim(),
    decisionNote: String(data?.decisionNote || '').trim(),
    decidedByUid: String(data?.decidedByUid || '').trim(),
    selectionSource: String(data?.selectionSource || '').trim(),
    decidedAt: data?.decidedAt || null,
    createdAt: data?.createdAt || null,
    updatedAt: data?.updatedAt || null,
  }
}

function normalizeMember(id, data) {
  return {
    id,
    studentUid: String(data?.studentUid || id || '').trim(),
    studentNo: String(data?.studentNo || '').trim(),
    name: String(data?.name || '').trim(),
    source: String(data?.source || '').trim(),
    applicationId: String(data?.applicationId || '').trim(),
    addedByUid: String(data?.addedByUid || '').trim(),
    addedAt: data?.addedAt || null,
  }
}

function normalizeDraftPreference(row, index = 0) {
  return {
    clubId: String(row?.clubId || '').trim(),
    preferenceRank: toRound(row?.preferenceRank, index + 1),
    careerGoal: String(row?.careerGoal || '').trim(),
    applyReason: String(row?.applyReason || '').trim(),
    wantedActivity: String(row?.wantedActivity || '').trim(),
  }
}

function normalizeDraft(id, data) {
  const preferences = (Array.isArray(data?.preferences) ? data.preferences : [])
    .map((row, index) => normalizeDraftPreference(row, index))
    .sort((a, b) => a.preferenceRank - b.preferenceRank)

  return {
    id,
    cycleId: String(data?.cycleId || CYCLE_DOC_ID).trim() || CYCLE_DOC_ID,
    studentUid: String(data?.studentUid || '').trim(),
    studentNo: String(data?.studentNo || '').trim(),
    studentName: String(data?.studentName || '').trim(),
    clubIds: Array.from(new Set(
      (Array.isArray(data?.clubIds) ? data.clubIds : preferences.map((row) => row.clubId))
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    )),
    preferences,
    submittedAt: toIsoString(data?.submittedAt),
    updatedAt: toIsoString(data?.updatedAt) || data?.updatedAt || null,
  }
}

function buildAssignmentDocId(cycleId, studentUid) {
  const normalizedCycleId = String(cycleId || CYCLE_DOC_ID).trim() || CYCLE_DOC_ID
  const normalizedStudentUid = String(studentUid || '').trim()
  return `${normalizedCycleId}__${normalizedStudentUid}`.replaceAll('/', '_')
}

function buildDraftDocId(cycleId, studentUid) {
  const normalizedCycleId = String(cycleId || CYCLE_DOC_ID).trim() || CYCLE_DOC_ID
  const normalizedStudentUid = String(studentUid || '').trim()
  return `${normalizedCycleId}__${normalizedStudentUid}`.replaceAll('/', '_')
}

function buildApplicationDocId(cycleId, studentUid, preferenceRank) {
  const normalizedCycleId = String(cycleId || CYCLE_DOC_ID).trim() || CYCLE_DOC_ID
  const normalizedStudentUid = String(studentUid || '').trim()
  return `${normalizedCycleId}__${normalizedStudentUid}__${toRound(preferenceRank, 1)}`.replaceAll('/', '_')
}

function buildSystemActor(club) {
  const uid = String(getClubTeacherUids(club)[0] || club?.teacherUid || club?.createdByUid || 'system-sync').trim() || 'system-sync'
  return {
    uid,
    role: 'admin',
    name: 'system-sync',
    studentNo: '',
  }
}

function getReopenedStatus(preferenceRank, currentRound) {
  const rank = toRound(preferenceRank, 0)
  const round = toRound(currentRound, 1)
  if (rank === round) return STATUS.PENDING
  if (rank > round) return STATUS.WAITING
  return ''
}

export function getSubmissionWindowState(cycle, nowValue = new Date()) {
  const now = toDateValue(nowValue) || new Date()
  const startAt = toDateValue(cycle?.submissionStartAt)
  const endAt = toDateValue(cycle?.submissionEndAt)
  const finalizedAt = toDateValue(cycle?.submissionFinalizedAt)
  const configured = !!startAt && !!endAt && startAt.getTime() < endAt.getTime()

  if (!configured) {
    return {
      configured: false,
      phase: 'unconfigured',
      startAt: null,
      endAt: null,
      finalizedAt,
      canSubmit: false,
      selectionReady: true,
      needsFinalization: false,
    }
  }

  // finalizedAt이 현재 신청 기간의 시작일 이후에 발생한 경우에만 closed로 처리
  // (이전 기간에서 남아있는 finalizedAt은 새 기간을 막지 않음)
  if (finalizedAt && finalizedAt.getTime() >= startAt.getTime()) {
    return {
      configured: true,
      phase: 'closed',
      startAt,
      endAt,
      finalizedAt,
      canSubmit: false,
      selectionReady: true,
      needsFinalization: false,
    }
  }

  if (now.getTime() < startAt.getTime()) {
    return {
      configured: true,
      phase: 'before',
      startAt,
      endAt,
      finalizedAt,
      canSubmit: false,
      selectionReady: false,
      needsFinalization: false,
    }
  }

  if (now.getTime() <= endAt.getTime()) {
    return {
      configured: true,
      phase: 'open',
      startAt,
      endAt,
      finalizedAt,
      canSubmit: true,
      selectionReady: false,
      needsFinalization: false,
    }
  }

  return {
    configured: true,
    phase: 'closed',
    startAt,
    endAt,
    finalizedAt,
    canSubmit: false,
    selectionReady: true,
    needsFinalization: !finalizedAt,
  }
}

export function getTeacherPreAssignmentWindowState(cycle, nowValue = new Date()) {
  const now = toDateValue(nowValue) || new Date()
  const startAt = toDateValue(cycle?.preAssignmentStartAt)
  const endAt = toDateValue(cycle?.preAssignmentEndAt)
  const configured = !!startAt && !!endAt && startAt.getTime() < endAt.getTime()

  if (!configured) {
    return {
      configured: false,
      phase: 'unconfigured',
      startAt: null,
      endAt: null,
      canAssign: false,
    }
  }

  if (now.getTime() < startAt.getTime()) {
    return {
      configured: true,
      phase: 'before',
      startAt,
      endAt,
      canAssign: false,
    }
  }

  if (now.getTime() <= endAt.getTime()) {
    return {
      configured: true,
      phase: 'open',
      startAt,
      endAt,
      canAssign: true,
    }
  }

  return {
    configured: true,
    phase: 'closed',
    startAt,
    endAt,
    canAssign: false,
  }
}

function isSyntheticAssignedApplication(app) {
  const source = String(app?.selectionSource || '').trim()
  if (
    source !== 'manual_assign'
    && source !== 'interview_manual'
    && source !== LEADER_AUTO_SOURCE
    && source !== ADMIN_FORCE_SOURCE
  ) {
    return false
  }

  return !String(app?.careerGoal || '').trim()
    && !String(app?.applyReason || '').trim()
    && !String(app?.wantedActivity || '').trim()
}

function inferGradeFromStudentNo(studentNo) {
  const raw = String(studentNo || '').trim()
  const first = Number(raw[0])
  if (first === 1 || first === 2 || first === 3) {
    return first
  }
  return null
}

function isStudentEligibleForClub(club, studentNo) {
  const grade = inferGradeFromStudentNo(studentNo)
  if (!grade) return false
  const targets = Array.isArray(club?.targetGrades) ? club.targetGrades : []
  return targets.includes(grade)
}

function assertActor(actor) {
  const uid = String(actor?.uid || '').trim()
  const role = String(actor?.role || '').trim()
  if (!uid || !role) {
    throw new Error('사용자 정보가 필요합니다.')
  }
  return {
    uid,
    role,
    name: String(actor?.name || '').trim(),
    studentNo: String(actor?.studentNo || '').trim(),
  }
}

function assertOpenCycle(cycle) {
  if (cycle.status !== 'open') {
    throw new Error('현재 모집 사이클이 닫혀 있습니다.')
  }
}

function getLocalMembers(clubId) {
  if (!localMembersByClub.has(clubId)) {
    localMembersByClub.set(clubId, [])
  }
  return localMembersByClub.get(clubId)
}

function shuffle(items) {
  const next = [...items]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = next[i]
    next[i] = next[j]
    next[j] = temp
  }
  return next
}

function chunk(list, size = 450) {
  const rows = []
  for (let i = 0; i < list.length; i += size) {
    rows.push(list.slice(i, i + size))
  }
  return rows
}

async function getAllApplications() {
  if (!isFirebaseEnabled()) {
    return [...localApplications]
  }

  const snapshot = await getDocs(collection(db, APPLICATIONS))
  return snapshot.docs.map((item) => normalizeApplication(item.id, item.data()))
}

async function getApplicationsByCycle(cycleId) {
  if (!isFirebaseEnabled()) {
    return localApplications.filter((row) => row.cycleId === cycleId)
  }

  const snapshot = await getDocs(query(collection(db, APPLICATIONS), where('cycleId', '==', cycleId)))
  return snapshot.docs.map((item) => normalizeApplication(item.id, item.data()))
}

async function getApplicationsByStudent(studentUid) {
  if (!isFirebaseEnabled()) {
    return localApplications.filter((row) => row.studentUid === studentUid)
  }

  const snapshot = await getDocs(query(collection(db, APPLICATIONS), where('studentUid', '==', studentUid)))
  return snapshot.docs.map((item) => normalizeApplication(item.id, item.data()))
}

async function getApplicationsByClub(clubId) {
  if (!isFirebaseEnabled()) {
    return localApplications.filter((row) => row.clubId === clubId)
  }

  const snapshot = await getDocs(query(collection(db, APPLICATIONS), where('clubId', '==', clubId)))
  return snapshot.docs.map((item) => normalizeApplication(item.id, item.data()))
}

async function listDraftsByCycle(cycleId) {
  if (!isFirebaseEnabled()) {
    return Array.from(localDrafts.values()).filter((row) => row.cycleId === cycleId)
  }

  const snapshot = await getDocs(query(collection(db, DRAFTS), where('cycleId', '==', cycleId)))
  return snapshot.docs.map((item) => normalizeDraft(item.id, item.data()))
}

async function getStudentDraftByCycle(cycleId, studentUid) {
  const targetCycleId = String(cycleId || CYCLE_DOC_ID).trim() || CYCLE_DOC_ID
  const targetStudentUid = String(studentUid || '').trim()
  if (!targetStudentUid) return null

  const draftId = buildDraftDocId(targetCycleId, targetStudentUid)
  if (!isFirebaseEnabled()) {
    return localDrafts.get(draftId) || null
  }

  const snapshot = await getDoc(doc(db, DRAFTS, draftId))
  if (!snapshot.exists()) return null
  return normalizeDraft(snapshot.id, snapshot.data())
}

function assertSubmissionWindowEditable(cycle) {
  const submission = getSubmissionWindowState(cycle)
  if (cycle.status !== 'open') {
    throw new Error('현재 모집 사이클이 종료되어 신청서를 수정할 수 없습니다.')
  }
  if (!submission.configured) {
    throw new Error('관리자가 아직 동아리 신청 기간을 설정하지 않았습니다.')
  }
  if (submission.phase === 'before') {
    throw new Error('동아리 신청 기간이 아직 시작되지 않았습니다.')
  }
  if (submission.phase === 'closed') {
    throw new Error('동아리 신청 기간이 종료되어 더 이상 수정할 수 없습니다.')
  }
  return submission
}

async function normalizeStudentPreferences(studentNo, preferences) {
  const rows = Array.isArray(preferences) ? preferences : []
  const grade = inferGradeFromStudentNo(studentNo)
  if (!grade) {
    throw new Error('학번 첫 자리로 학년을 추정할 수 없습니다. 학번을 확인해주세요.')
  }

  if (rows.length !== 3) {
    throw new Error('1지망, 2지망, 3지망을 모두 입력해주세요. (교사 사전 배정 학생 제외 전원 필수)')
  }

  const uniqueClubIds = new Set()
  const normalized = []

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const clubId = String(row?.clubId || '').trim()
    if (!clubId) {
      throw new Error(`${i + 1}지망 동아리를 선택해주세요.`)
    }
    if (uniqueClubIds.has(clubId)) {
      throw new Error('동일한 동아리를 중복 지망할 수 없습니다.')
    }

    const club = await getScheduleById(clubId)
    if (!club || club.legacy) {
      throw new Error('유효하지 않은 동아리 선택입니다.')
    }
    if (club.isInterviewSelection) {
      throw new Error('자체면접 동아리는 학생 신청으로 선택할 수 없습니다.')
    }
    if (!isStudentEligibleForClub(club, studentNo)) {
      throw new Error(`${club.clubName}은(는) 대상학년에 해당하지 않습니다.`)
    }

    const careerGoal = String(row?.careerGoal || '').trim()
    const applyReason = String(row?.applyReason || '').trim()
    const wantedActivity = String(row?.wantedActivity || '').trim()
    if (!careerGoal || !applyReason || !wantedActivity) {
      throw new Error(`${i + 1}지망의 진로희망/신청사유/활동계획을 모두 입력해주세요.`)
    }

    uniqueClubIds.add(clubId)
    normalized.push({
      clubId,
      preferenceRank: i + 1,
      careerGoal,
      applyReason,
      wantedActivity,
    })
  }

  return normalized
}

function buildApplicationsFromDraft(cycle, draft) {
  return draft.preferences.map((item) => ({
    id: buildApplicationDocId(cycle.id, draft.studentUid, item.preferenceRank),
    cycleId: cycle.id,
    studentUid: draft.studentUid,
    studentNo: draft.studentNo,
    studentName: draft.studentName,
    clubId: item.clubId,
    preferenceRank: item.preferenceRank,
    careerGoal: item.careerGoal,
    applyReason: item.applyReason,
    wantedActivity: item.wantedActivity,
    status: item.preferenceRank === 1 ? STATUS.PENDING : STATUS.WAITING,
    rejectReason: '',
    decisionNote: '',
    decidedByUid: '',
    selectionSource: '',
  }))
}

async function ensureSelectionPhaseReady(options = {}) {
  const allowPreAssignment = options?.allowPreAssignment === true
  const cycle = await getCurrentRecruitmentCycle()
  const submission = getSubmissionWindowState(cycle)
  const preAssignment = getTeacherPreAssignmentWindowState(cycle)

  if (allowPreAssignment && preAssignment.canAssign) {
    return cycle
  }

  if (!submission.configured) {
    return cycle
  }
  if (submission.phase === 'before') {
    if (allowPreAssignment) {
      if (!preAssignment.configured) {
        throw new Error('교사 사전 학생 배정 기간이 설정되지 않았습니다.')
      }
      if (preAssignment.phase === 'before') {
        throw new Error('교사 사전 학생 배정 기간이 아직 시작되지 않았습니다.')
      }
      if (preAssignment.phase === 'closed') {
        throw new Error('교사 사전 학생 배정 기간이 종료되었습니다.')
      }
    }
    throw new Error('동아리 신청 시작 전에는 선발을 진행할 수 없습니다.')
  }
  if (submission.phase === 'open') {
    throw new Error(allowPreAssignment
      ? '동아리 신청 기간에는 교사 사전 학생 배정을 진행할 수 없습니다.'
      : '동아리 신청 기간이 끝난 뒤 선발을 진행해주세요.')
  }

  if (submission.needsFinalization) {
    await finalizeCurrentCycleDraftsIfNeeded()
    return getCurrentRecruitmentCycle()
  }

  return cycle
}

async function updateApplicationsStatusBulk(patches) {
  if (!patches.length) return

  if (!isFirebaseEnabled()) {
    const patchMap = new Map(patches.map((patch) => [patch.id, patch]))
    localApplications = localApplications.map((row) => {
      const patch = patchMap.get(row.id)
      if (!patch) return row
      return {
        ...row,
        ...patch,
        updatedAt: nowIso(),
      }
    })
    return
  }

  for (const rows of chunk(patches, 400)) {
    const batch = writeBatch(db)
    rows.forEach((patch) => {
      const ref = doc(db, APPLICATIONS, patch.id)
      const { id, ...rest } = patch
      void id
      batch.update(ref, {
        ...rest,
        updatedAt: serverTimestamp(),
      })
    })
    await batch.commit()
  }
}

async function createApprovedDirectApplication({
  cycle,
  club,
  student,
  actor,
  source = 'manual_assign',
  decisionNote = '',
}) {
  const appPayload = {
    cycleId: cycle.id,
    studentUid: student.uid,
    studentNo: student.studentNo,
    studentName: student.name,
    clubId: club.id,
    preferenceRank: 1,
    careerGoal: '',
    applyReason: '',
    wantedActivity: '',
    status: STATUS.APPROVED,
    rejectReason: '',
    decisionNote: String(decisionNote || '').trim(),
    decidedByUid: actor.uid,
    selectionSource: source,
  }

  if (!isFirebaseEnabled()) {
    const next = {
      id: `local-direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...appPayload,
      decidedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    localApplications = [...localApplications, next]
    return next
  }

  const ref = doc(collection(db, APPLICATIONS))
  await setDoc(ref, {
    ...appPayload,
    decidedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  return {
    id: ref.id,
    ...appPayload,
  }
}

function directAssignStatusRank(status) {
  if (status === STATUS.PENDING) return 0
  if (status === STATUS.WAITING) return 1
  if (status === STATUS.REJECTED) return 2
  if (status === STATUS.CANCELLED) return 3
  return 9
}

function pickDirectAssignApplication(rows, cycleId, clubId) {
  const targets = rows
    .filter((row) => row.cycleId === cycleId && row.clubId === clubId)
    .sort((a, b) => directAssignStatusRank(a.status) - directAssignStatusRank(b.status))
  return targets[0] || null
}

export function inferStudentGrade(studentNo) {
  return inferGradeFromStudentNo(studentNo)
}

export async function getCurrentRecruitmentCycle(options = {}) {
  if (!isFirebaseEnabled()) {
    return { ...localCycle }
  }

  const force = options?.force === true
  if (!force && cycleCache) {
    return cloneCycle(cycleCache)
  }

  if (!force && cyclePromise) {
    return cloneCycle(await cyclePromise)
  }

  cyclePromise = (async () => {
    const ref = doc(db, CYCLES, CYCLE_DOC_ID)
    const snapshot = await getDoc(ref)
    if (!snapshot.exists()) {
      await setDoc(ref, {
        currentRound: 1,
        status: 'open',
        preAssignmentStartAt: null,
        preAssignmentEndAt: null,
        submissionStartAt: null,
        submissionEndAt: null,
        submissionFinalizedAt: null,
        updatedAt: serverTimestamp(),
      })
      return {
        id: CYCLE_DOC_ID,
        currentRound: 1,
        status: 'open',
        preAssignmentStartAt: null,
        preAssignmentEndAt: null,
        submissionStartAt: null,
        submissionEndAt: null,
        submissionFinalizedAt: null,
        updatedAt: null,
      }
    }

    return normalizeCycle(snapshot.data())
  })()

  try {
    return setCycleCache(await cyclePromise)
  } catch (error) {
    cyclePromise = null
    throw error
  }
}

export async function getStudentPreferenceDraft(studentUid) {
  const targetStudentUid = String(studentUid || '').trim()
  if (!targetStudentUid) return null
  const cycle = await getCurrentRecruitmentCycle()
  return getStudentDraftByCycle(cycle.id, targetStudentUid)
}

export async function updateRecruitmentSubmissionWindow(payload) {
  const user = assertActor(payload?.actor)
  if (user.role !== 'admin') {
    throw new Error('신청 기간 설정은 관리자만 가능합니다.')
  }

  const cycle = await getCurrentRecruitmentCycle()
  if (cycle.status === 'closed') {
    throw new Error('종료된 모집 사이클의 신청 기간은 변경할 수 없습니다.')
  }

  const startRaw = String(payload?.submissionStartAt || '').trim()
  const endRaw = String(payload?.submissionEndAt || '').trim()
  const startAt = startRaw ? toIsoString(startRaw) : null
  const endAt = endRaw ? toIsoString(endRaw) : null

  if ((startAt && !endAt) || (!startAt && endAt)) {
    throw new Error('신청 시작/종료 일시를 모두 입력해주세요.')
  }
  if (startAt && endAt && new Date(startAt).getTime() >= new Date(endAt).getTime()) {
    throw new Error('신청 종료 일시는 시작 일시보다 뒤여야 합니다.')
  }

  const existingApps = await getApplicationsByCycle(cycle.id)
  const existingDrafts = await listDraftsByCycle(cycle.id)
  const hasSelectionData = existingApps.some((row) => row.selectionSource !== LEADER_AUTO_SOURCE || row.status !== STATUS.APPROVED)
  if ((!startAt || !endAt) && (existingDrafts.length > 0 || hasSelectionData)) {
    throw new Error('이미 제출 또는 선발 데이터가 있어 신청 기간을 비울 수 없습니다.')
  }

  // 새 신청 기간의 시작일 이전의 finalizedAt은 이전 기간의 것이므로 유지하지 않음
  const oldFinalizedAt = toDateValue(cycle?.submissionFinalizedAt)
  const newStartAt = toDateValue(startAt)
  const keepFinalized = oldFinalizedAt && newStartAt && oldFinalizedAt.getTime() >= newStartAt.getTime()
  const nextFinalizedAt = keepFinalized ? cycle.submissionFinalizedAt : null

  if (!isFirebaseEnabled()) {
    localCycle = {
      ...localCycle,
      submissionStartAt: startAt,
      submissionEndAt: endAt,
      submissionFinalizedAt: nextFinalizedAt,
      updatedAt: nowIso(),
    }
    return { ...localCycle }
  }

  await setDoc(
    doc(db, CYCLES, CYCLE_DOC_ID),
    {
      currentRound: cycle.currentRound,
      status: cycle.status,
      preAssignmentStartAt: cycle.preAssignmentStartAt || null,
      preAssignmentEndAt: cycle.preAssignmentEndAt || null,
      submissionStartAt: startAt,
      submissionEndAt: endAt,
      submissionFinalizedAt: keepFinalized ? cycle.submissionFinalizedAt : null,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )

  return getCurrentRecruitmentCycle()
}

export async function updateRecruitmentPreAssignmentWindow(payload) {
  const user = assertActor(payload?.actor)
  if (user.role !== 'admin') {
    throw new Error('교사 사전 학생 배정 기간 설정은 관리자만 가능합니다.')
  }

  const cycle = await getCurrentRecruitmentCycle()
  if (cycle.status === 'closed') {
    throw new Error('종료된 모집 사이클의 교사 사전 학생 배정 기간은 변경할 수 없습니다.')
  }

  const startRaw = String(payload?.preAssignmentStartAt || '').trim()
  const endRaw = String(payload?.preAssignmentEndAt || '').trim()
  const startAt = startRaw ? toIsoString(startRaw) : null
  const endAt = endRaw ? toIsoString(endRaw) : null

  if ((startAt && !endAt) || (!startAt && endAt)) {
    throw new Error('교사 사전 학생 배정 시작/종료 일시를 모두 입력해주세요.')
  }
  if (startAt && endAt && new Date(startAt).getTime() >= new Date(endAt).getTime()) {
    throw new Error('교사 사전 학생 배정 종료 일시는 시작 일시보다 뒤여야 합니다.')
  }

  if (!isFirebaseEnabled()) {
    localCycle = {
      ...localCycle,
      preAssignmentStartAt: startAt,
      preAssignmentEndAt: endAt,
      updatedAt: nowIso(),
    }
    return { ...localCycle }
  }

  await setDoc(
    doc(db, CYCLES, CYCLE_DOC_ID),
    {
      currentRound: cycle.currentRound,
      status: cycle.status,
      preAssignmentStartAt: startAt,
      preAssignmentEndAt: endAt,
      submissionStartAt: cycle.submissionStartAt || null,
      submissionEndAt: cycle.submissionEndAt || null,
      submissionFinalizedAt: cycle.submissionFinalizedAt || null,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )

  return getCurrentRecruitmentCycle()
}

export async function saveStudentPreferenceDraft(payload) {
  const studentUid = String(payload?.studentUid || '').trim()
  const studentNo = String(payload?.studentNo || '').trim()
  const studentName = String(payload?.studentName || '').trim()
  const preferences = Array.isArray(payload?.preferences) ? payload.preferences : []

  if (!studentUid) {
    throw new Error('학생 계정 정보가 필요합니다.')
  }
  if (!studentNo) {
    throw new Error('학생 학번이 필요합니다.')
  }
  if (!studentName) {
    throw new Error('학생 이름이 필요합니다.')
  }

  const cycle = await getCurrentRecruitmentCycle()
  assertSubmissionWindowEditable(cycle)

  const existingApps = await getApplicationsByStudent(studentUid)
  const alreadyFinalized = existingApps.some((row) => row.cycleId === cycle.id)
  if (alreadyFinalized) {
    throw new Error('이미 신청이 확정되어 더 이상 수정할 수 없습니다.')
  }

  const normalizedPreferences = await normalizeStudentPreferences(studentNo, preferences)
  const draftId = buildDraftDocId(cycle.id, studentUid)
  const existingDraft = await getStudentDraftByCycle(cycle.id, studentUid)
  const draft = normalizeDraft(draftId, {
    cycleId: cycle.id,
    studentUid,
    studentNo,
    studentName,
    clubIds: normalizedPreferences.map((row) => row.clubId),
    preferences: normalizedPreferences,
    submittedAt: existingDraft?.submittedAt || nowIso(),
    updatedAt: nowIso(),
  })

  if (!isFirebaseEnabled()) {
    localDrafts.set(draftId, draft)
    return draft
  }

  const ref = doc(db, DRAFTS, draftId)
  await setDoc(
    ref,
    {
      cycleId: cycle.id,
      studentUid,
      studentNo,
      studentName,
      clubIds: normalizedPreferences.map((row) => row.clubId),
      preferences: normalizedPreferences,
      submittedAt: existingDraft?.submittedAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
  return getStudentDraftByCycle(cycle.id, studentUid)
}

export async function cancelStudentPreferenceDraft(payload) {
  const studentUid = String(payload?.studentUid || '').trim()
  if (!studentUid) {
    throw new Error('학생 계정 정보가 필요합니다.')
  }

  const cycle = await getCurrentRecruitmentCycle()
  assertSubmissionWindowEditable(cycle)

  const draftId = buildDraftDocId(cycle.id, studentUid)
  if (!isFirebaseEnabled()) {
    localDrafts.delete(draftId)
    return { ok: true }
  }

  await deleteDoc(doc(db, DRAFTS, draftId))
  return { ok: true }
}

export async function finalizeCurrentCycleDraftsIfNeeded() {
  const cycle = await getCurrentRecruitmentCycle()
  const submission = getSubmissionWindowState(cycle)

  // 신청 기간 종료 전이면 finalize 불필요
  if (!submission.configured || submission.phase === 'open' || submission.phase === 'before') {
    return { finalized: false, created: 0, skipped: 0 }
  }

  const drafts = await listDraftsByCycle(cycle.id)
  if (drafts.length === 0) {
    return { finalized: false, created: 0, skipped: 0 }
  }
  const existingApps = await getApplicationsByCycle(cycle.id)
  const existingByStudent = new Set(existingApps.map((row) => row.studentUid))
  const appRows = []
  const finalizedStudentUids = new Set()
  let skipped = 0

  for (const draft of drafts) {
    if (existingByStudent.has(draft.studentUid)) {
      skipped += 1
      finalizedStudentUids.add(draft.studentUid)
      continue
    }

    // finalize 시에는 개별 지망 단위로 유효성을 판단하여,
    // 자체면접 동아리 등 검증 실패한 지망만 제외하고 나머지는 정상 변환
    const validPrefs = []
    for (const pref of (draft.preferences || [])) {
      try {
        const club = await getScheduleById(pref.clubId)
        if (!club || club.legacy || club.isInterviewSelection) continue
        if (!isStudentEligibleForClub(club, draft.studentNo)) continue
        const careerGoal = String(pref.careerGoal || '').trim()
        const applyReason = String(pref.applyReason || '').trim()
        const wantedActivity = String(pref.wantedActivity || '').trim()
        if (!careerGoal || !applyReason || !wantedActivity) continue
        validPrefs.push({
          clubId: pref.clubId,
          preferenceRank: pref.preferenceRank,
          careerGoal,
          applyReason,
          wantedActivity,
        })
      } catch {
        // 개별 지망 검증 실패 시 해당 지망만 건너뜀
      }
    }

    if (validPrefs.length > 0) {
      appRows.push(...buildApplicationsFromDraft(cycle, {
        ...draft,
        preferences: validPrefs,
      }))
      finalizedStudentUids.add(draft.studentUid)
    } else {
      skipped += 1
    }
  }

  // 성공적으로 finalize된 draft만 삭제 (검증 실패한 draft는 유지)
  const draftIds = drafts
    .filter((row) => finalizedStudentUids.has(row.studentUid))
    .map((row) => buildDraftDocId(cycle.id, row.studentUid))

  if (!isFirebaseEnabled()) {
    const nextMap = new Map(localApplications.map((row) => [row.id, row]))
    const now = nowIso()
    appRows.forEach((row) => {
      nextMap.set(row.id, {
        ...row,
        createdAt: nextMap.get(row.id)?.createdAt || now,
        updatedAt: now,
        decidedAt: nextMap.get(row.id)?.decidedAt || null,
      })
    })
    localApplications = Array.from(nextMap.values())
    draftIds.forEach((id) => localDrafts.delete(id))
    localCycle = {
      ...localCycle,
      submissionFinalizedAt: now,
      updatedAt: now,
    }
    return { finalized: true, created: appRows.length, skipped }
  }

  // 지원서 생성과 초안 삭제를 같은 배치에 묶어 원자성 보장
  // Firestore 배치 한도(500)를 고려하여 지원서+초안을 함께 청킹
  const allOps = []
  appRows.forEach((row) => {
    allOps.push({
      type: 'set',
      ref: doc(db, APPLICATIONS, row.id),
      data: {
        cycleId: row.cycleId,
        studentUid: row.studentUid,
        studentNo: row.studentNo,
        studentName: row.studentName,
        clubId: row.clubId,
        preferenceRank: row.preferenceRank,
        careerGoal: row.careerGoal,
        applyReason: row.applyReason,
        wantedActivity: row.wantedActivity,
        status: row.status,
        rejectReason: row.rejectReason,
        decisionNote: row.decisionNote,
        decidedByUid: row.decidedByUid,
        selectionSource: row.selectionSource,
        decidedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    })
  })
  draftIds.forEach((draftId) => {
    allOps.push({ type: 'delete', ref: doc(db, DRAFTS, draftId) })
  })

  for (const ops of chunk(allOps, 400)) {
    const batch = writeBatch(db)
    ops.forEach((op) => {
      if (op.type === 'delete') {
        batch.delete(op.ref)
      } else {
        batch.set(op.ref, op.data, { merge: true })
      }
    })
    await batch.commit()
  }

  await updateDoc(doc(db, CYCLES, CYCLE_DOC_ID), {
    submissionFinalizedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  return { finalized: true, created: appRows.length, skipped }
}

export async function submitStudentPreferences(payload) {
  return saveStudentPreferenceDraft(payload)
}

const _cycleAppsCache = { data: null, cycleId: null, ts: 0 }
const CYCLE_APPS_TTL = 30_000 // 30초 캐시

export async function listCurrentCycleApplications({ forceRefresh = false } = {}) {
  const cycle = await getCurrentRecruitmentCycle()
  const now = Date.now()
  if (!forceRefresh && _cycleAppsCache.data && _cycleAppsCache.cycleId === cycle.id && now - _cycleAppsCache.ts < CYCLE_APPS_TTL) {
    return _cycleAppsCache.data
  }
  const rows = await getApplicationsByCycle(cycle.id)
  _cycleAppsCache.data = rows
  _cycleAppsCache.cycleId = cycle.id
  _cycleAppsCache.ts = now
  return rows
}

export function invalidateApplicationCache() {
  _cycleAppsCache.data = null
  _cycleAppsCache.ts = 0
}

export async function listCurrentCycleDrafts() {
  const cycle = await getCurrentRecruitmentCycle()
  return listDraftsByCycle(cycle.id)
}

export async function listStudentApplications(studentUid, options = {}) {
  const cycle = options?.cycle || await getCurrentRecruitmentCycle()
  const rows = await getApplicationsByStudent(studentUid)
  const filtered = options?.allCycles
    ? rows
    : rows.filter((item) => item.cycleId === cycle.id)

  // 신청 기간 중이면 아직 applications로 변환되지 않은 draft도 포함
  if (!options?.allCycles && filtered.length === 0) {
    const draft = await getStudentDraftByCycle(cycle.id, studentUid)
    if (draft?.preferences?.length) {
      const draftRows = draft.preferences.map((pref) => normalizeApplication(
        `draft__${draft.id}__${pref.preferenceRank}`,
        {
          cycleId: cycle.id,
          clubId: pref.clubId,
          studentUid,
          studentNo: draft.studentNo || '',
          studentName: draft.studentName || '',
          preferenceRank: pref.preferenceRank,
          careerGoal: pref.careerGoal || '',
          applyReason: pref.applyReason || '',
          wantedActivity: pref.wantedActivity || '',
          status: 'pending',
          selectionSource: 'draft',
        },
      ))
      const draftClubs = await Promise.all(draftRows.map((item) => getScheduleById(item.clubId)))
      return draftRows
        .map((item, index) => ({ ...item, club: draftClubs[index] }))
        .sort((a, b) => Number(a.preferenceRank || 0) - Number(b.preferenceRank || 0))
    }
  }

  const clubs = await Promise.all(filtered.map((item) => getScheduleById(item.clubId)))

  return filtered
    .map((item, index) => ({
      ...item,
      club: clubs[index],
    }))
    .sort((a, b) => {
      const leftRank = Number(a.preferenceRank || 0)
      const rightRank = Number(b.preferenceRank || 0)
      if (leftRank !== rightRank) return leftRank - rightRank
      return String(a.id).localeCompare(String(b.id), 'ko')
    })
}

export async function listApplicationsBySchedule(clubId, options = {}) {
  const cycle = options?.cycle || await getCurrentRecruitmentCycle()
  const rows = (await getApplicationsByClub(clubId)).filter((item) => item.cycleId === cycle.id)
  const profilesByUid = options?.profilesByUid

  // draft가 남아있으면 항상 포함 (신청 기간 중, finalize 대기 중, 또는 검증 실패로 잔류)
  if (cycle.status === 'open') {
    const drafts = await listDraftsByCycle(cycle.id)
    const existingStudents = new Set(rows.map((row) => row.studentUid))
    drafts.forEach((draft) => {
      if (existingStudents.has(draft.studentUid)) return
      draft.preferences.forEach((pref) => {
        if (pref.clubId !== clubId) return
        rows.push(normalizeApplication(
          `draft__${draft.id}__${pref.preferenceRank}`,
          {
            cycleId: cycle.id,
            studentUid: draft.studentUid,
            studentNo: draft.studentNo,
            studentName: draft.studentName,
            clubId: pref.clubId,
            preferenceRank: pref.preferenceRank,
            careerGoal: pref.careerGoal,
            applyReason: pref.applyReason,
            wantedActivity: pref.wantedActivity,
            status: pref.preferenceRank === 1 ? STATUS.PENDING : STATUS.WAITING,
            selectionSource: 'draft',
            createdAt: draft.submittedAt,
            updatedAt: draft.updatedAt,
          },
        ))
      })
    })
  }

  const cachedProfiles = rows.map((row) => readProfileFromCache(profilesByUid, row.studentUid))
  const missingIndexes = cachedProfiles
    .map((profile, index) => (profile ? -1 : index))
    .filter((index) => index >= 0)
  const missingIndexSet = new Set(missingIndexes)
  const loadedProfiles = missingIndexes.length > 0
    ? await Promise.all(missingIndexes.map((index) => getUserProfile(rows[index].studentUid)))
    : []
  const loadedProfileByIndex = new Map(
    missingIndexes.map((index, loadedIndex) => [index, loadedProfiles[loadedIndex] || null]),
  )

  const enriched = rows.map((row, index) => {
    const profile = cachedProfiles[index] || (missingIndexSet.has(index) ? loadedProfileByIndex.get(index) : null)
    return {
      ...row,
      studentName: profile?.name || row.studentName,
      studentNo: profile?.studentNo || row.studentNo,
    }
  })

  return enriched.sort((a, b) => {
    if (a.preferenceRank !== b.preferenceRank) {
      return a.preferenceRank - b.preferenceRank
    }
    return String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'ko')
  })
}

export async function getRoundStatsByClubIds(clubIds, options = {}) {
  const ids = Array.from(
    new Set(
      (Array.isArray(clubIds) ? clubIds : [])
        .map((item) => String(item || '').trim())
        .filter((item) => !!item),
    ),
  )

  const stats = Object.fromEntries(
    ids.map((clubId) => [
      clubId,
      {
        clubId,
        pendingCurrent: 0,
        total: 0,
        approved: 0,
        rejected: 0,
        cancelled: 0,
        pref1: 0,
        pref2: 0,
        pref3: 0,
      },
    ]),
  )

  if (ids.length === 0) {
    return stats
  }

  const cycle = options?.cycle || await getCurrentRecruitmentCycle()
  const currentRound = Number(cycle?.currentRound || 1)

  const rows = !isFirebaseEnabled()
    ? localApplications.filter((row) => row.cycleId === cycle.id)
    : (await getDocs(query(collection(db, APPLICATIONS), where('cycleId', '==', cycle.id))))
      .docs
      .map((item) => normalizeApplication(item.id, item.data()))

  // draft가 남아있으면 항상 통계에 포함 (검증 실패로 finalize되지 못한 draft 포함)
  const draftStudentClubs = new Set()
  if (cycle.status === 'open') {
    const drafts = await listDraftsByCycle(cycle.id)
    // 이미 application이 있는 학생은 제외
    const existingStudents = new Set(rows.map((row) => row.studentUid))
    drafts.forEach((draft) => {
      if (existingStudents.has(draft.studentUid)) return
      draft.preferences.forEach((pref) => {
        const target = stats[pref.clubId]
        if (!target) return
        draftStudentClubs.add(`${draft.studentUid}__${pref.clubId}`)
        target.total += 1
        const rank = Number(pref.preferenceRank)
        if (rank === 1) target.pref1 += 1
        else if (rank === 2) target.pref2 += 1
        else if (rank === 3) target.pref3 += 1
        if (rank === currentRound) {
          target.pendingCurrent += 1
        }
      })
    })
  }

  rows.forEach((row) => {
    const target = stats[row.clubId]
    if (!target) return

    target.total += 1
    const rank = Number(row.preferenceRank)
    if (rank === 1) target.pref1 += 1
    else if (rank === 2) target.pref2 += 1
    else if (rank === 3) target.pref3 += 1
    if (row.status === STATUS.PENDING && rank === currentRound) {
      target.pendingCurrent += 1
    }
    if (row.status === STATUS.APPROVED) target.approved += 1
    if (row.status === STATUS.REJECTED) target.rejected += 1
    if (row.status === STATUS.CANCELLED) target.cancelled += 1
  })

  return stats
}

async function approveApplicationInternal({ applicationId, actor, source = 'approval' }) {
  const user = assertActor(actor)
  const cycle = await ensureSelectionPhaseReady()
  assertOpenCycle(cycle)

  if (!isFirebaseEnabled()) {
    const app = localApplications.find((row) => row.id === applicationId)
    if (!app) {
      throw new Error('신청 정보를 찾을 수 없습니다.')
    }
    if (app.status !== STATUS.PENDING) {
      throw new Error('대기 상태 신청만 승인할 수 있습니다.')
    }
    if (app.preferenceRank !== cycle.currentRound) {
      throw new Error('현재 라운드 신청만 승인할 수 있습니다.')
    }

    const club = await getScheduleById(app.clubId)
    if (!club) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }
    if (!canManageSelection(club, user)) {
      throw new Error('승인 권한이 없습니다.')
    }

    const alreadyApproved = localApplications.some(
      (row) => row.cycleId === app.cycleId
        && row.studentUid === app.studentUid
        && row.status === STATUS.APPROVED,
    )
    if (alreadyApproved) {
      throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
    }

    const members = getLocalMembers(club.id)
    if (members.some((row) => row.studentUid === app.studentUid)) {
      throw new Error('이미 동아리 학생으로 확정된 계정입니다.')
    }

    if (club.memberCount >= club.maxMembers) {
      throw new Error('동아리 정원이 가득 찼습니다.')
    }

    const now = nowIso()
    localApplications = localApplications.map((row) => {
      if (row.id === app.id) {
        return {
          ...row,
          status: STATUS.APPROVED,
          rejectReason: '',
          decidedByUid: user.uid,
          selectionSource: source,
          decidedAt: now,
          updatedAt: now,
        }
      }
      if (
        row.cycleId === app.cycleId
        && row.studentUid === app.studentUid
        && (row.status === STATUS.PENDING || row.status === STATUS.WAITING)
      ) {
        return {
          ...row,
          status: STATUS.CANCELLED,
          rejectReason: REJECT_REASON.HIGHER_CHOICE,
          decidedByUid: user.uid,
          updatedAt: now,
        }
      }
      return row
    })

    members.push({
      id: app.studentUid,
      studentUid: app.studentUid,
      studentNo: app.studentNo,
      name: app.studentName,
      source,
      applicationId: app.id,
      addedByUid: user.uid,
      addedAt: now,
    })

    await updateScheduleMemberCount(club.id, club.memberCount + 1)
    return
  }

  const appRef = doc(db, APPLICATIONS, applicationId)
  const cycleRef = doc(db, CYCLES, CYCLE_DOC_ID)

  await runTransaction(db, async (tx) => {
    const appSnap = await tx.get(appRef)
    if (!appSnap.exists()) {
      throw new Error('신청 정보를 찾을 수 없습니다.')
    }

    const app = normalizeApplication(appSnap.id, appSnap.data())
    if (app.status !== STATUS.PENDING) {
      throw new Error('대기 상태 신청만 승인할 수 있습니다.')
    }

    const cycleSnap = await tx.get(cycleRef)
    const cycleData = cycleSnap.exists()
      ? normalizeCycle(cycleSnap.data())
      : { id: CYCLE_DOC_ID, currentRound: 1, status: 'open' }

    if (cycleData.status !== 'open') {
      throw new Error('현재 모집 사이클이 닫혀 있습니다.')
    }
    if (app.preferenceRank !== cycleData.currentRound) {
      throw new Error('현재 라운드 신청만 승인할 수 있습니다.')
    }

    const clubRef = doc(db, 'schedules', app.clubId)
    const clubSnap = await tx.get(clubRef)
    if (!clubSnap.exists()) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }

    const club = {
      id: clubSnap.id,
      ...clubSnap.data(),
    }

    if (!canManageSelection(club, user)) {
      throw new Error('승인 권한이 없습니다.')
    }

    const memberRef = doc(db, 'schedules', app.clubId, MEMBERS_SUBCOLLECTION, app.studentUid)
    const memberSnap = await tx.get(memberRef)
    if (memberSnap.exists()) {
      throw new Error('이미 동아리 학생으로 확정된 계정입니다.')
    }
    const assignmentRef = doc(db, ASSIGNMENTS, buildAssignmentDocId(app.cycleId, app.studentUid))
    const assignmentSnap = await tx.get(assignmentRef)
    const assignedClubId = String(assignmentSnap.data()?.clubId || '').trim()
    if (assignedClubId && assignedClubId !== app.clubId) {
      throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
    }

    // 트랜잭션 내부에서 학생의 모든 지원서를 조회하여 race condition 방지
    const byStudentSnap = await getDocs(
      query(collection(db, APPLICATIONS), where('studentUid', '==', app.studentUid)),
    )
    const byStudent = byStudentSnap.docs.map((d) => normalizeApplication(d.id, d.data()))

    const alreadyApproved = byStudent.some(
      (row) => row.id !== app.id && row.cycleId === app.cycleId && row.status === STATUS.APPROVED,
    )
    if (!assignmentSnap.exists() && alreadyApproved) {
      throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
    }

    const currentMemberCount = Number(club.memberCount || 0)
    const maxMembers = Number(club.maxMembers || 0)
    if (currentMemberCount >= maxMembers) {
      throw new Error('동아리 정원이 가득 찼습니다.')
    }

    tx.update(appRef, {
      status: STATUS.APPROVED,
      rejectReason: '',
      decidedByUid: user.uid,
      selectionSource: source,
      decidedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    tx.set(memberRef, {
      studentUid: app.studentUid,
      studentNo: app.studentNo,
      name: app.studentName,
      source,
      applicationId: app.id,
      addedByUid: user.uid,
      addedAt: serverTimestamp(),
    })
    tx.set(
      assignmentRef,
      {
        cycleId: app.cycleId,
        studentUid: app.studentUid,
        clubId: app.clubId,
        applicationId: app.id,
        assignedByUid: user.uid,
        source,
        ...(assignmentSnap.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )

    tx.update(clubRef, {
      memberCount: currentMemberCount + 1,
      updatedAt: serverTimestamp(),
    })

    byStudent
      .filter(
        (row) => row.id !== app.id
          && row.cycleId === app.cycleId
          && (row.status === STATUS.PENDING || row.status === STATUS.WAITING),
      )
      .forEach((row) => {
        tx.update(doc(db, APPLICATIONS, row.id), {
          status: STATUS.CANCELLED,
          rejectReason: REJECT_REASON.HIGHER_CHOICE,
          decidedByUid: user.uid,
          updatedAt: serverTimestamp(),
        })
      })
  })
}

export async function approveApplication(payload) {
  return approveApplicationInternal({
    applicationId: String(payload?.applicationId || ''),
    actor: payload?.actor,
    source: payload?.source || 'approval',
  })
}

export async function rejectApplication(payload) {
  const applicationId = String(payload?.applicationId || '')
  const reason = String(payload?.reason || REJECT_REASON.MANUAL)
  const user = assertActor(payload?.actor)
  const cycle = await ensureSelectionPhaseReady()
  assertOpenCycle(cycle)

  if (!applicationId) {
    throw new Error('신청 ID가 필요합니다.')
  }

  if (!isFirebaseEnabled()) {
    const app = localApplications.find((row) => row.id === applicationId)
    if (!app) {
      throw new Error('신청 정보를 찾을 수 없습니다.')
    }
    if (app.status !== STATUS.PENDING) {
      throw new Error('대기 상태 신청만 반려할 수 있습니다.')
    }

    const club = await getScheduleById(app.clubId)
    if (!club) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }
    if (!canManageSelection(club, user)) {
      throw new Error('반려 권한이 없습니다.')
    }

    localApplications = localApplications.map((row) => {
      if (row.id !== app.id) return row
      return {
        ...row,
        status: STATUS.REJECTED,
        rejectReason: reason,
        decidedByUid: user.uid,
        decidedAt: nowIso(),
        updatedAt: nowIso(),
      }
    })
    return
  }

  await runTransaction(db, async (tx) => {
    const appRef = doc(db, APPLICATIONS, applicationId)
    const appSnap = await tx.get(appRef)
    if (!appSnap.exists()) {
      throw new Error('신청 정보를 찾을 수 없습니다.')
    }

    const app = normalizeApplication(appSnap.id, appSnap.data())
    if (app.status !== STATUS.PENDING) {
      throw new Error('대기 상태 신청만 반려할 수 있습니다.')
    }

    const clubRef = doc(db, 'schedules', app.clubId)
    const clubSnap = await tx.get(clubRef)
    if (!clubSnap.exists()) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }

    if (!canManageSelection({ id: clubSnap.id, ...clubSnap.data() }, user)) {
      throw new Error('반려 권한이 없습니다.')
    }

    tx.update(appRef, {
      status: STATUS.REJECTED,
      rejectReason: reason,
      decidedByUid: user.uid,
      decidedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  })
}

export async function revokeApprovedApplication(payload) {
  const applicationId = String(payload?.applicationId || '')
  const user = assertActor(payload?.actor)
  if (!applicationId) {
    throw new Error('신청 ID가 필요합니다.')
  }

  const allowClosedCycle = payload?.allowClosedCycle === true
  const allowPreAssignment = payload?.allowPreAssignment === true
  const cycle = allowClosedCycle
    ? await getCurrentRecruitmentCycle()
    : await ensureSelectionPhaseReady({ allowPreAssignment })
  const skipPermissionCheck = payload?.skipPermissionCheck === true
  if (!allowClosedCycle) {
    assertOpenCycle(cycle)
  }
  const canReopen = cycle.status === 'open'

  if (!isFirebaseEnabled()) {
    const app = localApplications.find((row) => row.id === applicationId)
    if (!app) {
      throw new Error('신청 정보를 찾을 수 없습니다.')
    }
    if (app.status !== STATUS.APPROVED) {
      throw new Error('승인 상태 신청만 취소할 수 있습니다.')
    }

    const club = await getScheduleById(app.clubId)
    if (!club) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }
    if (!skipPermissionCheck && !canManageSelection(club, user)) {
      throw new Error('승인 취소 권한이 없습니다.')
    }

    const members = getLocalMembers(club.id)
    const studentApps = localApplications.filter((row) => row.studentUid === app.studentUid)
    const synthetic = isSyntheticAssignedApplication(app)
    const now = nowIso()

    localApplications = localApplications.flatMap((row) => {
      if (row.id === app.id) {
        if (synthetic) {
          return []
        }

        const reopenedStatus = canReopen ? getReopenedStatus(row.preferenceRank, cycle.currentRound) : ''
        if (reopenedStatus) {
          return [{
            ...row,
            status: reopenedStatus,
            rejectReason: '',
            decisionNote: '',
            decidedByUid: '',
            selectionSource: '',
            decidedAt: null,
            updatedAt: now,
          }]
        }

        return [{
          ...row,
          status: STATUS.CANCELLED,
          rejectReason: REJECT_REASON.APPROVAL_REVOKED,
          decisionNote: '',
          decidedByUid: user.uid,
          selectionSource: '',
          decidedAt: now,
          updatedAt: now,
        }]
      }

      if (
        row.studentUid === app.studentUid
        && row.cycleId === app.cycleId
        && row.status === STATUS.CANCELLED
        && row.rejectReason === REJECT_REASON.HIGHER_CHOICE
      ) {
        const reopenedStatus = canReopen ? getReopenedStatus(row.preferenceRank, cycle.currentRound) : ''
        if (reopenedStatus) {
          return [{
            ...row,
            status: reopenedStatus,
            rejectReason: '',
            decisionNote: '',
            decidedByUid: '',
            selectionSource: '',
            decidedAt: null,
            updatedAt: now,
          }]
        }
      }

      return [row]
    })

    localMembersByClub.set(
      club.id,
      members.filter((row) => row.studentUid !== app.studentUid),
    )

    await updateScheduleMemberCount(club.id, Math.max(0, Number(club.memberCount || 0) - 1))
    return {
      applicationId,
      removedStudentUid: app.studentUid,
      restoredCount: studentApps.filter(
        (row) => row.cycleId === app.cycleId
          && row.status === STATUS.CANCELLED
          && row.rejectReason === REJECT_REASON.HIGHER_CHOICE
          && !!getReopenedStatus(row.preferenceRank, cycle.currentRound),
      ).length,
    }
  }

  const appRef = doc(db, APPLICATIONS, applicationId)
  const cycleRef = doc(db, CYCLES, CYCLE_DOC_ID)

  let removedStudentUid = ''

  await runTransaction(db, async (tx) => {
    const cycleSnap = await tx.get(cycleRef)
    const cycleData = cycleSnap.exists()
      ? normalizeCycle(cycleSnap.data())
      : { id: CYCLE_DOC_ID, currentRound: 1, status: 'open' }
    if (!allowClosedCycle && cycleData.status !== 'open') {
      throw new Error('현재 모집 사이클이 닫혀 있습니다.')
    }

    const appSnap = await tx.get(appRef)
    if (!appSnap.exists()) {
      throw new Error('신청 정보를 찾을 수 없습니다.')
    }

    const app = normalizeApplication(appSnap.id, appSnap.data())
    if (app.status !== STATUS.APPROVED) {
      throw new Error('승인 상태 신청만 취소할 수 있습니다.')
    }
    removedStudentUid = app.studentUid

    const clubRef = doc(db, 'schedules', app.clubId)
    const clubSnap = await tx.get(clubRef)
    if (!clubSnap.exists()) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }

    const club = {
      id: clubSnap.id,
      ...clubSnap.data(),
    }
    if (!skipPermissionCheck && !canManageSelection(club, user)) {
      throw new Error('승인 취소 권한이 없습니다.')
    }

    const memberRef = doc(db, 'schedules', app.clubId, MEMBERS_SUBCOLLECTION, app.studentUid)
    const assignmentRef = doc(db, ASSIGNMENTS, buildAssignmentDocId(app.cycleId, app.studentUid))
    const synthetic = isSyntheticAssignedApplication(app)
    const currentMemberCount = Number(club.memberCount || 0)

    tx.delete(memberRef)
    tx.delete(assignmentRef)
    tx.update(clubRef, {
      memberCount: Math.max(0, currentMemberCount - 1),
      updatedAt: serverTimestamp(),
    })

    if (synthetic) {
      tx.delete(appRef)
    } else {
      const reopenedStatus = cycleData.status === 'open'
        ? getReopenedStatus(app.preferenceRank, cycleData.currentRound)
        : ''
      if (reopenedStatus) {
        tx.update(appRef, {
          status: reopenedStatus,
          rejectReason: '',
          decisionNote: '',
          decidedByUid: '',
          selectionSource: '',
          decidedAt: null,
          updatedAt: serverTimestamp(),
        })
      } else {
        tx.update(appRef, {
          status: STATUS.CANCELLED,
          rejectReason: REJECT_REASON.APPROVAL_REVOKED,
          decisionNote: '',
          decidedByUid: user.uid,
          selectionSource: '',
          decidedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      }
    }

    // 트랜잭션 내부에서 학생의 지원서를 조회하여 데이터 일관성 보장
    const studentAppsSnap = await getDocs(
      query(collection(db, APPLICATIONS), where('studentUid', '==', app.studentUid)),
    )
    const studentApps = studentAppsSnap.docs.map((d) => normalizeApplication(d.id, d.data()))

    studentApps
      .filter(
        (row) => row.id !== app.id
          && row.cycleId === app.cycleId
          && row.status === STATUS.CANCELLED
          && row.rejectReason === REJECT_REASON.HIGHER_CHOICE,
      )
      .forEach((row) => {
        const reopenedStatus = cycleData.status === 'open'
          ? getReopenedStatus(row.preferenceRank, cycleData.currentRound)
          : ''
        if (!reopenedStatus) return
        tx.update(doc(db, APPLICATIONS, row.id), {
          status: reopenedStatus,
          rejectReason: '',
          decisionNote: '',
          decidedByUid: '',
          selectionSource: '',
          decidedAt: null,
          updatedAt: serverTimestamp(),
        })
      })
  })

  return {
    applicationId,
    removedStudentUid,
  }
}

export async function randomSelectPending(payload) {
  const clubId = String(payload?.clubId || '')
  const user = assertActor(payload?.actor)
  if (!clubId) {
    throw new Error('동아리 ID가 필요합니다.')
  }

  const cycle = await ensureSelectionPhaseReady()
  assertOpenCycle(cycle)

  const club = await getScheduleById(clubId)
  if (!club) {
    throw new Error('동아리 정보를 찾을 수 없습니다.')
  }
  if (!canManageSelection(club, user)) {
    throw new Error('무작위 선발 권한이 없습니다.')
  }
  if (club.randomDrawnRounds.includes(cycle.currentRound)) {
    throw new Error(`${cycle.currentRound}라운드 무작위 선발은 이미 실행되었습니다.`)
  }

  const rows = (await getApplicationsByClub(clubId)).filter(
    (row) => row.cycleId === cycle.id
      && row.preferenceRank === cycle.currentRound
      && row.status === STATUS.PENDING,
  )

  if (rows.length === 0) {
    throw new Error('현재 라운드 대기 신청자가 없습니다.')
  }

  const shuffled = shuffle(rows)
  let selectedCount = 0
  let rejectedCount = 0

  for (const row of shuffled) {
    // 매 승인마다 최신 클럽 정보를 다시 읽어 정원 초과 방지
    const freshClub = await getScheduleById(clubId)
    const seats = Math.max(0, Number(freshClub.maxMembers || 0) - Number(freshClub.memberCount || 0))
    if (seats > 0) {
      try {
        await approveApplicationInternal({
          applicationId: row.id,
          actor: user,
          source: 'random',
        })
        selectedCount++
      } catch {
        // 이미 다른 동아리에 배정된 학생 등 승인 실패 시 반려 처리
        await rejectApplication({
          applicationId: row.id,
          actor: user,
          reason: REJECT_REASON.RANDOM_UNSELECTED,
        })
        rejectedCount++
      }
    } else {
      await rejectApplication({
        applicationId: row.id,
        actor: user,
        reason: REJECT_REASON.RANDOM_UNSELECTED,
      })
      rejectedCount++
    }
  }

  await updateSchedule(
    club.id,
    {
      randomDrawnRounds: Array.from(new Set([...club.randomDrawnRounds, cycle.currentRound])).sort((a, b) => a - b),
    },
    { actor: user },
  )

  return {
    selected: selectedCount,
    rejected: rejectedCount,
  }
}

export async function advanceRecruitmentRound(payload) {
  const user = assertActor(payload?.actor)
  if (user.role !== 'admin') {
    throw new Error('라운드 전환은 관리자만 가능합니다.')
  }

  const cycle = await ensureSelectionPhaseReady()
  assertOpenCycle(cycle)

  const allApps = await getApplicationsByCycle(cycle.id)
  const currentPending = allApps.filter(
    (row) => row.preferenceRank === cycle.currentRound
      && row.status === STATUS.PENDING,
  )

  if (currentPending.length > 0) {
    throw new Error(`현재 라운드 대기 신청 ${currentPending.length}건을 먼저 처리해주세요.`)
  }

  const cycleRef = isFirebaseEnabled() ? doc(db, CYCLES, CYCLE_DOC_ID) : null

  if (cycle.currentRound >= 3) {
    const remainings = allApps.filter(
      (row) => row.cycleId === cycle.id
        && (row.status === STATUS.PENDING || row.status === STATUS.WAITING),
    )

    const patches = remainings.map((row) => ({
      id: row.id,
      status: STATUS.REJECTED,
      rejectReason: REJECT_REASON.FINAL_CLOSED,
      decidedByUid: user.uid,
      decidedAt: isFirebaseEnabled() ? serverTimestamp() : nowIso(),
    }))

    await updateApplicationsStatusBulk(patches)

    if (!isFirebaseEnabled()) {
      localCycle = {
        ...localCycle,
        status: 'closed',
        updatedAt: nowIso(),
      }
      setCycleCache(localCycle)
    } else {
      await updateDoc(cycleRef, {
        status: 'closed',
        updatedAt: serverTimestamp(),
      })
      setCycleCache({
        ...cycle,
        status: 'closed',
      })
    }

    return {
      ...cycle,
      status: 'closed',
    }
  }

  const nextRound = cycle.currentRound + 1

  const approvedStudents = new Set(
    allApps
      .filter((row) => row.cycleId === cycle.id && row.status === STATUS.APPROVED)
      .map((row) => row.studentUid),
  )

  const targetApps = allApps.filter(
    (row) => row.cycleId === cycle.id
      && row.preferenceRank === nextRound
      && row.status === STATUS.WAITING,
  )

  const patches = []
  for (const row of targetApps) {
    if (approvedStudents.has(row.studentUid)) {
      patches.push({
        id: row.id,
        status: STATUS.CANCELLED,
        rejectReason: REJECT_REASON.HIGHER_CHOICE,
        decidedByUid: user.uid,
      })
      continue
    }

    const club = await getScheduleById(row.clubId)
    if (!club || club.legacy || club.isInterviewSelection || !club.leaderUid || !isStudentEligibleForClub(club, row.studentNo)) {
      patches.push({
        id: row.id,
        status: STATUS.REJECTED,
        rejectReason: REJECT_REASON.ROUND_INELIGIBLE,
        decidedByUid: user.uid,
      })
      continue
    }

    // 정원이 이미 찬 동아리의 대기 신청은 자동 반려
    const currentMemberCount = Number(club.memberCount || 0)
    const maxMembers = Number(club.maxMembers || 0)
    if (maxMembers > 0 && currentMemberCount >= maxMembers) {
      patches.push({
        id: row.id,
        status: STATUS.REJECTED,
        rejectReason: REJECT_REASON.ROUND_INELIGIBLE,
        decidedByUid: user.uid,
      })
      continue
    }

    patches.push({
      id: row.id,
      status: STATUS.PENDING,
      rejectReason: '',
      decidedByUid: '',
    })
  }

  await updateApplicationsStatusBulk(patches)

  if (!isFirebaseEnabled()) {
    localCycle = {
      ...localCycle,
      currentRound: nextRound,
      updatedAt: nowIso(),
    }
    setCycleCache(localCycle)
  } else {
    await updateDoc(cycleRef, {
      currentRound: nextRound,
      updatedAt: serverTimestamp(),
    })
    setCycleCache({
      ...cycle,
      currentRound: nextRound,
    })
  }

  return {
    ...cycle,
    currentRound: nextRound,
  }
}

export async function listClubMembers(clubId) {
  const targetId = String(clubId || '').trim()
  if (!targetId) return []

  if (!isFirebaseEnabled()) {
    return [...getLocalMembers(targetId)]
  }

  const snapshot = await getDocs(collection(db, 'schedules', targetId, MEMBERS_SUBCOLLECTION))
  return snapshot.docs.map((item) => normalizeMember(item.id, item.data()))
}

async function directAssignMemberInternal(payload, options = {}) {
  const clubId = String(payload?.clubId || '').trim()
  const studentUid = String(payload?.studentUid || '').trim()
  const user = assertActor(payload?.actor)
  const source = String(options?.source || payload?.source || 'manual_assign').trim() || 'manual_assign'
  const requireInterview = options?.requireInterview === true
  const requireLeader = options?.requireLeader === true
  const requireSelectionReady = options?.requireSelectionReady !== false
  const allowPreAssignment = options?.allowPreAssignment === true
  const requireOpenCycle = options?.requireOpenCycle !== false
  const skipPermissionCheck = options?.skipPermissionCheck === true
  const ignoreStudentEligibility = options?.ignoreStudentEligibility === true
  const overrideApproved = options?.overrideApproved === true
  const overrideRejectReason = String(options?.overrideRejectReason || REJECT_REASON.HIGHER_CHOICE)
  const decisionNote = String(options?.decisionNote ?? payload?.decisionNote ?? '').trim()

  if (!clubId || !studentUid) {
    throw new Error('동아리와 학생을 선택해주세요.')
  }

  const cycle = requireSelectionReady
    ? await ensureSelectionPhaseReady({ allowPreAssignment })
    : await getCurrentRecruitmentCycle()
  if (requireOpenCycle) {
    assertOpenCycle(cycle)
  }

  const club = await getScheduleById(clubId)
  if (!club || club.legacy) {
    throw new Error('동아리 정보를 찾을 수 없습니다.')
  }
  if (requireInterview && !club.isInterviewSelection) {
    throw new Error('자체면접 동아리에서만 직접 선발이 가능합니다.')
  }
  if (requireLeader && !club.leaderUid) {
    throw new Error('동아리장이 지정되지 않은 동아리는 직접 선발할 수 없습니다.')
  }
  if (!skipPermissionCheck && !canManageSelection(club, user)) {
    throw new Error('직접 선발 권한이 없습니다.')
  }

  const student = await getUserProfile(studentUid)
  if (!student || student.role !== 'student') {
    throw new Error('학생 계정을 찾을 수 없습니다.')
  }
  if (!ignoreStudentEligibility && (!student.studentNo || !isStudentEligibleForClub(club, student.studentNo))) {
    throw new Error('대상학년이 아닌 학생은 선발할 수 없습니다.')
  }

  const studentApps = await getApplicationsByStudent(studentUid)
  const approvedApps = studentApps.filter(
    (row) => row.cycleId === cycle.id && row.status === STATUS.APPROVED,
  )
  const approvedElsewhere = approvedApps.filter((row) => row.clubId !== club.id)
  if (approvedElsewhere.length > 0 && !overrideApproved) {
    throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
  }

  const existingMembers = await listClubMembers(club.id)
  const memberExists = existingMembers.some((row) => row.studentUid === studentUid)
  if (!memberExists && club.memberCount >= club.maxMembers) {
    throw new Error('동아리 정원이 가득 찼습니다.')
  }

  if (!isFirebaseEnabled()) {
    const now = nowIso()
    const members = getLocalMembers(club.id)
    const targetApp = pickDirectAssignApplication(studentApps, cycle.id, club.id)
    let applicationId = targetApp?.id || ''
    const releasedClubIds = new Set()

    for (const approved of approvedElsewhere) {
      if (releasedClubIds.has(approved.clubId)) continue
      const otherMembers = getLocalMembers(approved.clubId)
      const hadMember = otherMembers.some((row) => row.studentUid === student.uid)
      localMembersByClub.set(
        approved.clubId,
        otherMembers.filter((row) => row.studentUid !== student.uid),
      )
      if (hadMember) {
        const approvedClub = await getScheduleById(approved.clubId)
        if (approvedClub) {
          await updateScheduleMemberCount(approved.clubId, Math.max(0, Number(approvedClub.memberCount || 0) - 1))
        }
        releasedClubIds.add(approved.clubId)
      }
    }

    localApplications = localApplications.flatMap((row) => {
      if (targetApp && row.id === targetApp.id) {
        return [{
          ...row,
          studentNo: student.studentNo,
          studentName: student.name,
          status: STATUS.APPROVED,
          rejectReason: '',
          decisionNote,
          decidedByUid: user.uid,
          selectionSource: source,
          decidedAt: now,
          updatedAt: now,
        }]
      }
      if (approvedElsewhere.some((item) => item.id === row.id)) {
        if (isSyntheticAssignedApplication(row)) {
          return []
        }
        return [{
          ...row,
          status: STATUS.CANCELLED,
          rejectReason: overrideRejectReason,
          decisionNote: '',
          decidedByUid: user.uid,
          selectionSource: '',
          decidedAt: now,
          updatedAt: now,
        }]
      }
      if (
        row.cycleId === cycle.id
        && row.studentUid === studentUid
        && row.id !== targetApp?.id
        && (row.status === STATUS.PENDING || row.status === STATUS.WAITING)
      ) {
        return [{
          ...row,
          status: STATUS.CANCELLED,
          rejectReason: REJECT_REASON.HIGHER_CHOICE,
          decisionNote: '',
          decidedByUid: user.uid,
          selectionSource: '',
          decidedAt: now,
          updatedAt: now,
        }]
      }
      return [row]
    })

    if (!targetApp) {
      const created = await createApprovedDirectApplication({
        cycle,
        club,
        student,
        actor: user,
        source,
        decisionNote,
      })
      applicationId = created.id
    }

    if (!memberExists) {
      members.push({
        id: student.uid,
        studentUid: student.uid,
        studentNo: student.studentNo,
        name: student.name,
        source,
        applicationId,
        addedByUid: user.uid,
        addedAt: now,
      })
    }

    if (!memberExists) {
      await updateScheduleMemberCount(club.id, club.memberCount + 1)
    }
    return { applicationId }
  }

  let applicationId = ''

  await runTransaction(db, async (tx) => {
    const clubRef = doc(db, 'schedules', club.id)
    const clubSnap = await tx.get(clubRef)
    if (!clubSnap.exists()) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }

    const clubLive = { id: clubSnap.id, ...clubSnap.data() }
    if (!skipPermissionCheck && !canManageSelection(clubLive, user)) {
      throw new Error('직접 선발 권한이 없습니다.')
    }

    const memberRef = doc(db, 'schedules', club.id, MEMBERS_SUBCOLLECTION, student.uid)
    const memberSnap = await tx.get(memberRef)
    const targetMemberExists = memberSnap.exists()

    const count = Number(clubLive.memberCount || 0)
    const max = Number(clubLive.maxMembers || 0)
    if (!targetMemberExists && count >= max) {
      throw new Error('동아리 정원이 가득 찼습니다.')
    }
    const assignmentRef = doc(db, ASSIGNMENTS, buildAssignmentDocId(cycle.id, student.uid))
    const assignmentSnap = await tx.get(assignmentRef)
    const assignedClubId = String(assignmentSnap.data()?.clubId || '').trim()
    if (assignedClubId && assignedClubId !== club.id && !overrideApproved) {
      throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
    }

    // 트랜잭션 내부에서 학생의 지원서를 다시 조회하여 일관성 보장
    const freshStudentAppsSnap = await getDocs(
      query(collection(db, APPLICATIONS), where('studentUid', '==', student.uid)),
    )
    const freshStudentApps = freshStudentAppsSnap.docs.map((d) => normalizeApplication(d.id, d.data()))
    const freshApprovedElsewhere = freshStudentApps.filter(
      (row) => row.cycleId === cycle.id && row.status === STATUS.APPROVED && row.clubId !== club.id,
    )

    if (!assignmentSnap.exists() && freshApprovedElsewhere.length > 0 && !overrideApproved) {
      throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
    }

    const otherClubRefs = new Map()
    const otherClubSnaps = new Map()
    const otherMemberSnaps = new Map()
    for (const approved of freshApprovedElsewhere) {
      if (!otherClubRefs.has(approved.clubId)) {
        const previousClubRef = doc(db, 'schedules', approved.clubId)
        otherClubRefs.set(approved.clubId, previousClubRef)
        otherClubSnaps.set(approved.clubId, await tx.get(previousClubRef))
        otherMemberSnaps.set(
          approved.clubId,
          await tx.get(doc(db, 'schedules', approved.clubId, MEMBERS_SUBCOLLECTION, student.uid)),
        )
      }
    }

    const targetApp = pickDirectAssignApplication(freshStudentApps, cycle.id, club.id)
    const assignedAppRef = targetApp
      ? doc(db, APPLICATIONS, targetApp.id)
      : doc(collection(db, APPLICATIONS))

    if (targetApp) {
      tx.update(assignedAppRef, {
        studentNo: student.studentNo,
        studentName: student.name,
        status: STATUS.APPROVED,
        rejectReason: '',
        decisionNote,
        decidedByUid: user.uid,
        selectionSource: source,
        decidedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    } else {
      tx.set(assignedAppRef, {
        cycleId: cycle.id,
        studentUid: student.uid,
        studentNo: student.studentNo,
        studentName: student.name,
        clubId: club.id,
        preferenceRank: 1,
        careerGoal: '',
        applyReason: '',
        wantedActivity: '',
        status: STATUS.APPROVED,
        rejectReason: '',
        decisionNote,
        decidedByUid: user.uid,
        selectionSource: source,
        decidedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }

    if (!targetMemberExists) {
      tx.set(memberRef, {
        studentUid: student.uid,
        studentNo: student.studentNo,
        name: student.name,
        source,
        applicationId: assignedAppRef.id,
        addedByUid: user.uid,
        addedAt: serverTimestamp(),
      })
    }
    tx.set(
      assignmentRef,
      {
        cycleId: cycle.id,
        studentUid: student.uid,
        clubId: club.id,
        applicationId: assignedAppRef.id,
        assignedByUid: user.uid,
        source,
        decisionNote,
        ...(assignmentSnap.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )

    if (!targetMemberExists) {
      tx.update(clubRef, {
        memberCount: count + 1,
        updatedAt: serverTimestamp(),
      })
    }

    freshApprovedElsewhere.forEach((row) => {
      const approvedRef = doc(db, APPLICATIONS, row.id)
      if (isSyntheticAssignedApplication(row)) {
        tx.delete(approvedRef)
      } else {
        tx.update(approvedRef, {
          status: STATUS.CANCELLED,
          rejectReason: overrideRejectReason,
          decisionNote: '',
          decidedByUid: user.uid,
          selectionSource: '',
          decidedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      }
      tx.delete(doc(db, 'schedules', row.clubId, MEMBERS_SUBCOLLECTION, student.uid))
    })

    for (const [previousClubId, previousClubRef] of otherClubRefs.entries()) {
      const previousMemberSnap = otherMemberSnaps.get(previousClubId)
      if (!previousMemberSnap?.exists()) continue
      const previousClubSnap = otherClubSnaps.get(previousClubId)
      if (!previousClubSnap.exists()) continue
      const previousCount = Number(previousClubSnap.data()?.memberCount || 0)
      tx.update(previousClubRef, {
        memberCount: Math.max(0, previousCount - 1),
        updatedAt: serverTimestamp(),
      })
    }

    freshStudentApps
      .filter(
        (row) => row.id !== assignedAppRef.id
          && row.cycleId === cycle.id
          && (row.status === STATUS.PENDING || row.status === STATUS.WAITING),
      )
      .forEach((row) => {
        tx.update(doc(db, APPLICATIONS, row.id), {
          status: STATUS.CANCELLED,
          rejectReason: REJECT_REASON.HIGHER_CHOICE,
          decisionNote: '',
          decidedByUid: user.uid,
          updatedAt: serverTimestamp(),
        })
      })

    applicationId = assignedAppRef.id
  })

  return { applicationId }
}

export async function directAssignStudentToClub(payload) {
  return directAssignMemberInternal(payload, {
    source: 'manual_assign',
    requireInterview: false,
    requireLeader: false,
    allowPreAssignment: true,
  })
}

export async function adminForceAssignStudentToClub(payload) {
  const actor = assertActor(payload?.actor)
  if (actor.role !== 'admin') {
    throw new Error('강제 배정은 관리자만 가능합니다.')
  }

  const reason = String(payload?.reason || '').trim()
  if (!reason) {
    throw new Error('강제 배정 사유를 입력해주세요.')
  }

  return directAssignMemberInternal(payload, {
    source: ADMIN_FORCE_SOURCE,
    requireInterview: false,
    requireLeader: false,
    overrideApproved: true,
    overrideRejectReason: REJECT_REASON.ADMIN_FORCE_ASSIGNED,
    decisionNote: reason,
  })
}

export async function directSelectInterviewMember(payload) {
  return directAssignMemberInternal(payload, {
    source: 'interview_manual',
    requireInterview: true,
    requireLeader: true,
    allowPreAssignment: true,
  })
}

async function ensureApprovedMemberRecord({ club, app, student, actor }) {
  const source = String(app?.selectionSource || LEADER_AUTO_SOURCE).trim() || LEADER_AUTO_SOURCE
  const addedByUid = String(app?.decidedByUid || actor?.uid || buildSystemActor(club).uid).trim()
    || buildSystemActor(club).uid

  if (!isFirebaseEnabled()) {
    const members = getLocalMembers(club.id)
    const exists = members.some((row) => row.studentUid === student.uid)
    if (!exists) {
      members.push({
        id: student.uid,
        studentUid: student.uid,
        studentNo: student.studentNo,
        name: student.name,
        source,
        applicationId: app.id,
        addedByUid,
        addedAt: nowIso(),
      })
      await updateScheduleMemberCount(club.id, Number(club.memberCount || 0) + 1)
      return { changed: true }
    }
    return { changed: false }
  }

  const clubRef = doc(db, 'schedules', club.id)
  const memberRef = doc(db, 'schedules', club.id, MEMBERS_SUBCOLLECTION, student.uid)
  const assignmentRef = doc(db, ASSIGNMENTS, buildAssignmentDocId(app.cycleId, student.uid))
  let changed = false

  await runTransaction(db, async (tx) => {
    const clubSnap = await tx.get(clubRef)
    if (!clubSnap.exists()) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }

    const memberSnap = await tx.get(memberRef)
    const assignmentSnap = await tx.get(assignmentRef)

    if (!memberSnap.exists()) {
      const count = Number(clubSnap.data()?.memberCount || 0)
      tx.set(memberRef, {
        studentUid: student.uid,
        studentNo: student.studentNo,
        name: student.name,
        source,
        applicationId: app.id,
        addedByUid,
        addedAt: serverTimestamp(),
      })
      tx.update(clubRef, {
        memberCount: count + 1,
        updatedAt: serverTimestamp(),
      })
      changed = true
    }

    tx.set(
      assignmentRef,
      {
        cycleId: app.cycleId,
        studentUid: student.uid,
        clubId: club.id,
        applicationId: app.id,
        assignedByUid: addedByUid,
        source,
        ...(assignmentSnap.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
  })

  return { changed }
}

export async function syncLeaderAssignmentForClub(clubInput) {
  const clubId = String(clubInput?.id || '').trim()
  if (!clubId) {
    throw new Error('동아리 ID가 필요합니다.')
  }

  const club = await getScheduleById(clubId)
  if (!club || club.legacy) {
    return { changed: false }
  }

  const cycle = await getCurrentRecruitmentCycle()
  const actor = buildSystemActor(club)
  let changed = false

  const clubApps = (await getApplicationsByClub(club.id)).filter((row) => row.cycleId === cycle.id)
  const staleLeaderApps = clubApps.filter(
    (row) => row.selectionSource === LEADER_AUTO_SOURCE
      && row.status === STATUS.APPROVED
      && row.studentUid !== String(club.leaderUid || '').trim(),
  )

  for (const row of staleLeaderApps) {
    await revokeApprovedApplication({
      applicationId: row.id,
      actor,
      allowClosedCycle: true,
      skipPermissionCheck: true,
    })
    changed = true
  }

  const leaderUid = String(club.leaderUid || '').trim()
  if (!leaderUid) {
    return { changed }
  }

  const student = await getUserProfile(leaderUid)
  if (!student || student.role !== 'student') {
    return { changed }
  }

  const studentApps = await getApplicationsByStudent(leaderUid)
  const approvedSameClub = studentApps.find(
    (row) => row.cycleId === cycle.id && row.clubId === club.id && row.status === STATUS.APPROVED,
  )
  const approvedElsewhere = studentApps.filter(
    (row) => row.cycleId === cycle.id && row.clubId !== club.id && row.status === STATUS.APPROVED,
  )

  if (approvedSameClub && approvedElsewhere.length === 0) {
    const repaired = await ensureApprovedMemberRecord({
      club,
      app: approvedSameClub,
      student,
      actor,
    })
    return { changed: changed || repaired.changed }
  }

  await directAssignMemberInternal(
    {
      clubId: club.id,
      studentUid: leaderUid,
      actor,
    },
    {
      source: LEADER_AUTO_SOURCE,
      requireInterview: false,
      requireLeader: false,
      requireSelectionReady: false,
      requireOpenCycle: false,
      skipPermissionCheck: true,
      ignoreStudentEligibility: true,
      overrideApproved: true,
      overrideRejectReason: REJECT_REASON.LEADER_ASSIGNED,
    },
  )

  return { changed: true }
}

export async function syncLeaderAssignmentsForClubs(clubs, options = {}) {
  const rows = Array.isArray(clubs) ? clubs : []
  const continueOnError = options?.continueOnError === true
  let changed = 0

  for (const club of rows) {
    try {
      const result = await syncLeaderAssignmentForClub(club)
      if (result?.changed) changed += 1
    } catch (error) {
      if (!continueOnError) throw error
    }
  }

  return { changed }
}

export async function purgeLegacyRecruitmentData(payload) {
  const user = assertActor(payload?.actor)
  if (user.role !== 'admin') {
    throw new Error('초기화는 관리자만 가능합니다.')
  }

  const clubs = await listSchedules({ includeLegacy: true })
  for (const club of clubs) {
    try {
      await deleteSchedule(club.id, { actor: user })
    } catch {
      // noop
    }
  }

  if (!isFirebaseEnabled()) {
    localApplications = []
    localDrafts.clear()
    localCycle = {
      id: CYCLE_DOC_ID,
      currentRound: 1,
      status: 'open',
      preAssignmentStartAt: null,
      preAssignmentEndAt: null,
      submissionStartAt: null,
      submissionEndAt: null,
      submissionFinalizedAt: null,
      updatedAt: nowIso(),
    }
    setCycleCache(localCycle)
    localMembersByClub.clear()
    return
  }

  const appsSnapshot = await getDocs(collection(db, APPLICATIONS))
  for (const rows of chunk(appsSnapshot.docs, 400)) {
    const batch = writeBatch(db)
    rows.forEach((row) => batch.delete(row.ref))
    await batch.commit()
  }

  const assignmentsSnapshot = await getDocs(collection(db, ASSIGNMENTS))
  for (const rows of chunk(assignmentsSnapshot.docs, 400)) {
    const batch = writeBatch(db)
    rows.forEach((row) => batch.delete(row.ref))
    await batch.commit()
  }

  const draftsSnapshot = await getDocs(collection(db, DRAFTS))
  for (const rows of chunk(draftsSnapshot.docs, 400)) {
    const batch = writeBatch(db)
    rows.forEach((row) => batch.delete(row.ref))
    await batch.commit()
  }

  await setDoc(doc(db, CYCLES, CYCLE_DOC_ID), {
    currentRound: 1,
    status: 'open',
    preAssignmentStartAt: null,
    preAssignmentEndAt: null,
    submissionStartAt: null,
    submissionEndAt: null,
    submissionFinalizedAt: null,
    updatedAt: serverTimestamp(),
  })
  setCycleCache({
    id: CYCLE_DOC_ID,
    currentRound: 1,
    status: 'open',
    updatedAt: null,
  })
}

// Backward-compatible wrapper (legacy UI compatibility)
export async function listAppliedSchedulesByTeacher(uid) {
  const rows = await listStudentApplications(uid)
  return rows
    .filter((row) => !!row.club)
    .map((row) => ({ ...row, schedule: row.club }))
}

// Legacy single apply API is no longer used after 1~3 지망 전환.
export async function applyToSchedule() {
  throw new Error('개별 신청 방식은 종료되었습니다. 학생은 1~3지망을 한 번에 제출해주세요.')
}

// Legacy single cancel API is no longer used after 1~3 지망 전환.
export async function cancelApplication() {
  throw new Error('개별 취소 방식은 종료되었습니다. 재신청 정책은 비활성화되어 있습니다.')
}
