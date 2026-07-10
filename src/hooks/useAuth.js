import { useAuthContext } from '../providers/authContext'

export function useAuth() {
  return useAuthContext()
}
