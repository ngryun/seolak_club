import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getStudentActivityRecord,
  getTeacherActivityAttendanceSummary,
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

const RECORD_TEXT_LIMIT = 3000
const NEIS_BYTE_LIMIT = 1500

// NEIS 기준 바이트 계산: 한글 등 다국어 문자 3Byte, 줄바꿈 2Byte, 영문·숫자·공백 1Byte
function neisBytes(text) {
  let bytes = 0
  for (const ch of text) {
    if (ch === '\n') bytes += 2
    else bytes += ch.charCodeAt(0) > 127 ? 3 : 1
  }
  return bytes
}

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

function StudentAnswerDetails({ row }) {
  const snapshotMap = new Map((row.questionSnapshot || []).map((question) => [question.id, question]))
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        {[['진로희망', row.application?.careerGoal], ['신청사유', row.application?.applyReason], ['희망활동', row.application?.wantedActivity]].map(([label, value]) => (
          <div key={label} style={{ padding: 10, borderRadius: 8, background: '#f8fafc' }}><div style={{ fontSize: 11, fontWeight: 800, color: color.sub }}>{label}</div><div style={{ marginTop: 4, fontSize: 13, whiteSpace: 'pre-wrap' }}>{value || '-'}</div></div>
        ))}
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
    </div>
  )
}

