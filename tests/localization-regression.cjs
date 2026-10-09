const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const authSource = read('authService.js');
const swSource = read('sw.js');
const han = /\p{Script=Han}/u;

function section(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Missing source boundary: ${start}`);
  return source.slice(a, b);
}

function uiRuntime() {
  const elements = new Map();
  const context = vm.createContext({
    currentLang: 'en', currentCity: 'manila',
    document: { getElementById: id => elements.get(id) },
    getLocalizedText: undefined, console
  });
  vm.runInContext([
    section(html, '    const I18N_DICT =', '    const SEARCH_SYNONYMS'),
    section(html, '    const REGION_CONFIG =', '    function safeStr('),
    section(html, '    function formatUiText(', '    function refreshPendingActionLabels('),
    section(html, '    function detectQueryTargetCity(', '    // AI 快捷'),
    section(html, '    function encodeAiArgument(', '    // 宏觀導引'),
    read('googleSheetService.js').slice(read('googleSheetService.js').indexOf('export function getLocalizedText')).replace(/^export /, '')
  ].join('\n'), context);
  return { context, elements, dict: vm.runInContext('I18N_DICT', context) };
}

function testUi() {
  const { context: ctx, elements, dict } = uiRuntime();
  assert.deepEqual(Object.keys(dict.en).sort(), Object.keys(dict['zh-TW']).sort());
  for (const [key, value] of Object.entries(dict.en)) {
    if (typeof value === 'string') assert(!han.test(value), `Chinese UI copy in en.${key}`);
  }
  for (const match of html.matchAll(/data-i18n(?:-placeholder|-alt)?="([A-Za-z]\w*)"/g)) {
    assert(dict.en[match[1]], `Missing translation: ${match[1]}`);
  }
  for (const city of ['manila', 'cebu', 'davao', 'boracay', 'palawan', 'bohol', 'siargao', 'samal']) {
    assert(!han.test(ctx.getCityDisplayName(city)));
  }
  assert.equal(ctx.detectMainIntent('Recommend iconic attractions'), 'attraction');
  assert.equal(ctx.detectMainIntent('Shopping malls in Manila'), 'attraction');
  assert.equal(ctx.detectMainIntent('Manila seafood restaurants'), 'restaurant');
  assert.equal(ctx.detectQueryTargetCity('Where to go in the Philippines?').mode, 'macro');
  assert.equal(ctx.detectQueryTargetCity('Seafood in Cebu').city, 'cebu');
  assert.equal(ctx.detectCategoryHookDetailed('Top Wagyu BBQ', 'restaurant').key, 'japanese');
  assert.equal(ctx.detectCategoryHookDetailed('Fresh seafood', 'restaurant').key, 'seafood');
  assert.equal(ctx.detectCategoryHookDetailed('historic churches', 'attraction').key, 'history');
  assert.equal(ctx.detectCategoryHookDetailed('beaches', 'attraction').key, 'beach');
  assert.equal(ctx.getAiSubFilter('seafood', 'manila', 'restaurant'), 'seafood');
  assert.equal(ctx.getAiSubFilter('seafood', 'boracay', 'restaurant'), 'all');
  assert.equal(ctx.getAiSubFilter('beach', 'boracay', 'attraction'), 'beach');
  assert.equal(ctx.getAiSubFilter('beach', 'manila', 'attraction'), 'all');
  const historyFilter = vm.runInContext(`(cat, currentSubFilter = 'history') => {
    ${section(html, "          if (currentSubFilter === 'history')", "          if (currentSubFilter === 'beach')")}
  }`, ctx);
  for (const category of ['歷史古蹟', 'Historic sites', 'history', 'landmark', 'sightseeing']) {
    assert(historyFilter(category.toLowerCase()), `Historic category excludes ${category}`);
  }
  assert.equal(historyFilter('shopping'), false);
  const place = {
    id: `venue'"<>`, city: 'manila', name_zh: '原始店名', name_en: 'English Venue',
    bigv_comment_zh: '中文點評', big_v_comment: '舊版中文', description_en: 'English description'
  };
  assert.equal(ctx.getAiPlaceDescription(place), 'English description');
  place.bigv_comment_en = 'English curator note';
  assert.equal(ctx.getAiPlaceDescription(place), 'English curator note');
  const response = { id: 'test-response', kind: 'picks', city: 'manila', intent: 'restaurant', hook: { key: 'seafood' }, items: [place] };
  elements.set(response.id, { innerHTML: '', textContent: '' });
  const before = JSON.stringify(place);
  for (const lang of ['en', 'zh-TW', 'en']) {
    ctx.currentLang = lang;
    ctx.renderAiResponse(response);
    const output = elements.get(response.id).innerHTML;
    if (lang === 'en') {
      assert(!han.test(output), 'English recommendation must use available English fields');
      assert(output.includes('English curator note'));
    } else {
      assert(output.includes('中文點評'));
    }
    assert(output.includes(ctx.encodeAiArgument(place.id)), 'Card target must be encoded intact');
  }
  assert.equal(JSON.stringify(place), before, 'Rendering must not rewrite source data');
  delete place.name_en;
  delete place.bigv_comment_en;
  delete place.description_en;
  ctx.renderAiResponse(response);
  assert(elements.get(response.id).innerHTML.includes('原始店名'));
  assert(elements.get(response.id).innerHTML.includes('中文點評'));
  ctx.renderAiResponse({ ...response, items: [] });
  assert(elements.get(response.id).innerHTML.includes('No matching places in Manila yet'));
  assert(!elements.get(response.id).innerHTML.includes('ai-jump-btn'));
  assert.equal(ctx.escapeUiText('<script>"&</script>'), '&lt;script&gt;&quot;&amp;&lt;/script&gt;');
  assert.equal(ctx.formatUiText('penaltyContent', { excerpt: '原始{count}' }, 'en').includes('原始{count}'), true);
  assert.equal(ctx.formatUiText('adminHistory', { count: 0, next: 1 }, 'en'), 'Prior: 0 · Next: 1');
}

