import { authorizeClub, createPublicToken, db, handleError, hashPin, json, normalizeEntries, readBody, requireActor, timestamp } from './_attendance-utils.js'

function refs(clubId, sessionId) {
  const session = db().doc(`schedules/${clubId}/attendanceSessions/${sessionId}`)
  return { session, entries: session.collection('entries') }
}

async function readRecord(clubId, sessionId, create = true) {
  const { session, entries } = refs(clubId, sessionId)
  let sessionSnap = await session.get()
  if (!sessionSnap.exists && create) {
    const memberSnap = await db().collection(`schedules/${clubId}/members`).get()
    const rosterSnapshot = memberSnap.docs.map((doc) => ({ studentUid: String(doc.data().studentUid || doc.id), studentNo: String(doc.data().studentNo || ''), name: String(doc.data().name || '') })).sort((a, b) => a.studentNo.localeCompare(b.studentNo, 'ko', { numeric: true }))
    const batch = db().batch()
    batch.set(session, { status: 'open', rosterSnapshot, publicEnabled: false, tokenVersion: 1, createdAt: timestamp(), updatedAt: timestamp() })
    for (const student of rosterSnapshot) batch.set(entries.doc(student.studentUid), { status: 'unchecked', updatedAt: timestamp(), updatedBy: 'system' })
    await batch.commit()
    sessionSnap = await session.get()
  }
  if (!sessionSnap.exists) throw Object.assign(new Error('출석 회차를 찾을 수 없습니다.'), { status: 404 })
  const entrySnap = await entries.get(); const entryMap = Object.fromEntries(entrySnap.docs.map((doc) => [doc.id, doc.data()]))
  const data = sessionSnap.data(); const rosterSnapshot = Array.isArray(data.rosterSnapshot) ? data.rosterSnapshot : []
  return { clubId, sessionId, ...data, rosterSnapshot, entries: Object.fromEntries(rosterSnapshot.map((row) => [row.studentUid, entryMap[row.studentUid] || { status: 'unchecked' }])) }
}

export default async (req) => {
  try {
    const actor = requireActor(req); const body = await readBody(req); const action = body.action
    if (action === 'set-pin') {
      if (!/^\d{4,8}$/u.test(String(body.pin || ''))) return json({ error: 'PIN은 숫자 4~8자리로 입력해주세요.' }, 400)
      const userSnap = await db().doc(`users/${actor.uid}`).get(); const user = userSnap.data()
      if (!userSnap.exists || (user.role !== 'admin' && user.loginId !== 'admin')) return json({ error: '관리자만 PIN을 설정할 수 있습니다.' }, 403)
      const encoded = hashPin(body.pin)
      await db().doc(`_attendanceAccess/${body.programId}`).set({ ...encoded, failedAttempts: 0, lockedUntil: null, updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      return json({ ok: true })
    }
    if (action === 'export') {
      const userSnap = await db().doc(`users/${actor.uid}`).get(); const user = userSnap.data()
      if (!userSnap.exists || (user.role !== 'admin' && user.loginId !== 'admin')) return json({ error: '관리자만 백업할 수 있습니다.' }, 403)
      const sessions = await db().collectionGroup('attendanceSessions').get(); const records = []
      for (const doc of sessions.docs) { const clubId = doc.ref.parent.parent.id; records.push(await readRecord(clubId, doc.id, false)) }
      return json({ records })
    }
    const clubId = String(body.clubId || ''); const sessionId = String(body.sessionId || '')
    const { club } = await authorizeClub(actor, clubId)
    if (String(body.programId || '') && String(club.programId || '') !== String(body.programId)) return json({ error: '프로그램과 수업 정보가 일치하지 않습니다.' }, 400)
    const programSnap = await db().doc(`programs/${body.programId}`).get(); const program = programSnap.data()
    if (!programSnap.exists || program.features?.attendance !== true) return json({ error: '출석부 기능이 활성화되지 않은 프로그램입니다.' }, 400)
    const sessionConfig = (program.attendanceSchedule || []).find((row) => String(row.id) === sessionId)
    if (!sessionConfig) return json({ error: '프로그램에 등록되지 않은 출석 회차입니다.' }, 400)
    if (action === 'get') return json(await readRecord(clubId, sessionId))
    const record = await readRecord(clubId, sessionId); const { session, entries } = refs(clubId, sessionId)
    if (action === 'set-status') {
      const status = body.status === 'closed' ? 'closed' : 'open'
      await session.set({ status, ...(status === 'closed' ? { publicEnabled: false, publicUrl: '' } : {}), updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      return json(await readRecord(clubId, sessionId, false))
    }
    if (record.status === 'closed') return json({ error: '종료된 출석 회차입니다.' }, 409)
    if (action === 'save') {
      const batch = db().batch(); const allowed = record.rosterSnapshot.map((row) => row.studentUid)
      for (const [uid, status] of normalizeEntries(body.entries, allowed)) batch.set(entries.doc(uid), { status, updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      batch.set(session, { updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true }); await batch.commit()
      return json(await readRecord(clubId, sessionId, false))
    }
    if (action === 'sync-roster') {
      if (Object.values(record.entries).some((row) => row.status && row.status !== 'unchecked')) return json({ error: '출결 입력이 시작된 회차는 명단을 동기화할 수 없습니다.' }, 409)
      const memberSnap = await db().collection(`schedules/${clubId}/members`).get()
      const rosterSnapshot = memberSnap.docs.map((doc) => ({ studentUid: String(doc.data().studentUid || doc.id), studentNo: String(doc.data().studentNo || ''), name: String(doc.data().name || '') })).sort((a, b) => a.studentNo.localeCompare(b.studentNo, 'ko', { numeric: true }))
      const oldEntries = await entries.get(); const batch = db().batch()
      for (const doc of oldEntries.docs) batch.delete(doc.ref)
      for (const student of rosterSnapshot) batch.set(entries.doc(student.studentUid), { status: 'unchecked', updatedAt: timestamp(), updatedBy: actor.uid })
      batch.set(session, { rosterSnapshot, updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      await batch.commit()
      return json(await readRecord(clubId, sessionId, false))
    }
    if (action === 'configure-public') {
      const version = (Number(record.tokenVersion) || 1) + (body.rotate ? 1 : 0)
      const enabled = body.enabled === true
      if (enabled) {
        const access = await db().doc(`_attendanceAccess/${body.programId}`).get()
        if (!access.exists || !access.data().hash) return json({ error: '관리자가 먼저 프로그램 QR PIN을 설정해야 합니다.' }, 409)
      }
      const token = createPublicToken({ scheduleId: clubId, sessionId, programId: body.programId, version })
      const origin = new URL(req.url).origin
      const publicUrl = enabled ? `${origin}/attendance/public/${token}` : ''
      await session.set({ publicEnabled: enabled, tokenVersion: version, publicUrl, updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      return json({ publicEnabled: enabled, tokenVersion: version, publicUrl })
    }
    return json({ error: '지원하지 않는 작업입니다.' }, 400)
  } catch (error) { return handleError(error) }
}

export const config = { path: '/.netlify/functions/attendance-api' }
