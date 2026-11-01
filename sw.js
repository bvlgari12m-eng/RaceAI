/* ============================================================
   RaceAI / sw.js — キャッシュ制御
   ------------------------------------------------------------
   方針:
   ・アプリ本体（HTML/CSS/JS/アイコン）は stale-while-revalidate
   ・データ(JSON)は network-first。ネットワークが死んでいる場合のみ
     キャッシュを返し、その応答に X-RaceAI-Cache: stale を付ける。
     → アプリ側は「これは古いデータだ」と判定でき、
       最新データとして表示してしまうことを防ぐ。
   ============================================================ */

const VERSION = 'raceai-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/data-loader.js',
  './js/predictor.js',
  './js/odds.js',
  './js/backtest.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      /* 1件失敗してもインストールを止めない */
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
        )
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isDataRequest(url) {
  return url.pathname.endsWith('/data/demo-races.json') || url.pathname.includes('/data/');
}

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

/** キャッシュ応答に「古いデータである」印を付けて返す */
async function respondStale(request, cachedAt) {
  const cached = await caches.match(request);
  if (!cached) return null;
  const body = await cached.blob();
  const headers = new Headers(cached.headers);
  headers.set('X-RaceAI-Cache', 'stale');
  headers.set('X-RaceAI-Cached-At', cachedAt || headers.get('X-RaceAI-Cached-At') || '');
  return new Response(body, {
    status: 200,
    statusText: 'OK (stale)',
    headers
  });
}

/** データ: network-first。失敗時のみ stale を返す */
async function handleData(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(DATA_CACHE);
      const clone = res.clone();
      /* 取得時刻をヘッダに刻んでキャッシュしておく */
      const body = await clone.blob();
      const headers = new Headers(clone.headers);
      headers.set('X-RaceAI-Cached-At', new Date().toISOString());
      const stamped = new Response(body, { status: clone.status, statusText: clone.statusText, headers });
      cache.put(request, stamped.clone());
      return res;
    }
    const stale = await respondStale(request);
    return stale || res;
  } catch (err) {
    const stale = await respondStale(request);
    if (stale) return stale;
    return new Response(
      JSON.stringify({ error: 'offline', message: 'オフラインで、キャッシュされたデータもありません' }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'X-RaceAI-Cache': 'miss' } }
    );
  }
}

/** 画面遷移: network-first（HTMLは更新されやすいため） */
async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./index.html', res.clone()).catch(() => {});
      return res;
    }
    const cached = await caches.match('./index.html');
    return cached || res;
  } catch (err) {
    const cached = await caches.match('./index.html');
    if (cached) return cached;
    return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

/** 静的アセット: cache-first + 背景更新 */
async function handleAsset(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (res) => {
      if (res && res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  return cached || (await network) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isNavigation(request)) {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isDataRequest(url)) {
    event.respondWith(handleData(request));
    return;
  }
  event.respondWith(handleAsset(request));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((c) => c.postMessage({ type: 'CACHES_CLEARED' })))
    );
  }
});
