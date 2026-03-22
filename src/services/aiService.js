// AI 서비스 — Netlify 서버리스 함수를 통해 OpenAI 호출
// API 키는 서버 측(OPENAI_API_KEY)에만 존재, 클라이언트 번들에 포함되지 않음

const PROXY_URL = '/.netlify/functions/ai-proxy'

export function isAiAvailable() {
  // 서버에 키가 있는지 클라이언트에서 알 수 없으므로 항상 true
  // (키 미설정 시 서버에서 에러 반환)
  return true
}

async function chatCompletion(messages, { maxTokens = 1200 } = {}) {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, maxTokens }),
  })

  const data = await res.json()

  if (!res.ok) {
    throw new Error(data?.error || `AI 요청 실패 (${res.status})`)
  }

  return String(data?.content || '').trim()
}

/**
 * 동아리 개요 생성
 * @param {{ clubName: string, description: string }} params
 * @returns {Promise<string>} 200자 이내 개요
 */
export async function generateClubOverview({ clubName, description }) {
  const messages = [
    {
      role: 'system',
      content: '당신은 한국 고등학교 동아리 교육과정 전문가입니다. 주어진 동아리 정보를 바탕으로 간결하고 핵심적인 동아리 개요를 작성해 주세요. 200자 이내, 존댓말 없이 간결한 문체로 작성하세요. 개요만 출력하고 다른 말은 하지 마세요.',
    },
    {
      role: 'user',
      content: `동아리명: ${clubName}\n동아리 소개: ${description || '(소개 없음)'}\n\n위 정보를 바탕으로 동아리 활동 목표와 방향을 포함한 개요를 200자 이내로 작성해 주세요.`,
    },
  ]

  const result = await chatCompletion(messages, { maxTokens: 400 })
  return result.slice(0, 200)
}

/**
 * 차시별 활동내용 생성
 * @param {{ clubName: string, overview: string, lessonCount: number }} params
 * @returns {Promise<string[]>} 차시별 활동내용 배열
 */
export async function generateLessonActivities({ clubName, overview, lessonCount }) {
  const messages = [
    {
      role: 'system',
      content: `당신은 한국 고등학교 동아리 교육과정 전문가입니다. 동아리 개요를 바탕으로 ${lessonCount}차시 분량의 활동내용을 작성해 주세요.
규칙:
- 1차시는 반드시 "동아리 오리엔테이션 및 활동계획 수립"으로 시작
- 마지막 차시는 반드시 "활동 결과물 정리 및 발표/제출"로 마무리
- 각 차시별 활동내용은 한 줄, 20자 내외로 간결하게
- 정확히 ${lessonCount}줄을 출력하세요 (번호 없이 줄바꿈으로 구분)
- 다른 설명 없이 활동내용만 출력하세요`,
    },
    {
      role: 'user',
      content: `동아리명: ${clubName}\n동아리 개요: ${overview}\n\n${lessonCount}차시 활동내용을 작성해 주세요.`,
    },
  ]

  const result = await chatCompletion(messages, { maxTokens: 2000 })
  const lines = result
    .split('\n')
    .map((line) => line.replace(/^\d+[\.\)\-\s]*/, '').trim())
    .filter(Boolean)

  // lessonCount에 맞게 조정
  const activities = []
  for (let i = 0; i < lessonCount; i++) {
    activities.push(lines[i] || '')
  }
  return activities
}
