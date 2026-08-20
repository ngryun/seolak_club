const HEADERS = ['학번', '이름', '참여프로그램명', '특기사항', '바이트수']
const NEIS_BYTE_LIMIT = 1500
const EXCEL_FONT = 'Apple SD Gothic Neo'

let xlsxModulePromise = null

async function getXlsx() {
  if (!xlsxModulePromise) xlsxModulePromise = import('xlsx-js-style')
  const mod = await xlsxModulePromise
  return mod?.utils ? mod : mod.default
}

export function getNeisByteCount(value) {
  let bytes = 0
  for (const char of String(value || '')) {
    if (char === '\n') bytes += 2
    else bytes += char.charCodeAt(0) > 127 ? 3 : 1
  }
  return bytes
}

// 학번은 5자리(학년 1자리 + 반 2자리 + 번호 2자리)를 기준으로 학급을 구분합니다.
export function parseActivityRecordClass(studentNo) {
  const digits = String(studentNo || '').replace(/\D/g, '')
  if (digits.length !== 5) return null
  const grade = Number(digits[0])
  const classNum = Number(digits.slice(1, 3))
  const number = Number(digits.slice(3))
  if (!grade || !classNum) return null
  return {
    grade,
    classNum,
    number,
    key: `${grade}-${String(classNum).padStart(2, '0')}`,
    label: `${grade}학년 ${classNum}반`,
  }
}

function groupRowsByClass(rows) {
  const groups = new Map()
  const seen = new Set()

  for (const source of rows || []) {
    const uniqueKey = `${source.clubId || source.clubName || ''}::${source.studentUid || source.studentNo || ''}`
    if (seen.has(uniqueKey)) continue
    seen.add(uniqueKey)

    const homeroom = parseActivityRecordClass(source.studentNo)
    const key = homeroom?.key || 'etc'
    if (!groups.has(key)) {
      groups.set(key, homeroom
        ? { ...homeroom, rows: [] }
        : { grade: Number.MAX_SAFE_INTEGER, classNum: Number.MAX_SAFE_INTEGER, key, label: '기타(학급 미상)', rows: [] })
    }
    groups.get(key).rows.push({
      studentNo: String(source.studentNo || '').trim(),
      studentName: String(source.studentName || '').trim(),
      clubName: String(source.clubName || '').trim(),
      studentRecordText: String(source.studentRecordText || '').trim(),
      teacherStatus: source.teacherStatus || '',
    })
  }

  return [...groups.values()]
    .sort((left, right) => left.grade - right.grade || left.classNum - right.classNum)
    .map((group) => ({
      ...group,
      rows: group.rows.sort((left, right) => (
        left.studentNo.localeCompare(right.studentNo, 'ko', { numeric: true })
        || left.studentName.localeCompare(right.studentName, 'ko')
        || left.clubName.localeCompare(right.clubName, 'ko')
      )),
    }))
}

function safeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || '운영프로그램'
}

function applyStyle(cell, style) {
  if (cell) cell.s = style
}

function setRowStyles(XLSX, sheet, rowNumber, columnCount, style) {
  for (let column = 0; column < columnCount; column += 1) {
    applyStyle(sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: column })], style)
  }
}

