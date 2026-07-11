import { authorizeClub, createPublicToken, db, handleError, hashPin, json, normalizeEntries, readBody, requireActor, timestamp } from './_attendance-utils.js'

function refs(clubId, sessionId) {
  const session = db().doc(`schedules/${clubId}/attendanceSessions/${sessionId}`)
  return { session, entries: session.collection('entries') }
}

async function readRecord(clubId, sessionId, create = true, programId = '', origin = '') {
  const { session, entries } = refs(clubId, sessionId)
  let sessionSnap = await session.get()
  if (!sessionSnap.exists && create) {
    const memberSnap = await db().collection(`schedules/${clubId}/members`).get()
    const rosterSnapshot = memberSnap.docs.map((doc) => ({ studentUid: String(doc.data().studentUid || doc.id), studentNo: String(doc.data().studentNo || ''), name: String(doc.data().name || '') })).sort((a, b) => a.studentNo.localeCompare(b.studentNo, 'ko', { numeric: true }))
    const accessSnap = programId ? await db().doc(`_attendanceAccess/${programId}`).get() : null
    const publicEnabled = accessSnap?.data()?.enabled === true
    const tokenVersion = 1
    const publicUrl = publicEnabled && origin
      ? `${origin}/attendance/public/${createPublicToken({ scheduleId: clubId, sessionId, programId, version: tokenVersion })}`
      : ''
    const batch = db().batch()
    batch.set(session, { programId, status: 'open', rosterSnapshot, publicEnabled, tokenVersion, publicUrl, createdAt: timestamp(), updatedAt: timestamp() })
    for (const student of rosterSnapshot) batch.set(entries.doc(student.studentUid), { status: 'unchecked', updatedAt: timestamp(), updatedBy: 'system' })
    await batch.commit()
    sessionSnap = await session.get()
  }
  if (!sessionSnap.exists) throw Object.assign(new Error('출석 회차를 찾을 수 없습니다.'), { status: 404 })
  const entrySnap = await entries.get(); const entryMap = Object.fromEntries(entrySnap.docs.map((doc) => [doc.id, doc.data()]))
  let data = sessionSnap.data()
  // 프로그램 단위 설정을 기준으로 기존·지연 생성 회차의 QR 상태도 동기화합니다.
  // 일괄 처리 중 일부 회차가 새로 만들어지거나 재시도되는 경우에도 상태가 어긋나지 않습니다.
  if (programId) {
    const accessSnap = await db().doc(`_attendanceAccess/${programId}`).get()
    const shouldEnable = accessSnap.data()?.enabled === true && data.status !== 'closed'
    const tokenVersion = Math.max(1, Number(data.tokenVersion) || 1)
    const expectedUrl = shouldEnable && origin
      ? `${origin}/attendance/public/${createPublicToken({ scheduleId: clubId, sessionId, programId, version: tokenVersion })}`
      : ''
    const canSyncPublicState = Boolean(origin) || !shouldEnable
    const needsSync = data.programId !== programId
      || (canSyncPublicState && (data.publicEnabled !== shouldEnable || data.publicUrl !== expectedUrl || Number(data.tokenVersion) !== tokenVersion))
    if (needsSync) {
      const responsePatch = {
        programId,
        tokenVersion,
        ...(canSyncPublicState ? { publicEnabled: shouldEnable, publicUrl: expectedUrl } : {}),
      }
      await session.set({ ...responsePatch, updatedAt: timestamp() }, { merge: true })
      data = { ...data, ...responsePatch }
    }
  }
  const rosterSnapshot = Array.isArray(data.rosterSnapshot) ? data.rosterSnapshot : []
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
    if (action === 'configure-program-public') {
      const userSnap = await db().doc(`users/${actor.uid}`).get(); const user = userSnap.data()
      if (!userSnap.exists || (user.role !== 'admin' && user.loginId !== 'admin')) return json({ error: '관리자만 프로그램 QR을 설정할 수 있습니다.' }, 403)
      const programId = String(body.programId || '').trim()
      if (!programId) return json({ error: '프로그램 정보가 필요합니다.' }, 400)
      const programSnap = await db().doc(`programs/${programId}`).get(); const program = programSnap.data()
      if (!programSnap.exists || program.features?.attendance !== true) return json({ error: '출석부 기능이 활성화되지 않은 프로그램입니다.' }, 400)

      const pin = String(body.pin || '').trim()
      if (pin && !/^\d{4,8}$/u.test(pin)) return json({ error: 'PIN은 숫자 4~8자리로 입력해주세요.' }, 400)
      const accessRef = db().doc(`_attendanceAccess/${programId}`)
      const accessSnap = await accessRef.get()
      if (body.enabled === true && !pin && (!accessSnap.exists || !accessSnap.data().hash)) {
        return json({ error: 'QR을 활성화하려면 프로그램 PIN을 먼저 입력해주세요.' }, 409)
      }
      await accessRef.set({
        ...(pin ? { ...hashPin(pin), failedAttempts: 0, lockedUntil: null } : {}),
        enabled: body.enabled === true,
        updatedAt: timestamp(),
        updatedBy: actor.uid,
      }, { merge: true })
      await programSnap.ref.set({ attendanceQrEnabled: body.enabled === true, updatedAt: timestamp() }, { merge: true })

      const origin = new URL(req.url).origin
      const scheduleSnap = await db().collection('schedules').get()
      const clubs = scheduleSnap.docs.filter((row) => {
        const clubProgramId = String(row.data().programId || (programId === 'club-default' ? 'club-default' : ''))
        return clubProgramId === programId
      })
      const sessions = (program.attendanceSchedule || []).filter((row) => row?.active !== false && row?.id)
      let updatedCount = 0
      let closedCount = 0
      for (const club of clubs) {
        for (const sessionConfig of sessions) {
          const record = await readRecord(club.id, String(sessionConfig.id), true, programId, origin)
          if (record.status === 'closed') { closedCount += 1; continue }
          const version = (Number(record.tokenVersion) || 1) + (body.rotate === true ? 1 : 0)
          const enabled = body.enabled === true
          const publicUrl = enabled
            ? `${origin}/attendance/public/${createPublicToken({ scheduleId: club.id, sessionId: String(sessionConfig.id), programId, version })}`
            : ''
          await refs(club.id, String(sessionConfig.id)).session.set({
            programId,
            publicEnabled: enabled,
            tokenVersion: version,
            publicUrl,
            updatedAt: timestamp(),
            updatedBy: actor.uid,
          }, { merge: true })
          updatedCount += 1
        }
      }
      return json({ ok: true, enabled: body.enabled === true, updatedCount, closedCount })
    }
    if (action === 'export') {
      const userSnap = await db().doc(`users/${actor.uid}`).get(); const user = userSnap.data()
      if (!userSnap.exists || (user.role !== 'admin' && user.loginId !== 'admin')) return json({ error: '관리자만 백업할 수 있습니다.' }, 403)
      const sessions = await db().collectionGroup('attendanceSessions').get(); const records = []
      for (const doc of sessions.docs) { const clubId = doc.ref.parent.parent.id; records.push(await readRecord(clubId, doc.id, false)) }
      return json({ records })
    }
    const clubId = String(body.clubId || ''); const sessionId = String(body.sessionId || '')
    const { club } = await authorizeClub(actor, clubId, action === 'configure-public')
    if (String(body.programId || '') && String(club.programId || '') !== String(body.programId)) return json({ error: '프로그램과 수업 정보가 일치하지 않습니다.' }, 400)
    const programSnap = await db().doc(`programs/${body.programId}`).get(); const program = programSnap.data()
    if (!programSnap.exists || program.features?.attendance !== true) return json({ error: '출석부 기능이 활성화되지 않은 프로그램입니다.' }, 400)
    const sessionConfig = (program.attendanceSchedule || []).find((row) => String(row.id) === sessionId)
    if (!sessionConfig) return json({ error: '프로그램에 등록되지 않은 출석 회차입니다.' }, 400)
    const origin = new URL(req.url).origin
    if (action === 'get') return json(await readRecord(clubId, sessionId, true, String(body.programId || ''), origin))
    const record = await readRecord(clubId, sessionId, true, String(body.programId || ''), origin); const { session, entries } = refs(clubId, sessionId)
    if (action === 'set-status') {
      const status = body.status === 'closed' ? 'closed' : 'open'
      let publicPatch = { publicEnabled: false, publicUrl: '' }
      if (status === 'open') {
        const accessSnap = await db().doc(`_attendanceAccess/${body.programId}`).get()
        if (accessSnap.data()?.enabled === true) {
          const version = Number(record.tokenVersion) || 1
          publicPatch = {
            publicEnabled: true,
            publicUrl: `${origin}/attendance/public/${createPublicToken({ scheduleId: clubId, sessionId, programId: body.programId, version })}`,
          }
        }
      }
      await session.set({ status, ...publicPatch, updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      return json(await readRecord(clubId, sessionId, false, String(body.programId || ''), origin))
    }
    if (record.status === 'closed') return json({ error: '종료된 출석 회차입니다.' }, 409)
    if (action === 'save') {
      const batch = db().batch(); const allowed = record.rosterSnapshot.map((row) => row.studentUid)
      for (const [uid, status] of normalizeEntries(body.entries, allowed)) batch.set(entries.doc(uid), { status, updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      batch.set(session, { updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true }); await batch.commit()
      return json(await readRecord(clubId, sessionId, false, String(body.programId || ''), origin))
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
      return json(await readRecord(clubId, sessionId, false, String(body.programId || ''), origin))
    }
    if (action === 'configure-public') {
      const version = (Number(record.tokenVersion) || 1) + (body.rotate ? 1 : 0)
      const enabled = body.enabled === true
      if (enabled) {
        const access = await db().doc(`_attendanceAccess/${body.programId}`).get()
        if (!access.exists || !access.data().hash || access.data().enabled !== true) return json({ error: '관리자가 프로그램 관리에서 QR을 먼저 활성화해야 합니다.' }, 409)
      }
      const token = createPublicToken({ scheduleId: clubId, sessionId, programId: body.programId, version })
      const publicUrl = enabled ? `${origin}/attendance/public/${token}` : ''
      await session.set({ publicEnabled: enabled, tokenVersion: version, publicUrl, updatedAt: timestamp(), updatedBy: actor.uid }, { merge: true })
      return json({ publicEnabled: enabled, tokenVersion: version, publicUrl })
    }
    return json({ error: '지원하지 않는 작업입니다.' }, 400)
  } catch (error) { return handleError(error) }
}

export const config = { path: '/.netlify/functions/attendance-api' }
