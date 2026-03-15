import { listSchedules } from './scheduleService'
import { listUsers } from './userService'
import { listClubMembers, listCurrentCycleApplications } from './applicationService'

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

  const [clubs, users, applications] = await Promise.all([
    listSchedules({ includeLegacy: true }),
    listUsers(),
    listCurrentCycleApplications(),
  ])

  const userMap = new Map(users.map((u) => [u.uid, u]))

  // 1. 동아리 목록 시트
  const clubRows = clubs.map((c) => [
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
  const clubHeaders = ['동아리명', '담당교사', '대상학년', '동아리실', '정원', '확정인원', '면접선발', '설명', 'ID']

  // 2. 신청 내역 시트
  const appRows = applications.map((a) => {
    const club = clubs.find((c) => c.id === a.clubId)
    const student = userMap.get(a.studentUid)
    return [
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
  const appHeaders = ['학생명', '학번', '아이디', '동아리명', '지망순위', '상태', '탈락사유', '진로희망', '지원동기', '희망활동', '신청일시', 'ID']

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
    u.school || '',
    u.phone || '',
    u.email || '',
    formatDate(u.createdAt),
    u.uid,
  ])
  const userHeaders = ['이름', '아이디', '역할', '학번', '학교', '전화번호', '이메일', '생성일시', 'UID']

  // 워크북 생성
  const wb = XLSX.utils.book_new()

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
  }
}
