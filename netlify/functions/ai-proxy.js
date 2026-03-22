const API_URL = 'https://api.openai.com/v1/chat/completions'
const MODEL = 'gpt-5.4-nano'

export default async (req) => {
  // OPENAI_API_KEY (VITE_ 접두사 없음 — 서버 측 전용)
  const apiKey = process.env.OPENAI_API_KEY || ''
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenAI API 키가 서버에 설정되지 않았습니다.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST만 허용됩니다.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: '잘못된 요청입니다.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { messages, maxTokens = 1200 } = body
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages 배열이 필요합니다.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_completion_tokens: Math.min(Number(maxTokens) || 1200, 2000),
        temperature: 0.7,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return new Response(JSON.stringify({ error: `OpenAI 오류 (${res.status}): ${text.slice(0, 300)}` }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content || ''

    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: `서버 오류: ${err.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export const config = {
  path: '/.netlify/functions/ai-proxy',
}
