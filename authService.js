// authService.js - 大V的旅遊窩 PWA 認證模組（全平台跨網域防阻擋高相容版 + Storage 圖片支援）

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signInWithRedirect, 
  getRedirectResult, 
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

let currentUserProfile = null;

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

// 核心：雙軌互通會員資料庫讀取與同步
export async function fetchOrCreateUserProfile(user) {
  if (!user) {
    currentUserProfile = null;
    broadcastAuthChange(null, null);
    return null;
  }

  const userEmail = (user.email || "").toLowerCase().trim();
  const userRef = doc(db, "users", user.uid);

  try {
    const docSnap = await getDoc(userRef);

    if (docSnap.exists()) {
      const data = docSnap.data();
      currentUserProfile = {
        uid: user.uid,
        displayName: data.displayName || user.displayName || "吃貨食客",
        photoURL: data.photoURL || user.photoURL || "",
        email: userEmail,
        points: typeof data.points === "number" ? data.points : 50,
        level: data.level || calculateUserLevel(data.points || 50)
      };
    } else {
      let inheritedPoints = 50;
      let inheritedLevel = "LV.1 探店初心者";

      if (userEmail) {
        try {
          const emailQuery = query(collection(db, "users"), where("email", "==", userEmail));
          const querySnap = await getDocs(emailQuery);
          if (!querySnap.empty) {
            const oldData = querySnap.docs[0].data();
            inheritedPoints = oldData.points || 50;
            inheritedLevel = oldData.level || calculateUserLevel(inheritedPoints);
          }
        } catch (queryErr) {
          console.warn("[AuthService] 檢查歷史帳號略過:", queryErr);
        }
      }

      const newProfile = {
        displayName: user.displayName || "吃貨食客",
        photoURL: user.photoURL || "",
        email: userEmail,
        points: inheritedPoints,
        level: inheritedLevel,
        createdAt: serverTimestamp(),
        lastLoginAt: serverTimestamp()
      };

      await setDoc(userRef, newProfile, { merge: true });
      currentUserProfile = {
        uid: user.uid,
        ...newProfile
      };
    }

    broadcastAuthChange(user, currentUserProfile);
    return currentUserProfile;
  } catch (error) {
    console.error("[AuthService] 讀取/建立會員資料失敗:", error);
    currentUserProfile = {
      uid: user.uid,
      displayName: user.displayName || "吃貨食客",
      photoURL: user.photoURL || "",
      email: userEmail,
      points: 50,
      level: "LV.1 探店初心者"
    };
    broadcastAuthChange(user, currentUserProfile);
    return currentUserProfile;
  }
}

// 1. Google 登入
export async function loginWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    if (result && result.user) {
      const profile = await fetchOrCreateUserProfile(result.user);
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

  const actionCodeSettings = {
    url: window.location.origin + window.location.pathname,
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
    return [];
  }
}

// ⭐ 新增：上傳單張已壓縮照片到 Firebase Storage
export async function uploadCommentPhoto(storeId, fileBlob) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("請先登入後再上傳照片。");

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
    throw new Error("請先登入後再發表探店評價。");
  }

  if (!storeId) {
    throw new Error("店家代碼無效。");
  }

  const cleanComment = (typeof commentPayload === 'string' ? commentPayload : (commentPayload?.comment || "")).trim();
  const photoList = Array.isArray(commentPayload?.photos) ? commentPayload.photos : (Array.isArray(photos) ? photos : []);

  if (!cleanComment && photoList.length === 0) {
    throw new Error("請填寫評價內容或上傳照片。");
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
    userName: currentUserProfile?.displayName || currentUser.displayName || "匿名老饕",
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
  if (isSignInWithEmailLink(auth, window.location.href)) {
    let email = window.localStorage.getItem("emailForSignIn");
    if (!email) {
      email = window.prompt("請輸入登入時所使用的電子郵件信箱：");
    }
    if (email) {
      signInWithEmailLink(auth, email, window.location.href)
        .then(async (result) => {
          window.localStorage.removeItem("emailForSignIn");
          await fetchOrCreateUserProfile(result.user);
          window.history.replaceState({}, document.title, window.location.pathname);
        })
        .catch((err) => console.error("[AuthService] Email 魔法登入驗證錯誤:", err));
    }
  }

  getRedirectResult(auth)
    .then(async (result) => {
      if (result && result.user) {
        await fetchOrCreateUserProfile(result.user);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    })
    .catch((error) => {
      console.warn("[AuthService] Redirect 狀態略過:", error.code);
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
