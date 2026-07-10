import { createSessionToken, db, handleError, json, passwordHash, readBody } from './_attendance-utils.js'

export default async (req) => {
  try {
    const body = await readBody(req)
    const loginId = String(body.loginId || '').trim()
    const password = String(body.password || '')
    if (!loginId || !password) return json({ error: '아이디와 비밀번호가 필요합니다.' }, 400)
    const snapshot = await db().collection('users').where('loginIdLower', '==', loginId.toLowerCase()).limit(1).get()
    let doc = snapshot.docs[0]
    if (!doc) {
      const fallback = await db().collection('users').where('loginId', '==', loginId).limit(1).get()
      doc = fallback.docs[0]
    }
    if (!doc) return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401)
    const user = { uid: doc.id, ...doc.data() }
    const valid = user.passwordHash ? user.passwordHash === passwordHash(user.loginId, password) : String(user.password || '') === password
    if (!valid || !['admin', 'teacher'].includes(user.role)) return json({ error: '출석부를 사용할 수 없는 계정입니다.' }, 401)
    return json({ token: createSessionToken(user), expiresIn: 28800 })
  } catch (error) { return handleError(error) }
}

export const config = { path: '/.netlify/functions/attendance-auth' }
