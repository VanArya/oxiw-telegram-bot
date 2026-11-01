import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { firebaseConfig, firebaseConfigReady } from './firebase-config.js';

const requiredConfigKeys = [
  'apiKey',
  'authDomain',
  'projectId',
  'messagingSenderId',
  'appId',
];

const statusElement = document.querySelector('#status');
const signInButton = document.querySelector('#sign-in');
const signOutButton = document.querySelector('#sign-out');
const userPanel = document.querySelector('#user-panel');
const userEmail = document.querySelector('#user-email');
const userUid = document.querySelector('#user-uid');

function setStatus(message, tone = 'neutral') {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
}

function isConfigured() {
  return firebaseConfigReady
    && requiredConfigKeys.every((key) => (
      typeof firebaseConfig?.[key] === 'string'
      && firebaseConfig[key].trim().length > 0
    ));
}

function renderUser(user) {
  const signedIn = Boolean(user);
  userPanel.hidden = !signedIn;
  signOutButton.hidden = !signedIn;
  signInButton.hidden = signedIn;

  if (!signedIn) {
    userEmail.textContent = '—';
    userUid.textContent = '—';
    return;
  }

  userEmail.textContent = user.email || 'ایمیل در دسترس نیست';
  userUid.textContent = user.uid;
  setStatus('ورود Firebase انجام شد؛ نقش administrator هنوز بررسی نشده است.', 'success');
}

function publicAuthError(error) {
  const knownMessages = new Map([
    ['auth/popup-blocked', 'مرورگر پنجره ورود را مسدود کرد. اجازه پنجره بازشو را بدهید.'],
    ['auth/popup-closed-by-user', 'پنجره ورود بسته شد؛ دوباره تلاش کنید.'],
    ['auth/cancelled-popup-request', 'درخواست ورود دیگری در حال انجام است.'],
    ['auth/unauthorized-domain', 'این دامنه در Firebase مجاز نشده است.'],
    ['auth/operation-not-allowed', 'ورود Google در Firebase فعال نشده است.'],
  ]);
  return knownMessages.get(error?.code) || 'ورود انجام نشد. تنظیمات Firebase و دامنه مجاز را بررسی کنید.';
}

let auth;

if (!isConfigured()) {
  setStatus('پیکربندی Firebase تنظیم نشده است. ابتدا firebase-config.js را با مقدار Web App پر کنید.', 'error');
} else {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    signInButton.disabled = false;

    onAuthStateChanged(auth, (user) => {
      renderUser(user);
      if (!user) setStatus('برای ادامه با حساب Google وارد شوید.');
    });
  } catch {
    setStatus('راه‌اندازی Firebase انجام نشد؛ پیکربندی Web App را بررسی کنید.', 'error');
  }
}

signInButton.addEventListener('click', async () => {
  if (!auth) return;
  signInButton.disabled = true;
  setStatus('در حال بازکردن ورود Google…');
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    setStatus(publicAuthError(error), 'error');
  } finally {
    signInButton.disabled = false;
  }
});

signOutButton.addEventListener('click', async () => {
  if (!auth) return;
  signOutButton.disabled = true;
  try {
    await signOut(auth);
  } catch {
    setStatus('خروج انجام نشد؛ دوباره تلاش کنید.', 'error');
  } finally {
    signOutButton.disabled = false;
  }
});
