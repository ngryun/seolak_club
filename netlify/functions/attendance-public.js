import { createSessionToken, db, handleError, json, normalizeEntries, readBody, requireActor, timestamp, verifyPin, verifyPublicToken } from './_attendance-utils.js'

function publicIdentity(payload) {
  return Array.isArray(payload.sessionIds)
    ? `public:${payload.scheduleId}:date:${payload.date || ''}`
    : `public:${payload.scheduleId}:${payload.sessionId}`
}

async function validatePublic(token) {
  const payload = verifyPublicToken(token)
  const sessionIds = Array.isArray(payload.sessionIds) && payload.sessionIds.length
    ? payload.sessionIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [String(payload.sessionId || '').trim()].filter(Boolean)
  const refs = sessionIds.map((sessionId) => db().doc(`schedules/${payload.scheduleId}/attendanceSessions/${sessionId}`))
  const [snapshots, accessSnap] = await Promise.all([
    Promise.all(refs.map((ref) => ref.get())),
    db().doc(`_attendanceAccess/${payload.programId}`).get(),
  ])
  if (snapshots.some((snap) => !snap.exists)) throw Object.assign(new Error('출석 회차를 찾을 수 없습니다.'), { status: 404 })
  const allRows = snapshots.map((snap, index) => ({ sessionId: sessionIds[index], ref: refs[index], record: snap.data() }))
  const isMulti = sessionIds.length > 1 || Array.isArray(payload.sessionIds)
  const version = Number(payload.version) || 0
  const usableRows = allRows.filter(({ record }) => record.publicEnabled && record.status !== 'closed'
    && (!version || isMulti || Number(record.tokenVersion) === version))
  if (accessSnap.data()?.enabled !== true || !usableRows.length) throw Object.assign(new Error('중지되었거나 종료된 출석 링크입니다.'), { status: 410 })
  return {
    payload,
    isMulti,
    sessionIds: usableRows.map((row) => row.sessionId),
    refs: usableRows.map((row) => row.ref),
    records: usableRows.map((row) => row.record),
  }
}

async function fullRecord(payload, sessionId, record, ref = null) {
  const entryRef = ref || db().collection(`schedules/${payload.scheduleId}/attendanceSessions/${sessionId}/entries`)
  const entrySnap = await entryRef.get(); const map = Object.fromEntries(entrySnap.docs.map((doc) => [doc.id, doc.data()]))
  const rosterSnapshot = Array.isArray(record.rosterSnapshot) ? record.rosterSnapshot : []
  return { clubId: payload.scheduleId, sessionId, programId: payload.programId, ...record, rosterSnapshot, entries: Object.fromEntries(rosterSnapshot.map((row) => [row.studentUid, map[row.studentUid] || { status: 'unchecked' }])) }
}

async function fullRecords(payload, sessionIds, records, refs) {
  return Promise.all(records.map((record, index) => fullRecord(payload, sessionIds[index], record, refs[index].collection('entries'))))
}

function responseForRecords(isMulti, payload, records, sessionIds, refs) {
  return fullRecords(payload, sessionIds, records, refs).then((full) => isMulti
    ? { records: full, sessions: payload.sessions || [] }
    : { record: full[0] })
}

export default async (req) => {
  try {
    const body = await readBody(req); const context = await validatePublic(body.token)
    const { payload, isMulti, sessionIds, refs, records } = context
    const accessRef = db().doc(`_attendanceAccess/${payload.programId}`); const accessSnap = await accessRef.get(); const access = accessSnap.data() || {}
    if (body.action === 'open') {
      if (access.pinRequired !== false) return json({ error: '프로그램 PIN이 필요합니다.', requiresPin: true }, 409)
      const editToken = createSessionToken({ uid: publicIdentity(payload), role: 'public' })
      return json({ ...(await responseForRecords(isMulti, payload, records, sessionIds, refs)), editToken })
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
      const editToken = createSessionToken({ uid: publicIdentity(payload), role: 'public' })
      return json({ ...(await responseForRecords(isMulti, payload, records, sessionIds, refs)), editToken })
    }
    if (body.action === 'save') {
      const { uid, role } = requireActor(new Request(req.url, { headers: { authorization: `Bearer ${body.editToken}` } }))
      if (role !== 'public' || uid !== publicIdentity(payload)) return json({ error: 'QR 수정 인증이 만료되었습니다.' }, 401)
      const batch = db().batch()
      refs.forEach((ref, index) => {
        const roster = Array.isArray(records[index].rosterSnapshot) ? records[index].rosterSnapshot : []
        const values = isMulti ? (body.entries?.[sessionIds[index]] || {}) : body.entries
        for (const [studentUid, status] of normalizeEntries(values, roster.map((row) => row.studentUid))) batch.set(ref.collection('entries').doc(studentUid), { status, updatedAt: timestamp(), updatedBy: 'public-qr' }, { merge: true })
        batch.set(ref, { updatedAt: timestamp(), updatedBy: 'public-qr' }, { merge: true })
      })
      await batch.commit()
      const fresh = await Promise.all(refs.map((ref) => ref.get()))
      const freshRecords = fresh.map((snap) => snap.data())
      return json(await responseForRecords(isMulti, payload, freshRecords, sessionIds, refs))
    }
    return json({ error: '지원하지 않는 작업입니다.' }, 400)
  } catch (error) { return handleError(error) }
}