function workerRuntime(stores = new Map()) {
  const listeners = {};
  const shown = [];
  const warnings = [];
  const badges = [], navigations = [];
  const clients = {
    claim: async () => {},
    matchAll: async () => [{
      url: 'https://example.test/app/',
      navigate: url => navigations.push(url),
      focus: async () => navigations.push('focus')
    }]
  };
  const self = {
    registration: {
      scope: 'https://example.test/app/',
      showNotification: async (title, options) => shown.push({ title, options })
    },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    skipWaiting() {},
    clients,
    location: { origin: 'https://example.test' }
  };
  const caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        put: async (key, value) => store.set(String(key), await value.text()),
        match: async key => store.has(String(key)) ? new Response(store.get(String(key))) : undefined,
        addAll: async () => {}
      };
    },
    keys: async () => [...stores.keys()],
    delete: async key => stores.delete(key)
  };
  const context = vm.createContext({
    self, clients, navigator: {
      setAppBadge: async count => badges.push(count),
      clearAppBadge: async () => badges.push(0)
    }, URL, Response, caches,
    console: { log() {}, warn: (...args) => warnings.push(args) }
  });
  vm.runInContext(swSource, context);
  const dispatch = async (type, data) => {
    const waits = [];
    listeners[type]({ data, waitUntil: promise => waits.push(promise) });
    await Promise.all(waits);
  };
  const push = async payload => {
    await dispatch('push', payload === undefined ? null : { json: () => payload });
    return shown.at(-1);
  };
  const click = async url => {
    let closed = false;
    const waits = [];
    listeners.notificationclick({
      notification: { data: { url }, close: () => { closed = true; } },
      waitUntil: promise => waits.push(promise)
    });
    await Promise.all(waits);
    assert(closed);
  };
  return { context, stores, dispatch, push, shown, warnings, badges, navigations, click };
}

async function testPush() {
  let worker = workerRuntime();
  assert(!han.test((await worker.push()).options.body), 'Fresh worker defaults to English');
  await worker.dispatch('message', { type: 'SET_LANGUAGE', lang: 'zh-TW' });
  assert(han.test((await worker.push()).options.body));
  worker.stores.set('bigv-static-old', new Map());
  await worker.dispatch('activate');
  assert(worker.stores.has('tour2gether-preferences'), 'Updates must preserve selected language');
  assert(!worker.stores.has('bigv-static-old'));
  worker = workerRuntime(worker.stores);
  assert(han.test((await worker.push()).options.body), 'Language must survive worker restart');
  await worker.dispatch('message', { type: 'SET_LANGUAGE', lang: 'en' });
  const notice = await worker.push({
    notification: { title: '舊通知', body: '中文內容' },
    data: { title_en: 'English alert', body_en: 'English details', url: '/place?id=123' }
  });
  assert.equal(notice.title, 'English alert');
  assert.equal(notice.options.body, 'English details');
  assert.equal(notice.options.data.url, '/place?id=123');
  assert.equal(worker.badges.at(-1), 1);
  assert.deepEqual(Array.from(notice.options.vibrate), [300, 150, 300, 150, 300]);
  assert.equal(notice.options.requireInteraction, true);
  await worker.click('/place?id=123');
  assert.equal(worker.badges.at(-1), 0);
  assert.deepEqual(worker.navigations, ['/place?id=123', 'focus']);
  assert.equal((await worker.push({ body: '只有中文的原始通知' })).options.body, '只有中文的原始通知');
  await worker.dispatch('message', { type: 'SET_LANGUAGE', lang: 'invalid' });
  assert(!han.test((await worker.push()).options.body));
  await Promise.all([
    worker.dispatch('message', { type: 'SET_LANGUAGE', lang: 'zh-TW' }),
    worker.dispatch('message', { type: 'SET_LANGUAGE', lang: 'en' })
  ]);
  assert(!han.test((await worker.push()).options.body), 'Latest language must win');
  await worker.dispatch('push', { json() { throw new Error('plain text'); }, text: () => 'Raw text alert' });
  assert.equal(worker.shown.at(-1).options.body, 'Raw text alert');
  await worker.push(null);
  assert.equal(worker.warnings.length, 0);
}

