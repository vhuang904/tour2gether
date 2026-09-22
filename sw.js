/**
 * 大V的旅遊窩 PWA - Service Worker (版本自適應 & App Badging 紅點推播強化版)
 * 1. 帶動態版本戳記，發布時自動清空舊版快取
 * 2. 核心頁面與腳本採用 Network First 網路優先策略
 * 3. 整合 App Badging API：背景推播送達亮紅點，點擊通知自動清除
 * 4. 強化通知震動反饋與提示聲呼叫
 */

// 👉 每次重大發布修改此版本號，強制手機客戶端熱更新
const CACHE_VERSION = '20260922-v51.0';
const STATIC_CACHE_NAME = `bigv-static-${CACHE_VERSION}`;
const IMAGE_CACHE_NAME = `bigv-images-${CACHE_VERSION}`;

// 核心離線必備靜態外殼
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './ai-avatar.jpg',
  './googleSheetService.js',
  './authService.js'
];

// 1. 安裝階段：立即跳過等待，預載核心外殼
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[PWA SW] 預快取部分檔案失敗 (不影響運行):', err);
      });
    })
  );
});

// 2. 啟用階段：主動刪除舊版本的程式碼快取，杜絕死鎖
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== STATIC_CACHE_NAME && cacheName !== IMAGE_CACHE_NAME) {
            console.log(`[PWA SW] 清除過期快取: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. 請求攔截與分流策略
self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http://') && !event.request.url.startsWith('https://')) {
    return;
  }

  const url = new URL(event.request.url);

  // 策略 A：關鍵放行名單（Google Sheet Apps Script、Firebase、認證、AI Worker）-> 永遠連網，絕不快取！
  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.hostname.includes('docs.google.com') ||
    url.hostname.includes('spreadsheets.google.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('accounts.google.com') ||
    url.hostname.includes('apis.google.com') ||
    url.hostname.includes('identitytoolkit') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('workers.dev') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // 策略 B：Firebase Storage 圖片與 Unsplash 圖庫 -> Stale-While-Revalidate
  if (
    url.hostname.includes('firebasestorage.googleapis.com') ||
    url.hostname.includes('images.unsplash.com')
  ) {
    event.respondWith(
      caches.open(IMAGE_CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          const fetchPromise = fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // 策略 C：核心 HTML 與 JS 檔案 ->【網路優先 (Network First)】隨時獲取最新代碼
  if (
    event.request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname === '/'
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              cache.put(event.request, copy);
            });
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 策略 D：其餘靜態資源（CSS、字型、圖標）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networked = fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const respClone = resp.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              cache.put(event.request, respClone);
            });
          }
          return resp;
        })
        .catch(() => null);

      return cached || networked;
    })
  );
});

// 4. 監聽前端發來的指令（支援熱更新與主動清除紅點）
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
  }
});

// ==========================================
// Web Push 推播通知與點擊處理邏輯（整合 App Badging）
// ==========================================

// 1. 監聽推播訊息 (背景接收)
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = {
        notification: {
          title: '大V的旅遊窩',
          body: event.data.text()
        }
      };
    }
  }

  const notificationTitle = (data.notification && data.notification.title) || data.title || '大V的旅遊窩 精選通知';
  const notificationOptions = {
    body: (data.notification && data.notification.body) || data.body || '有全新的菲律賓美食與特惠推薦！點此查看。',
    icon: (data.notification && data.notification.icon) || data.icon || './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: {
      url: (data.data && data.data.url) || data.url || '/'
    },
    vibrate: [300, 150, 300, 150, 300], // 強效長震動節奏
    tag: 'bigv-push-notification-' + Date.now(), // 每次產生獨立通知，強制喚醒浮動橫幅
    renotify: true,
    requireInteraction: true, // ⭐ 強制常駐快顯 (Android Heads-up 關鍵)
    silent: false             // ⭐ 禁止靜音處理，確保觸發系統喚醒
  };

  // ⭐ 背景亮起桌面 App Icon 紅點徽章
  const badgePromise = ('setAppBadge' in navigator)
    ? navigator.setAppBadge(data.badgeCount || 1).catch(() => {})
    : Promise.resolve();

  const showNotificationPromise = self.registration.showNotification(notificationTitle, notificationOptions);

  event.waitUntil(Promise.all([showNotificationPromise, badgePromise]));
});

// 2. 監聽使用者點擊通知卡片
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // ⭐ 使用者點了通知，立刻清除桌面紅點徽章
  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if (client.url.includes(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
