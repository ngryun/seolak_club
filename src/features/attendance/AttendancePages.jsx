import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { listClubMembers } from '../../services/applicationService'
import {
  configurePublicAttendance,
  getAttendanceRecord,
  hasAttendanceApiSession,
  saveAttendanceRecord,
  savePublicAttendance,
  setAttendancePin,
  setAttendanceSessionStatus,
  syncAttendanceRoster,
  unlockPublicAttendance,
} from '../../services/attendanceService'

const colors = { accent: '#1769e0', border: '#dce3ec', text: '#172033', sub: '#64748b', ok: '#16803c', danger: '#c62828', warnBg: '#fffbe6', warnLine: '#f0b429' }
const card = { background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12, padding: 16 }
const input = { width: '100%', minHeight: 40, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 10px', boxSizing: 'border-box', background: '#fff' }
const button = { minHeight: 38, border: 0, borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontWeight: 700 }
const th = { padding: 9, textAlign: 'left', borderBottom: `1px solid ${colors.border}`, color: colors.sub, fontSize: 12, verticalAlign: 'bottom' }
const td = { padding: 9, borderBottom: `1px solid ${colors.border}` }

function statusLabel(value) {
  if (value === 'present') return '출석'
  if (value === 'absent') return '결석'
  return '미체크'
}

function toEntryMap(record) {
  return Object.fromEntries((record?.rosterSnapshot || []).map((student) => [student.studentUid, record.entries?.[student.studentUid]?.status || 'unchecked']))
}

// PrototypeApp Layout의 모바일 분기점(980px)과 동일하게 맞춘다.
function useIsNarrow(breakpoint = 980) {
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < breakpoint : false))
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setNarrow(window.innerWidth < breakpoint)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [breakpoint])
  return narrow
}

function groupScheduleByDate(schedule) {
  const map = new Map()
  for (const row of Array.isArray(schedule) ? schedule : []) {
    if (!row?.date || row.active === false) continue
    if (!map.has(row.date)) map.set(row.date, [])
    map.get(row.date).push(row)
  }
  return [...map.entries()]
    .map(([date, sessions]) => ({ date, sessions: [...sessions].sort((a, b) => (Number(a.period) || 0) - (Number(b.period) || 0)) }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function todayIso() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function pickInitialDate(groups) {
  if (!groups.length) return ''
  const today = todayIso()
  return (groups.find((group) => group.date >= today) || groups[groups.length - 1]).date
}

function withWeekday(date) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return `${date} (${['일', '월', '화', '수', '목', '금', '토'][parsed.getDay()]})`
}

function sessionTitle(session) {
  if (!session) return ''
  return `${session.period}교시${session.label ? ` · ${session.label}` : ''}`
}

function StatusToggle({ value, onChange, disabled = false, fill = false }) {
  return (
    <div style={{ display: 'flex', gap: 6, width: fill ? '100%' : undefined }}>
      {['present', 'absent'].map((status) => (
        <button key={status} type="button" disabled={disabled} onClick={() => onChange(status)} style={{
          ...button, minHeight: fill ? 44 : 36, padding: fill ? '8px 12px' : '5px 11px', flex: fill ? 1 : undefined,
          background: value === status ? (status === 'present' ? '#e8f7ed' : '#fff0f0') : '#f8fafc',
          color: value === status ? (status === 'present' ? colors.ok : colors.danger) : colors.sub,
          border: `1px solid ${value === status ? 'currentColor' : colors.border}`,
          opacity: disabled ? 0.55 : 1,
        }}>{statusLabel(status)}</button>
      ))}
    </div>
  )
}

function AttendanceRoster({ record, entries, onChange, disabled = false }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 420, borderCollapse: 'collapse' }}>
        <thead><tr>{['학번', '이름', '출결'].map((head) => <th key={head} style={th}>{head}</th>)}</tr></thead>
        <tbody>
          {(record?.rosterSnapshot || []).map((student) => {
            const value = entries[student.studentUid] || 'unchecked'
            return <tr key={student.studentUid}>
              <td style={td}>{student.studentNo || '-'}</td>
              <td style={{ ...td, fontWeight: 700 }}>{student.name || '-'}</td>
              <td style={{ ...td, background: value === 'unchecked' ? colors.warnBg : undefined }}>
                <StatusToggle value={value} disabled={disabled} onChange={(status) => onChange(student.studentUid, status)} fill />
              </td>
            </tr>
          })}
          {!record?.rosterSnapshot?.length ? <tr><td colSpan="3" style={{ padding: 18, textAlign: 'center', color: colors.sub }}>확정 학생이 없습니다.</td></tr> : null}
        </tbody>
      </table>
    </div>
  )
}

