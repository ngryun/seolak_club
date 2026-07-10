import { useEffect, useState } from 'react'
import PrototypeApp from '../features/prototype/PrototypeApp'
import { PublicAttendancePage } from '../features/attendance/AttendancePages'

export function AppRouter() {
  const [path, setPath] = useState(window.location.pathname)

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (path === '/prototype') {
      window.history.replaceState({}, '', `/${window.location.search}${window.location.hash}`)
      setPath('/')
    }
  }, [path])

  const studentOnly = path === '/student'
  const publicAttendanceMatch = path.match(/^\/attendance\/public\/([^/]+)$/u)

  if (publicAttendanceMatch) {
    return <PublicAttendancePage token={decodeURIComponent(publicAttendanceMatch[1])} />
  }

  return <PrototypeApp studentOnly={studentOnly} />
}
