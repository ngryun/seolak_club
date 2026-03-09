import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported as isAnalyticsSupported } from 'firebase/analytics'
import { getFirestore } from 'firebase/firestore'
import { appConfig, isFirebaseConfigReady } from '../config/appConfig'

let app = null
let db = null

if (appConfig.useFirebase && isFirebaseConfigReady()) {
  app = initializeApp(appConfig.firebase)
  db = getFirestore(app)
}

export { app, db }

export function isFirebaseEnabled() {
  return !!app && !!db
}

export async function tryInitAnalytics() {
  if (!app || !appConfig.firebase.measurementId) {
    return null
  }

  const supported = await isAnalyticsSupported()
  if (!supported) {
    return null
  }

  return getAnalytics(app)
}
