import { useEffect, useMemo, useRef, useState } from 'react'
import { isFirebaseEnabled } from '../lib/firebase'
import { AuthContext } from './authContext'
import {
  bootstrapDefaultAdminIfNeeded,
  ensureDefaultAdminAccount,
  getUserProfile,
  signInWithLoginId,
  recordLastLogin,
} from '../services/userService'
import { clearAttendanceApiSession, createAttendanceApiSession, refreshAttendanceApiSession } from '../services/attendanceService'

const SESSION_KEY = 'app.session.v3'

function readInitialSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function normalizeRole(role) {
  if (role === 'admin') return 'admin'
  if (role === 'teacher') return 'teacher'
  if (role === 'homeroom') return 'homeroom'
  return 'student'
}

function persistSession(session) {
  try {
    if (session) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } else {
      localStorage.removeItem(SESSION_KEY)
    }
  } catch {
    // noop
  }
}

function buildSession(profile, fallback = {}) {
  const loginId = String(profile?.loginId || fallback.loginId || '').trim()
  return {
    uid: profile?.uid || fallback.uid || '',
    loginId,
    role: normalizeRole(profile?.role || fallback.role),
    email: profile?.email || fallback.email || '',
    name: profile?.name || fallback.name || loginId || '사용자',
    school: profile?.school || fallback.school || '',
    phone: profile?.phone || fallback.phone || '',
    subject: profile?.subject || fallback.subject || '',
    studentNo: profile?.studentNo || fallback.studentNo || '',
    homeroomClass: profile?.homeroomClass || fallback.homeroomClass || '',
    passwordChangedAt: profile?.passwordChangedAt || fallback.passwordChangedAt || null,
  }
}

function normalizeNameToken(name) {
  return String(name || '').trim().replace(/\s+/g, '').toLowerCase()
}

function assertLoginPolicy(account, { loginRole = 'teacher', studentName = '' } = {}) {
  const role = normalizeRole(account?.role)
  const mode = loginRole === 'student' ? 'student' : 'teacher'

  if (mode === 'teacher') {
    if (role === 'student') {
      throw new Error('교사 탭에서는 교사/관리자 계정으로 로그인해주세요.')
    }
    return
  }

  if (role !== 'student') {
    throw new Error('학생 탭에서는 학생 계정으로 로그인해주세요.')
  }

  const expected = normalizeNameToken(studentName)
  if (!expected) {
    throw new Error('학생 이름을 입력해주세요.')
  }

  const actual = normalizeNameToken(account?.name)
  if (!actual || actual !== expected) {
    throw new Error('학번 또는 이름이 올바르지 않습니다.')
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(readInitialSession)
  const [loading, setLoading] = useState(true)
  const [syncError, setSyncError] = useState('')
  // 로그아웃/재로그인 시 이전 로그인의 백그라운드 토큰 발급이 세션을 덮어쓰지 않도록 구분합니다.
  const attendanceSessionSeqRef = useRef(0)

  useEffect(() => {
    let mounted = true

    async function bootstrap() {
      try {
        // 기본 관리자 점검은 첫 화면 표시를 막지 않도록 백그라운드로 수행합니다.
        const adminBootstrap = isFirebaseEnabled() ? bootstrapDefaultAdminIfNeeded() : ensureDefaultAdminAccount()
        adminBootstrap.catch(() => {})

        const current = readInitialSession()
        if (!current?.uid) {
          if (!mounted) return
          setSession(null)
          persistSession(null)
          setSyncError('')
          return
        }

        const profile = await getUserProfile(current.uid)
        if (!mounted) return

        if (!profile) {
          setSession(null)
          persistSession(null)
          setSyncError('')
          return
        }

        const nextSession = buildSession(profile, current)
        setSession(nextSession)
        persistSession(nextSession)
        setSyncError('')
        // 로그인 세션이 유지되는 동안 출석부 보안 토큰도 만료되지 않도록 조용히 연장합니다.
        refreshAttendanceApiSession().catch(() => {})
      } catch (error) {
        if (!mounted) return
        const message = error instanceof Error ? error.message : '로그인 초기화 실패'
        setSyncError(message)
      } finally {
        if (mounted) setLoading(false)
      }
    }

    bootstrap()
    return () => {
      mounted = false
    }
  }, [])

  const value = useMemo(
    () => ({
      user: session,
      isAuthenticated: !!session,
      isLoading: loading,
      lastSyncError: syncError,
      authMode: isFirebaseEnabled() ? 'firestore' : 'demo',
      signInDemo(role = 'student') {
        const nextRole = normalizeRole(role)
        const nextSession = {
          uid: nextRole === 'admin' ? 'demo-admin' : `demo-${nextRole}`,
          loginId: nextRole === 'admin' ? 'admin' : `demo-${nextRole}`,
          role: nextRole,
          email: nextRole === 'admin' ? 'admin@example.com' : `${nextRole}@example.com`,
          name: nextRole === 'admin' ? '관리자 데모' : `${nextRole === 'teacher' ? '교사' : '학생'} 데모`,
          school: '',
          phone: '',
          subject: '',
          studentNo: '',
        }
        setSession(nextSession)
        setSyncError('')
        persistSession(nextSession)
      },
      async signInWithCredentials(loginId, password, options = {}) {
        const normalizedId = String(loginId || '').trim()
        const rawPassword = String(password || '')
        const loginRole = options?.loginRole === 'student' ? 'student' : 'teacher'
        const studentName = String(options?.studentName || '').trim()

        if (!normalizedId || !rawPassword) {
          throw new Error('아이디와 비밀번호를 입력해주세요.')
        }
        if (loginRole === 'student' && !studentName) {
          throw new Error('학생 이름을 입력해주세요.')
        }

        const account = await signInWithLoginId(normalizedId, rawPassword)
        assertLoginPolicy(account, { loginRole, studentName })

        recordLastLogin(account.uid).catch(() => {})

        const nextSession = buildSession(account, {
          uid: account.uid,
          loginId: normalizedId,
        })
        setSession(nextSession)
        setSyncError('')
        persistSession(nextSession)

        // 출석부 보안 토큰은 로그인 완료를 막지 않도록 백그라운드에서 발급합니다.
        // 서버 함수 콜드 스타트로 첫 시도가 실패할 수 있어 간격을 두고 재시도합니다.
        const seq = ++attendanceSessionSeqRef.current
        ;(async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await createAttendanceApiSession(normalizedId, rawPassword)
              if (attendanceSessionSeqRef.current === seq) setSyncError('')
              return
            } catch {
              if (attendanceSessionSeqRef.current !== seq) return
              await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
              if (attendanceSessionSeqRef.current !== seq) return
            }
          }
          if (attendanceSessionSeqRef.current !== seq) return
          clearAttendanceApiSession()
          setSyncError('출석부 보안 세션 발급에 실패했습니다. 출석부 기능이 필요하면 다시 로그인해주세요.')
        })()
      },
      async signInWithGoogle() {
        throw new Error('아이디/비밀번호 로그인 방식을 사용해주세요.')
      },
      async signOut() {
        attendanceSessionSeqRef.current += 1
        clearAttendanceApiSession()
        setSession(null)
        setSyncError('')
        persistSession(null)
      },
    }),
    [loading, session, syncError],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
