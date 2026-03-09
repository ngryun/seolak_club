import { useEffect, useState } from 'react'
import { appConfig, isFirebaseConfigReady } from '../config/appConfig'
import { useAuth } from '../hooks/useAuth'
import { listAppliedSchedulesByTeacher } from '../services/applicationService'
import { listSchedules } from '../services/scheduleService'

const roleLabel = (role) => {
  if (role === 'admin') return '관리자'
  if (role === 'teacher') return '교사'
  return '학생'
}

const pageStyle = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#f7f5f2',
  padding: '24px',
}

const cardStyle = {
  width: '100%',
  maxWidth: '720px',
  background: '#ffffff',
  border: '1px solid #e7e2db',
  borderRadius: '16px',
  padding: '28px',
  boxShadow: '0 6px 22px rgba(0, 0, 0, 0.05)',
  fontFamily: "'Pretendard Variable', 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
}

const titleStyle = {
  margin: 0,
  fontSize: '24px',
  color: '#1f1f1f',
}

const textStyle = {
  marginTop: '10px',
  color: '#5f5a53',
  lineHeight: 1.5,
}

const rowStyle = {
  marginTop: '22px',
  display: 'flex',
  gap: '12px',
  flexWrap: 'wrap',
}

const primaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '10px 16px',
  borderRadius: '10px',
  background: '#be6f4c',
  color: '#fff',
  textDecoration: 'none',
  fontWeight: 600,
}

const subtleButton = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '10px 16px',
  borderRadius: '10px',
  border: '1px solid #e0d8cd',
  background: '#fff',
  color: '#433f39',
  textDecoration: 'none',
  fontWeight: 500,
  cursor: 'pointer',
}

export function ServiceHomePage() {
  const { user, isAuthenticated, isLoading, authMode, lastSyncError, signInDemo, signInWithCredentials, signOut } = useAuth()
  const [scheduleCount, setScheduleCount] = useState(0)
  const [myApplicationCount, setMyApplicationCount] = useState(0)
  const [loginRole, setLoginRole] = useState('teacher')
  const [loginId, setLoginId] = useState('')
  const [loginName, setLoginName] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    let mounted = true

    async function loadSchedules() {
      const schedules = await listSchedules()
      if (mounted) {
        setScheduleCount(schedules.length)
      }
    }

    loadSchedules()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    let mounted = true

    async function loadMyApplications() {
      if (!isAuthenticated || !user?.uid) {
        if (mounted) setMyApplicationCount(0)
        return
      }

      const myApplied = await listAppliedSchedulesByTeacher(user.uid)
      if (mounted) {
        setMyApplicationCount(myApplied.length)
      }
    }

    loadMyApplications()

    return () => {
      mounted = false
    }
  }, [isAuthenticated, user?.uid])

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={titleStyle}>강원 설악고등학교 신청 통합 시스템</h1>
        <p style={textStyle}>
          현재는 동아리 신청 서비스로 전환 중입니다. 다음 단계에서 Firebase 인증/DB를
          연결해 실제 운영 흐름으로 전환합니다.
        </p>
        <p style={{ ...textStyle, marginTop: '8px', fontSize: '14px' }}>
          Auth 상태: {isLoading ? '확인 중...' : isAuthenticated ? `${roleLabel(user.role)} (${user.loginId || user.email || user.uid})` : '로그인 안됨'}
        </p>
        <p style={{ ...textStyle, marginTop: '4px', fontSize: '13px' }}>
          Auth 모드: {authMode}
        </p>
        <p style={{ ...textStyle, marginTop: '4px', fontSize: '13px' }}>
          Firebase 준비: {appConfig.useFirebase ? (isFirebaseConfigReady() ? '설정 완료' : 'env 미완료') : '비활성화'}
        </p>
        <p style={{ ...textStyle, marginTop: '4px', fontSize: '13px' }}>
          서비스 레이어 조회: 동아리 모집 {scheduleCount}건
        </p>
        <p style={{ ...textStyle, marginTop: '4px', fontSize: '13px' }}>
          서비스 레이어 조회: 내 신청 {myApplicationCount}건
        </p>
        {!!lastSyncError && (
          <p style={{ ...textStyle, marginTop: '8px', color: '#b23a2b', fontSize: '13px' }}>
            Firestore 동기화 오류: {lastSyncError}
          </p>
        )}
        {!!authError && (
          <p style={{ ...textStyle, marginTop: '8px', color: '#b23a2b', fontSize: '13px' }}>
            로그인 오류: {authError}
          </p>
        )}
        <div style={rowStyle}>
          <a href="/prototype" style={primaryButton}>
            기존 프로토타입 열기
          </a>
          <a href="/" style={subtleButton}>
            서비스 홈
          </a>
          <button
            type="button"
            style={{
              ...subtleButton,
              background: loginRole === 'teacher' ? '#f4ece6' : '#fff',
              borderColor: loginRole === 'teacher' ? '#d6b9a6' : '#e0d8cd',
            }}
            onClick={() => {
              setLoginRole('teacher')
              setAuthError('')
            }}
          >
            교사 탭
          </button>
          <button
            type="button"
            style={{
              ...subtleButton,
              background: loginRole === 'student' ? '#f4ece6' : '#fff',
              borderColor: loginRole === 'student' ? '#d6b9a6' : '#e0d8cd',
            }}
            onClick={() => {
              setLoginRole('student')
              setAuthError('')
            }}
          >
            학생 탭
          </button>
          <input
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            placeholder={loginRole === 'student' ? '학생 학번(5자리)' : '교사 아이디(성명)'}
            style={{ ...subtleButton, minWidth: '140px', textAlign: 'left', fontWeight: 400, border: '1px solid #e0d8cd' }}
          />
          {loginRole === 'student' && (
            <input
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="학생 이름"
              style={{ ...subtleButton, minWidth: '120px', textAlign: 'left', fontWeight: 400, border: '1px solid #e0d8cd' }}
            />
          )}
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            placeholder="비밀번호"
            style={{ ...subtleButton, minWidth: '140px', textAlign: 'left', fontWeight: 400, border: '1px solid #e0d8cd' }}
          />
          <button
            type="button"
            style={subtleButton}
            onClick={async () => {
              try {
                setAuthError('')
                await signInWithCredentials(loginId, loginPassword, {
                  loginRole,
                  studentName: loginName,
                })
              } catch (error) {
                setAuthError(error instanceof Error ? error.message : '로그인 실패')
              }
            }}
          >
            아이디 로그인
          </button>
          <button type="button" style={subtleButton} onClick={() => signInDemo('admin')}>
            관리자 데모 로그인
          </button>
          <button type="button" style={subtleButton} onClick={() => signInDemo('student')}>
            학생 데모 로그인
          </button>
          <button type="button" style={subtleButton} onClick={signOut}>
            로그아웃
          </button>
        </div>
      </div>
    </div>
  )
}
