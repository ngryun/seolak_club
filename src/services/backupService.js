import { listSchedules } from './scheduleService'
import { listUsers } from './userService'
import { listClubMembers, listCurrentCycleApplications } from './applicationService'
import { listPrograms } from './programService'
import { exportAttendanceData } from './attendanceService'
import { exportActivityRecordData } from './activityRecordService'

let xlsxModulePromise = null

async function getXlsx() {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import('xlsx')
  }
  const mod = await xlsxModulePromise
  if (mod && mod.utils) return mod
  return mod.default
}

function formatDate(value) {
  if (!value) return ''
  try {
    const d = value?.toDate ? value.toDate() : new Date(value)
    return d.toISOString().slice(0, 19).replace('T', ' ')
  } catch {
    return String(value)
  }
}

function toStatusLabel(status) {
  const map = {
    waiting_round: '대기',
    pending: '심사중',
    approved: '선발',
    rejected: '탈락',
    cancelled: '취소',
  }
  return map[status] || status
}

export async function exportFullBackup() {
  const XLSX = await getXlsx()

  const [clubs, users, programs, attendanceData, activityRecordData] = await Promise.all([
    listSchedules({ includeLegacy: true }),
    listUsers(),
    listPrograms({ includeArchived: true }),
    exportAttendanceData(),
    exportActivityRecordData(),
  ])

  // 프로그램별 현재 사이클 신청 내역을 모두 수집
  const applications = []
  for (const program of programs) {
    try {
      const rows = await listCurrentCycleApplications({ program })
      rows.forEach((row) => applications.push({ ...row, programName: program.name }))
    } catch {
      // 개별 프로그램 조회 실패 시 건너뜀
    }
  }

  const userMap = new Map(users.map((u) => [u.uid, u]))
  const programMap = new Map(programs.map((p) => [p.id, p]))

  // 0. 프로그램 목록 시트
  const programRows = programs.map((p) => [
    p.name,
    p.unitLabel,
    p.preferenceCount,
    p.features?.leader ? 'O' : '',
    p.features?.plan ? 'O' : '',
    p.features?.room ? 'O' : '',
    p.features?.interview ? 'O' : '',
    p.features?.attendance ? 'O' : '',
    (p.attendanceSchedule || []).map((row) => `${row.date} ${row.period}교시${row.active === false ? '(보관)' : ''}${row.label ? ` ${row.label}` : ''}`).join(' / '),
    formatDate(p.activityRecordStartAt),
    formatDate(p.activityRecordEndAt),
    (p.activityRecordQuestions || []).map((row) => `${row.active === false ? '[사용중지] ' : ''}${row.title}${row.required ? '(필수)' : ''}`).join(' / '),
    Array.isArray(p.targetClasses) && p.targetClasses.length > 0 ? p.targetClasses.join(', ') : '전체',
    p.status === 'archived' ? '보관' : '운영중',
    p.cycleId,
    p.id,
  ])
  const programHeaders = ['프로그램명', '개설단위', '지망수', '대표학생', '계획서', '장소', '면접', '출석부', '출석일정', '활동기록시작', '활동기록종료', '활동기록추가질문', '신청대상학급', '상태', '사이클ID', 'ID']

  // 1. 동아리 목록 시트
  const clubRows = clubs.map((c) => [
    programMap.get(c.programId)?.name || c.programId || '',
    c.clubName,
    c.teacherNames?.join(', ') || c.teacherName || '',
    (c.targetGrades || []).join(', '),
    c.room || '',
    c.maxMembers || 0,
    c.memberCount || 0,
    c.isInterviewSelection ? 'O' : '',
    c.description || '',
    c.id,
  ])
  const clubHeaders = ['프로그램', '동아리명', '담당교사', '대상학년', '동아리실', '정원', '확정인원', '면접선발', '설명', 'ID']

  // 2. 신청 내역 시트
  const appRows = applications.map((a) => {
    const club = clubs.find((c) => c.id === a.clubId)
    const student = userMap.get(a.studentUid)
    return [
      a.programName || '',
      student?.name || a.studentName || '',
      student?.studentNo || a.studentNo || '',
      student?.loginId || '',
      club?.clubName || a.clubId,
      a.preferenceRank || '',
      toStatusLabel(a.status),
      a.rejectReason || '',
      a.careerGoal || '',
      a.applyReason || '',
      a.wantedActivity || '',
      formatDate(a.createdAt),
      a.id,
    ]
  })
  const appHeaders = ['프로그램', '학생명', '학번', '아이디', '동아리명', '지망순위', '상태', '탈락사유', '진로희망', '지원동기', '희망활동', '신청일시', 'ID']

  // 3. 확정 부원 시트 (동아리별 members)
  const memberRows = []
  for (const club of clubs) {
    if (club.legacy) continue
    try {
      const members = await listClubMembers(club.id)
      for (const m of members) {
        const student = userMap.get(m.studentUid)
        memberRows.push([
          club.clubName,
          student?.name || m.name || '',
          student?.studentNo || m.studentNo || '',
          student?.loginId || '',
          m.source || '',
          formatDate(m.addedAt),
        ])
      }
    } catch {
      // skip clubs that fail
    }
  }
  const memberHeaders = ['동아리명', '학생명', '학번', '아이디', '선발방식', '확정일시']

  // 4. 회원 목록 시트
  const userRows = users.map((u) => [
    u.name || '',
    u.loginId || '',
    u.role || '',
    u.studentNo || '',
    u.homeroomClass || '',
    u.school || '',
    u.phone || '',
    u.email || '',
    formatDate(u.createdAt),
    u.uid,
  ])
  const userHeaders = ['이름', '아이디', '역할', '학번', '담당학급', '학교', '전화번호', '이메일', '생성일시', 'UID']

  // 5. 출석 회차 및 출결 내역 (운영 모드는 서버 전용 API, 데모 모드는 로컬 저장소)
  const attendanceRecords = Array.isArray(attendanceData?.records) ? attendanceData.records : []
  const attendanceSessionRows = attendanceRecords.map((record) => {
    const club = clubs.find((row) => row.id === record.clubId)
    const program = programs.find((row) => row.id === (record.programId || club?.programId))
    const session = program?.attendanceSchedule?.find((row) => row.id === record.sessionId)
    return [program?.name || '', club?.clubName || record.clubId || '', session?.date || '', session?.period || '', session?.label || '', record.status || 'open', record.publicEnabled ? 'O' : '', record.rosterSnapshot?.length || 0, record.sessionId || '']
  })
  const attendanceSessionHeaders = ['프로그램', '수업', '날짜', '교시', '설명', '회차상태', 'QR활성', '명단인원', '회차ID']
  const attendanceEntryRows = attendanceRecords.flatMap((record) => {
    const club = clubs.find((row) => row.id === record.clubId)
    const program = programs.find((row) => row.id === (record.programId || club?.programId))
    const session = program?.attendanceSchedule?.find((row) => row.id === record.sessionId)
    return (record.rosterSnapshot || []).map((student) => {
      const entry = record.entries?.[student.studentUid] || {}
      return [program?.name || '', club?.clubName || record.clubId || '', session?.date || '', session?.period || '', student.studentNo || '', student.name || '', entry.status === 'present' ? '출석' : entry.status === 'absent' ? '결석' : '미체크', formatDate(entry.updatedAt), entry.updatedBy || '']
    })
  })
  const attendanceEntryHeaders = ['프로그램', '수업', '날짜', '교시', '학번', '학생명', '출결', '수정일시', '수정주체']

  // 6. 학생 활동 기록 및 교사 생활기록부 작성 내용
  const activityRecords = Array.isArray(activityRecordData?.records) ? activityRecordData.records : []
  const activityRecordRows = activityRecords.map((record) => {
    const club = clubs.find((row) => row.id === record.clubId)
    const program = programs.find((row) => row.id === (record.programId || club?.programId))
    const questionMap = new Map((record.questionSnapshot || []).map((row) => [row.id, row.title]))
    const additional = Object.entries(record.additionalAnswers || {})
      .map(([id, answer]) => `${questionMap.get(id) || id}: ${answer}`)
      .join(' / ')
    return [
      program?.name || record.programId || '',
      club?.clubName || record.clubId || '',
      record.studentNo || '',
      record.studentName || '',
      record.studentStatus || 'unsubmitted',
      record.commonAnswers?.activity || '',
      record.commonAnswers?.contribution || '',
      record.commonAnswers?.learning || '',
      record.commonAnswers?.change || '',
      record.commonAnswers?.followUp || '',
      additional,
      (record.attachments || []).map((row) => row.name).join(', '),
      record.observationNote || '',
      record.studentRecordText || '',
      record.teacherStatus || '',
      formatDate(record.submittedAt),
      formatDate(record.teacherUpdatedAt),
      record.cycleId || '',
    ]
  })
  const activityRecordHeaders = ['프로그램', '수업', '학번', '학생명', '학생상태', '활동내용', '역할과기여', '배운점', '느낀점과변화', '후속활동', '추가답변', '첨부파일', '교사관찰메모', '생활기록부작성내용', '교사상태', '학생제출일시', '교사수정일시', '사이클ID']

  // 워크북 생성
  const wb = XLSX.utils.book_new()

  const wsPrograms = XLSX.utils.aoa_to_sheet([programHeaders, ...programRows])
  wsPrograms['!cols'] = programHeaders.map(() => ({ wch: 16 }))
  XLSX.utils.book_append_sheet(wb, wsPrograms, '프로그램목록')

  const wsClubs = XLSX.utils.aoa_to_sheet([clubHeaders, ...clubRows])
  wsClubs['!cols'] = clubHeaders.map(() => ({ wch: 16 }))
  XLSX.utils.book_append_sheet(wb, wsClubs, '동아리목록')

  const wsApps = XLSX.utils.aoa_to_sheet([appHeaders, ...appRows])
  wsApps['!cols'] = appHeaders.map(() => ({ wch: 16 }))
  XLSX.utils.book_append_sheet(wb, wsApps, '신청내역')

  const wsMembers = XLSX.utils.aoa_to_sheet([memberHeaders, ...memberRows])
  wsMembers['!cols'] = memberHeaders.map(() => ({ wch: 16 }))
  XLSX.utils.book_append_sheet(wb, wsMembers, '확정부원')

  const wsUsers = XLSX.utils.aoa_to_sheet([userHeaders, ...userRows])
  wsUsers['!cols'] = userHeaders.map(() => ({ wch: 16 }))
  XLSX.utils.book_append_sheet(wb, wsUsers, '회원목록')

  const wsAttendanceSessions = XLSX.utils.aoa_to_sheet([attendanceSessionHeaders, ...attendanceSessionRows])
  wsAttendanceSessions['!cols'] = attendanceSessionHeaders.map(() => ({ wch: 16 }))
  XLSX.utils.book_append_sheet(wb, wsAttendanceSessions, '출석회차')

  const wsAttendanceEntries = XLSX.utils.aoa_to_sheet([attendanceEntryHeaders, ...attendanceEntryRows])
  wsAttendanceEntries['!cols'] = attendanceEntryHeaders.map(() => ({ wch: 16 }))
  XLSX.utils.book_append_sheet(wb, wsAttendanceEntries, '출결내역')

  const wsActivityRecords = XLSX.utils.aoa_to_sheet([activityRecordHeaders, ...activityRecordRows])
  wsActivityRecords['!cols'] = activityRecordHeaders.map((header) => ({ wch: ['활동내용', '역할과기여', '배운점', '느낀점과변화', '후속활동', '추가답변', '교사관찰메모', '생활기록부작성내용'].includes(header) ? 36 : 16 }))
  XLSX.utils.book_append_sheet(wb, wsActivityRecords, '학생활동기록')

  const now = new Date()
  const dateStr = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('')

  XLSX.writeFile(wb, `동아리_데이터백업_${dateStr}.xlsx`)

  return {
    clubCount: clubRows.length,
    applicationCount: appRows.length,
    memberCount: memberRows.length,
    userCount: userRows.length,
    attendanceSessionCount: attendanceSessionRows.length,
    attendanceEntryCount: attendanceEntryRows.length,
    activityRecordCount: activityRecordRows.length,
  }
}
