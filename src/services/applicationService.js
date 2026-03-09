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
  getScheduleById,
  listSchedules,
  updateSchedule,
  updateScheduleMemberCount,
} from './scheduleService'
import { getUserProfile } from './userService'

const APPLICATIONS = 'applications'
const CYCLES = 'recruitmentCycles'
const CYCLE_DOC_ID = 'current'
const MEMBERS_SUBCOLLECTION = 'members'

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
}

let localApplications = []
let localCycle = {
  id: CYCLE_DOC_ID,
  currentRound: 1,
  status: 'open',
  updatedAt: new Date().toISOString(),
}
const localMembersByClub = new Map()

function nowIso() {
  return new Date().toISOString()
}

function toRound(value, fallback = 1) {
  const parsed = Number(value)
  if (parsed === 1 || parsed === 2 || parsed === 3) return parsed
  return fallback
}

function normalizeCycle(data) {
  return {
    id: CYCLE_DOC_ID,
    currentRound: toRound(data?.currentRound, 1),
    status: data?.status === 'closed' ? 'closed' : 'open',
    updatedAt: data?.updatedAt || null,
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

export async function getCurrentRecruitmentCycle() {
  if (!isFirebaseEnabled()) {
    return { ...localCycle }
  }

  const ref = doc(db, CYCLES, CYCLE_DOC_ID)
  const snapshot = await getDoc(ref)
  if (!snapshot.exists()) {
    await setDoc(ref, {
      currentRound: 1,
      status: 'open',
      updatedAt: serverTimestamp(),
    })
    return {
      id: CYCLE_DOC_ID,
      currentRound: 1,
      status: 'open',
      updatedAt: null,
    }
  }

  return normalizeCycle(snapshot.data())
}

export async function submitStudentPreferences(payload) {
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

  const grade = inferGradeFromStudentNo(studentNo)
  if (!grade) {
    throw new Error('학번 첫 자리로 학년을 추정할 수 없습니다. 학번을 확인해주세요.')
  }

  if (preferences.length < 1 || preferences.length > 3) {
    throw new Error('동아리 지망은 1~3개까지 제출할 수 있습니다.')
  }

  const cycle = await getCurrentRecruitmentCycle()
  assertOpenCycle(cycle)

  const submittedRows = await getApplicationsByStudent(studentUid)
  const alreadySubmitted = submittedRows.some((row) => row.cycleId === cycle.id)
  if (alreadySubmitted) {
    throw new Error('이미 동아리 지망을 제출했습니다. 재신청은 불가합니다.')
  }

  const uniqueClubIds = new Set()
  const normalizedPreferences = []

  for (let i = 0; i < preferences.length; i += 1) {
    const row = preferences[i]
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
    if (!club.leaderUid) {
      throw new Error(`${club.clubName} 동아리는 동아리장이 지정되지 않아 현재 신청할 수 없습니다.`)
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
    normalizedPreferences.push({
      clubId,
      careerGoal,
      applyReason,
      wantedActivity,
      preferenceRank: i + 1,
    })
  }

  const rows = normalizedPreferences.map((item) => ({
    cycleId: cycle.id,
    studentUid,
    studentNo,
    studentName,
    clubId: item.clubId,
    preferenceRank: item.preferenceRank,
    careerGoal: item.careerGoal,
    applyReason: item.applyReason,
    wantedActivity: item.wantedActivity,
    status: item.preferenceRank === 1 ? STATUS.PENDING : STATUS.WAITING,
    rejectReason: '',
    decidedByUid: '',
    selectionSource: '',
  }))

  if (!isFirebaseEnabled()) {
    const now = nowIso()
    const inserted = rows.map((row, index) => ({
      id: `local-app-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      ...row,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
    }))
    localApplications = [...localApplications, ...inserted]
    return inserted
  }

  const batch = writeBatch(db)
  const inserted = rows.map((row) => {
    const ref = doc(collection(db, APPLICATIONS))
    batch.set(ref, {
      ...row,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      decidedAt: null,
    })
    return { id: ref.id, ...row }
  })

  await batch.commit()
  return inserted
}

export async function listStudentApplications(studentUid, options = {}) {
  const cycle = await getCurrentRecruitmentCycle()
  const rows = await getApplicationsByStudent(studentUid)
  const filtered = options?.allCycles
    ? rows
    : rows.filter((item) => item.cycleId === cycle.id)

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

export async function listApplicationsBySchedule(clubId) {
  const cycle = await getCurrentRecruitmentCycle()
  const rows = (await getApplicationsByClub(clubId)).filter((item) => item.cycleId === cycle.id)

  const enriched = await Promise.all(
    rows.map(async (row) => {
      const profile = await getUserProfile(row.studentUid)
      return {
        ...row,
        studentName: profile?.name || row.studentName,
        studentNo: profile?.studentNo || row.studentNo,
      }
    }),
  )

  return enriched.sort((a, b) => {
    if (a.preferenceRank !== b.preferenceRank) {
      return a.preferenceRank - b.preferenceRank
    }
    return String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'ko')
  })
}

async function approveApplicationInternal({ applicationId, actor, source = 'approval' }) {
  const user = assertActor(actor)
  const cycle = await getCurrentRecruitmentCycle()
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

    const byStudentSnap = await tx.get(
      query(collection(db, APPLICATIONS), where('studentUid', '==', app.studentUid)),
    )
    const byStudent = byStudentSnap.docs.map((item) => normalizeApplication(item.id, item.data()))

    const alreadyApproved = byStudent.some((row) => row.cycleId === app.cycleId && row.status === STATUS.APPROVED)
    if (alreadyApproved) {
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
  const cycle = await getCurrentRecruitmentCycle()
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

export async function randomSelectPending(payload) {
  const clubId = String(payload?.clubId || '')
  const user = assertActor(payload?.actor)
  if (!clubId) {
    throw new Error('동아리 ID가 필요합니다.')
  }

  const cycle = await getCurrentRecruitmentCycle()
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

  const seats = Math.max(0, Number(club.maxMembers || 0) - Number(club.memberCount || 0))
  const shuffled = shuffle(rows)
  const selected = shuffled.slice(0, seats)
  const rejected = shuffled.slice(seats)

  for (const row of selected) {
    await approveApplicationInternal({
      applicationId: row.id,
      actor: user,
      source: 'random',
    })
  }

  for (const row of rejected) {
    await rejectApplication({
      applicationId: row.id,
      actor: user,
      reason: REJECT_REASON.RANDOM_UNSELECTED,
    })
  }

  await updateSchedule(
    club.id,
    {
      randomDrawnRounds: Array.from(new Set([...club.randomDrawnRounds, cycle.currentRound])).sort((a, b) => a - b),
    },
    { actor: user },
  )

  return {
    selected: selected.length,
    rejected: rejected.length,
  }
}

export async function advanceRecruitmentRound(payload) {
  const user = assertActor(payload?.actor)
  if (user.role !== 'admin') {
    throw new Error('라운드 전환은 관리자만 가능합니다.')
  }

  const cycle = await getCurrentRecruitmentCycle()
  assertOpenCycle(cycle)

  const allApps = await getAllApplications()
  const currentPending = allApps.filter(
    (row) => row.cycleId === cycle.id
      && row.preferenceRank === cycle.currentRound
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
    } else {
      await updateDoc(cycleRef, {
        status: 'closed',
        updatedAt: serverTimestamp(),
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
  } else {
    await updateDoc(cycleRef, {
      currentRound: nextRound,
      updatedAt: serverTimestamp(),
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

export async function directSelectInterviewMember(payload) {
  const clubId = String(payload?.clubId || '').trim()
  const studentUid = String(payload?.studentUid || '').trim()
  const user = assertActor(payload?.actor)

  if (!clubId || !studentUid) {
    throw new Error('동아리와 학생을 선택해주세요.')
  }

  const cycle = await getCurrentRecruitmentCycle()
  assertOpenCycle(cycle)

  const club = await getScheduleById(clubId)
  if (!club || club.legacy) {
    throw new Error('동아리 정보를 찾을 수 없습니다.')
  }
  if (!club.isInterviewSelection) {
    throw new Error('자체면접 동아리에서만 직접 선발이 가능합니다.')
  }
  if (!club.leaderUid) {
    throw new Error('동아리장이 지정되지 않은 동아리는 직접 선발할 수 없습니다.')
  }
  if (!canManageSelection(club, user)) {
    throw new Error('직접 선발 권한이 없습니다.')
  }

  const student = await getUserProfile(studentUid)
  if (!student || student.role !== 'student') {
    throw new Error('학생 계정을 찾을 수 없습니다.')
  }
  if (!student.studentNo || !isStudentEligibleForClub(club, student.studentNo)) {
    throw new Error('대상학년이 아닌 학생은 선발할 수 없습니다.')
  }

  if (club.memberCount >= club.maxMembers) {
    throw new Error('동아리 정원이 가득 찼습니다.')
  }

  const studentApps = await getApplicationsByStudent(studentUid)
  const approvedExists = studentApps.some(
    (row) => row.cycleId === cycle.id && row.status === STATUS.APPROVED,
  )
  if (approvedExists) {
    throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
  }

  const existingMembers = await listClubMembers(club.id)
  if (existingMembers.some((row) => row.studentUid === studentUid)) {
    throw new Error('이미 선발된 학생입니다.')
  }

  if (!isFirebaseEnabled()) {
    const members = getLocalMembers(club.id)
    members.push({
      id: student.uid,
      studentUid: student.uid,
      studentNo: student.studentNo,
      name: student.name,
      source: 'interview_manual',
      applicationId: '',
      addedByUid: user.uid,
      addedAt: nowIso(),
    })

    await updateScheduleMemberCount(club.id, club.memberCount + 1)
    await createApprovedInterviewApplication({
      cycle,
      club,
      student,
      actor: user,
    })

    const studentRows = localApplications.filter((row) => row.studentUid === studentUid)
    const patches = studentRows
      .filter((row) => row.cycleId === cycle.id && (row.status === STATUS.PENDING || row.status === STATUS.WAITING))
      .map((row) => ({
        id: row.id,
        status: STATUS.CANCELLED,
        rejectReason: REJECT_REASON.HIGHER_CHOICE,
        decidedByUid: user.uid,
      }))
    await updateApplicationsStatusBulk(patches)
    return
  }

  await runTransaction(db, async (tx) => {
    const clubRef = doc(db, 'schedules', club.id)
    const clubSnap = await tx.get(clubRef)
    if (!clubSnap.exists()) {
      throw new Error('동아리 정보를 찾을 수 없습니다.')
    }

    const clubLive = { id: clubSnap.id, ...clubSnap.data() }
    if (!canManageSelection(clubLive, user)) {
      throw new Error('직접 선발 권한이 없습니다.')
    }

    const memberRef = doc(db, 'schedules', club.id, MEMBERS_SUBCOLLECTION, student.uid)
    const memberSnap = await tx.get(memberRef)
    if (memberSnap.exists()) {
      throw new Error('이미 선발된 학생입니다.')
    }

    const count = Number(clubLive.memberCount || 0)
    const max = Number(clubLive.maxMembers || 0)
    if (count >= max) {
      throw new Error('동아리 정원이 가득 찼습니다.')
    }

    const studentAppsSnap = await tx.get(
      query(collection(db, APPLICATIONS), where('studentUid', '==', student.uid)),
    )
    const studentAppsLocal = studentAppsSnap.docs.map((item) => normalizeApplication(item.id, item.data()))

    const approved = studentAppsLocal.some((row) => row.cycleId === cycle.id && row.status === STATUS.APPROVED)
    if (approved) {
      throw new Error('해당 학생은 이미 다른 동아리에 배정되었습니다.')
    }

    const interviewAppRef = doc(collection(db, APPLICATIONS))
    tx.set(interviewAppRef, {
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
      decidedByUid: user.uid,
      selectionSource: 'interview_manual',
      decidedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })

    tx.set(memberRef, {
      studentUid: student.uid,
      studentNo: student.studentNo,
      name: student.name,
      source: 'interview_manual',
      applicationId: interviewAppRef.id,
      addedByUid: user.uid,
      addedAt: serverTimestamp(),
    })

    tx.update(clubRef, {
      memberCount: count + 1,
      updatedAt: serverTimestamp(),
    })

    studentAppsLocal
      .filter((row) => row.cycleId === cycle.id && (row.status === STATUS.PENDING || row.status === STATUS.WAITING))
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
    localCycle = {
      id: CYCLE_DOC_ID,
      currentRound: 1,
      status: 'open',
      updatedAt: nowIso(),
    }
    localMembersByClub.clear()
    return
  }

  const appsSnapshot = await getDocs(collection(db, APPLICATIONS))
  for (const rows of chunk(appsSnapshot.docs, 400)) {
    const batch = writeBatch(db)
    rows.forEach((row) => batch.delete(row.ref))
    await batch.commit()
  }

  await setDoc(doc(db, CYCLES, CYCLE_DOC_ID), {
    currentRound: 1,
    status: 'open',
    updatedAt: serverTimestamp(),
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
