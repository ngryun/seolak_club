import { SESSION_TTL_SECONDS, createSessionToken, db, handleError, json, passwordHash, readBody, requireActor } from './_attendance-utils.js'

const ALLOWED_ROLES = ['admin', 'teacher', 'homeroom', 'student']

export default async (req) => {
  try {
    const body = await readBody(req)
    if (body.action === 'refresh') {
      // 아직 유효한 토큰을 가진 사용자에게 새 토큰을 발급해 앱 로그인 세션이
      // 유지되는 동안 보안 세션만 먼저 만료되지 않도록 합니다.
      const actor = requireActor(req)
      const snapshot = await db().doc(`users/${actor.uid}`).get()
      const user = snapshot.exists ? { uid: snapshot.id, ...snapshot.data() } : null
      if (!user || !ALLOWED_ROLES.includes(user.role)) return json({ error: '보안 기능을 사용할 수 없는 계정입니다.' }, 401)
      return json({ token: createSessionToken(user), expiresIn: SESSION_TTL_SECONDS })
    }
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
    if (!valid || !ALLOWED_ROLES.includes(user.role)) return json({ error: '보안 기능을 사용할 수 없는 계정입니다.' }, 401)
    return json({ token: createSessionToken(user), expiresIn: SESSION_TTL_SECONDS })
  } catch (error) { return handleError(error) }
}

