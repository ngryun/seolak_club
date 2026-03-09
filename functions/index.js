const admin = require('firebase-admin')
const { setGlobalOptions } = require('firebase-functions/v2')
const { HttpsError, onCall } = require('firebase-functions/v2/https')

if (!admin.apps.length) {
  admin.initializeApp()
}

const db = admin.firestore()
const REGION = 'asia-northeast3'
const ROLES = new Set(['admin', 'teacher', 'student'])

setGlobalOptions({
  region: REGION,
  maxInstances: 10,
})

function cleanText(value) {
  return String(value || '').trim()
}

function normalizeRole(value) {
  const raw = cleanText(value).toLowerCase()
  if (raw === '관리자') return 'admin'
  if (raw === '교사') return 'teacher'
  if (raw === '학생') return 'student'
  if (ROLES.has(raw)) return raw
  return 'student'
}

function requireAuth(context) {
  if (!context.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.')
  }
  return context.auth.uid
}

async function requireAdmin(context) {
  const uid = requireAuth(context)
  const snap = await db.collection('users').doc(uid).get()
  if (!snap.exists || normalizeRole(snap.data()?.role) !== 'admin') {
    throw new HttpsError('permission-denied', '관리자 권한이 필요합니다.')
  }
  return uid
}

exports.adminUpdateUserProfile = onCall(async (request) => {
  const adminUid = await requireAdmin(request)
  const targetUid = cleanText(request.data?.uid)
  if (!targetUid) {
    throw new HttpsError('invalid-argument', '수정할 사용자 UID가 필요합니다.')
  }

  const targetRef = db.collection('users').doc(targetUid)
  const targetSnap = await targetRef.get()
  if (!targetSnap.exists) {
    throw new HttpsError('not-found', '대상 계정을 찾을 수 없습니다.')
  }

  const patch = {}
  if (request.data?.name != null) patch.name = cleanText(request.data.name)
  if (request.data?.email != null) patch.email = cleanText(request.data.email)
  if (request.data?.school != null) patch.school = cleanText(request.data.school)
  if (request.data?.phone != null) patch.phone = cleanText(request.data.phone)
  if (request.data?.subject != null) patch.subject = cleanText(request.data.subject)
  if (request.data?.studentNo != null) patch.studentNo = cleanText(request.data.studentNo)
  if (request.data?.role != null) patch.role = normalizeRole(request.data.role)

  if (Object.keys(patch).length === 0) {
    throw new HttpsError('invalid-argument', '변경할 항목이 없습니다.')
  }

  if (targetUid === adminUid && patch.role && patch.role !== 'admin') {
    throw new HttpsError('invalid-argument', '본인 관리자 계정의 권한은 변경할 수 없습니다.')
  }

  const targetRole = patch.role || normalizeRole(targetSnap.data()?.role)
  if (targetRole === 'student' && patch.studentNo && !/^\d{5}$/.test(patch.studentNo)) {
    throw new HttpsError('invalid-argument', '학생 학번은 5자리 숫자여야 합니다.')
  }

  await targetRef.update({
    ...patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  })

  return { ok: true }
})

exports.adminResetUserPassword = onCall(async (request) => {
  await requireAdmin(request)
  const targetUid = cleanText(request.data?.uid)
  const newPassword = String(request.data?.newPassword || '')

  if (!targetUid) {
    throw new HttpsError('invalid-argument', '초기화할 사용자 UID가 필요합니다.')
  }
  if (newPassword.length < 6) {
    throw new HttpsError('invalid-argument', '비밀번호는 6자 이상이어야 합니다.')
  }

  await admin.auth().updateUser(targetUid, {
    password: newPassword,
  })

  const targetRef = db.collection('users').doc(targetUid)
  const targetSnap = await targetRef.get()
  if (targetSnap.exists) {
    await targetRef.update({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  }

  return { ok: true }
})

exports.adminDeleteUser = onCall(async (request) => {
  const adminUid = await requireAdmin(request)
  const targetUid = cleanText(request.data?.uid)
  if (!targetUid) {
    throw new HttpsError('invalid-argument', '삭제할 사용자 UID가 필요합니다.')
  }
  if (targetUid === adminUid) {
    throw new HttpsError('invalid-argument', '현재 로그인한 관리자 계정은 삭제할 수 없습니다.')
  }

  const applicationsSnap = await db
    .collection('applications')
    .where('teacherUid', '==', targetUid)
    .get()

  const scheduleCounts = new Map()
  applicationsSnap.forEach((docSnap) => {
    const scheduleId = cleanText(docSnap.data()?.scheduleId)
    if (!scheduleId) return
    const prev = scheduleCounts.get(scheduleId) || 0
    scheduleCounts.set(scheduleId, prev + 1)
  })

  const deleteRefs = [...applicationsSnap.docs.map((d) => d.ref), db.collection('users').doc(targetUid)]
  const chunkSize = 450
  for (let i = 0; i < deleteRefs.length; i += chunkSize) {
    const batch = db.batch()
    const chunk = deleteRefs.slice(i, i + chunkSize)
    chunk.forEach((ref) => batch.delete(ref))
    await batch.commit()
  }

  for (const [scheduleId, removedCount] of scheduleCounts.entries()) {
    const scheduleRef = db.collection('schedules').doc(scheduleId)
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(scheduleRef)
      if (!snap.exists) return
      const applied = Number(snap.data()?.applied || 0)
      tx.update(scheduleRef, {
        applied: Math.max(0, applied - removedCount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    })
  }

  try {
    await admin.auth().deleteUser(targetUid)
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      throw error
    }
  }

  return {
    ok: true,
    removedApplications: applicationsSnap.size,
  }
})
