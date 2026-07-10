import { useEffect, useMemo, useState } from 'react'
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

const colors = { accent: '#1769e0', border: '#dce3ec', text: '#172033', sub: '#64748b', ok: '#16803c', danger: '#c62828' }
const card = { background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12, padding: 16 }
const input = { width: '100%', minHeight: 40, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 10px', boxSizing: 'border-box', background: '#fff' }
const button = { minHeight: 38, border: 0, borderRadius: 8, padding: '8px 12px', cursor: 'pointer', fontWeight: 700 }

function statusLabel(value) {
  if (value === 'present') return '출석'
  if (value === 'absent') return '결석'
  return '미체크'
}

function toEntryMap(record) {
  return Object.fromEntries((record?.rosterSnapshot || []).map((student) => [student.studentUid, record.entries?.[student.studentUid]?.status || 'unchecked']))
}

function AttendanceRoster({ record, entries, onChange, disabled = false }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 540, borderCollapse: 'collapse' }}>
        <thead><tr>{['학번', '이름', '출결'].map((head) => <th key={head} style={{ padding: 9, textAlign: 'left', borderBottom: `1px solid ${colors.border}`, color: colors.sub, fontSize: 12 }}>{head}</th>)}</tr></thead>
        <tbody>
          {(record?.rosterSnapshot || []).map((student) => {
            const value = entries[student.studentUid] || 'unchecked'
            return <tr key={student.studentUid}>
              <td style={{ padding: 9, borderBottom: `1px solid ${colors.border}` }}>{student.studentNo || '-'}</td>
              <td style={{ padding: 9, borderBottom: `1px solid ${colors.border}`, fontWeight: 700 }}>{student.name || '-'}</td>
              <td style={{ padding: 9, borderBottom: `1px solid ${colors.border}` }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['present', 'absent'].map((status) => <button key={status} type="button" disabled={disabled} onClick={() => onChange(student.studentUid, status)} style={{ ...button, minHeight: 32, padding: '5px 11px', background: value === status ? (status === 'present' ? '#e8f7ed' : '#fff0f0') : '#f8fafc', color: value === status ? (status === 'present' ? colors.ok : colors.danger) : colors.sub, border: `1px solid ${value === status ? 'currentColor' : colors.border}` }}>{statusLabel(status)}</button>)}
                </div>
              </td>
            </tr>
          })}
          {!record?.rosterSnapshot?.length ? <tr><td colSpan="3" style={{ padding: 18, textAlign: 'center', color: colors.sub }}>확정 학생이 없습니다.</td></tr> : null}
        </tbody>
      </table>
    </div>
  )
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

