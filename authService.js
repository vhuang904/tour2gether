// authService.js - Tour2gether PWA 認證模組（全平台跨網域防阻擋高相容版 + Storage 圖片支援）

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signInWithRedirect, 
  getRedirectResult,
  getAdditionalUserInfo,
  signOut, 
  onAuthStateChanged,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
  getFirestore, 
  doc, 
  getDoc, 
  getDocFromServer,
  runTransaction,
  setDoc, 
  updateDoc, 
  collection, 
  getDocs,
  query, 
  where,
  addDoc, 
  serverTimestamp, 
  increment 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
  getStorage, 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCm2dCa2Y8d6Z-Dc_Uz9yvvgai6fav-1Vg",
  authDomain: "auth.tour2gether.ph",
  projectId: "bigv-foodmap",
  storageBucket: "bigv-foodmap.firebasestorage.app",
  messagingSenderId: "701000455421",
  appId: "1:701000455421:web:ab02befef466e1f8989a94",
  measurementId: "G-9G6BR6ZGBP"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// 設定登入狀態本機持久化
setPersistence(auth, browserLocalPersistence).catch(err => {
  console.warn("[AuthService] 設定持久化略過:", err);
});

const googleProvider = new GoogleAuthProvider();
// 拿掉 prompt: 'select_account'，讓瀏覽器記住上次選取的帳號，實現一鍵靜默授權
googleProvider.setCustomParameters({});
googleProvider.addScope("email");

let currentUserProfile = null;

function getAuthLanguage() {
  return document.documentElement.lang === 'zh-TW' ? 'zh-TW' : 'en';
}

export function calculateUserLevel(points = 0) {
  if (points >= 500) return "LV.5 終極米其林老饕";
  if (points >= 300) return "LV.4 尋味美食家";
  if (points >= 150) return "LV.3 街巷老吃貨";
  if (points >= 50) return "LV.2 認證探店客";
  return "LV.1 探店初心者";
}

function broadcastAuthChange(user, profile) {
  const event = new CustomEvent("auth-user-changed", {
    detail: {
      user: user,
      profile: profile,
      isLoggedIn: !!user
    }
  });
  window.dispatchEvent(event);
}

function normalizeMemberEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email) ? email : '';
}

// A result is used only for the same Firebase UID. Never persist OAuth tokens.
async function resolveMemberEmail(user, result) {
  const primary = normalizeMemberEmail(user.email);
  if (primary) return primary;
  const google = (user.providerData || []).find(p => p.providerId === 'google.com');
  const providerEmail = normalizeMemberEmail(google?.email);
  if (providerEmail) return providerEmail;
  if (!result || result.user?.uid !== user.uid || result.providerId !== 'google.com') return '';
  const info = getAdditionalUserInfo(result);
  const profile = info?.providerId === 'google.com' ? info.profile : null;
  const profileEmail = normalizeMemberEmail(profile?.email);
  if (profileEmail && (profile.email_verified === true || profile.verified_email === true)) return profileEmail;
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken || !google?.uid) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + credential.accessToken },
      cache: 'no-store', credentials: 'omit', signal: controller.signal
    });
    if (!response.ok) return '';
    const data = await response.json();
    if (data.sub !== google.uid || data.email_verified !== true) return '';
    return normalizeMemberEmail(data.email);
  } finally { clearTimeout(timer); }
}

// Only the email is backfilled on existing profiles; transactions protect concurrent logins.
export async function fetchOrCreateUserProfile(user, result = null) {
  if (!user) {
    currentUserProfile = null;
    broadcastAuthChange(null, null);
    return null;
  }
  let userEmail = '';
  try { userEmail = await resolveMemberEmail(user, result); }
  catch (_) { console.warn('[AuthService] Email lookup unavailable; existing profile retained.'); }
  const userRef = doc(db, 'users', user.uid);
  try {
    const snapshot = await getDoc(userRef);
    let inheritedPoints = 50;
    let inheritedLevel = 'LV.1 探店初心者';
    if (!snapshot.exists() && userEmail) {
      try {
        const matches = await getDocs(query(collection(db, 'users'), where('email', '==', userEmail)));
        if (!matches.empty) {
          const old = matches.docs[0].data();
          inheritedPoints = old.points || 50;
          inheritedLevel = old.level || calculateUserLevel(old.points || 50);
        }
      } catch (_) { console.warn('[AuthService] Historical profile lookup unavailable.'); }
    }
    // Normal/restored sessions retain the existing cache-friendly read path.
    const saved = snapshot.exists() ? snapshot.data() : null;
    const data = saved && (String(saved.email || '').trim() || !userEmail) ? saved : await runTransaction(db, async transaction => {
      const current = await transaction.get(userRef);
      if (current.exists()) {
        const existing = current.data();
        if (!String(existing.email || '').trim() && userEmail) {
          transaction.update(userRef, { email: userEmail });
          return { ...existing, email: userEmail };
        }
        return existing;
      }
      const created = {
        displayName: user.displayName || '', photoURL: user.photoURL || '',
        email: userEmail, points: inheritedPoints, level: inheritedLevel,
        createdAt: serverTimestamp(), lastLoginAt: serverTimestamp()
      };
      transaction.set(userRef, created);
      return created;
    });
    const profile = {
      uid: user.uid, displayName: data.displayName || user.displayName || '',
      photoURL: data.photoURL || user.photoURL || '', email: data.email || '',
      points: typeof data.points === 'number' ? data.points : 50,
      level: data.level || calculateUserLevel(data.points || 50)
    };
    if (auth.currentUser?.uid !== user.uid) return profile;
    currentUserProfile = profile;
    broadcastAuthChange(user, profile);
    return profile;
  } catch (error) {
    console.error('[AuthService] Member profile save failed:', error.code || 'unknown');
    const profile = {
      uid: user.uid, displayName: user.displayName || '', photoURL: user.photoURL || '',
      email: userEmail, points: 50, level: 'LV.1 探店初心者'
    };
    if (auth.currentUser?.uid !== user.uid) return profile;
    currentUserProfile = profile;
    broadcastAuthChange(user, profile);
    return profile;
  }
}

