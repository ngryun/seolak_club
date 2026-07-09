const PROGRAM_HEADERS = [
  '프로그램명',
  '개설 단위',
  '지망 수',
  '학생 대표 사용',
  '활동계획서 사용',
  '장소 배정 사용',
  '자체면접 사용',
  '학생 공개',
]

const HEADER_MAP = {
  프로그램명: 'name',
  프로그램: 'name',
  이름: 'name',
  개설단위: 'unitLabel',
  개설단위명칭: 'unitLabel',
  단위명칭: 'unitLabel',
  지망수: 'preferenceCount',
  지망개수: 'preferenceCount',
  선발라운드수: 'preferenceCount',
  학생대표: 'leader',
  학생대표사용: 'leader',
  대표학생사용: 'leader',
  부장사용: 'leader',
  활동계획서: 'plan',
  활동계획서사용: 'plan',
  계획서사용: 'plan',
  장소배정: 'room',
  장소배정사용: 'room',
  장소사용: 'room',
  자체면접: 'interview',
  자체면접사용: 'interview',
  면접사용: 'interview',
  학생공개: 'studentVisible',
  학생화면표시: 'studentVisible',
  학생노출: 'studentVisible',
}

const TRUE_VALUES = new Set(['y', 'yes', 'o', 'true', '1', '예', '사용', '공개'])
const FALSE_VALUES = new Set(['n', 'no', 'x', 'false', '0', '아니오', '미사용', '비공개'])
const MAX_PREFERENCE_COUNT = 3

let xlsxModulePromise = null

async function getXlsx() {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import('xlsx')
  }
  const mod = await xlsxModulePromise
  if (mod && mod.utils) return mod
  return mod.default
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .replace(/[\s_(){}·/\\-]+/g, '')
    .toLowerCase()
}

function parseBoolean(value, fallback, label) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  throw new Error(`${label} 값은 예/아니오, Y/N, O/X 중 하나로 입력해주세요.`)
}

function parsePreferenceCount(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return 1
  const parsed = Number(normalized.replace(/지망$/u, '').trim())
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PREFERENCE_COUNT) {
    throw new Error(`지망 수는 1~${MAX_PREFERENCE_COUNT} 사이의 정수여야 합니다.`)
  }
  return parsed
}

export async function downloadProgramTemplate() {
  const XLSX = await getXlsx()
  const sampleRows = [
    PROGRAM_HEADERS,
    ['2026 1학기 방과후학교', '강좌', 1, '아니오', '아니오', '예', '아니오', '예'],
    ['2026 자율교육과정', '과목', 3, '예', '예', '예', '예', '예'],
  ]
  const ws = XLSX.utils.aoa_to_sheet(sampleRows)
  ws['!cols'] = [
    { wch: 28 },
    { wch: 14 },
    { wch: 10 },
    { wch: 16 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 12 },
  ]
  ws['!autofilter'] = { ref: `A1:H${sampleRows.length}` }

  const guideRows = [
    ['항목', '작성 방법'],
    ['프로그램명', '필수. 기존 프로그램과 중복되지 않게 입력합니다.'],
    ['개설 단위', '선택. 예: 강좌, 과목, 동아리. 비워두면 동아리로 등록됩니다.'],
    ['지망 수', '선택. 1~3 사이의 정수. 비워두면 1로 등록됩니다.'],
    ['기능 사용 여부', '예/아니오, Y/N, O/X, TRUE/FALSE, 1/0을 사용할 수 있습니다.'],
    ['학생 공개', '비워두면 예(학생 화면에 표시)로 등록됩니다.'],
  ]
  const guide = XLSX.utils.aoa_to_sheet(guideRows)
  guide['!cols'] = [{ wch: 20 }, { wch: 72 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '프로그램목록')
  XLSX.utils.book_append_sheet(wb, guide, '작성안내')
  XLSX.writeFile(wb, '운영프로그램_일괄등록_양식.xlsx')
}

export async function parseProgramExcel(file) {
  try {
    const XLSX = await getXlsx()
    const buffer = await file.arrayBuffer()
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) {
      throw new Error('엑셀 파일에 시트가 없습니다.')
    }

    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
    if (rows.length === 0) return []

    const hasProgramNameHeader = Object.keys(rows[0]).some(
      (key) => HEADER_MAP[normalizeHeader(key)] === 'name',
    )
    if (!hasProgramNameHeader) {
      throw new Error("첫 행에서 '프로그램명' 열을 찾지 못했습니다. 제공된 양식을 사용해주세요.")
    }

    return rows
      .map((row, index) => {
        const mapped = {}
        for (const [key, value] of Object.entries(row)) {
          const targetKey = HEADER_MAP[normalizeHeader(key)]
          if (!targetKey) continue
          if (mapped[targetKey] != null && String(mapped[targetKey]).trim() !== '') continue
          mapped[targetKey] = value
        }

        const sourceRow = Number.isInteger(row.__rowNum__) ? row.__rowNum__ + 1 : index + 2
        const hasValue = Object.values(mapped).some((value) => String(value ?? '').trim() !== '')
        if (!hasValue) return null

        const errors = []
        const name = String(mapped.name || '').trim()
        if (!name) errors.push('프로그램명은 필수입니다.')

        let preferenceCount = 1
        let leader = false
        let plan = false
        let room = false
        let interview = false
        let studentVisible = true

        try { preferenceCount = parsePreferenceCount(mapped.preferenceCount) } catch (error) { errors.push(error.message) }
        try { leader = parseBoolean(mapped.leader, false, '학생 대표 사용') } catch (error) { errors.push(error.message) }
        try { plan = parseBoolean(mapped.plan, false, '활동계획서 사용') } catch (error) { errors.push(error.message) }
        try { room = parseBoolean(mapped.room, false, '장소 배정 사용') } catch (error) { errors.push(error.message) }
        try { interview = parseBoolean(mapped.interview, false, '자체면접 사용') } catch (error) { errors.push(error.message) }
        try { studentVisible = parseBoolean(mapped.studentVisible, true, '학생 공개') } catch (error) { errors.push(error.message) }

        return {
          sourceRow,
          name,
          unitLabel: String(mapped.unitLabel || '').trim() || '동아리',
          preferenceCount,
          features: { leader, plan, room, interview },
          studentVisible,
          importError: errors.join(' '),
        }
      })
      .filter(Boolean)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('시트가 없습니다') || message.includes("'프로그램명' 열을 찾지 못했습니다")) {
      throw error
    }
    throw new Error('엑셀 파일을 읽는 데 실패했습니다.')
  }
}
