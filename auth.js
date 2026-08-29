/* =========================================================================================
   KITABLOX AUTH MODULE
   Handles: email/password register + login, Google sign-in, username claiming/uniqueness
   via Firestore, session persistence, sign-out, and wiring the results into the game's
   existing menu overlay / HUD.

   Firestore layout used by this module:
     users/{uid}          -> { username, usernameLower, email, createdAt, lastLogin }
     usernames/{lowercase username} -> { uid, username }   (uniqueness reservation doc)

   Recommended Firestore security rules (set these in the Firebase console):
   ---------------------------------------------------------------------
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read: if true;
         allow create, update: if request.auth != null && request.auth.uid == uid;
       }
       match /usernames/{name} {
         allow read: if true;
         allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
         allow update, delete: if false;
       }
     }
   }
   ---------------------------------------------------------------------
   Also enable the "Email/Password" and "Google" sign-in providers under
   Firebase Console -> Authentication -> Sign-in method, and make sure the
   domain this page is hosted on is listed under Authentication -> Settings
   -> Authorized domains.

   Depends on: the Firebase compat SDK <script> tags and the auth/menu markup
   in index.html. Does NOT depend on graphics.js / world.js / engine.js -- it
   only touches `controls` defensively (typeof-checked) when signing out mid-game.
   ========================================================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyD00fU6Eszz-hGmlr3P618jL5EoDxxWiYA",
  authDomain: "kitablox.firebaseapp.com",
  projectId: "kitablox",
  storageBucket: "kitablox.firebasestorage.app",
  messagingSenderId: "701333528621",
  appId: "1:701333528621:web:fe0da62d5c815750ead8a4",
  measurementId: "G-VZ59WQ6HJH"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

let currentUser = null;      // firebase.auth().currentUser mirror
let currentUsername = null;  // resolved from Firestore users/{uid}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

function validateUsername(name) {
  return USERNAME_RE.test(name || '');
}

// ---------- small DOM helpers ----------
function showScreen(name) {
  document.querySelectorAll('.auth-screen').forEach(el => {
    el.classList.toggle('active', el.dataset.screen === name);
  });
}

function showError(scope, message) {
  const el = document.getElementById(scope + '-error');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
}

function clearError(scope) {
  const el = document.getElementById(scope + '-error');
  if (!el) return;
  el.textContent = '';
  el.classList.remove('show');
}

function setLoading(buttonEl, loading) {
  if (!buttonEl) return;
  buttonEl.disabled = loading;
  buttonEl.classList.toggle('is-loading', loading);
}

function friendlyAuthError(err) {
  const code = err && err.code;
  const map = {
    'auth/email-already-in-use': 'That email is already registered. Try logging in instead.',
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password. Try again.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-login-credentials': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
    'auth/network-request-failed': 'Network error. Check your connection and try again.'
  };
  if (code && map[code]) return map[code];
  if (err && err.message === 'USERNAME_TAKEN') return 'That username is already taken. Try another.';
  return (err && err.message) ? err.message : 'Something went wrong. Please try again.';
}

// ---------- Firestore username claim (used by register + Google setup) ----------
async function claimUsername(uid, email, username) {
  const usernameLower = username.toLowerCase();
  const usernameRef = db.collection('usernames').doc(usernameLower);
  const userRef = db.collection('users').doc(uid);

  await db.runTransaction(async (tx) => {
    const nameSnap = await tx.get(usernameRef);
    if (nameSnap.exists && nameSnap.data().uid !== uid) {
      throw new Error('USERNAME_TAKEN');
    }
    tx.set(usernameRef, { uid, username });
    tx.set(userRef, {
      username,
      usernameLower,
      email: email || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastLogin: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

function touchLastLogin(uid) {
  db.collection('users').doc(uid).update({
    lastLogin: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(() => { /* non-fatal */ });
}

// ---------- Register with email/password ----------
async function handleRegister(email, password, confirmPassword, username) {
  clearError('register');

  if (!validateUsername(username)) {
    showError('register', 'Username must be 3-16 characters: letters, numbers, underscore only.');
    return;
  }
  if (password.length < 6) {
    showError('register', 'Password must be at least 6 characters.');
    return;
  }
  if (password !== confirmPassword) {
    showError('register', 'Passwords do not match.');
    return;
  }

  const btn = document.getElementById('register-submit-btn');
  setLoading(btn, true);
  let createdCred = null;
  try {
    createdCred = await auth.createUserWithEmailAndPassword(email, password);
    await claimUsername(createdCred.user.uid, email, username);
    await createdCred.user.updateProfile({ displayName: username });
    // onAuthStateChanged will pick this up and route to the play screen.
  } catch (err) {
    // Roll back the just-created auth account if username claim failed,
    // so we don't leave a "ghost" account with no username.
    if (createdCred && createdCred.user) {
      await createdCred.user.delete().catch(() => {});
      await auth.signOut().catch(() => {});
    }
    showError('register', friendlyAuthError(err));
  } finally {
    setLoading(btn, false);
  }
}