function SessionHeadInfo({ session, record, error, uncheckedCount, onMarkAllPresent, onRetry, disabled }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontWeight: 700, fontSize: 13, color: colors.text }}>
        {sessionTitle(session)}
        {record?.status === 'closed' ? <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 6, background: '#fff0f0', color: colors.danger, fontSize: 11 }}>종료</span> : null}
      </span>
      {error ? (
        <span style={{ color: colors.danger, fontWeight: 400 }}>불러오기 실패 <button type="button" onClick={onRetry} style={{ ...button, minHeight: 26, padding: '2px 8px', fontSize: 12, background: '#f8fafc', color: colors.accent, border: `1px solid ${colors.border}` }}>재시도</button></span>
      ) : record ? (
        <span style={{ fontWeight: 400 }}>
          <span style={{ color: uncheckedCount ? colors.danger : colors.sub }}>미체크 {uncheckedCount}</span>
          <button type="button" disabled={disabled || record.status === 'closed'} onClick={onMarkAllPresent} style={{ ...button, marginLeft: 6, minHeight: 26, padding: '2px 8px', fontSize: 12, background: '#e8f7ed', color: colors.ok, opacity: disabled || record.status === 'closed' ? 0.55 : 1 }}>전체 출석</button>
        </span>
      ) : null}
    </div>
  )
}

function MultiSessionRoster({ sessions, records, entriesMap, loadErrors, students, showUncheckedOnly, onChange, onMarkAllPresent, onRetrySession, disabled }) {
  const rows = students.filter((student) => !showUncheckedOnly
    || sessions.some((session) => records[session.id]?.status !== 'closed' && entriesMap[session.id]?.[student.studentUid] === 'unchecked'))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 300 + sessions.length * 180, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 90 }}>학번</th>
            <th style={{ ...th, width: 110 }}>이름</th>
            {sessions.map((session) => (
              <th key={session.id} style={th}>
                <SessionHeadInfo
                  session={session} record={records[session.id]} error={loadErrors[session.id]}
                  uncheckedCount={Object.values(entriesMap[session.id] || {}).filter((value) => value === 'unchecked').length}
                  onMarkAllPresent={() => onMarkAllPresent(session.id)} onRetry={() => onRetrySession(session)} disabled={disabled}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((student) => {
            const rowUnchecked = sessions.some((session) => records[session.id]?.status !== 'closed' && entriesMap[session.id]?.[student.studentUid] === 'unchecked')
            return <tr key={student.studentUid}>
              <td style={{ ...td, borderLeft: `3px solid ${rowUnchecked ? colors.warnLine : 'transparent'}` }}>{student.studentNo || '-'}</td>
              <td style={{ ...td, fontWeight: 700 }}>{student.name || '-'}</td>
              {sessions.map((session) => {
                const value = entriesMap[session.id]?.[student.studentUid]
                if (value === undefined) return <td key={session.id} style={td}><span title="이 교시 명단에 없습니다" style={{ color: '#b6c0cf' }}>—</span></td>
                return <td key={session.id} style={{ ...td, background: value === 'unchecked' && records[session.id]?.status !== 'closed' ? colors.warnBg : undefined }}>
                  <StatusToggle value={value} disabled={disabled || records[session.id]?.status === 'closed'} onChange={(status) => onChange(session.id, student.studentUid, status)} />
                </td>
              })}
            </tr>
          })}
          {!rows.length ? <tr><td colSpan={2 + sessions.length} style={{ padding: 18, textAlign: 'center', color: colors.sub }}>표시할 학생이 없습니다.</td></tr> : null}
        </tbody>
      </table>
    </div>
  )
}

