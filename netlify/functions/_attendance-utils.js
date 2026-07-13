import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

export async function readBody(req) {
  if (req.method !== 'POST') throw Object.assign(new Error('POST만 허용됩니다.'), { status: 405 })
  return req.json().catch(() => { throw Object.assign(new Error('잘못된 요청입니다.'), { status: 400 }) })
}

export function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ''
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON 환경변수가 필요합니다.')
    const serviceAccount = JSON.parse(raw)
    const storageBucket = process.env.FIREBASE_STORAGE_BUCKET
      || (serviceAccount.project_id ? `${serviceAccount.project_id}.firebasestorage.app` : '')
    initializeApp({ credential: cert(serviceAccount), ...(storageBucket ? { storageBucket } : {}) })
  }
  return getFirestore()
}

export function storageBucket() {
  db()
  return getStorage().bucket()
}

function base64url(value) { return Buffer.from(value).toString('base64url') }

function signedToken(payload, secret) {
  if (!secret) throw new Error('출석부 서명 비밀키가 설정되지 않았습니다.')
  const encoded = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifyToken(token, secret) {
  const [encoded, signature] = String(token || '').split('.')
  if (!encoded || !signature || !secret) throw Object.assign(new Error('유효하지 않은 보안 토큰입니다.'), { status: 401 })
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url')
  const left = Buffer.from(signature); const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw Object.assign(new Error('유효하지 않은 보안 토큰입니다.'), { status: 401 })
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw Object.assign(new Error('보안 세션이 만료되었습니다. 다시 로그인해주세요.'), { status: 401 })
  return payload
}

export function createSessionToken(user) {
  return signedToken({ uid: user.uid, role: user.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 }, process.env.ATTENDANCE_SESSION_SECRET)
}

export function requireActor(req) {
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/iu, '')
  return verifyToken(token, process.env.ATTENDANCE_SESSION_SECRET)
}

export function createPublicToken(payload) {
  return signedToken(payload, process.env.ATTENDANCE_PUBLIC_SECRET)
}

export function verifyPublicToken(token) {
  return verifyToken(token, process.env.ATTENDANCE_PUBLIC_SECRET)
}

export function passwordHash(loginId, password) {
  return createHash('sha256').update(`${String(loginId || '').trim().toLowerCase()}::${String(password || '')}`).digest('hex')
}

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: scryptSync(String(pin), salt, 64).toString('hex') }
}

export function verifyPin(pin, salt, expected) {
  try {
    const actual = Buffer.from(scryptSync(String(pin), String(salt), 64).toString('hex'))
    const wanted = Buffer.from(String(expected || ''))
    return actual.length === wanted.length && timingSafeEqual(actual, wanted)
  } catch { return false }
}

export async function authorizeClub(actor, clubId, adminOnly = false) {
  const store = db()
  const [userSnap, clubSnap] = await Promise.all([store.doc(`users/${actor.uid}`).get(), store.doc(`schedules/${clubId}`).get()])
  if (!userSnap.exists || !clubSnap.exists) throw Object.assign(new Error('사용자 또는 수업 정보를 찾을 수 없습니다.'), { status: 404 })
  const user = { uid: userSnap.id, ...userSnap.data() }; const club = { id: clubSnap.id, ...clubSnap.data() }
  const isAdmin = user.role === 'admin' || user.loginId === 'admin'
  const teacherUids = Array.isArray(club.teacherUids) ? club.teacherUids : [club.teacherUid].filter(Boolean)
  if (adminOnly ? !isAdmin : (!isAdmin && !teacherUids.includes(actor.uid))) throw Object.assign(new Error('이 수업의 출석부 권한이 없습니다.'), { status: 403 })
  return { user, club, isAdmin }
}

export function normalizeEntries(value, rosterUids) {
  const allowed = new Set(rosterUids)
  return Object.entries(value || {}).filter(([uid, status]) => allowed.has(uid) && ['present', 'absent', 'unchecked'].includes(status))
}

export function timestamp() { return FieldValue.serverTimestamp() }

export function handleError(error) {
  console.error(error)
  return json({ error: error instanceof Error ? error.message : '서버 요청을 처리하지 못했습니다.' }, Number(error?.status) || 500)
}