// 1. Google 登入
export async function loginWithGoogle() {
  auth.languageCode = getAuthLanguage();
  try {
    const result = await signInWithPopup(auth, googleProvider);
    if (result && result.user) {
      const profile = await fetchOrCreateUserProfile(result.user, result);
      return profile;
    }
    return null;
  } catch (error) {
    console.warn("[AuthService] Google Popup 登入異常:", error.code, error.message);

    if (error.code === 'auth/popup-blocked' || error.code === 'auth/cancelled-popup-request') {
      console.log("[AuthService] 彈窗受阻，切換至轉址模式備援...");
      await signInWithRedirect(auth, googleProvider);
      return null;
    }

    if (error.code === 'auth/popup-closed-by-user') {
      throw new Error("您已關閉登入視窗。");
    }

    throw error;
  }
}

// 2. Email 魔法精靈登入
export async function sendMagicEmailLink(email) {
  const cleanEmail = (email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("請輸入正確的電子郵件信箱。");
  }

  const lang = getAuthLanguage();
  auth.languageCode = lang;
  const actionCodeSettings = {
    url: window.location.origin + window.location.pathname + '?lang=' + lang,
    handleCodeInApp: true
  };

  await sendSignInLinkToEmail(auth, cleanEmail, actionCodeSettings);
  window.localStorage.setItem("emailForSignIn", cleanEmail);
  return true;
}

// 3. 登出
export async function logoutUser() {
  try {
    await signOut(auth);
    currentUserProfile = null;
    window.localStorage.removeItem("emailForSignIn");
    broadcastAuthChange(null, null);
  } catch (error) {
    console.error("[AuthService] 登出失敗:", error);
    throw error;
  }
}

export function getCurrentProfile() {
  return currentUserProfile;
}

/**
 * users/{uid}: emailDigestEnabled (boolean), emailDigestPreferenceUpdatedAt (timestamp).
 * Missing preference defaults to on only after a successful server read.
 * A default is not consent: reads never write enrollment or consent records.
 * These helpers do not send email or change browser push subscriptions.
 */
export async function getEmailDigestPreference(expectedUid) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to read email preferences.");
  if (user.uid !== expectedUid) throw new Error("The signed-in account has changed.");
  const snapshot = await getDocFromServer(doc(db, "users", user.uid));
  if (!snapshot.exists()) throw new Error("Member profile is unavailable.");
  const enabled = snapshot.data().emailDigestEnabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Invalid email preference.");
  }
  return { enabled: enabled === undefined ? true : enabled, isDefault: enabled === undefined };
}

export async function setEmailDigestPreference(enabled, expectedUid) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to update email preferences.");
  if (user.uid !== expectedUid) throw new Error("The signed-in account has changed.");
  if (typeof enabled !== "boolean") throw new Error("Email preference must be a boolean.");
  if (!navigator.onLine) throw new Error("An internet connection is required to save email preferences.");
  await updateDoc(doc(db, "users", user.uid), {
    emailDigestEnabled: enabled,
    emailDigestPreferenceUpdatedAt: serverTimestamp()
  });
  return { enabled, isDefault: false };
}

export async function getStoreComments(storeId) {
  try {
    const q = query(
      collection(db, "comments"),
      where("storeId", "==", String(storeId).trim())
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(doc => {
      list.push({ id: doc.id, ...doc.data() });
    });
    return list;
  } catch (err) {
    console.error("[authService] getStoreComments 失敗:", err);
    throw err;
  }
}

// ⭐ 新增：上傳單張已壓縮照片到 Firebase Storage
export async function uploadCommentPhoto(storeId, fileBlob) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw Object.assign(new Error("請先登入後再上傳照片。"), { code: "comment/sign-in-required" });

  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const filePath = `comments/${String(storeId).trim()}/${currentUser.uid}_${timestamp}_${randomStr}.webp`;
  const storageRef = ref(storage, filePath);

  await uploadBytes(storageRef, fileBlob, { contentType: 'image/webp' });
  const downloadURL = await getDownloadURL(storageRef);
  return downloadURL;
}

