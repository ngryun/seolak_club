const BASE_HEADER_MAP = {
  개설명: 'clubName',
  동아리명: 'clubName',
  강좌명: 'clubName',
  과목명: 'clubName',
  프로그램명: 'clubName',
  이름: 'clubName',
  담당교사: 'teacherLoginIds',
  담당교사아이디: 'teacherLoginIds',
  교사아이디: 'teacherLoginIds',
  담당자아이디: 'teacherLoginIds',
  대표학생학번: 'leaderStudentNo',
  대표학번: 'leaderStudentNo',
  동아리장학번: 'leaderStudentNo',
  부장학번: 'leaderStudentNo',
  대상학년: 'targetGrades',
  학년: 'targetGrades',
  장소: 'room',
  활동장소: 'room',
  동아리실: 'room',
  정원: 'maxMembers',
  최대인원: 'maxMembers',
  자체면접: 'isInterviewSelection',
  면접여부: 'isInterviewSelection',
  소개: 'description',
  설명: 'description',
  활동소개: 'description',
}

const TRUE_VALUES = new Set(['y', 'yes', 'o', 'true', '1', '예', '사용'])
const FALSE_VALUES = new Set(['n', 'no', 'x', 'false', '0', '아니오', '미사용'])

let xlsxModulePromise = null

async function getXlsx() {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import('xlsx')
  }
  const mod = await xlsxModulePromise
  if (mod && mod.utils) return mod
  return mod.default
}

function normalizeKey(value) {
  return String(value || '').trim().normalize('NFKC').toLocaleLowerCase('ko')
}

function normalizeHeader(value) {
  return normalizeKey(value).replace(/[\s_(){}·/\\-]+/g, '')
}

function getLabels(program) {
  const unit = String(program?.unitLabel || '').trim() || '동아리'
  const isClubLike = unit === '동아리'
  return {
    unit,
    room: String(program?.roomLabel || '').trim() || (isClubLike ? '동아리실' : '활동 장소'),
    leader: String(program?.leaderLabel || '').trim() || (isClubLike ? '동아리장' : '대표 학생'),
  }
}

function getFeatures(program) {
  return program?.features || { leader: true, plan: true, room: true, interview: true }
}

