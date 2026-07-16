import { useEffect, useMemo, useState } from 'react'
import {
  getStudentActivityRecord,
  listTeacherActivityRecords,
  saveStudentActivityRecord,
  saveTeacherActivityRecord,
} from '../../services/activityRecordService'

const color = {
  border: '#dfe3ee', text: '#1c2431', sub: '#5f6b7d', accent: '#1f6feb',
  danger: '#c62828', ok: '#2e7d32', warn: '#c77700', muted: '#eef2f8',
}

const card = { background: '#fff', border: `1px solid ${color.border}`, borderRadius: 12, padding: 16 }
const input = { width: '100%', boxSizing: 'border-box', border: `1px solid ${color.border}`, borderRadius: 8, padding: '9px 10px', font: 'inherit', color: color.text, background: '#fff' }
const button = { border: 'none', borderRadius: 8, padding: '9px 13px', cursor: 'pointer', font: 'inherit' }

const COMMON_QUESTIONS = [
  { key: 'activity', title: '활동 내용', question: '프로그램에서 실제로 한 주요 활동을 구체적으로 작성하세요.', limit: 200 },
  { key: 'contribution', title: '역할과 기여', question: '활동에서 본인이 맡거나 스스로 한 일, 다른 사람이나 모둠에 기여한 일을 작성하세요.', limit: 200 },
  { key: 'learning', title: '배운 점', question: '활동을 통해 새롭게 알게 된 내용이나 익힌 기능을 구체적으로 작성하세요.', limit: 250 },
  { key: 'change', title: '느낀 점과 변화', question: '활동 전후로 생각·태도·관심이 달라진 점과 그렇게 된 계기를 작성하세요.', limit: 250 },
  { key: 'followUp', title: '후속 활동', question: '앞으로 더 해보고 싶은 활동이나 알아보고 싶은 주제와 그 이유를 작성하세요.', limit: 200 },
]

const EMPTY_COMMON = Object.fromEntries(COMMON_QUESTIONS.map((row) => [row.key, '']))

function formatTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR')
}

function windowMessage(windowState) {
  if (!windowState?.configured) return '관리자가 아직 학생 활동 기록 기간을 설정하지 않았습니다.'
  if (windowState.phase === 'before') return `${formatTime(windowState.startAt)}부터 작성할 수 있습니다.`
  if (windowState.phase === 'closed') return `작성 기간이 ${formatTime(windowState.endAt)}에 종료되었습니다.`
  return `${formatTime(windowState.endAt)}까지 작성·수정할 수 있습니다.`
}

function statusMeta(record) {
  if (record?.studentStatus !== 'submitted') return { label: '학생 미작성', bg: '#f1f5f9', fg: color.sub }
  if (record?.teacherStatus === 'completed') return { label: '작성 완료', bg: '#e8f5e9', fg: color.ok }
  if (record?.teacherStatus === 'reviewing') return { label: '교사 검토 중', bg: '#edf4ff', fg: color.accent }
  return { label: '학생 작성 완료', bg: '#fff8e1', fg: color.warn }
}

function StatusBadge({ record }) {
  const meta = statusMeta(record)
  return <span style={{ display: 'inline-flex', padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 800, background: meta.bg, color: meta.fg }}>{meta.label}</span>
}

function Field({ title, help, required, value, limit, disabled, onChange }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 800 }}>{title}{required ? <span style={{ color: color.danger }}> *</span> : null}</span>
      <span style={{ fontSize: 12, color: color.sub, lineHeight: 1.55 }}>{help}</span>
      <textarea
        value={value}
        disabled={disabled}
        maxLength={limit}
        rows={4}
        onChange={(event) => onChange(event.target.value)}
        style={{ ...input, resize: 'vertical', minHeight: 92, background: disabled ? '#f8fafc' : '#fff' }}
      />
      <span style={{ justifySelf: 'end', fontSize: 11, color: value.length >= limit ? color.danger : color.sub }}>{value.length}/{limit}</span>
    </label>
  )
}