export function AttendancePanel({ user, program, clubs = [], onMessage }) {
  const sessions = useMemo(() => program?.attendanceSchedule || [], [program?.attendanceSchedule])
  const [clubId, setClubId] = useState(clubs[0]?.id || '')
  const [sessionId, setSessionId] = useState(sessions[0]?.id || '')
  const [record, setRecord] = useState(null)
  const [entries, setEntries] = useState({})
  const [loading, setLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pin, setPin] = useState('')
  const club = clubs.find((row) => row.id === clubId) || clubs[0] || null
  const session = sessions.find((row) => row.id === sessionId) || sessions[0] || null

  useEffect(() => { if (!clubs.some((row) => row.id === clubId)) setClubId(clubs[0]?.id || '') }, [clubs, clubId])
  useEffect(() => { if (!sessions.some((row) => row.id === sessionId)) setSessionId(sessions[0]?.id || '') }, [sessions, sessionId])

  async function load() {
    if (!club || !session) return
    setLoading(true)
    try {
      if (!hasAttendanceApiSession()) throw new Error('출석부 보안 세션이 없습니다. 로그아웃 후 다시 로그인해주세요.')
      const roster = await listClubMembers(club.id)
      const next = await getAttendanceRecord({ program, club, session, roster })
      setRecord(next); setEntries(toEntryMap(next)); setDirty(false)
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  useEffect(() => { setRecord(null); setEntries({}); setDirty(false) }, [clubId, sessionId, program?.id])

  const counts = useMemo(() => Object.values(entries).reduce((result, value) => ({ ...result, [value]: (result[value] || 0) + 1 }), { present: 0, absent: 0, unchecked: 0 }), [entries])

  async function save() {
    if (!record || !club || !session) return
    if (counts.unchecked > 0 && !window.confirm(`미체크 학생이 ${counts.unchecked}명입니다. 그대로 저장할까요?`)) return
    setLoading(true)
    try {
      const next = await saveAttendanceRecord({ program, club, session, entries, actor: user })
      setRecord(next); setEntries(toEntryMap(next)); setDirty(false); onMessage?.('ok', '출석부를 저장했습니다.')
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function syncRoster() {
    if (!record || !club || !session) return
    setLoading(true)
    try {
      const roster = await listClubMembers(club.id)
      const next = await syncAttendanceRoster({ program, club, session, roster })
      setRecord(next); setEntries(toEntryMap(next)); setDirty(false); onMessage?.('ok', '현재 확정 학생 명단으로 동기화했습니다.')
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function configure(enabled, rotate = false) {
    if (!record || !club || !session) return
    setLoading(true)
    try {
      const next = await configurePublicAttendance({ program, club, session, enabled, rotate })
      setRecord((prev) => ({ ...prev, ...next })); onMessage?.('ok', enabled ? (rotate ? 'QR 링크를 재발급했습니다.' : 'QR 공개 수정을 활성화했습니다.') : 'QR 공개 수정을 중지했습니다.')
    } catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function changeSessionStatus(status) {
    if (!record || !club || !session) return
    if (status === 'closed' && !window.confirm('회차를 종료하면 QR 링크도 즉시 차단됩니다. 종료할까요?')) return
    setLoading(true)
    try { const next = await setAttendanceSessionStatus({ program, club, session, status }); setRecord(next); setEntries(toEntryMap(next)); onMessage?.('ok', status === 'closed' ? '출석 회차를 종료했습니다.' : '출석 회차를 다시 열었습니다.') }
    catch (error) { onMessage?.('error', error.message) } finally { setLoading(false) }
  }

  async function printSheet() {
    if (!record || !club || !session) return
    const qrData = record.publicEnabled && record.publicUrl ? await QRCode.toDataURL(record.publicUrl, { width: 220, margin: 1 }) : ''
    const rows = record.rosterSnapshot.map((student, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(student.studentNo)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(statusLabel(entries[student.studentUid]))}</td></tr>`).join('')
    const popup = window.open('', '_blank')
    if (!popup) { onMessage?.('error', '인쇄 창을 열 수 없습니다. 팝업 차단을 해제해주세요.'); return }
    popup.opener = null
    popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>출석부</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#111}h1{font-size:22px}.meta{line-height:1.7;margin-bottom:16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #777;padding:8px;text-align:left}.qr{position:absolute;right:28px;top:28px;text-align:center;font-size:11px}.qr img{width:140px;height:140px}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(program.name)} 출석부</h1><div class="meta"><b>수업:</b> ${escapeHtml(club.clubName)}<br><b>일시:</b> ${escapeHtml(session.date)} ${escapeHtml(session.period)}교시 ${escapeHtml(session.label)}<br><b>담당교사:</b> ${escapeHtml((club.teacherNames || [club.teacherName]).filter(Boolean).join(', '))}</div>${qrData ? `<div class="qr"><img src="${qrData}"><div>PIN 확인 후 출결 수정</div></div>` : ''}<table><thead><tr><th>번호</th><th>학번</th><th>이름</th><th>출결</th></tr></thead><tbody>${rows}</tbody></table><button onclick="window.print()">인쇄</button></body></html>`)
    popup.document.close(); popup.focus(); setTimeout(() => popup.print(), 250)
  }

  if (!program?.features?.attendance) return null
  return <div style={{ display: 'grid', gap: 12 }}>
    <section style={card}><h2 style={{ margin: '0 0 6px', fontSize: 18 }}>프로그램 출석부</h2><div style={{ color: colors.sub, fontSize: 13 }}>확정 학생 명단은 회차를 처음 열 때 고정됩니다. 출결 입력 전에는 명단을 다시 동기화할 수 있습니다.</div></section>
    <section style={{ ...card, display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, alignItems: 'end' }}>
        <label style={{ fontSize: 12, color: colors.sub }}>수업<select value={club?.id || ''} onChange={(e) => setClubId(e.target.value)} style={input}>{clubs.map((row) => <option key={row.id} value={row.id}>{row.clubName}</option>)}</select></label>
        <label style={{ fontSize: 12, color: colors.sub }}>회차<select value={session?.id || ''} onChange={(e) => setSessionId(e.target.value)} style={input}>{sessions.map((row) => <option key={row.id} value={row.id}>{row.date} · {row.period}교시{row.label ? ` · ${row.label}` : ''}{row.active === false ? ' · 보관' : ''}</option>)}</select></label>
        <button onClick={load} disabled={loading || !club || !session} style={{ ...button, background: colors.accent, color: '#fff' }}>{loading ? '처리 중...' : '출석부 열기'}</button>
      </div>
      {!clubs.length ? <div style={{ padding: 16, color: colors.sub }}>담당 수업이 없습니다.</div> : null}
      {!sessions.length ? <div style={{ padding: 16, color: colors.sub }}>관리자가 등록한 출석 회차가 없습니다.</div> : null}
    </section>
    {record ? <>
      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><div><b>전체 {record.rosterSnapshot.length}명</b> · 출석 {counts.present} · 결석 {counts.absent} · <span style={{ color: counts.unchecked ? colors.danger : colors.sub }}>미체크 {counts.unchecked}</span> · <b>{record.status === 'closed' ? '종료' : '진행중'}</b>{dirty ? <span style={{ marginLeft: 8, color: colors.danger }}>저장되지 않은 변경</span> : null}</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button onClick={() => { setEntries(Object.fromEntries(record.rosterSnapshot.map((row) => [row.studentUid, 'present']))); setDirty(true) }} disabled={record.status === 'closed'} style={{ ...button, background: '#e8f7ed', color: colors.ok }}>전체 출석</button><button onClick={syncRoster} disabled={loading || record.status === 'closed'} style={{ ...button, background: '#f8fafc', color: colors.sub, border: `1px solid ${colors.border}` }}>명단 동기화</button><button onClick={save} disabled={loading || !dirty || record.status === 'closed'} style={{ ...button, background: colors.accent, color: '#fff' }}>저장</button><button onClick={() => changeSessionStatus(record.status === 'closed' ? 'open' : 'closed')} disabled={loading} style={{ ...button, background: record.status === 'closed' ? '#e8f7ed' : '#fff0f0', color: record.status === 'closed' ? colors.ok : colors.danger }}>{record.status === 'closed' ? '회차 다시 열기' : '회차 종료'}</button></div></div>
        <AttendanceRoster record={record} entries={entries} onChange={(uid, status) => { setEntries((prev) => ({ ...prev, [uid]: status })); setDirty(true) }} disabled={loading || record.status === 'closed'} />
      </section>
      <section style={{ ...card, display: 'grid', gap: 10 }}><h3 style={{ margin: 0, fontSize: 16 }}>인쇄 및 공개 QR</h3>{user.role === 'admin' ? <div style={{ display: 'flex', gap: 8, alignItems: 'end', maxWidth: 420 }}><label style={{ flex: 1, fontSize: 12, color: colors.sub }}>프로그램 PIN (숫자 4~8자리)<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} style={input} /></label><button onClick={async () => { try { await setAttendancePin({ programId: program.id, pin }); setPin(''); onMessage?.('ok', '프로그램 QR PIN을 저장했습니다.') } catch (error) { onMessage?.('error', error.message) } }} style={{ ...button, background: '#334155', color: '#fff' }}>PIN 저장</button></div> : null}<div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}><button onClick={() => configure(true)} disabled={loading || record.publicEnabled} style={{ ...button, background: '#e8f7ed', color: colors.ok }}>QR 수정 활성화</button><button onClick={() => configure(true, true)} disabled={loading} style={{ ...button, background: '#fff7e6', color: '#9a6700' }}>QR 재발급</button><button onClick={() => configure(false)} disabled={loading || !record.publicEnabled} style={{ ...button, background: '#fff0f0', color: colors.danger }}>QR 중지</button><button onClick={printSheet} style={{ ...button, background: colors.accent, color: '#fff' }}>출석부 인쇄</button></div>{record.publicEnabled && record.publicUrl ? <div style={{ fontSize: 12, color: colors.sub, wordBreak: 'break-all' }}>공개 링크: <a href={record.publicUrl} target="_blank" rel="noreferrer">{record.publicUrl}</a></div> : <div style={{ fontSize: 12, color: colors.sub }}>QR이 중지되어 있으며 인쇄물에는 QR이 표시되지 않습니다.</div>}</section>
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