// 4. 發表評論累計積分 (+20 PTS，支援 photos 多圖陣列與背景非同步雙向中英互譯)
export async function addStoreComment(storeId, commentPayload, photos = []) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw Object.assign(new Error("請先登入後再發表探店評價。"), { code: "comment/sign-in-required" });
  }

  if (!storeId) {
    throw Object.assign(new Error("店家代碼無效。"), { code: "comment/invalid-place" });
  }

  const cleanComment = (typeof commentPayload === 'string' ? commentPayload : (commentPayload?.comment || "")).trim();
  const photoList = Array.isArray(commentPayload?.photos) ? commentPayload.photos : (Array.isArray(photos) ? photos : []);

  if (!cleanComment && photoList.length === 0) {
    throw Object.assign(new Error("請填寫評價內容或上傳照片。"), { code: "comment/empty" });
  }

  const rating = Number(commentPayload?.rating) || 5;

  // 判斷語言：若包含中文字元則為中文，否則視為英文
  const hasChinese = /[\u4e00-\u9fa5]/.test(cleanComment);
  const detectedOriginalLang = hasChinese ? "zh-TW" : "en";

  // 1. 立即寫入 Firestore（包含 photos 陣列）
  const commentDocData = {
    storeId: String(storeId),
    targetId: String(storeId),
    userId: currentUser.uid,
    userEmail: currentUser.email || "",
    userName: currentUserProfile?.displayName || currentUser.displayName || "Member",
    userPhoto: currentUserProfile?.photoURL || currentUser.photoURL || "",
    rating: rating,
    comment: cleanComment,
    content: cleanComment,
    photos: photoList,
    comment_zh: hasChinese ? cleanComment : "",
    comment_en: !hasChinese ? cleanComment : "",
    originalLang: detectedOriginalLang,
    createdAt: serverTimestamp()
  };

  const docRef = await addDoc(collection(db, "comments"), commentDocData);

  // 2. 累計會員積分與等級更新
  const userRef = doc(db, "users", currentUser.uid);
  await updateDoc(userRef, {
    points: increment(20),
    lastCommentAt: serverTimestamp()
  });

  if (currentUserProfile) {
    currentUserProfile.points = (currentUserProfile.points || 0) + 20;
    currentUserProfile.level = calculateUserLevel(currentUserProfile.points);
    await updateDoc(userRef, { level: currentUserProfile.level });
    broadcastAuthChange(currentUser, currentUserProfile);
  }

  // 3. 背景非同步翻譯文字（若有文字內容）
  if (cleanComment) {
    (async () => {
      try {
        const AI_WORKER_TRANSLATE_URL = "https://food-ai-assistant.vhuang904.workers.dev/translate-comment";
        const sourceLang = hasChinese ? "chinese" : "english";
        const targetLang = hasChinese ? "english" : "chinese";

        const res = await fetch(AI_WORKER_TRANSLATE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            text: cleanComment,
            source_lang: sourceLang,
            target_lang: targetLang
          })
        });
        const data = await res.json();
        if (data.translatedText && data.translatedText.trim()) {
          const updatePayload = hasChinese 
            ? { comment_en: data.translatedText.trim() } 
            : { comment_zh: data.translatedText.trim() };

          await updateDoc(doc(db, "comments", docRef.id), updatePayload);
        }
      } catch (e) {
        console.warn("[AuthService] 背景雙向翻譯回填略過:", e);
      }
    })();
  }

  return {
    success: true,
    addedPoints: 20,
    newPoints: currentUserProfile?.points,
    newLevel: currentUserProfile?.level
  };
}

// 5. 初始化認證監聽
export function initAuthService() {
  auth.languageCode = getAuthLanguage();
  if (isSignInWithEmailLink(auth, window.location.href)) {
    let email = window.localStorage.getItem("emailForSignIn");
    if (!email) {
      email = window.prompt(getAuthLanguage() === 'en'
        ? "Enter the email address you used to request this sign-in link:"
        : "請輸入登入時所使用的電子郵件信箱：");
    }
    if (email) {
      signInWithEmailLink(auth, email, window.location.href)
        .then(async (result) => {
          window.localStorage.removeItem("emailForSignIn");
          await fetchOrCreateUserProfile(result.user, result);
          window.history.replaceState({}, document.title, window.location.pathname);
        })
        .catch((err) => {
          console.error("[AuthService] Email 魔法登入驗證錯誤:", err);
          window.dispatchEvent(new CustomEvent('auth-sign-in-error', { detail: { method: 'email' } }));
        });
    }
  }

  getRedirectResult(auth)
    .then(async (result) => {
      if (result && result.user) {
        await fetchOrCreateUserProfile(result.user, result);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    })
    .catch((error) => {
      console.warn("[AuthService] Redirect 狀態略過:", error.code);
      window.dispatchEvent(new CustomEvent('auth-sign-in-error', { detail: { method: 'redirect' } }));
    });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      await fetchOrCreateUserProfile(user);
    } else {
      currentUserProfile = null;
      broadcastAuthChange(null, null);
    }
  });
}

export async function deleteStoreComment(commentId) {
  const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
  await deleteDoc(doc(db, "comments", commentId));
}