function addMainSheet(XLSX, workbook, program, groups) {
  const exportedAt = new Date().toLocaleString('ko-KR')
  const data = [
    [`${String(program?.name || '운영프로그램').trim()} 학생 활동 기록`],
    [`내보낸 시각: ${exportedAt} · 학급 수: ${groups.length}개 · 학생 기록: ${groups.reduce((sum, group) => sum + group.rows.length, 0)}건`],
    [],
    ['학급', '학생 수', '작성 학생', '학급 시트 바로가기'],
    ...groups.map((group) => [
      group.label,
      group.rows.length,
      group.rows.filter((row) => row.studentRecordText).length,
      `${group.label} 열기`,
    ]),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(data)
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
  ]
  sheet['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 28 }]
  sheet['!rows'] = [{ hpt: 28 }, { hpt: 22 }, { hpt: 8 }, { hpt: 24 }, ...groups.map(() => ({ hpt: 22 }))]
  sheet['!autofilter'] = { ref: `A4:D${Math.max(4, groups.length + 4)}` }

  const titleStyle = { font: { name: EXCEL_FONT, bold: true, color: { rgb: 'FFFFFF' }, sz: 16 }, fill: { fgColor: { rgb: '1F4E78' } }, alignment: { horizontal: 'left', vertical: 'center' } }
  const subtitleStyle = { font: { name: EXCEL_FONT, color: { rgb: '49657D' }, sz: 10 }, fill: { fgColor: { rgb: 'EAF2F8' } }, alignment: { vertical: 'center' } }
  const headerStyle = { font: { name: EXCEL_FONT, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '2F75B5' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: { bottom: { style: 'thin', color: { rgb: 'B4C7E7' } } } }
  const bodyStyle = { font: { name: EXCEL_FONT }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: { bottom: { style: 'thin', color: { rgb: 'D9E2F3' } } } }
  const linkStyle = { ...bodyStyle, font: { name: EXCEL_FONT, color: { rgb: '0563C1' }, underline: true, bold: true } }

  setRowStyles(XLSX, sheet, 1, 4, titleStyle)
  setRowStyles(XLSX, sheet, 2, 4, subtitleStyle)
  setRowStyles(XLSX, sheet, 4, 4, headerStyle)
  groups.forEach((group, index) => {
    const rowNumber = index + 5
    setRowStyles(XLSX, sheet, rowNumber, 4, bodyStyle)
    const link = sheet[`D${rowNumber}`]
    link.l = { Target: `#'${group.label.replaceAll("'", "''")}'!A1`, Tooltip: `${group.label} 시트로 이동` }
    applyStyle(link, linkStyle)
  })

  XLSX.utils.book_append_sheet(workbook, sheet, '학급목록')
}

function addClassSheet(XLSX, workbook, program, group) {
  const body = group.rows.map((row) => [
    row.studentNo,
    row.studentName,
    row.clubName,
    row.studentRecordText,
    getNeisByteCount(row.studentRecordText),
  ])
  const data = [
    [`${group.label} 학생 활동 기록`],
    [`${String(program?.name || '운영프로그램').trim()} · 총 ${group.rows.length}건`],
    ['← 학급 목록으로'],
    [],
    HEADERS,
    ...body,
  ]
  const sheet = XLSX.utils.aoa_to_sheet(data)
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 4 } },
  ]
  sheet['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 24 }, { wch: 48 }, { wch: 12 }]
  sheet['!rows'] = [
    { hpt: 28 },
    { hpt: 21 },
    { hpt: 20 },
    { hpt: 8 },
    { hpt: 28 },
    ...group.rows.map((row) => {
      const lineCount = Math.max(1, row.studentRecordText.split('\n').length, Math.ceil(row.studentRecordText.length / 36))
      return { hpt: Math.min(90, Math.max(24, lineCount * 16)) }
    }),
  ]
  sheet['!autofilter'] = { ref: `A5:E${Math.max(5, body.length + 5)}` }
  sheet['!freeze'] = { xSplit: 0, ySplit: 5, topLeftCell: 'A6', activePane: 'bottomLeft', state: 'frozen' }

  const titleStyle = { font: { name: EXCEL_FONT, bold: true, color: { rgb: 'FFFFFF' }, sz: 15 }, fill: { fgColor: { rgb: '1F4E78' } }, alignment: { horizontal: 'left', vertical: 'center' } }
  const subtitleStyle = { font: { name: EXCEL_FONT, color: { rgb: '49657D' }, sz: 10 }, fill: { fgColor: { rgb: 'EAF2F8' } }, alignment: { vertical: 'center' } }
  const backLinkStyle = { font: { name: EXCEL_FONT, color: { rgb: '0563C1' }, underline: true, bold: true }, alignment: { vertical: 'center' } }
  const headerStyle = { font: { name: EXCEL_FONT, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '2F75B5' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: { bottom: { style: 'thin', color: { rgb: 'B4C7E7' } } } }

  setRowStyles(XLSX, sheet, 1, 5, titleStyle)
  setRowStyles(XLSX, sheet, 2, 5, subtitleStyle)
  setRowStyles(XLSX, sheet, 3, 5, backLinkStyle)
  setRowStyles(XLSX, sheet, 5, 5, headerStyle)
  sheet.A3.l = { Target: "#'학급목록'!A1", Tooltip: '학급 목록 시트로 이동' }

  group.rows.forEach((row, index) => {
    const rowNumber = index + 6
    const alternate = index % 2 === 1
    const baseStyle = {
      font: { name: EXCEL_FONT },
      fill: alternate ? { fgColor: { rgb: 'F7FAFC' } } : undefined,
      alignment: { vertical: 'center', wrapText: true },
      border: { bottom: { style: 'thin', color: { rgb: 'D9E2F3' } } },
    }
    setRowStyles(XLSX, sheet, rowNumber, 5, baseStyle)
    for (const column of ['A', 'B', 'E']) {
      sheet[`${column}${rowNumber}`].s = { ...baseStyle, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } }
    }
    const byteCell = sheet[`E${rowNumber}`]
    byteCell.z = '#,##0'
    if (getNeisByteCount(row.studentRecordText) > NEIS_BYTE_LIMIT) {
      byteCell.s = {
        ...byteCell.s,
        font: { name: EXCEL_FONT, bold: true, color: { rgb: 'C62828' } },
        fill: { fgColor: { rgb: 'FDECEA' } },
      }
    }
  })

  XLSX.utils.book_append_sheet(workbook, sheet, group.label.slice(0, 31))
}

export async function createActivityRecordWorkbook({ program, rows }) {
  const XLSX = await getXlsx()
  const groups = groupRowsByClass(rows)
  const workbook = XLSX.utils.book_new()
  addMainSheet(XLSX, workbook, program, groups)
  groups.forEach((group) => addClassSheet(XLSX, workbook, program, group))
  return {
    XLSX,
    workbook,
    classCount: groups.length,
    recordCount: groups.reduce((sum, group) => sum + group.rows.length, 0),
    unmatchedCount: groups.find((group) => group.key === 'etc')?.rows.length || 0,
  }
}

export async function downloadActivityRecordsExcel({ program, rows }) {
  const result = await createActivityRecordWorkbook({ program, rows })
  const now = new Date()
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('')
  const fileName = `${safeFilePart(program?.name)}_학생활동기록_${date}.xlsx`
  result.XLSX.writeFile(result.workbook, fileName, { cellStyles: true })
  return { classCount: result.classCount, recordCount: result.recordCount, unmatchedCount: result.unmatchedCount, fileName }
}
