import { createSessionToken, db, handleError, json, normalizeEntries, readBody, requireActor, timestamp, verifyPin, verifyPublicToken } from './_attendance-utils.js'

async function validatePublic(token) {
  const payload = verifyPublicToken(token)
  const ref = db().doc(`schedules/${payload.scheduleId}/attendanceSessions/${payload.sessionId}`)
  const [snap, accessSnap] = await Promise.all([
    ref.get(),
    db().doc(`_attendanceAccess/${payload.programId}`).get(),
  ])
  if (!snap.exists) throw Object.assign(new Error('출석 회차를 찾을 수 없습니다.'), { status: 404 })
  const record = snap.data()
  if (accessSnap.data()?.enabled !== true || !record.publicEnabled || Number(record.tokenVersion) !== Number(payload.version) || record.status === 'closed') throw Object.assign(new Error('중지되었거나 종료된 출석 링크입니다.'), { status: 410 })
  return { payload, ref, record }
}

async function fullRecord(payload, record) {
  const entrySnap = await db().collection(`schedules/${payload.scheduleId}/attendanceSessions/${payload.sessionId}/entries`).get(); const map = Object.fromEntries(entrySnap.docs.map((doc) => [doc.id, doc.data()]))
  const rosterSnapshot = Array.isArray(record.rosterSnapshot) ? record.rosterSnapshot : []
  return { clubId: payload.scheduleId, sessionId: payload.sessionId, programId: payload.programId, ...record, rosterSnapshot, entries: Object.fromEntries(rosterSnapshot.map((row) => [row.studentUid, map[row.studentUid] || { status: 'unchecked' }])) }
}

export default async (req) => {
  try {
    const body = await readBody(req); const { payload, ref, record } = await validatePublic(body.token)
    const accessRef = db().doc(`_attendanceAccess/${payload.programId}`); const accessSnap = await accessRef.get(); const access = accessSnap.data() || {}
    if (body.action === 'open') {
      if (access.pinRequired !== false) return json({ error: '프로그램 PIN이 필요합니다.', requiresPin: true }, 409)
      const editToken = createSessionToken({ uid: `public:${payload.scheduleId}:${payload.sessionId}`, role: 'public' })
      return json({ record: await fullRecord(payload, record), editToken })
    }
    if (body.action === 'unlock') {
      if (access.pinRequired !== false) {
        if (access.lockedUntil?.toMillis?.() > Date.now()) return json({ error: 'PIN 오류가 반복되어 잠시 잠겼습니다. 5분 후 다시 시도해주세요.' }, 429)
        if (!access.hash || !verifyPin(body.pin, access.salt, access.hash)) {
          const failed = (Number(access.failedAttempts) || 0) + 1; const patch = { failedAttempts: failed, updatedAt: timestamp() }
          if (failed >= 5) { patch.failedAttempts = 0; patch.lockedUntil = new Date(Date.now() + 5 * 60 * 1000) }
          await accessRef.set(patch, { merge: true }); return json({ error: 'PIN이 올바르지 않습니다.' }, 401)
        }
        await accessRef.set({ failedAttempts: 0, lockedUntil: null, updatedAt: timestamp() }, { merge: true })
      }
      const editToken = createSessionToken({ uid: `public:${payload.scheduleId}:${payload.sessionId}`, role: 'public' })
      return json({ record: await fullRecord(payload, record), editToken })
    }
    if (body.action === 'save') {
      const { uid, role } = requireActor(new Request(req.url, { headers: { authorization: `Bearer ${body.editToken}` } }))
      if (role !== 'public' || uid !== `public:${payload.scheduleId}:${payload.sessionId}`) return json({ error: 'QR 수정 인증이 만료되었습니다.' }, 401)
      const roster = Array.isArray(record.rosterSnapshot) ? record.rosterSnapshot : []; const batch = db().batch()
      for (const [studentUid, status] of normalizeEntries(body.entries, roster.map((row) => row.studentUid))) batch.set(ref.collection('entries').doc(studentUid), { status, updatedAt: timestamp(), updatedBy: 'public-qr' }, { merge: true })
      batch.set(ref, { updatedAt: timestamp(), updatedBy: 'public-qr' }, { merge: true }); await batch.commit()
      return json(await fullRecord(payload, (await ref.get()).data()))
    }
    return json({ error: '지원하지 않는 작업입니다.' }, 400)
  } catch (error) { return handleError(error) }
}