function StudentAnswerModal({ row, program, onClose }) {
  const [attendance, setAttendance] = useState(null)

  useEffect(() => {
    let active = true
    getTeacherActivityAttendanceSummary({ program, clubId: row.clubId, studentUid: row.studentUid })
      .then((summary) => { if (active) setAttendance(summary) })
      .catch(() => { if (active) setAttendance(undefined) })
    return () => { active = false }
  }, [program, row.clubId, row.studentUid])

  useEffect(() => {
    function onKey(event) { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto', zIndex: 1000 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        style={{ ...card, width: '100%', maxWidth: 720, margin: 'auto', display: 'grid', gap: 14 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{row.studentNo} {row.studentName}</h3>
            <div style={{ fontSize: 12, color: color.sub }}>{row.clubName} · 학생 제출 {formatTime(row.submittedAt)}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusBadge record={row} />
            <button type="button" onClick={onClose} aria-label="닫기" style={{ ...button, padding: '6px 12px', background: '#fff', border: `1px solid ${color.border}`, color: color.sub, fontWeight: 800 }}>닫기 ✕</button>
          </div>
        </div>

        <div style={{ padding: 10, borderRadius: 8, background: '#f6f9ff', fontSize: 13 }}>
          {attendance === null
            ? '출결 현황을 불러오는 중입니다.'
            : attendance === undefined
              ? '출결 현황을 불러오지 못했습니다.'
              : `출석 ${attendance.present || 0}회 · 결석 ${attendance.absent || 0}회 · 미체크 ${attendance.unchecked || 0}회 / 전체 ${attendance.total || 0}회`}
        </div>

        {row.studentUpdatedAfterReview ? <div style={{ padding: 10, borderRadius: 8, background: '#fff8e1', color: color.warn, fontSize: 12 }}>교사 검토 후 학생 답변이 변경되었습니다. 다시 확인해주세요.</div> : null}

        <StudentAnswerDetails row={row} />
      </div>
    </div>
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

function TeacherRecordEditor({ row, program, actor, nav, onSaved, onError }) {
  const [studentRecordText, setStudentRecordText] = useState(row.studentRecordText || '')
  const [saving, setSaving] = useState(false)
  const [attendance, setAttendance] = useState(null)
  const [showAnswers, setShowAnswers] = useState(true)
  const textareaRef = useRef(null)

  const dirty = studentRecordText !== (row.studentRecordText || '')
  const bytes = neisBytes(studentRecordText)
  const overNeis = bytes > NEIS_BYTE_LIMIT

  useEffect(() => {
    let active = true
    setAttendance(null)
    getTeacherActivityAttendanceSummary({ program, clubId: row.clubId, studentUid: row.studentUid })
      .then((summary) => { if (active) setAttendance(summary) })
      .catch(() => { if (active) setAttendance(undefined) })
    return () => { active = false }
  }, [program, row.clubId, row.studentUid])

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.max(220, element.scrollHeight)}px`
  }, [studentRecordText])

  async function save(teacherStatus) {
    setSaving(true)
    onError('')
    try {
      const next = await saveTeacherActivityRecord({ program, actor, clubId: row.clubId, studentUid: row.studentUid, studentRecordText, teacherStatus })
      onSaved(next, teacherStatus === 'completed' ? '생활기록부 작성 내용을 완료 처리했습니다.' : '교사 검토 내용을 저장했습니다.')
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '교사 기록을 저장하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  function moveBy(delta) {
    if (dirty && !window.confirm('저장하지 않은 생활기록부 작성 내용이 있습니다. 저장하지 않고 이동할까요?')) return
    nav.select(nav.index + delta)
  }

  return (
    <section style={{ ...card, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{row.studentNo} {row.studentName}</h3>
          <div style={{ fontSize: 12, color: color.sub }}>{row.clubName} · 학생 제출 {formatTime(row.submittedAt)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <StatusBadge record={row} />
          <button type="button" disabled={saving || nav.index <= 0} onClick={() => moveBy(-1)} style={{ ...button, padding: '6px 10px', background: '#fff', border: `1px solid ${color.border}`, color: color.sub, opacity: saving || nav.index <= 0 ? 0.45 : 1 }}>◀ 이전</button>
          <span style={{ fontSize: 12, color: color.sub }}>{nav.index + 1} / {nav.total}</span>
          <button type="button" disabled={saving || nav.index >= nav.total - 1} onClick={() => moveBy(1)} style={{ ...button, padding: '6px 10px', background: '#fff', border: `1px solid ${color.border}`, color: color.sub, opacity: saving || nav.index >= nav.total - 1 ? 0.45 : 1 }}>다음 ▶</button>
        </div>
      </div>

      <div style={{ padding: 10, borderRadius: 8, background: '#f6f9ff', fontSize: 13 }}>
        {attendance === null
          ? '출결 현황을 불러오는 중입니다.'
          : attendance === undefined
            ? '출결 현황을 불러오지 못했습니다.'
            : `출석 ${attendance.present || 0}회 · 결석 ${attendance.absent || 0}회 · 미체크 ${attendance.unchecked || 0}회 / 전체 ${attendance.total || 0}회`}
      </div>

      <div style={{ border: `1px solid ${color.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <button type="button" onClick={() => setShowAnswers((prev) => !prev)} style={{ ...button, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#f8fafc', borderRadius: 0, color: color.text }}>
          <span style={{ fontSize: 13, fontWeight: 800 }}>학생 활동 기록·지원 정보</span>
          <span style={{ fontSize: 12, color: color.sub }}>{showAnswers ? '접기 ▲' : '펼치기 ▼'}</span>
        </button>
        {showAnswers ? (
          <div style={{ padding: 12, borderTop: `1px solid ${color.border}` }}>
            <StudentAnswerDetails row={row} />
          </div>
        ) : null}
      </div>

      {row.studentUpdatedAfterReview ? <div style={{ padding: 10, borderRadius: 8, background: '#fff8e1', color: color.warn, fontSize: 12 }}>교사 검토 후 학생 답변이 변경되었습니다. 다시 확인해주세요.</div> : null}

      <div style={{ border: '1px solid #9db4d4', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 12px', background: '#eef3fa', borderBottom: '1px solid #d5e0ef' }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#27466f' }}>생활기록부 작성 내용</span>
          <span style={{ fontSize: 11, color: color.sub }}>학생 답변을 그대로 복사하지 않고 실제 관찰 사실을 확인해 작성해주세요.</span>
        </div>
        <textarea
          ref={textareaRef}
          value={studentRecordText}
          disabled={saving}
          maxLength={RECORD_TEXT_LIMIT}
          spellCheck={false}
          onChange={(event) => setStudentRecordText(event.target.value)}
          style={{ display: 'block', width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', padding: 12, font: 'inherit', fontSize: 14, lineHeight: 1.8, color: color.text, resize: 'none', overflow: 'hidden', minHeight: 220, background: saving ? '#f8fafc' : '#fff' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '7px 12px', background: '#f6f9ff', borderTop: '1px solid #d5e0ef', fontSize: 12 }}>
          <span style={{ color: color.sub }}>NEIS 기준: 한글 3Byte · 영문/숫자/공백 1Byte · 줄바꿈 2Byte</span>
          <span style={{ fontWeight: 800, color: overNeis ? color.danger : color.accent }}>{studentRecordText.length.toLocaleString()}자 · {bytes.toLocaleString()} / {NEIS_BYTE_LIMIT.toLocaleString()} Byte</span>
        </div>
        {overNeis ? <div style={{ padding: '7px 12px', background: '#fdecea', color: color.danger, fontSize: 12 }}>NEIS 동아리활동 특기사항 기준 {NEIS_BYTE_LIMIT.toLocaleString()}Byte를 초과했습니다. NEIS에 입력하려면 내용을 줄여주세요.</div> : null}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
        {dirty ? <span style={{ fontSize: 12, color: color.warn }}>저장하지 않은 변경 사항이 있습니다.</span> : null}
        <button type="button" disabled={saving} onClick={() => save('reviewing')} style={{ ...button, background: '#fff', border: `1px solid ${color.border}`, color: color.sub }}>검토 내용 저장</button>
        <button type="button" disabled={saving || row.studentStatus !== 'submitted'} onClick={() => save('completed')} style={{ ...button, background: saving || row.studentStatus !== 'submitted' ? '#cfd8e3' : color.ok, color: '#fff', fontWeight: 800 }}>작성 완료</button>
      </div>
    </section>
  )
}

function GrowTextarea({ value, disabled, onChange }) {
  const ref = useRef(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.max(96, element.scrollHeight)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      disabled={disabled}
      maxLength={RECORD_TEXT_LIMIT}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      style={{ display: 'block', width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', padding: '10px 12px', font: 'inherit', fontSize: 13, lineHeight: 1.7, color: color.text, resize: 'none', overflow: 'hidden', minHeight: 96, background: 'transparent' }}
    />
  )
}

function TeacherRecordGrid({ rows, program, actor, onSaved, onError, onOpenDetail }) {
  const [drafts, setDrafts] = useState({})
  const [savingKey, setSavingKey] = useState('')
  const [modalRow, setModalRow] = useState(null)

  const keyOf = (row) => `${row.clubId}::${row.studentUid}`
  const draftOf = (row) => {
    const key = keyOf(row)
    return key in drafts ? drafts[key] : (row.studentRecordText || '')
  }
  const isDirty = (row) => draftOf(row) !== (row.studentRecordText || '')
  const dirtyRows = rows.filter(isDirty)

  async function save(row, teacherStatus) {
    const key = keyOf(row)
    setSavingKey(key)
    onError('')
    try {
      const next = await saveTeacherActivityRecord({ program, actor, clubId: row.clubId, studentUid: row.studentUid, studentRecordText: draftOf(row), teacherStatus })
      setDrafts((prev) => {
        const copy = { ...prev }
        delete copy[key]
        return copy
      })
      onSaved(next, teacherStatus === 'completed' ? `${row.studentName} 학생을 작성 완료 처리했습니다.` : `${row.studentName} 학생의 작성 내용을 저장했습니다.`)
      return true
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '교사 기록을 저장하지 못했습니다.')
      return false
    } finally {
      setSavingKey('')
    }
  }

  async function saveAllDirty() {
    for (const row of dirtyRows) {
      const ok = await save(row, 'reviewing')
      if (!ok) return
    }
  }

  const th = { padding: '9px 12px', fontSize: 12, fontWeight: 800, color: color.sub, textAlign: 'left', background: '#f8fafc', borderBottom: `1px solid ${color.border}`, whiteSpace: 'nowrap' }
  const td = { padding: '10px 12px', fontSize: 13, verticalAlign: 'top', borderBottom: `1px solid ${color.border}` }

  if (rows.length === 0) return <section style={{ ...card, color: color.sub, fontSize: 13 }}>조건에 맞는 학생이 없습니다.</section>

  return (
    <section style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 12px', background: '#eef3fa', borderBottom: '1px solid #d5e0ef' }}>
        <span style={{ fontSize: 12, color: color.sub }}>특기사항 칸에 바로 입력한 뒤 행별로 저장하세요. 상태 배지를 누르면 학생 제출 내용을 볼 수 있습니다.</span>
        <button type="button" disabled={dirtyRows.length === 0 || Boolean(savingKey)} onClick={saveAllDirty} style={{ ...button, padding: '6px 11px', background: dirtyRows.length === 0 || savingKey ? '#cfd8e3' : color.accent, color: '#fff', fontWeight: 800, fontSize: 12 }}>변경된 {dirtyRows.length}개 행 모두 저장</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 880 }}>
          <thead>
            <tr>
              <th style={th}>학번</th>
              <th style={th}>이름</th>
              <th style={th}>상태</th>
              <th style={{ ...th, minWidth: 420, width: '100%' }}>특기사항</th>
              <th style={th}>분량</th>
              <th style={th}>작업</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = keyOf(row)
              const text = draftOf(row)
              const dirty = isDirty(row)
              const bytes = neisBytes(text)
              const overNeis = bytes > NEIS_BYTE_LIMIT
              const saving = savingKey === key
              return (
                <tr key={key} style={{ background: dirty ? '#fffbe6' : '#fff' }}>
                  <td style={td}>
                    <button type="button" onClick={() => onOpenDetail(row)} title="학생 답변·출결을 보며 개별 편집" style={{ ...button, padding: 0, background: 'none', color: color.accent, fontWeight: 800, textDecoration: 'underline' }}>{row.studentNo || '-'}</button>
                  </td>
                  <td style={{ ...td, fontWeight: 800, whiteSpace: 'nowrap' }}>{row.studentName}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {row.studentStatus === 'submitted' ? (
                      <button type="button" onClick={() => setModalRow(row)} title="학생 제출 내용 보기" style={{ ...button, padding: 0, background: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <StatusBadge record={row} />
                        <span style={{ fontSize: 11, color: color.accent, fontWeight: 800 }}>보기 🔍</span>
                      </button>
                    ) : (
                      <StatusBadge record={row} />
                    )}
                    {dirty ? <div style={{ marginTop: 5, fontSize: 11, color: color.warn, fontWeight: 800 }}>저장 안 됨</div> : null}
                  </td>
                  <td style={{ ...td, padding: 0, borderLeft: `1px solid ${color.border}`, borderRight: `1px solid ${color.border}` }}>
                    <GrowTextarea value={text} disabled={saving} onChange={(value) => setDrafts((prev) => ({ ...prev, [key]: value }))} />
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap', fontSize: 12 }}>
                    <div style={{ fontWeight: 800, color: overNeis ? color.danger : color.accent }}>{bytes.toLocaleString()} / {NEIS_BYTE_LIMIT.toLocaleString()}B</div>
                    <div style={{ marginTop: 3, color: color.sub }}>{text.length.toLocaleString()}자</div>
                    {overNeis ? <div style={{ marginTop: 3, color: color.danger, fontWeight: 800 }}>NEIS 초과</div> : null}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'grid', gap: 5 }}>
                      <button type="button" disabled={saving || !dirty} onClick={() => save(row, 'reviewing')} style={{ ...button, padding: '5px 10px', fontSize: 12, background: '#fff', border: `1px solid ${color.border}`, color: color.sub, opacity: saving || !dirty ? 0.5 : 1 }}>저장</button>
                      <button type="button" disabled={saving || row.studentStatus !== 'submitted'} onClick={() => save(row, 'completed')} style={{ ...button, padding: '5px 10px', fontSize: 12, background: saving || row.studentStatus !== 'submitted' ? '#cfd8e3' : color.ok, color: '#fff', fontWeight: 800 }}>완료</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {modalRow ? <StudentAnswerModal key={`${modalRow.clubId}::${modalRow.studentUid}`} row={modalRow} program={program} onClose={() => setModalRow(null)} /> : null}
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
  const [viewMode, setViewMode] = useState('table')

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
  const selectedIndex = useMemo(() => {
    const index = filtered.findIndex((row) => `${row.clubId}::${row.studentUid}` === selectedKey)
    return index === -1 ? (filtered.length > 0 ? 0 : -1) : index
  }, [filtered, selectedKey])
  const selected = selectedIndex >= 0 ? filtered[selectedIndex] : null

  function onSaved(next, text) {
    // 저장 응답은 해당 학생의 레코드 하나만 담고 있으므로 그 행만 교체합니다.
    const saved = next?.record
    if (clubId && saved) {
      setRowsByClub((prev) => ({
        ...prev,
        [clubId]: (prev[clubId] || []).map((row) => (
          row.clubId === saved.clubId && row.studentUid === saved.studentUid ? { ...row, ...saved } : row
        )),
      }))
    }
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
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
            {['학생 미작성', '학생 작성 완료', '교사 검토 중', '작성 완료'].map((label) => <span key={label} style={{ padding: '4px 8px', background: '#f8fafc', borderRadius: 999 }}>{label} {rows.filter((row) => statusMeta(row).label === label).length}명</span>)}
            <span style={{ display: 'inline-flex', marginLeft: 'auto', border: `1px solid ${color.border}`, borderRadius: 8, overflow: 'hidden' }}>
              {[['table', '표 편집'], ['detail', '개별 편집']].map(([mode, label]) => (
                <button key={mode} type="button" onClick={() => setViewMode(mode)} style={{ ...button, borderRadius: 0, padding: '6px 12px', fontSize: 12, fontWeight: 800, background: viewMode === mode ? color.accent : '#fff', color: viewMode === mode ? '#fff' : color.sub }}>{label}</button>
              ))}
            </span>
          </div>
        ) : null}
      </section>

      {!clubId ? (
        <section style={{ ...card, color: color.sub, fontSize: 13 }}>수업을 선택하면 해당 수업 학생들의 활동 기록을 불러옵니다.</section>
      ) : rowsLoading ? (
        <section style={{ ...card, color: color.sub, fontSize: 13 }}>선택한 수업의 학생 활동 기록을 불러오는 중입니다.</section>
      ) : viewMode === 'table' ? (
        <TeacherRecordGrid
          rows={filtered}
          program={program}
          actor={user}
          onSaved={onSaved}
          onError={setError}
          onOpenDetail={(row) => {
            setSelectedKey(`${row.clubId}::${row.studentUid}`)
            setViewMode('detail')
          }}
        />
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
          {selected ? (
            <TeacherRecordEditor
              key={`${selected.clubId}:${selected.studentUid}:${selected.studentUpdatedAt || ''}:${selected.teacherUpdatedAt || ''}`}
              row={selected}
              program={program}
              actor={user}
              nav={{
                index: selectedIndex,
                total: filtered.length,
                select: (index) => {
                  const target = filtered[index]
                  if (target) setSelectedKey(`${target.clubId}::${target.studentUid}`)
                },
              }}
              onSaved={onSaved}
              onError={setError}
            />
          ) : <section style={card}>학생을 선택해주세요.</section>}
        </div>
      )}
    </div>
  )
}