async function testVoiceAndLanguageSync() {
  const { context: ctx, dict } = uiRuntime();
  const notices = [], messages = [];
  const worker = { postMessage: message => messages.push(message) };
  Object.assign(ctx, {
    currentUser: { uid: 'member' }, isVoiceActive: false, speechRecognizer: null,
    voiceTranscript: '', chatInput: { value: '', placeholder: '' }, btnVoice: null,
    showToast: text => notices.push(text), console: { warn() {} },
    navigator: { serviceWorker: { getRegistration: async () => ({ active: worker, waiting: worker }) } }
  });
  vm.runInContext([
    section(html, '    function startVoiceRecording(', '    if (btnVoice)'),
    section(html, '    async function syncPushLanguage(', "    document.getElementById('lang-btn-zh')")
  ].join('\n'), ctx);
  ctx.startVoiceRecording();
  assert.equal(notices.at(-1), dict.en.voiceUnsupported);
  ctx.speechRecognizer = { start() { throw new Error('Synthetic start failure'); }, stop() {} };
  ctx.startVoiceRecording();
  assert.equal(notices.at(-1), dict.en.voiceFailed);
  assert.equal(ctx.isVoiceActive, false);
  ctx.speechRecognizer = { start() {}, stop() {} };
  for (const lang of ['en', 'zh-TW']) {
    ctx.currentLang = lang;
    ctx.startVoiceRecording();
    assert.equal(ctx.chatInput.placeholder, dict[lang].voiceListening);
    assert.equal(ctx.speechRecognizer.lang, lang === 'en' ? 'en-US' : 'zh-TW');
    ctx.stopVoiceRecording(false);
    assert.equal(ctx.chatInput.placeholder, dict[lang].chatPlaceholder);
    const before = messages.length;
    await ctx.syncPushLanguage();
    assert.equal(messages.length, before + 1, 'Same worker should receive one language message');
    assert.equal(messages.at(-1).lang, lang);
  }
}

async function testAuth() {
  const requests = [], prompts = [], events = [], saved = new Map();
  const ctx = vm.createContext({
    auth: {}, document: { documentElement: { lang: 'en' } },
    window: {
      location: { origin: 'https://example.test', pathname: '/app/', href: 'https://example.test/app/?lang=en' },
      localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
      prompt: text => { prompts.push(text); return 'member@example.test'; },
      dispatchEvent: event => events.push(event), history: { replaceState() {} }
    },
    CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
    sendSignInLinkToEmail: async (...args) => requests.push(args),
    isSignInWithEmailLink: () => true,
    signInWithEmailLink: async () => { throw new Error('expired'); },
    getRedirectResult: async () => null,
    onAuthStateChanged() {}, console: { error() {}, warn() {} }
  });
  vm.runInContext([
    section(authSource, 'function getAuthLanguage()', 'export function calculateUserLevel'),
    section(authSource, 'export async function sendMagicEmailLink(', '// 3.'),
    section(authSource, 'export function initAuthService()', 'export async function deleteStoreComment')
  ].join('\n').replace(/^export /gm, ''), ctx);
  for (const lang of ['en', 'zh-TW']) {
    ctx.document.documentElement.lang = lang;
    await ctx.sendMagicEmailLink(' MEMBER@example.test ');
    assert.equal(ctx.auth.languageCode, lang);
    assert.equal(requests.at(-1)[1], 'member@example.test');
    assert.equal(new URL(requests.at(-1)[2].url).searchParams.get('lang'), lang);
    saved.clear();
    ctx.initAuthService();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(han.test(prompts.at(-1)), lang !== 'en');
    assert.equal(events.at(-1).type, 'auth-sign-in-error');
    assert.equal(events.at(-1).detail.method, 'email');
  }
}

async function main() {
  testUi();
  await testPush();
  await testAuth();
  await testVoiceAndLanguageSync();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!match[2].trim()) continue;
    const result = spawnSync(process.execPath, ['--check', '--input-type=' + (match[1].includes('module') ? 'module' : 'commonjs')], { input: match[2], encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  console.log('PASS: dictionary coverage, AI locales and source preservation, push persistence/restarts/badges/navigation, auth email language and error events, voice states, inline script syntax.');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { section, uiRuntime, html };