function splitIdentifiers(value) {
  return String(value ?? '')
    .split(/[,;|\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseBoolean(value, fallback, label) {
  const normalized = normalizeKey(value)
  if (!normalized) return fallback
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  throw new Error(`${label} 값은 예/아니오, Y/N, O/X 중 하나로 입력해주세요.`)
}

function parseTargetGrades(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return [1, 2, 3]
  const tokens = normalized
    .replace(/학년/gu, '')
    .split(/[,;|\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
  const grades = tokens.map(Number)
  if (grades.length === 0 || grades.some((grade) => !Number.isInteger(grade) || grade < 1 || grade > 3)) {
    throw new Error('대상학년은 1, 2, 3만 입력할 수 있습니다.')
  }
  return [...new Set(grades)].sort((a, b) => a - b)
}

function parseMaxMembers(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return 20
  const parsed = Number(normalized.replace(/명$/u, '').trim())
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('정원은 1 이상의 정수여야 합니다.')
  }
  return parsed
}

function buildHeaders(program) {
  const labels = getLabels(program)
  const features = getFeatures(program)
  const headers = [`${labels.unit}명`, '담당교사 아이디']
  if (features.leader) headers.push(`${labels.leader} 학번`)
  headers.push('대상학년')
  if (features.room) headers.push(labels.room)
  headers.push('정원')
  if (features.interview) headers.push('자체면접')
  headers.push(`${labels.unit} 소개`)
  return headers
}

export async function downloadClubTemplate({ program, users = [], rooms = [] } = {}) {
  const XLSX = await getXlsx()
  const labels = getLabels(program)
  const features = getFeatures(program)
  const headers = buildHeaders(program)
  const teacher = users.find((user) => user.role === 'teacher' || user.role === 'admin')
  const student = users.find((user) => user.role === 'student')
  const room = rooms.find((item) => String(item?.name || '').trim() && item.name !== '미정')

  const sample = [`${labels.unit} 예시`, teacher?.loginId || '김교사']
  if (features.leader) sample.push(student?.studentNo || student?.loginId || '')
  sample.push('1,2,3')
  if (features.room) sample.push(room?.name || '미정')
  sample.push(20)
  if (features.interview) sample.push('아니오')
  sample.push('활동 목적과 운영 방식을 입력합니다.')

  const ws = XLSX.utils.aoa_to_sheet([headers, sample])
  ws['!cols'] = headers.map((header) => {
    if (header.includes('소개')) return { wch: 44 }
    if (header.includes('아이디')) return { wch: 24 }
    if (header.includes('학번')) return { wch: 16 }
    return { wch: 18 }
  })
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}2` }

  const guideRows = [
    ['항목', '작성 방법'],
    [`${labels.unit}명`, '필수. 현재 프로그램 안에서 중복되지 않게 입력합니다.'],
    ['담당교사 아이디', '필수. 회원 관리에 등록된 교사/관리자 아이디를 입력합니다. 여러 명은 쉼표로 구분합니다.'],
    ...(features.leader ? [[`${labels.leader} 학번`, '선택. 회원 관리에 등록된 학생 학번을 입력합니다.']] : []),
    ['대상학년', '선택. 1,2,3처럼 쉼표로 구분합니다. 비워두면 전 학년으로 등록됩니다.'],
    ...(features.room ? [[labels.room, `선택. ${labels.room} 관리에 등록된 이름을 입력합니다. 비워두면 미정입니다.`]] : []),
    ['정원', '선택. 1 이상의 정수이며 비워두면 20명입니다.'],
    ...(features.interview ? [['자체면접', '예/아니오, Y/N, O/X, TRUE/FALSE, 1/0을 사용할 수 있습니다.']] : []),
    [`${labels.unit} 소개`, '선택. 활동 목적과 운영 방식을 입력합니다.'],
  ]
  const guide = XLSX.utils.aoa_to_sheet(guideRows)
  guide['!cols'] = [{ wch: 22 }, { wch: 86 }]

  const teacherRows = users
    .filter((user) => user.role === 'teacher' || user.role === 'admin')
    .map((user) => [user.loginId, user.name, user.role === 'admin' ? '관리자' : '교사'])
  const teacherSheet = XLSX.utils.aoa_to_sheet([['아이디', '이름', '역할'], ...teacherRows])
  teacherSheet['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 12 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, `${labels.unit}목록`.slice(0, 31))
  XLSX.utils.book_append_sheet(wb, guide, '작성안내')
  XLSX.utils.book_append_sheet(wb, teacherSheet, '담당교사목록')
  XLSX.writeFile(wb, `${String(program?.name || '운영프로그램').trim()}_${labels.unit}_일괄등록_양식.xlsx`)
}

export async function parseClubExcel(file, { program } = {}) {
  try {
    const XLSX = await getXlsx()
    const buffer = await file.arrayBuffer()
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) throw new Error('엑셀 파일에 시트가 없습니다.')

    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
    if (rows.length === 0) return []

    const labels = getLabels(program)
    const headerMap = {
      ...BASE_HEADER_MAP,
      [normalizeHeader(`${labels.unit}명`)]: 'clubName',
      [normalizeHeader(`${labels.leader}학번`)]: 'leaderStudentNo',
      [normalizeHeader(labels.room)]: 'room',
      [normalizeHeader(`${labels.unit}최대인원`)]: 'maxMembers',
      [normalizeHeader(`${labels.unit}소개`)]: 'description',
    }
    const hasNameHeader = Object.keys(rows[0]).some(
      (key) => headerMap[normalizeHeader(key)] === 'clubName',
    )
    if (!hasNameHeader) {
      throw new Error(`첫 행에서 '${labels.unit}명' 열을 찾지 못했습니다. 제공된 양식을 사용해주세요.`)
    }

    return rows
      .map((row, index) => {
        const mapped = {}
        for (const [key, value] of Object.entries(row)) {
          const targetKey = headerMap[normalizeHeader(key)]
          if (!targetKey) continue
          if (mapped[targetKey] != null && String(mapped[targetKey]).trim() !== '') continue
          mapped[targetKey] = value
        }

        const sourceRow = Number.isInteger(row.__rowNum__) ? row.__rowNum__ + 1 : index + 2
        const hasValue = Object.values(mapped).some((value) => String(value ?? '').trim() !== '')
        if (!hasValue) return null

        const errors = []
        const clubName = String(mapped.clubName || '').trim()
        const teacherLoginIds = splitIdentifiers(mapped.teacherLoginIds)
        const leaderStudentNo = String(mapped.leaderStudentNo || '').trim()
        if (!clubName) errors.push(`${labels.unit}명은 필수입니다.`)
        if (teacherLoginIds.length === 0) errors.push('담당교사 아이디는 필수입니다.')

        let targetGrades = [1, 2, 3]
        let maxMembers = 20
        let isInterviewSelection = false
        try { targetGrades = parseTargetGrades(mapped.targetGrades) } catch (error) { errors.push(error.message) }
        try { maxMembers = parseMaxMembers(mapped.maxMembers) } catch (error) { errors.push(error.message) }
        try { isInterviewSelection = parseBoolean(mapped.isInterviewSelection, false, '자체면접') } catch (error) { errors.push(error.message) }

        return {
          sourceRow,
          clubName,
          teacherLoginIds,
          leaderStudentNo,
          targetGrades,
          room: String(mapped.room || '').trim() || '미정',
          maxMembers,
          isInterviewSelection,
          description: String(mapped.description || '').trim(),
          importError: errors.join(' '),
        }
      })
      .filter(Boolean)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('시트가 없습니다') || message.includes('열을 찾지 못했습니다')) throw error
    throw new Error('엑셀 파일을 읽는 데 실패했습니다.')
  }
}

export function resolveClubExcelRows(rows, { program, users = [], rooms = [] } = {}) {
  const features = getFeatures(program)
  const teacherMap = new Map(
    users
      .filter((user) => user.role === 'teacher' || user.role === 'admin')
      .map((user) => [normalizeKey(user.loginId), user]),
  )
  const studentMap = new Map()
  users
    .filter((user) => user.role === 'student')
    .forEach((user) => {
      if (user.studentNo) studentMap.set(normalizeKey(user.studentNo), user)
      if (user.loginId) studentMap.set(normalizeKey(user.loginId), user)
    })
  const roomMap = new Map(
    rooms
      .map((room) => String(room?.name || '').trim())
      .filter(Boolean)
      .map((name) => [normalizeKey(name), name]),
  )
  roomMap.set(normalizeKey('미정'), '미정')

  return (rows || []).map((row) => {
    const errors = row.importError ? [row.importError] : []
    const teacherUids = []
    const missingTeachers = []
    for (const loginId of row.teacherLoginIds || []) {
      const teacher = teacherMap.get(normalizeKey(loginId))
      if (!teacher) missingTeachers.push(loginId)
      else if (!teacherUids.includes(teacher.uid)) teacherUids.push(teacher.uid)
    }
    if (missingTeachers.length > 0) {
      errors.push(`등록되지 않은 담당교사 아이디: ${missingTeachers.join(', ')}`)
    }

    let leaderUid = ''
    if (features.leader && row.leaderStudentNo) {
      const leader = studentMap.get(normalizeKey(row.leaderStudentNo))
      if (!leader) errors.push(`등록되지 않은 대표학생 학번: ${row.leaderStudentNo}`)
      else leaderUid = leader.uid
    }

    let room = '미정'
    if (features.room) {
      const matchedRoom = roomMap.get(normalizeKey(row.room || '미정'))
      if (!matchedRoom) errors.push(`등록되지 않은 장소: ${row.room}`)
      else room = matchedRoom
    }

    return {
      sourceRow: row.sourceRow,
      programId: String(program?.id || '').trim(),
      clubName: row.clubName,
      teacherUids,
      leaderUid,
      targetGrades: row.targetGrades,
      room,
      maxMembers: row.maxMembers,
      isInterviewSelection: features.interview ? row.isInterviewSelection : false,
      description: row.description,
      importError: errors.join(' '),
    }
  })
}
