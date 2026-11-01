// کپی محلی این فایل را با نام firebase-config.js بسازید و فقط مقادیر Web App
// پروژه خود را از Firebase Console در آن قرار دهید. کلید خصوصی یا service
// account credential نباید در این فایل قرار بگیرد.
export const firebaseConfig = Object.freeze({
  apiKey: 'FIREBASE_WEB_API_KEY',
  authDomain: 'PROJECT_ID.firebaseapp.com',
  projectId: 'PROJECT_ID',
  storageBucket: 'PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'MESSAGING_SENDER_ID',
  appId: 'FIREBASE_WEB_APP_ID',
});

export const firebaseConfigReady = true;
