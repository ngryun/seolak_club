import { authorizeClub, createPublicToken, db, handleError, hashPin, json, normalizeEntries, readBody, requireActor, timestamp } from './_attendance-utils.js'

function refs(clubId, sessionId) {
  const session = db().doc(`schedules/${clubId}/attendanceSessions/${sessionId}`)
  return { session, entries: session.collection('entries') }
}

function normalizeRosterRow(doc) {
  const data = doc.data() || {}
  return {
    studentUid: String(data.studentUid || data.uid || doc.id || '').trim(),
    studentNo: String(data.studentNo || data.loginId || '').trim(),
    name: String(data.name || data.studentName || '').trim(),
  }
}

function sortRoster(rows) {
  const seen = new Set()
  return rows
    .filter((row) => row.studentUid && !seen.has(row.studentUid) && seen.add(row.studentUid))
    .sort((a, b) => a.studentNo.localeCompare(b.studentNo, 'ko', { numeric: true }) || a.name.localeCompare(b.name, 'ko'))
}

async function loadClubRoster(clubId, program = {}) {
  const memberSnap = await db().collection(`schedules/${clubId}/members`).get()
  const memberRoster = sortRoster(memberSnap.docs.map(normalizeRosterRow))
  if (memberRoster.length) return memberRoster

  // 과거 데이터에서 members 문서가 누락된 경우에도 현재 사이클의 승인 학생으로 복구합니다.
  const applicationSnap = await db().collection('applications').where('clubId', '==', clubId).get()
  const cycleId = String(program.cycleId || '').trim()
  return sortRoster(applicationSnap.docs
    .map((doc) => ({ ...doc.data(), id: doc.id }))
    .filter((row) => row.status === 'approved' && (!cycleId || String(row.cycleId || '') === cycleId))
    .map((row) => ({
      studentUid: String(row.studentUid || '').trim(),
      studentNo: String(row.studentNo || '').trim(),
      name: String(row.studentName || row.name || '').trim(),
    })))
}