export function StudentActivityRecordPage({ user, program }) {
  const [data, setData] = useState(null)
  const [commonAnswers, setCommonAnswers] = useState(EMPTY_COMMON)
  const [additionalAnswers, setAdditionalAnswers] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  function applyData(next) {
    setData(next)
    setCommonAnswers({ ...EMPTY_COMMON, ...(next?.record?.commonAnswers || {}) })
    setAdditionalAnswers(next?.record?.additionalAnswers || {})
  }

  useEffect(() => {
    let active = true
    getStudentActivityRecord({ program, user })
      .then((next) => { if (active) applyData(next) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '활동 기록을 불러오지 못했습니다.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [program, user])

  async function save(mode) {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const next = await saveStudentActivityRecord({ program, user, commonAnswers, additionalAnswers, mode })
      applyData(next)
      setMessage(mode === 'submit' ? '학생 활동 기록을 제출했습니다.' : '임시 저장했습니다.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '활동 기록을 저장하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section style={card}>학생 활동 기록을 불러오는 중입니다.</section>
  if (error && !data) return <section style={{ ...card, color: color.danger }}>{error}</section>
  if (!data?.eligible) {
    return (
      <section style={card}>
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>학생 활동 기록</h2>
        <div style={{ fontSize: 13, color: color.sub }}>현재 프로그램의 확정 참여 명단에 포함된 학생만 작성할 수 있습니다.</div>
      </section>
    )
  }

  const editable = data.window?.open === true && !saving

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: '0 0 5px', fontSize: 18 }}>{program.name} 활동 기록</h2>
            <div style={{ fontSize: 13, color: color.sub }}>{data.club?.clubName || '-'} · {windowMessage(data.window)}</div>
          </div>
          <StatusBadge record={data.record} />
        </div>
        <div style={{ marginTop: 12, padding: 11, borderRadius: 9, background: '#f6f9ff', color: color.sub, fontSize: 12, lineHeight: 1.6 }}>
          “열심히 했다” 같은 표현보다 본인이 실제로 한 행동과 구체적인 사례를 작성해주세요. 제출한 내용은 담당교사가 확인하는 참고자료이며 생활기록부에 그대로 복사되지 않습니다.
        </div>
        {data.record?.studentUpdatedAfterReview ? <div style={{ marginTop: 8, color: color.warn, fontSize: 12 }}>교사 검토 후 학생 기록이 변경되어 다시 검토 중입니다.</div> : null}
        {message ? <div style={{ marginTop: 10, color: color.ok, fontSize: 13 }}>{message}</div> : null}
        {error ? <div style={{ marginTop: 10, color: color.danger, fontSize: 13 }}>{error}</div> : null}
      </section>

      <section style={{ ...card, display: 'grid', gap: 18 }}>
        {COMMON_QUESTIONS.map((row) => (
          <Field key={row.key} title={row.title} help={row.question} required value={commonAnswers[row.key] || ''} limit={row.limit} disabled={!editable} onChange={(value) => setCommonAnswers((prev) => ({ ...prev, [row.key]: value }))} />
        ))}
      </section>

      {(data.questions || []).length > 0 ? (
        <section style={{ ...card, display: 'grid', gap: 18 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>프로그램 추가 질문</h3>
          {data.questions.map((question) => (
            <Field key={question.id} title={question.title} help={question.helpText || '구체적인 활동 사례를 중심으로 작성해주세요.'} required={question.required} value={additionalAnswers[question.id] || ''} limit={300} disabled={!editable} onChange={(value) => setAdditionalAnswers((prev) => ({ ...prev, [question.id]: value }))} />
          ))}
        </section>
      ) : null}

      <section style={{ ...card, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => save('draft')} disabled={!editable} style={{ ...button, background: '#fff', border: `1px solid ${color.border}`, color: color.sub, opacity: editable ? 1 : 0.5 }}>임시 저장</button>
        <button type="button" onClick={() => save('submit')} disabled={!editable} style={{ ...button, background: editable ? color.accent : '#cfd8e3', color: '#fff', fontWeight: 800 }}>활동 기록 제출</button>
      </section>
    </div>
  )
}

function TeacherRecordEditor({ row, program, actor, onSaved, onError }) {
  const [observationNote, setObservationNote] = useState(row.observationNote || '')
  const [studentRecordText, setStudentRecordText] = useState(row.studentRecordText || '')
  const [saving, setSaving] = useState(false)

  async function save(teacherStatus) {
    setSaving(true)
    onError('')
    try {
      const next = await saveTeacherActivityRecord({ program, actor, clubId: row.clubId, studentUid: row.studentUid, observationNote, studentRecordText, teacherStatus })
      onSaved(next, teacherStatus === 'completed' ? '생활기록부 작성 내용을 완료 처리했습니다.' : '교사 검토 내용을 저장했습니다.')
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '교사 기록을 저장하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const snapshotMap = new Map((row.questionSnapshot || []).map((question) => [question.id, question]))

  return (
    <section style={{ ...card, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{row.studentNo} {row.studentName}</h3>
          <div style={{ fontSize: 12, color: color.sub }}>{row.clubName} · 학생 제출 {formatTime(row.submittedAt)}</div>
        </div>
        <StatusBadge record={row} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        {[['진로희망', row.application?.careerGoal], ['신청사유', row.application?.applyReason], ['희망활동', row.application?.wantedActivity]].map(([label, value]) => (
          <div key={label} style={{ padding: 10, borderRadius: 8, background: '#f8fafc' }}><div style={{ fontSize: 11, fontWeight: 800, color: color.sub }}>{label}</div><div style={{ marginTop: 4, fontSize: 13, whiteSpace: 'pre-wrap' }}>{value || '-'}</div></div>
        ))}
      </div>

      <div style={{ padding: 10, borderRadius: 8, background: '#f6f9ff', fontSize: 13 }}>
        출석 {row.attendance?.present || 0}회 · 결석 {row.attendance?.absent || 0}회 · 미체크 {row.attendance?.unchecked || 0}회 / 전체 {row.attendance?.total || 0}회
      </div>

      {row.studentStatus !== 'submitted' ? (
        <div style={{ padding: 14, borderRadius: 9, background: '#f8fafc', color: color.sub, fontSize: 13 }}>학생이 아직 활동 기록을 작성하지 않았습니다.</div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {COMMON_QUESTIONS.map((question) => (
            <div key={question.key} style={{ padding: 11, border: `1px solid ${color.border}`, borderRadius: 9 }}><div style={{ fontSize: 12, fontWeight: 800, color: color.sub }}>{question.title}</div><div style={{ marginTop: 5, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{row.commonAnswers?.[question.key] || '-'}</div></div>
          ))}
          {Object.entries(row.additionalAnswers || {}).map(([questionId, answer]) => (
            <div key={questionId} style={{ padding: 11, border: `1px solid ${color.border}`, borderRadius: 9 }}><div style={{ fontSize: 12, fontWeight: 800, color: color.sub }}>{snapshotMap.get(questionId)?.title || '프로그램 추가 질문'}</div><div style={{ marginTop: 5, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{answer || '-'}</div></div>
          ))}
        </div>
      )}

      {row.studentUpdatedAfterReview ? <div style={{ padding: 10, borderRadius: 8, background: '#fff8e1', color: color.warn, fontSize: 12 }}>교사 검토 후 학생 답변이 변경되었습니다. 다시 확인해주세요.</div> : null}

      <Field title="교사 관찰 메모" help="학생에게 공개되지 않는 담당교사 전용 메모입니다." value={observationNote} limit={2000} disabled={saving} onChange={setObservationNote} />
      <Field title="생활기록부 작성 내용" help="학생 답변을 그대로 복사하지 않고 실제 관찰 사실을 확인해 작성해주세요." value={studentRecordText} limit={3000} disabled={saving} onChange={setStudentRecordText} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" disabled={saving} onClick={() => save('reviewing')} style={{ ...button, background: '#fff', border: `1px solid ${color.border}`, color: color.sub }}>검토 내용 저장</button>
        <button type="button" disabled={saving || row.studentStatus !== 'submitted'} onClick={() => save('completed')} style={{ ...button, background: saving || row.studentStatus !== 'submitted' ? '#cfd8e3' : color.ok, color: '#fff', fontWeight: 800 }}>작성 완료</button>
      </div>
    </section>
  )
}

export function TeacherActivityRecordPage({ user, program }) {
  const [meta, setMeta] = useState(null)
  const [rowsByClub, setRowsByClub] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [query, setQuery] = useState('')
  const [clubId, setClubId] = useState('')
  const [status, setStatus] = useState('all')
  const [selectedKey, setSelectedKey] = useState('')

  useEffect(() => {
    let active = true
    listTeacherActivityRecords({ program, actor: user, metaOnly: true })
      .then((next) => {
        if (!active) return
        setMeta(next)
        if ((next.clubs || []).length === 1) setClubId(next.clubs[0].id)
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '학생 활동 기록을 불러오지 못했습니다.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [program, user])

  const rowsLoading = Boolean(clubId) && !(clubId in rowsByClub)

  useEffect(() => {
    if (!clubId || clubId in rowsByClub) return
    let active = true
    listTeacherActivityRecords({ program, actor: user, clubId })
      .then((next) => {
        if (!active) return
        setRowsByClub((prev) => ({ ...prev, [clubId]: next.rows }))
        setMeta((prev) => (prev ? { ...prev, window: next.window } : next))
        setError('')
      })
      .catch((reason) => {
        if (!active) return
        setRowsByClub((prev) => ({ ...prev, [clubId]: [] }))
        setError(reason instanceof Error ? reason.message : '학생 활동 기록을 불러오지 못했습니다.')
      })
    return () => { active = false }
  }, [clubId, program, user, rowsByClub])

  const rows = useMemo(() => (clubId ? rowsByClub[clubId] || [] : []), [clubId, rowsByClub])
  const filtered = useMemo(() => rows.filter((row) => {
    if (status !== 'all' && statusMeta(row).label !== status) return false
    const token = `${row.studentNo} ${row.studentName} ${row.clubName}`.toLowerCase()
    return token.includes(query.trim().toLowerCase())
  }), [query, rows, status])
  const selected = filtered.find((row) => `${row.clubId}::${row.studentUid}` === selectedKey) || filtered[0] || null

  function onSaved(next, text) {
    if (clubId) setRowsByClub((prev) => ({ ...prev, [clubId]: next.rows }))
    setMessage(text)
    setError('')
  }

  function refreshCurrentClub() {
    if (!clubId || rowsLoading) return
    setRowsByClub((prev) => {
      const next = { ...prev }
      delete next[clubId]
      return next
    })
  }

  if (loading) return <section style={card}>학생 활동 기록을 불러오는 중입니다.</section>

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section style={card}>
        <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>{program.name} 학생 활동 기록</h2>
        <div style={{ fontSize: 13, color: color.sub }}>{windowMessage(meta?.window)} · 담당 수업의 확정 학생만 표시됩니다.</div>
        {message ? <div style={{ marginTop: 9, color: color.ok, fontSize: 13 }}>{message}</div> : null}
        {error ? <div style={{ marginTop: 9, color: color.danger, fontSize: 13 }}>{error}</div> : null}
      </section>

      <section style={{ ...card, display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
          <select value={clubId} onChange={(event) => { setClubId(event.target.value); setSelectedKey(''); setMessage('') }} style={input}><option value="">수업을 선택하세요</option>{(meta?.clubs || []).map((club) => <option key={club.id} value={club.id}>{club.clubName}</option>)}</select>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="학번·이름 검색" style={input} />
          <select value={status} onChange={(event) => setStatus(event.target.value)} style={input}><option value="all">전체 상태</option>{['학생 미작성', '학생 작성 완료', '교사 검토 중', '작성 완료'].map((label) => <option key={label} value={label}>{label}</option>)}</select>
          <button type="button" disabled={!clubId || rowsLoading} onClick={refreshCurrentClub} style={{ ...button, background: '#fff', border: `1px solid ${color.border}`, color: color.sub, opacity: !clubId || rowsLoading ? 0.5 : 1 }}>새로고침</button>
        </div>
        {clubId ? (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', fontSize: 12 }}>
            {['학생 미작성', '학생 작성 완료', '교사 검토 중', '작성 완료'].map((label) => <span key={label} style={{ padding: '4px 8px', background: '#f8fafc', borderRadius: 999 }}>{label} {rows.filter((row) => statusMeta(row).label === label).length}명</span>)}
          </div>
        ) : null}
      </section>

      {!clubId ? (
        <section style={{ ...card, color: color.sub, fontSize: 13 }}>수업을 선택하면 해당 수업 학생들의 활동 기록을 불러옵니다.</section>
      ) : rowsLoading ? (
        <section style={{ ...card, color: color.sub, fontSize: 13 }}>선택한 수업의 학생 활동 기록을 불러오는 중입니다.</section>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 12, alignItems: 'start' }}>
          <section style={{ ...card, padding: 9, display: 'grid', gap: 5, maxHeight: '72vh', overflow: 'auto' }}>
            {filtered.map((row) => {
              const key = `${row.clubId}::${row.studentUid}`
              const active = selected && selected.clubId === row.clubId && selected.studentUid === row.studentUid
              return (
                <button key={key} type="button" onClick={() => setSelectedKey(key)} style={{ ...button, padding: 10, textAlign: 'left', background: active ? '#edf4ff' : '#fff', border: `1px solid ${active ? '#bfd4f7' : color.border}` }}>
                  <div style={{ fontSize: 13, fontWeight: 800 }}>{row.studentNo} {row.studentName}</div>
                  <div style={{ marginTop: 3, fontSize: 11, color: color.sub }}>{row.clubName}</div>
                  <div style={{ marginTop: 6 }}><StatusBadge record={row} /></div>
                </button>
              )
            })}
            {filtered.length === 0 ? <div style={{ padding: 12, fontSize: 12, color: color.sub }}>조건에 맞는 학생이 없습니다.</div> : null}
          </section>
          {selected ? <TeacherRecordEditor key={`${selected.clubId}:${selected.studentUid}:${selected.studentUpdatedAt || ''}:${selected.teacherUpdatedAt || ''}`} row={selected} program={program} actor={user} onSaved={onSaved} onError={setError} /> : <section style={card}>학생을 선택해주세요.</section>}
        </div>
      )}
    </div>
  )
}
