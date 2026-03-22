const env = import.meta.env
const rawAdminEmails = env.VITE_ADMIN_EMAILS || ''

export const appConfig = {
  useFirebase: env.VITE_USE_FIREBASE === 'true',
  authLoginDomain: env.VITE_AUTH_LOGIN_DOMAIN || 'seolak.local',
  defaultAdminPassword: env.VITE_DEFAULT_ADMIN_PASSWORD || 'Seolak#2026!',
  defaultAdminPasswordFromEnv: !!String(env.VITE_DEFAULT_ADMIN_PASSWORD || '').trim(),
  adminEmails: rawAdminEmails
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  firebase: {
    apiKey: env.VITE_FIREBASE_API_KEY || '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId: env.VITE_FIREBASE_PROJECT_ID || '',
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: env.VITE_FIREBASE_APP_ID || '',
    measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || '',
  },
}

export function isFirebaseConfigReady() {
  const values = [
    appConfig.firebase.apiKey,
    appConfig.firebase.authDomain,
    appConfig.firebase.projectId,
    appConfig.firebase.storageBucket,
    appConfig.firebase.messagingSenderId,
    appConfig.firebase.appId,
  ]
  return values.every((value) => value && String(value).trim().length > 0)
}