async function readRecord(clubId, sessionId, create = true, programId = '', origin = '', fallbackRoster = null, program = {}, accessData = null) {
  const { session, entries } = refs(clubId, sessionId)
  let sessionSnap = await session.get()
  if (!sessionSnap.exists && create) {
    const rosterSnapshot = fallbackRoster || await loadClubRoster(clubId, program)
    const access = programId
      ? (accessData || (await db().doc(`_attendanceAccess/${programId}`).get()).data())
      : null
    const publicEnabled = access?.enabled === true
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
  let data = sessionSnap.data()
  let rosterSnapshot = Array.isArray(data.rosterSnapshot) ? data.rosterSnapshot : []
  if (!rosterSnapshot.length) {
    const currentRoster = fallbackRoster || await loadClubRoster(clubId, program)
    if (currentRoster.length) {
      const batch = db().batch()
      batch.set(session, { rosterSnapshot: currentRoster, updatedAt: timestamp() }, { merge: true })
      for (const student of currentRoster) batch.set(entries.doc(student.studentUid), { status: 'unchecked', updatedAt: timestamp(), updatedBy: 'system' }, { merge: true })
      await batch.commit()
      data = { ...data, rosterSnapshot: currentRoster }
      rosterSnapshot = currentRoster
    }
  }
  const entrySnap = await entries.get(); const entryMap = Object.fromEntries(entrySnap.docs.map((doc) => [doc.id, doc.data()]))
  // 프로그램 단위 설정을 기준으로 기존·지연 생성 회차의 QR 상태도 동기화합니다.
  // 일괄 처리 중 일부 회차가 새로 만들어지거나 재시도되는 경우에도 상태가 어긋나지 않습니다.
  if (programId) {
    const access = accessData || (await db().doc(`_attendanceAccess/${programId}`).get()).data()
    const shouldEnable = access?.enabled === true && data.status !== 'closed'
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
      const pinRequired = body.pinRequired !== false
      if (pin && !/^\d{4,8}$/u.test(pin)) return json({ error: 'PIN은 숫자 4~8자리로 입력해주세요.' }, 400)
      const accessRef = db().doc(`_attendanceAccess/${programId}`)
      const accessSnap = await accessRef.get()
      if (body.enabled === true && pinRequired && !pin && (!accessSnap.exists || !accessSnap.data().hash)) {
        return json({ error: 'QR을 활성화하려면 프로그램 PIN을 먼저 입력해주세요.' }, 409)
      }
      await accessRef.set({
        ...(pin ? { ...hashPin(pin), failedAttempts: 0, lockedUntil: null } : {}),
        enabled: body.enabled === true,
        pinRequired,
        updatedAt: timestamp(),
        updatedBy: actor.uid,
      }, { merge: true })
      await programSnap.ref.set({ attendanceQrEnabled: body.enabled === true, attendanceQrPinRequired: pinRequired, updatedAt: timestamp() }, { merge: true })

      const origin = new URL(req.url).origin
      const scheduleSnap = await db().collection('schedules').get()
      const clubs = scheduleSnap.docs.filter((row) => {
        const clubProgramId = String(row.data().programId || (programId === 'club-default' ? 'club-default' : ''))
        return clubProgramId === programId
      })
      const sessions = (program.attendanceSchedule || []).filter((row) => row?.active !== false && row?.id)
      const accessData = { ...(accessSnap.data() || {}), enabled: body.enabled === true, pinRequired }
      const rosterRows = await Promise.all(clubs.map(async (club) => [club.id, await loadClubRoster(club.id, program)]))
      const rosterByClub = new Map(rosterRows)
      const jobs = clubs.flatMap((club) => sessions.map(async (sessionConfig) => {
        const sessionId = String(sessionConfig.id)
        const record = await readRecord(club.id, sessionId, true, programId, origin, rosterByClub.get(club.id) || [], program, accessData)
        if (record.status === 'closed') return { status: 'closed' }
        const version = (Number(record.tokenVersion) || 1) + (body.rotate === true ? 1 : 0)
        const enabled = body.enabled === true
        const publicUrl = enabled
          ? `${origin}/attendance/public/${createPublicToken({ scheduleId: club.id, sessionId, programId, version })}`
          : ''
        await refs(club.id, sessionId).session.set({
          programId,
          publicEnabled: enabled,
          tokenVersion: version,
          publicUrl,
          updatedAt: timestamp(),
          updatedBy: actor.uid,
        }, { merge: true })
        return { status: 'updated' }
      }))
      const results = await Promise.allSettled(jobs)
      const updatedCount = results.filter((result) => result.status === 'fulfilled' && result.value.status === 'updated').length
      const closedCount = results.filter((result) => result.status === 'fulfilled' && result.value.status === 'closed').length
      const failedCount = results.filter((result) => result.status === 'rejected').length
      return json({ ok: true, enabled: body.enabled === true, updatedCount, closedCount, failedCount })
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
    const origin = new URL(req.url).origin
    if (action === 'get-date-public') {
      const date = String(body.date || '').trim()
      const requestedIds = new Set((Array.isArray(body.sessionIds) ? body.sessionIds : [])
        .map((id) => String(id || '').trim()).filter(Boolean))
      const accessSnap = await db().doc(`_attendanceAccess/${body.programId}`).get()
      const accessData = accessSnap.data() || {}
      if (accessData.enabled !== true) return json({ error: '프로그램 QR이 활성화되어 있지 않습니다.' }, 409)
      const sessionConfigs = (program.attendanceSchedule || []).filter((row) => row?.active !== false
        && row?.id && String(row.date || '') === date
        && (!requestedIds.size || requestedIds.has(String(row.id))))
      if (!date || !sessionConfigs.length) return json({ error: '해당 날짜의 출석 회차가 없습니다.' }, 400)
      const records = await Promise.all(sessionConfigs.map((row) => readRecord(
        clubId, String(row.id), true, String(body.programId || ''), origin, null, program, accessData,
      )))
      const usable = records
        .map((record, index) => ({ record, config: sessionConfigs[index] }))
        .filter(({ record }) => record.status !== 'closed' && record.publicEnabled)
      if (!usable.length) return json({ error: '사용할 수 있는 출석 회차가 없습니다.' }, 409)
      const sessionRows = usable.map(({ config }) => ({
        id: String(config.id), date: String(config.date || ''), period: Number(config.period) || 0, label: String(config.label || ''),
      }))
      const version = Math.max(1, ...usable.map(({ record }) => Number(record.tokenVersion) || 1))
      const token = createPublicToken({
        scheduleId: clubId,
        sessionIds: sessionRows.map((row) => row.id),
        sessions: sessionRows,
        programId: String(body.programId || ''),
        date,
        version,
      })
      return json({ publicUrl: `${origin}/attendance/public/${token}`, sessions: sessionRows })
    }
    if (action === 'get-batch') {
      const sessionIds = Array.from(new Set((Array.isArray(body.sessionIds) ? body.sessionIds : [])
        .map((id) => String(id || '').trim()).filter(Boolean)))
      if (!sessionIds.length || sessionIds.some((id) => !(program.attendanceSchedule || []).some((row) => String(row.id) === id))) {
        return json({ error: '프로그램에 등록되지 않은 출석 회차가 포함되어 있습니다.' }, 400)
      }
      const roster = await loadClubRoster(clubId, program)
      const records = await Promise.all(sessionIds.map((id) => readRecord(clubId, id, true, String(body.programId || ''), origin, roster, program)))
      return json({ records })
    }
    if (!sessionConfig) return json({ error: '프로그램에 등록되지 않은 출석 회차입니다.' }, 400)
    if (action === 'get') return json(await readRecord(clubId, sessionId, true, String(body.programId || ''), origin, null, program))
    const record = await readRecord(clubId, sessionId, true, String(body.programId || ''), origin, null, program); const { session, entries } = refs(clubId, sessionId)
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
      const rosterSnapshot = await loadClubRoster(clubId, program)
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