function MobileSessionRoster({ sessions, records, entriesMap, loadErrors, students, showUncheckedOnly, onChange, onMarkAllPresent, onRetrySession, disabled }) {
  const [activeId, setActiveId] = useState(sessions[0]?.id || '')
  const session = sessions.find((row) => row.id === activeId) || sessions[0] || null
  if (!session) return null
  const record = records[session.id]
  const error = loadErrors[session.id]
  const entries = entriesMap[session.id] || {}
  const closed = record?.status === 'closed'
  const rows = students.filter((student) => entries[student.studentUid] !== undefined
    && (!showUncheckedOnly || (!closed && entries[student.studentUid] === 'unchecked')))
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {sessions.length > 1 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sessions.map((row) => {
            const unchecked = Object.values(entriesMap[row.id] || {}).filter((value) => value === 'unchecked').length
            const active = row.id === session.id
            return <button key={row.id} type="button" onClick={() => setActiveId(row.id)} style={{
              ...button, minHeight: 44, flex: '1 1 auto', background: active ? colors.accent : '#f8fafc', color: active ? '#fff' : colors.sub,
              border: `1px solid ${active ? colors.accent : colors.border}`,
            }}>{sessionTitle(row)}{records[row.id]?.status === 'closed' ? ' · 종료' : unchecked ? ` · 미체크 ${unchecked}` : ''}</button>
          })}
        </div>
      ) : null}
      <SessionHeadInfo
        session={session} record={record} error={error}
        uncheckedCount={Object.values(entries).filter((value) => value === 'unchecked').length}
        onMarkAllPresent={() => onMarkAllPresent(session.id)} onRetry={() => onRetrySession(session)} disabled={disabled}
      />
      {rows.map((student) => {
        const value = entries[student.studentUid]
        return <div key={student.studentUid} style={{
          border: `1px solid ${colors.border}`, borderLeft: `3px solid ${value === 'unchecked' && !closed ? colors.warnLine : colors.border}`,
          borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 8, background: value === 'unchecked' && !closed ? colors.warnBg : '#fff',
        }}>
          <div><span style={{ color: colors.sub, marginRight: 8 }}>{student.studentNo || '-'}</span><b>{student.name || '-'}</b></div>
          <StatusToggle value={value} disabled={disabled || closed} onChange={(status) => onChange(session.id, student.studentUid, status)} fill />
        </div>
      })}
      {!rows.length && !error ? <div style={{ padding: 18, textAlign: 'center', color: colors.sub }}>표시할 학생이 없습니다.</div> : null}
    </div>
  )
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