// ---------- Log in with email/password ----------
async function handleLogin(email, password) {
  clearError('login');
  const btn = document.getElementById('login-submit-btn');
  setLoading(btn, true);
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    showError('login', friendlyAuthError(err));
  } finally {
    setLoading(btn, false);
  }
}

// ---------- Google sign-in ----------
async function handleGoogleSignIn() {
  clearError('login');
  const btn = document.getElementById('google-signin-btn');
  setLoading(btn, true);
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
    // onAuthStateChanged handles routing: existing users -> play screen,
    // brand new Google users -> username setup screen.
  } catch (err) {
    if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request')) {
      try { await auth.signInWithRedirect(provider); return; } catch (e2) { /* fall through */ }
    }
    showError('login', friendlyAuthError(err));
  } finally {
    setLoading(btn, false);
  }
}

// ---------- Username setup (for accounts with no username yet, e.g. fresh Google sign-in) ----------
async function handleUsernameSetup(username) {
  clearError('username-setup');
  if (!validateUsername(username)) {
    showError('username-setup', 'Username must be 3-16 characters: letters, numbers, underscore only.');
    return;
  }
  const user = auth.currentUser;
  if (!user) { showScreen('auth'); return; }

  const btn = document.getElementById('username-setup-submit-btn');
  setLoading(btn, true);
  try {
    await claimUsername(user.uid, user.email, username);
    await user.updateProfile({ displayName: username }).catch(() => {});
    currentUsername = username;
    applyAuthenticatedUI(user, username);
    showScreen('play');
  } catch (err) {
    showError('username-setup', friendlyAuthError(err));
  } finally {
    setLoading(btn, false);
  }
}

function handleSignOut() {
  // If mid-game, release the pointer lock first so the overlay is visible.
  if (typeof controls !== 'undefined' && controls && controls.isLocked) {
    controls.unlock();
  }
  auth.signOut();
}

function applyAuthenticatedUI(user, username) {
  const initial = (username || '?').charAt(0).toUpperCase();
  document.getElementById('welcome-username').textContent = username;
  document.getElementById('welcome-avatar').textContent = initial;
  document.getElementById('hud-username').textContent = username;
  document.getElementById('account-badge').classList.add('show');
}

// ---------- Auth state -> screen routing ----------
auth.onAuthStateChanged(async (user) => {
  currentUser = user;

  if (!user) {
    currentUsername = null;
    document.getElementById('account-badge').classList.remove('show');
    showScreen('auth');
    return;
  }

  try {
    const doc = await db.collection('users').doc(user.uid).get();
    if (doc.exists && doc.data().username) {
      currentUsername = doc.data().username;
      applyAuthenticatedUI(user, currentUsername);
      touchLastLogin(user.uid);
      showScreen('play');
    } else {
      // Authenticated (likely via Google) but no username claimed yet.
      showScreen('usernameSetup');
    }
  } catch (err) {
    console.error('Failed to load user profile:', err);
    showScreen('auth');
    showError('login', 'Could not load your profile. Please try again.');
  }
});

// Catch redirect-based Google sign-in results (fallback path when popups are blocked).
auth.getRedirectResult().catch((err) => {
  if (err && err.code) console.warn('Redirect sign-in error:', err.code);
});

// ---------- Wire up DOM events once the document is ready ----------
document.addEventListener('DOMContentLoaded', () => {
  const tabLogin = document.getElementById('tab-login-btn');
  const tabRegister = document.getElementById('tab-register-btn');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    loginForm.classList.add('active');
    registerForm.classList.remove('active');
    clearError('login'); clearError('register');
  });

  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    registerForm.classList.add('active');
    loginForm.classList.remove('active');
    clearError('login'); clearError('register');
  });

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    handleLogin(email, password);
  });

  registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;
    const confirm = document.getElementById('register-password-confirm').value;
    handleRegister(email, password, confirm, username);
  });

  document.getElementById('google-signin-btn').addEventListener('click', handleGoogleSignIn);

  document.getElementById('username-setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('setup-username').value.trim();
    handleUsernameSetup(username);
  });
  document.getElementById('username-setup-signout-btn').addEventListener('click', handleSignOut);
  document.getElementById('play-signout-btn').addEventListener('click', handleSignOut);
  document.getElementById('hud-signout-btn').addEventListener('click', handleSignOut);
});