export function AttendancePanel({ user, program, clubs = [], onMessage, onDirtyChange }) {
  const isNarrow = useIsNarrow()
  const dateGroups = useMemo(() => groupScheduleByDate(program?.attendanceSchedule), [program?.attendanceSchedule])
  const [clubId, setClubId] = useState(clubs[0]?.id || '')
  const [dateKey, setDateKey] = useState(() => pickInitialDate(dateGroups))
  const [records, setRecords] = useState({})
  const [entriesMap, setEntriesMap] = useState({})
  const [dirtyMap, setDirtyMap] = useState({})
  const [loadErrors, setLoadErrors] = useState({})
  const [loading, setLoading] = useState(false)
  const [manageSessionId, setManageSessionId] = useState('')
  const [showUncheckedOnly, setShowUncheckedOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [pin, setPin] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const loadSeqRef = useRef(0)
  const rosterRef = useRef([])

  const secure = hasAttendanceApiSession()
  const club = clubs.find((row) => row.id === clubId) || clubs[0] || null
  const group = dateGroups.find((row) => row.date === dateKey) || null
  const sessions = useMemo(() => group?.sessions || [], [group])
  const sessionsSignature = sessions.map((session) => session.id).join(',')
  const manageSession = sessions.find((session) => session.id === manageSessionId) || sessions[0] || null
  const manageRecord = manageSession ? records[manageSession.id] : null

  useEffect(() => { if (!clubs.some((row) => row.id === clubId)) setClubId(clubs[0]?.id || '') }, [clubs, clubId])
  useEffect(() => { if (dateKey && !dateGroups.some((row) => row.date === dateKey)) setDateKey(pickInitialDate(dateGroups)) }, [dateGroups, dateKey])
  useEffect(() => { if (!dateKey && dateGroups.length) setDateKey(pickInitialDate(dateGroups)) }, [dateGroups, dateKey])
  useEffect(() => { setManageSessionId((prev) => (sessions.some((session) => session.id === prev) ? prev : (sessions[0]?.id || ''))) }, [sessions])

  const anyDirty = Object.keys(dirtyMap).length > 0
  const dirtySessionTitles = sessions.filter((session) => dirtyMap[session.id]).map(sessionTitle)

  useEffect(() => { onDirtyChange?.(anyDirty) }, [anyDirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange?.(false) }, [onDirtyChange])
  useEffect(() => {
    if (!anyDirty) return undefined
    const handler = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [anyDirty])

  useEffect(() => {
    loadSeqRef.current += 1
    const seq = loadSeqRef.current
    setRecords({}); setEntriesMap({}); setDirtyMap({}); setLoadErrors({})
    if (!club || !sessions.length || !secure) return
    const targetSessions = sessions
    ;(async () => {
      setLoading(true)
      try {
        const roster = await listClubMembers(club.id)
        if (seq !== loadSeqRef.current) return
        rosterRef.current = roster
        const results = await Promise.allSettled(targetSessions.map((session) => getAttendanceRecord({ program, club, session, roster })))
        if (seq !== loadSeqRef.current) return
        const nextRecords = {}; const nextEntries = {}; const nextErrors = {}
        results.forEach((result, index) => {
          const id = targetSessions[index].id
          if (result.status === 'fulfilled') { nextRecords[id] = result.value; nextEntries[id] = toEntryMap(result.value) }
          else nextErrors[id] = result.reason?.message || '출석부를 불러오지 못했습니다.'
        })
        setRecords(nextRecords); setEntriesMap(nextEntries); setLoadErrors(nextErrors)
      } catch (error) {
        if (seq === loadSeqRef.current) onMessage?.('error', error.message)
      } finally {
        if (seq === loadSeqRef.current) setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, dateKey, program?.id, sessionsSignature, secure, reloadKey])

  const sessionCounts = useMemo(() => {
    const result = {}
    for (const session of sessions) {
      const entries = entriesMap[session.id]
      if (!entries) continue
      result[session.id] = Object.values(entries).reduce((acc, value) => { acc[value] = (acc[value] || 0) + 1; return acc }, { present: 0, absent: 0, unchecked: 0 })
    }
    return result
  }, [sessions, entriesMap])

  const totals = useMemo(() => Object.values(sessionCounts).reduce((acc, counts) => ({
    present: acc.present + counts.present, absent: acc.absent + counts.absent, unchecked: acc.unchecked + counts.unchecked,
  }), { present: 0, absent: 0, unchecked: 0 }), [sessionCounts])

  const unionRoster = useMemo(() => {
    const map = new Map()
    for (const session of sessions) for (const student of records[session.id]?.rosterSnapshot || []) if (!map.has(student.studentUid)) map.set(student.studentUid, student)
    return [...map.values()].sort((a, b) => a.studentNo.localeCompare(b.studentNo, 'ko', { numeric: true }) || a.name.localeCompare(b.name, 'ko'))
  }, [sessions, records])

  const searchedStudents = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return unionRoster
    return unionRoster.filter((student) => `${student.studentNo} ${student.name}`.toLowerCase().includes(keyword))
  }, [unionRoster, search])

  const hasRecords = Object.keys(records).length > 0 || Object.keys(loadErrors).length > 0

  function guardedChange(apply) {
    if (anyDirty && !window.confirm('저장되지 않은 출결 변경이 있습니다. 이동하면 입력한 내용이 사라집니다. 계속할까요?')) return
    apply()
  }

  function onChangeEntry(sessionId, studentUid, status) {
    setEntriesMap((prev) => ({ ...prev, [sessionId]: { ...prev[sessionId], [studentUid]: status } }))
    setDirtyMap((prev) => ({ ...prev, [sessionId]: true }))
  }

  function markAllPresent(sessionId) {
    const record = records[sessionId]
    if (!record || record.status === 'closed') return
    setEntriesMap((prev) => ({ ...prev, [sessionId]: Object.fromEntries(record.rosterSnapshot.map((row) => [row.studentUid, 'present'])) }))
    setDirtyMap((prev) => ({ ...prev, [sessionId]: true }))
  }

  async function retrySession(session) {
    if (!club || !session) return
    setLoading(true)
    try {
      const roster = rosterRef.current.length ? rosterRef.current : await listClubMembers(club.id)
      const next = await getAttendanceRecord({ program, club, session, roster })
      setRecords((prev) => ({ ...prev, [session.id]: next }))
      setEntriesMap((prev) => ({ ...prev, [session.id]: toEntryMap(next) }))
      setLoadErrors((prev) => { const copy = { ...prev }; delete copy[session.id]; return copy })
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function saveAll() {
    const targets = sessions.filter((session) => dirtyMap[session.id] && records[session.id] && records[session.id].status !== 'closed')
    if (!targets.length || !club) return
    const uncheckedTotal = targets.reduce((sum, session) => sum + (sessionCounts[session.id]?.unchecked || 0), 0)
    if (uncheckedTotal > 0 && !window.confirm(`미체크 학생이 총 ${uncheckedTotal}명입니다. 그대로 저장할까요?`)) return
    setLoading(true)
    try {
      const results = await Promise.allSettled(targets.map((session) => saveAttendanceRecord({ program, club, session, entries: entriesMap[session.id], actor: user })))
      const failed = []
      const nextRecords = { ...records }; const nextEntries = { ...entriesMap }; const nextDirty = { ...dirtyMap }
      results.forEach((result, index) => {
        const session = targets[index]
        if (result.status === 'fulfilled') {
          nextRecords[session.id] = result.value
          nextEntries[session.id] = toEntryMap(result.value)
          delete nextDirty[session.id]
        } else failed.push({ session, message: result.reason?.message || '저장에 실패했습니다.' })
      })
      setRecords(nextRecords); setEntriesMap(nextEntries); setDirtyMap(nextDirty)
      if (!failed.length) {
        onMessage?.('ok', targets.length > 1 ? `${targets.length}개 교시 출석부를 저장했습니다.` : '출석부를 저장했습니다.')
      } else {
        const savedTitles = targets.filter((session) => !failed.some((row) => row.session.id === session.id)).map(sessionTitle)
        onMessage?.('error', `${savedTitles.length ? `${savedTitles.join(', ')}는 저장했지만 ` : ''}${failed.map((row) => sessionTitle(row.session)).join(', ')} 저장에 실패했습니다: ${failed[0].message}`)
      }
    } finally { setLoading(false) }
  }

  async function syncRoster() {
    if (!club || !manageSession) return
    setLoading(true)
    try {
      const roster = await listClubMembers(club.id)
      rosterRef.current = roster
      const next = await syncAttendanceRoster({ program, club, session: manageSession, roster })
      setRecords((prev) => ({ ...prev, [manageSession.id]: next }))
      setEntriesMap((prev) => ({ ...prev, [manageSession.id]: toEntryMap(next) }))
      setDirtyMap((prev) => { const copy = { ...prev }; delete copy[manageSession.id]; return copy })
      onMessage?.('ok', `${sessionTitle(manageSession)} 명단을 현재 확정 학생으로 동기화했습니다.`)
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function configure(enabled, rotate = false) {
    if (!club || !manageSession || !manageRecord) return
    setLoading(true)
    try {
      const next = await configurePublicAttendance({ program, club, session: manageSession, enabled, rotate })
      setRecords((prev) => ({ ...prev, [manageSession.id]: { ...prev[manageSession.id], ...next } }))
      onMessage?.('ok', enabled ? (rotate ? 'QR 링크를 재발급했습니다.' : 'QR 공개 수정을 활성화했습니다.') : 'QR 공개 수정을 중지했습니다.')
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function changeSessionStatus(status) {
    if (!club || !manageSession || !manageRecord) return
    if (status === 'closed' && !window.confirm('회차를 종료하면 QR 링크도 즉시 차단됩니다. 종료할까요?')) return
    setLoading(true)
    try {
      const next = await setAttendanceSessionStatus({ program, club, session: manageSession, status })
      setRecords((prev) => ({ ...prev, [manageSession.id]: next }))
      setEntriesMap((prev) => ({ ...prev, [manageSession.id]: toEntryMap(next) }))
      setDirtyMap((prev) => { const copy = { ...prev }; delete copy[manageSession.id]; return copy })
      onMessage?.('ok', status === 'closed' ? '출석 회차를 종료했습니다.' : '출석 회차를 다시 열었습니다.')
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function printSheet() {
    if (!club || !manageSession || !manageRecord) return
    const entries = entriesMap[manageSession.id] || {}
    const qrData = manageRecord.publicEnabled && manageRecord.publicUrl ? await QRCode.toDataURL(manageRecord.publicUrl, { width: 220, margin: 1 }) : ''
    const rows = manageRecord.rosterSnapshot.map((student, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(student.studentNo)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(statusLabel(entries[student.studentUid]))}</td></tr>`).join('')
    const popup = window.open('', '_blank')
    if (!popup) { onMessage?.('error', '인쇄 창을 열 수 없습니다. 팝업 차단을 해제해주세요.'); return }
    popup.opener = null
    popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>출석부</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#111}h1{font-size:22px}.meta{line-height:1.7;margin-bottom:16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #777;padding:8px;text-align:left}.qr{position:absolute;right:28px;top:28px;text-align:center;font-size:11px}.qr img{width:140px;height:140px}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(program.name)} 출석부</h1><div class="meta"><b>수업:</b> ${escapeHtml(club.clubName)}<br><b>일시:</b> ${escapeHtml(manageSession.date)} ${escapeHtml(manageSession.period)}교시 ${escapeHtml(manageSession.label)}<br><b>담당교사:</b> ${escapeHtml((club.teacherNames || [club.teacherName]).filter(Boolean).join(', '))}</div>${qrData ? `<div class="qr"><img src="${qrData}"><div>PIN 확인 후 출결 수정</div></div>` : ''}<table><thead><tr><th>번호</th><th>학번</th><th>이름</th><th>출결</th></tr></thead><tbody>${rows}</tbody></table><button onclick="window.print()">인쇄</button></body></html>`)
    popup.document.close(); popup.focus(); setTimeout(() => popup.print(), 250)
  }

  if (!program?.features?.attendance) return null
  return <div style={{ display: 'grid', gap: 12 }}>
    <section style={card}>
      <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>프로그램 출석부</h2>
      <div style={{ color: colors.sub, fontSize: 13 }}>수업과 날짜를 선택하면 그 날짜의 모든 교시가 자동으로 열립니다. 확정 학생 명단은 회차를 처음 열 때 고정되며, 출결 입력 전에는 명단을 다시 동기화할 수 있습니다.</div>
    </section>
    {!secure ? <section style={{ ...card, color: colors.danger, background: '#fff6f6' }}>출석부 보안 세션이 없습니다. 로그아웃 후 다시 로그인해주세요.</section> : null}
    <section style={{ ...card, display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, alignItems: 'end' }}>
        <label style={{ fontSize: 12, color: colors.sub }}>수업<select value={club?.id || ''} onChange={(e) => { const next = e.target.value; guardedChange(() => setClubId(next)) }} style={{ ...input, minHeight: isNarrow ? 44 : 40 }}>{clubs.map((row) => <option key={row.id} value={row.id}>{row.clubName}</option>)}</select></label>
        <label style={{ fontSize: 12, color: colors.sub }}>날짜<select value={group?.date || ''} onChange={(e) => { const next = e.target.value; guardedChange(() => setDateKey(next)) }} style={{ ...input, minHeight: isNarrow ? 44 : 40 }}>{dateGroups.map((row) => <option key={row.date} value={row.date}>{withWeekday(row.date)} · {row.sessions.length > 1 ? `${row.sessions.length}개 교시` : sessionTitle(row.sessions[0])}</option>)}</select></label>
      </div>
      {!clubs.length ? <div style={{ padding: 16, color: colors.sub }}>담당 수업이 없습니다.</div> : null}
      {!dateGroups.length ? <div style={{ padding: 16, color: colors.sub }}>관리자가 등록한 출석 회차가 없습니다.</div> : null}
      {loading && !hasRecords ? <div style={{ padding: 16, color: colors.sub }}>출석부를 불러오는 중...</div> : null}
    </section>
    {hasRecords ? <>
      <section style={{ ...card, padding: 0, overflow: 'visible' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#fff', borderBottom: `1px solid ${colors.border}`, borderRadius: '12px 12px 0 0', padding: '10px 16px', display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13 }}>
            <b>전체 {unionRoster.length}명</b> · 출석 {totals.present} · 결석 {totals.absent} · <span style={{ color: totals.unchecked ? colors.danger : colors.sub }}>미체크 {totals.unchecked}</span>
            {dirtySessionTitles.length ? <span style={{ marginLeft: 8, color: colors.danger, fontWeight: 700 }}>{dirtySessionTitles.join(', ')} 저장 안 됨</span> : null}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => guardedChange(() => setReloadKey((key) => key + 1))} disabled={loading} style={{ ...button, background: '#f8fafc', color: colors.sub, border: `1px solid ${colors.border}` }}>새로고침</button>
            <button onClick={saveAll} disabled={loading || !anyDirty} style={{ ...button, background: colors.accent, color: '#fff', opacity: loading || !anyDirty ? 0.55 : 1 }}>저장</button>
          </div>
        </div>
        <div style={{ padding: '10px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="학번·이름 검색" style={{ ...input, maxWidth: 240, minHeight: isNarrow ? 44 : 40 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.sub, cursor: 'pointer' }}>
            <input type="checkbox" checked={showUncheckedOnly} onChange={(e) => setShowUncheckedOnly(e.target.checked)} />미체크만 보기
          </label>
        </div>
        <div style={{ padding: '0 16px 16px' }}>
          {isNarrow
            ? <MobileSessionRoster sessions={sessions} records={records} entriesMap={entriesMap} loadErrors={loadErrors} students={searchedStudents} showUncheckedOnly={showUncheckedOnly} onChange={onChangeEntry} onMarkAllPresent={markAllPresent} onRetrySession={retrySession} disabled={loading} />
            : <MultiSessionRoster sessions={sessions} records={records} entriesMap={entriesMap} loadErrors={loadErrors} students={searchedStudents} showUncheckedOnly={showUncheckedOnly} onChange={onChangeEntry} onMarkAllPresent={markAllPresent} onRetrySession={retrySession} disabled={loading} />}
        </div>
      </section>
      <section style={{ ...card, display: 'grid', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>회차 관리 · 인쇄 및 공개 QR</h3>
        {sessions.length > 1 ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {sessions.map((session) => {
              const active = manageSession?.id === session.id
              return <button key={session.id} type="button" onClick={() => setManageSessionId(session.id)} style={{ ...button, minHeight: isNarrow ? 44 : 36, background: active ? colors.accent : '#f8fafc', color: active ? '#fff' : colors.sub, border: `1px solid ${active ? colors.accent : colors.border}` }}>{sessionTitle(session)}</button>
            })}
          </div>
        ) : null}
        {manageRecord ? <>
          <div style={{ fontSize: 13, color: colors.sub }}>
            <b style={{ color: manageRecord.status === 'closed' ? colors.danger : colors.ok }}>{manageRecord.status === 'closed' ? '종료' : '진행중'}</b>
            {' · '}QR {manageRecord.publicEnabled ? '활성' : '중지'} · 명단 {manageRecord.rosterSnapshot.length}명
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <button onClick={syncRoster} disabled={loading || manageRecord.status === 'closed'} style={{ ...button, background: '#f8fafc', color: colors.sub, border: `1px solid ${colors.border}` }}>명단 동기화</button>
            <button onClick={() => changeSessionStatus(manageRecord.status === 'closed' ? 'open' : 'closed')} disabled={loading} style={{ ...button, background: manageRecord.status === 'closed' ? '#e8f7ed' : '#fff0f0', color: manageRecord.status === 'closed' ? colors.ok : colors.danger }}>{manageRecord.status === 'closed' ? '회차 다시 열기' : '회차 종료'}</button>
          </div>
          {user.role === 'admin' ? <div style={{ display: 'flex', gap: 8, alignItems: 'end', maxWidth: 420 }}>
            <label style={{ flex: 1, fontSize: 12, color: colors.sub }}>프로그램 PIN (숫자 4~8자리)<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} style={input} /></label>
            <button onClick={async () => { try { await setAttendancePin({ programId: program.id, pin }); setPin(''); onMessage?.('ok', '프로그램 QR PIN을 저장했습니다.') } catch (error) { onMessage?.('error', error.message) } }} style={{ ...button, background: '#334155', color: '#fff' }}>PIN 저장</button>
          </div> : null}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <button onClick={() => configure(true)} disabled={loading || manageRecord.publicEnabled} style={{ ...button, background: '#e8f7ed', color: colors.ok }}>QR 수정 활성화</button>
            <button onClick={() => configure(true, true)} disabled={loading} style={{ ...button, background: '#fff7e6', color: '#9a6700' }}>QR 재발급</button>
            <button onClick={() => configure(false)} disabled={loading || !manageRecord.publicEnabled} style={{ ...button, background: '#fff0f0', color: colors.danger }}>QR 중지</button>
            <button onClick={printSheet} style={{ ...button, background: colors.accent, color: '#fff' }}>출석부 인쇄</button>
          </div>
          {manageRecord.publicEnabled && manageRecord.publicUrl
            ? <div style={{ fontSize: 12, color: colors.sub, wordBreak: 'break-all' }}>공개 링크: <a href={manageRecord.publicUrl} target="_blank" rel="noreferrer">{manageRecord.publicUrl}</a></div>
            : <div style={{ fontSize: 12, color: colors.sub }}>QR이 중지되어 있으며 인쇄물에는 QR이 표시되지 않습니다.</div>}
        </> : (manageSession && loadErrors[manageSession.id] ? <div style={{ color: colors.danger, fontSize: 13 }}>이 교시 출석부를 불러오지 못했습니다. 명단 영역에서 재시도해주세요.</div> : null)}
      </section>
    </> : null}
  </div>
}

export function PublicAttendancePage({ token }) {
  const [pin, setPin] = useState('')
  const [record, setRecord] = useState(null)
  const [entries, setEntries] = useState({})
  const [editToken, setEditToken] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  async function unlock(event) { event.preventDefault(); setLoading(true); setError(''); try { const result = await unlockPublicAttendance(token, pin); const next = result.record || result; setRecord(next); setEntries(toEntryMap(next)); setEditToken(result.editToken || ''); setPin('') } catch (e) { setError(e.message) } finally { setLoading(false) } }
  async function save() { setLoading(true); setError(''); try { const next = await savePublicAttendance(token, editToken, entries); setRecord(next); setEntries(toEntryMap(next)); setMessage('출석부를 저장했습니다.') } catch (e) { setError(e.message) } finally { setLoading(false) } }
  return <main style={{ minHeight: '100vh', background: '#f4f7fb', padding: 16, boxSizing: 'border-box' }}><div style={{ maxWidth: 760, margin: '0 auto', display: 'grid', gap: 12 }}><section style={card}><h1 style={{ margin: '0 0 6px', fontSize: 20 }}>QR 출석부</h1><div style={{ color: colors.sub, fontSize: 13 }}>PIN 확인 후에만 학생 명단과 출결 정보를 볼 수 있습니다.</div></section>{error ? <div style={{ ...card, color: colors.danger, background: '#fff6f6' }}>{error}</div> : null}{message ? <div style={{ ...card, color: colors.ok, background: '#f2fbf5' }}>{message}</div> : null}{!record ? <form onSubmit={unlock} style={{ ...card, display: 'grid', gap: 10 }}><label style={{ fontSize: 13, color: colors.sub }}>프로그램 PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} style={input} /></label><button disabled={loading || pin.length < 4} style={{ ...button, background: colors.accent, color: '#fff' }}>{loading ? '확인 중...' : '출석부 열기'}</button></form> : <section style={card}><div style={{ marginBottom: 10, color: colors.sub }}>전체 {(record.rosterSnapshot || []).length}명</div><AttendanceRoster record={record} entries={entries} onChange={(uid, status) => setEntries((prev) => ({ ...prev, [uid]: status }))} disabled={loading} /><button onClick={save} disabled={loading} style={{ ...button, marginTop: 12, width: '100%', background: colors.accent, color: '#fff' }}>{loading ? '저장 중...' : '출석부 저장'}</button></section>}</div></main>
}
