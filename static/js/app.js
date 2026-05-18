/* ── Utilities ────────────────────────────────────────────────────────────── */
const uuid = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const LS     = (k, d) => { try { return JSON.parse(localStorage.getItem(`vs_${k}`)) ?? d; } catch { return d; } };
const LS_SET = (k, v) => localStorage.setItem(`vs_${k}`, JSON.stringify(v));

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDuration = s => {
  if (!s) return '0s';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? `${m}m ${r}s` : `${m}m`;
};

/* ── IndexedDB ────────────────────────────────────────────────────────────── */
let _idb = null;

function openDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((res, rej) => {
    const req = indexedDB.open('voicestudio', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('samples')) {
        const s = db.createObjectStore('samples', { keyPath: 'id' });
        s.createIndex('voiceId', 'voiceId', { unique: false });
      }
    };
    req.onsuccess = e => { _idb = e.target.result; res(_idb); };
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbPut(record) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('samples', 'readwrite');
    const r  = tx.objectStore('samples').put(record);
    r.onsuccess = () => res();
    r.onerror   = e => rej(e.target.error);
  });
}

async function dbGetByVoice(voiceId) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('samples', 'readonly');
    const idx = tx.objectStore('samples').index('voiceId');
    const r   = idx.getAll(voiceId);
    r.onsuccess = () => res(r.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function dbDeleteByVoice(voiceId) {
  const records = await dbGetByVoice(voiceId);
  if (!records.length) return;
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx    = db.transaction('samples', 'readwrite');
    const store = tx.objectStore('samples');
    records.forEach(r => store.delete(r.id));
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  });
}

/* ── State ────────────────────────────────────────────────────────────────── */
const S = {
  user:          null,
  voice:         null,
  trainMode:     'initial',
  sentences:     [],
  sentenceIdx:   0,
  isRecording:   false,
  mediaRecorder: null,
  audioChunks:   [],
  stream:        null,
  audioCtx:      null,
  analyser:      null,
  animFrame:     null,
  generatedURL:  null,
  generatedMime: 'audio/mpeg',
  newRecBlob:    null,
  newRecording:  false,
  newStream:     null,
  newMediaRec:   null,
  newChunks:     [],
  newRecTimer:   null,
  newRecSecs:    0,
};

/* ── API Keys ─────────────────────────────────────────────────────────────── */
const Keys = {
  all:             ()  => LS('api_keys', {}),
  get:             (k) => Keys.all()[k] || '',
  set:             (obj) => LS_SET('api_keys', { ...Keys.all(), ...obj }),
  elevenlabs:      ()  => Keys.get('elevenlabs'),
  playhtSecret:    ()  => Keys.get('playht_secret'),
  playhtUser:      ()  => Keys.get('playht_user'),
  cartesia:        ()  => Keys.get('cartesia'),
  lmnt:            ()  => Keys.get('lmnt'),
};

/* ── Voice data ───────────────────────────────────────────────────────────── */
const getVoices     = ()   => LS('voices', []).filter(v => v.userId === S.user?.id);
const getVoice      = (id) => LS('voices', []).find(v => v.id === id) || null;

function saveVoice(voice) {
  const all = LS('voices', []);
  const i   = all.findIndex(v => v.id === voice.id);
  if (i >= 0) all[i] = voice; else all.push(voice);
  LS_SET('voices', all);
}

function removeVoice(id) {
  LS_SET('voices', LS('voices', []).filter(v => v.id !== id));
}

function makeVoice(name, source) {
  return {
    id: uuid(), userId: S.user.id, name, source,
    sampleCount: 0, totalDuration: 0,
    uploadedSampleCount: 0, providerMaps: {},
    createdAt: new Date().toISOString(),
  };
}

/* ── Auth ─────────────────────────────────────────────────────────────────── */
async function registerUser(username, password) {
  const users = LS('users', []);
  if (users.find(u => u.username === username))
    throw new Error('That username is already taken.');
  const user = { id: uuid(), username, passwordHash: await sha256(password), createdAt: new Date().toISOString() };
  users.push(user);
  LS_SET('users', users);
  return user;
}

async function loginUser(username, password) {
  const hash = await sha256(password);
  const user = LS('users', []).find(u => u.username === username && u.passwordHash === hash);
  if (!user) throw new Error('Invalid username or password.');
  return user;
}

/* ── Provider implementations ─────────────────────────────────────────────── */
const ElevenLabs = {
  id: 'elevenlabs', label: 'ElevenLabs',
  ok: () => !!Keys.elevenlabs(),

  async clone(name, blobs) {
    const fd = new FormData();
    fd.append('name', name);
    blobs.slice(0, 25).forEach((b, i) => fd.append('files', b, `s${i}.webm`));
    const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST', headers: { 'xi-api-key': Keys.elevenlabs() }, body: fd,
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail?.message || `ElevenLabs ${r.status}`); }
    return (await r.json()).voice_id;
  },

  async synth(vid, text) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
      method: 'POST',
      headers: { 'xi-api-key': Keys.elevenlabs(), 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true } }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail?.message || `ElevenLabs ${r.status}`); }
    return r.blob();
  },

  async del(vid) {
    await fetch(`https://api.elevenlabs.io/v1/voices/${vid}`,
      { method: 'DELETE', headers: { 'xi-api-key': Keys.elevenlabs() } });
  },
};

const PlayHT = {
  id: 'playht', label: 'Play.ht',
  ok: () => !!(Keys.playhtSecret() && Keys.playhtUser()),

  _h: () => ({ 'Authorization': `Bearer ${Keys.playhtSecret()}`, 'X-USER-ID': Keys.playhtUser() }),

  async clone(name, blobs) {
    const fd = new FormData();
    fd.append('voice_name', name);
    fd.append('sample_file', blobs[0], 'sample.webm');
    const r = await fetch('https://api.play.ht/api/v2/cloned-voices/instant',
      { method: 'POST', headers: PlayHT._h(), body: fd });
    if (!r.ok) throw new Error(`Play.ht ${r.status}`);
    const d = await r.json();
    return d.id || d.voice_id || '';
  },

  async synth(vid, text) {
    const r = await fetch('https://api.play.ht/api/v2/tts/stream', {
      method: 'POST',
      headers: { ...PlayHT._h(), 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text, voice: vid, voice_engine: 'PlayHT2.0-turbo',
        output_format: 'mp3', quality: 'medium', sample_rate: 24000, speed: 1 }),
    });
    if (!r.ok) throw new Error(`Play.ht ${r.status}`);
    return r.blob();
  },

  async del(vid) {
    await fetch(`https://api.play.ht/api/v2/cloned-voices/${vid}`,
      { method: 'DELETE', headers: PlayHT._h() });
  },
};

const Cartesia = {
  id: 'cartesia', label: 'Cartesia',
  ok: () => !!Keys.cartesia(),

  _h: (extra = {}) => ({ 'X-API-Key': Keys.cartesia(), 'Cartesia-Version': '2024-06-10', ...extra }),

  async clone(name, blobs) {
    const fd = new FormData();
    fd.append('clip', blobs[0], 'sample.webm');
    fd.append('name', name); fd.append('language', 'en'); fd.append('mode', 'clip');
    const r = await fetch('https://api.cartesia.ai/voices/clone',
      { method: 'POST', headers: Cartesia._h(), body: fd });
    if (!r.ok) throw new Error(`Cartesia ${r.status}`);
    return (await r.json()).id;
  },

  async synth(vid, text) {
    const r = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: Cartesia._h({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model_id: 'sonic-english', transcript: text,
        voice: { mode: 'id', id: vid },
        output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 } }),
    });
    if (!r.ok) throw new Error(`Cartesia ${r.status}`);
    return r.blob();
  },

  async del(vid) {
    await fetch(`https://api.cartesia.ai/voices/${vid}`,
      { method: 'DELETE', headers: Cartesia._h() });
  },
};

const LMNT = {
  id: 'lmnt', label: 'LMNT',
  ok: () => !!Keys.lmnt(),

  _h: (extra = {}) => ({ 'X-API-Key': Keys.lmnt(), ...extra }),

  async clone(name, blobs) {
    const fd = new FormData();
    blobs.slice(0, 5).forEach((b, i) => fd.append('files', b, `s${i}.webm`));
    fd.append('name', name); fd.append('enhance', 'false');
    const r = await fetch('https://api.lmnt.com/v1/ai/voice/clone',
      { method: 'POST', headers: LMNT._h(), body: fd });
    if (!r.ok) throw new Error(`LMNT ${r.status}`);
    return (await r.json()).id;
  },

  async synth(vid, text) {
    const r = await fetch('https://api.lmnt.com/v1/ai/speech', {
      method: 'POST',
      headers: LMNT._h({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ voice: vid, text, format: 'mp3' }),
    });
    if (!r.ok) throw new Error(`LMNT ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('audio')) return r.blob();
    const d = await r.json();
    if (d.audio) {
      const raw = atob(d.audio), arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return new Blob([arr], { type: 'audio/mpeg' });
    }
    throw new Error('LMNT unexpected response');
  },

  async del(vid) {
    await fetch(`https://api.lmnt.com/v1/ai/voice/${vid}`,
      { method: 'DELETE', headers: LMNT._h() });
  },
};

const PROVIDERS = [ElevenLabs, PlayHT, Cartesia, LMNT];
const configured = () => PROVIDERS.filter(p => p.ok());

let _synthIdx = 0;

/* ── Usage tracking ─────────────────────────────────────────────────────── */
const FREE_TIERS = {
  elevenlabs: { limit: 10000, unit: 'chars', label: 'EL', name: 'ElevenLabs' },
  playht:     { limit: 12500, unit: 'words', label: 'PH', name: 'Play.ht'    },
  cartesia:   { limit: 50000, unit: 'chars', label: 'CA', name: 'Cartesia'   },
  lmnt:       { limit: 500,   unit: 'reqs',  label: 'LM', name: 'LMNT'       },
};

const Usage = {
  get:   () => LS('usage', {}),
  reset: () => { LS_SET('usage', {}); updateUsageWidget(); toast('Usage counters reset.'); },
  track(providerId, text) {
    const all = Usage.get();
    if (!all[providerId]) all[providerId] = { chars: 0, words: 0, reqs: 0 };
    all[providerId].chars += text.length;
    all[providerId].words += text.trim().split(/\s+/).length;
    all[providerId].reqs  += 1;
    LS_SET('usage', all);
    updateUsageWidget();
  },
};

function updateUsageWidget() {
  const widget = document.getElementById('usage-widget');
  if (!widget || !S.user) return;
  const cfg = configured();
  if (!cfg.length) { widget.classList.add('hidden'); return; }
  widget.classList.remove('hidden');

  const usage = Usage.get();
  const wrap  = document.getElementById('usage-bars');
  wrap.innerHTML = '';

  cfg.forEach(p => {
    const tier = FREE_TIERS[p.id];
    if (!tier) return;
    const u   = usage[p.id] || { chars: 0, words: 0, reqs: 0 };
    const val = tier.unit === 'words' ? u.words : tier.unit === 'reqs' ? u.reqs : u.chars;
    const pct = Math.min(1, val / tier.limit);
    const fillClass = pct >= 0.9 ? 'crit' : pct >= 0.6 ? 'warn' : '';
    const numStr = tier.unit === 'chars'
      ? (val >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${val}`) + `/${tier.limit / 1000}k`
      : tier.unit === 'words'
      ? (val >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${val}`) + `/${tier.limit / 1000}k`
      : `${val}/${tier.limit}`;

    const row = document.createElement('div');
    row.className = 'usage-row';
    row.innerHTML = `
      <span class="usage-label">${tier.label}</span>
      <div class="usage-bar-track"><div class="usage-bar-fill ${fillClass}" style="width:${pct * 100}%"></div></div>
      <span class="usage-num">${numStr}</span>
    `;
    wrap.appendChild(row);
  });

  document.getElementById('btn-usage-reset').onclick = Usage.reset;
}

async function ensureOnProviders(voice) {
  const records = await dbGetByVoice(voice.id);
  if (!records.length) throw new Error('No audio samples found.');

  const providers = configured();
  if (!providers.length)
    throw new Error('No API keys configured. Click "Add keys" to add at least one key.');

  const needsUpload =
    voice.uploadedSampleCount < voice.sampleCount ||
    !providers.some(p => voice.providerMaps[p.id]);

  if (!needsUpload) return voice.providerMaps;

  for (const p of providers) {
    if (voice.providerMaps[p.id]) {
      try { await p.del(voice.providerMaps[p.id]); } catch {}
    }
  }

  const blobs    = records.map(r => new Blob([r.data], { type: r.mime || 'audio/webm' }));
  const newMaps  = {};
  const failures = [];

  for (const p of providers) {
    try {
      newMaps[p.id] = await p.clone(voice.name, blobs);
    } catch (e) {
      failures.push(`${p.label}: ${e.message}`);
    }
  }

  if (!Object.keys(newMaps).length)
    throw new Error('Voice upload failed on all providers.\n' + failures.join('\n'));

  voice.providerMaps          = newMaps;
  voice.uploadedSampleCount   = voice.sampleCount;
  saveVoice(voice);
  return newMaps;
}

async function synthesizeRotated(voice, text) {
  const avail = configured().filter(p => voice.providerMaps[p.id]);
  if (!avail.length) throw new Error('No providers have this voice. Generate speech to trigger upload.');

  const start  = _synthIdx % avail.length;
  _synthIdx++;
  const errors = [];

  for (let i = 0; i < avail.length; i++) {
    const p = avail[(start + i) % avail.length];
    try {
      const blob = await p.synth(voice.providerMaps[p.id], text);
      Usage.track(p.id, text);
      return blob;
    } catch (e) { errors.push(`${p.label}: ${e.message}`); }
  }
  throw new Error('All providers failed.\n' + errors.join('\n'));
}

/* ── Training sentences ─────────────────────────────────────────────────── */
const INITIAL_SENTENCES = [
  'The quick brown fox jumps over the lazy dog.',
  'Pack my box with five dozen liquor jugs.',
  'How vexingly quick daft zebras jump.',
  'Sphinx of black quartz, judge my vow.',
  'The five boxing wizards jump quickly.',
  'She sells seashells by the seashore, and the shells she sells are seashells.',
  'Whether the weather is warm or cold, we always have the weather whether we like it or not.',
  'How much wood would a woodchuck chuck if a woodchuck could chuck wood?',
  'Technology has fundamentally changed the way we communicate with each other every day.',
  'The warm summer breeze carried the scent of blooming flowers all through the garden.',
];

const EXTENDED_SENTENCES = [...INITIAL_SENTENCES,
  'Walking through the forest at dusk, she heard the distant call of an owl.',
  'His deep voice resonated through the empty concert hall on that quiet evening.',
  'The early morning fog crept quietly through the misty mountain valleys below.',
  'Around the rugged rocks the ragged rascal ran as fast as his legs would carry him.',
  'Peter Piper picked a peck of pickled peppers from a bright red pepper pot.',
  'The children laughed and played in the golden light of the long autumn afternoon.',
  'Red lorry, yellow lorry, red lorry, yellow lorry, over and over again.',
  'Standing by the window, she watched the soft rain fall onto the wet cobblestones.',
  'The sound of live music filled every corner of the small mountain village at dusk.',
  'The bright blue butterfly landed gently on the outstretched hand of the young child.',
  'Freshly baked bread from the corner bakery smells wonderful on a cold morning.',
  'The old wooden clock on the mantle ticked slowly through the silent winter night.',
  'Scientists have discovered a remarkable new species deep in the Amazon rainforest.',
  'The library was completely silent except for the soft rustling of turning pages.',
  'Every morning she would walk along the beach collecting interesting shells and stones.',
  'Learning a new language requires daily practice, patience, and persistence.',
  'The thunderstorm rolled in from the west, bringing a refreshing and cool breeze.',
  'My grandmother makes the most delicious apple pie every Thanksgiving without fail.',
  'A warm cup of tea on a cold winter morning is one of life\'s simple pleasures.',
  'The mountain trail was steep but the view from the top was absolutely breathtaking.',
];

/* ── Waveform helpers ───────────────────────────────────────────────────── */
function createAnimatedWaveform(container, { bars = 24, height = 40, gap = 3, width = 3, seed = 1, animated = true } = {}) {
  const heights = []; let s = seed * 1000;
  for (let i = 0; i < bars; i++) {
    s = (s * 9301 + 49297) % 233280;
    heights.push(0.25 + (s / 233280) * 0.75);
  }
  container.style.cssText = `display:flex;align-items:center;gap:${gap}px;height:${height}px`;
  heights.forEach((h, i) => {
    const bar = document.createElement('span');
    bar.style.cssText = `display:inline-block;width:${width}px;background:currentColor;border-radius:2px;height:${h * 100}%;transform-origin:center`;
    if (animated) {
      bar.classList.add('wf-bar');
      bar.style.animationDelay = `${i * 0.03}s`;
      bar.style.animationDuration = `${0.9 + (i % 5) * 0.12}s`;
    }
    container.appendChild(bar);
  });
}

function createStaticWave(container, { bars = 56, height = 44, seed = 1 } = {}) {
  const arr = []; let s = seed * 7919;
  for (let i = 0; i < bars; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const v = 0.2 + (s / 2147483648) * 0.8;
    const edge = Math.min(i, bars - 1 - i) / (bars * 0.18);
    arr.push(v * Math.min(1, edge));
  }
  container.style.cssText = `display:flex;align-items:center;gap:2px;height:${height}px`;
  arr.forEach(h => {
    const bar = document.createElement('span');
    bar.style.cssText = `flex:1;background:currentColor;border-radius:1px;height:${Math.max(8, h * 100)}%;opacity:${0.55 + h * 0.45}`;
    container.appendChild(bar);
  });
}

/* ── View router ────────────────────────────────────────────────────────── */
function show(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

/* ── Toast ──────────────────────────────────────────────────────────────── */
let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ── Auth view ──────────────────────────────────────────────────────────── */
function initAuth() {
  const form    = document.getElementById('form-auth');
  const submit  = document.getElementById('auth-submit');
  const err     = document.getElementById('auth-error');
  const toggle  = document.getElementById('auth-toggle');
  const eyebrow = document.getElementById('auth-eyebrow');
  const heading = document.getElementById('auth-heading');
  const sub     = document.getElementById('auth-sub');
  let mode = 'login';

  // Animated waveform in left panel
  const wfEl = document.getElementById('auth-waveform');
  if (wfEl) createAnimatedWaveform(wfEl, { bars: 32, height: 48, gap: 4, width: 3, seed: 42, animated: true });

  toggle.addEventListener('click', e => {
    e.preventDefault();
    mode = mode === 'login' ? 'register' : 'login';
    if (mode === 'register') {
      eyebrow.textContent  = 'NEW ACCOUNT';
      heading.textContent  = 'Create account.';
      sub.textContent      = 'Everything is stored only in this browser. We can\'t reset what we can\'t see.';
      submit.textContent   = 'Create account';
      toggle.textContent   = 'Already have one? Sign in →';
    } else {
      eyebrow.textContent  = 'WELCOME BACK';
      heading.textContent  = 'Sign in.';
      sub.textContent      = 'Everything is stored only in this browser. We can\'t reset what we can\'t see.';
      submit.textContent   = 'Sign in';
      toggle.textContent   = 'New here? Create account →';
    }
    err.classList.add('hidden');
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    err.classList.add('hidden');
    submit.disabled = true;
    try {
      S.user = mode === 'login'
        ? await loginUser(username, password)
        : await registerUser(username, password);
      LS_SET('session', S.user.id);
      initDashboard(true);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */
function initDashboard(freshLogin = false) {
  document.getElementById('app-grain').classList.add('on');
  show('view-dashboard');

  // Update nav
  const center = document.getElementById('nav-center');
  center.innerHTML = `
    <button class="btn primary tutorial" id="btn-tutorial">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Start Tutorial
    </button>
  `;
  const meta = document.getElementById('nav-meta');
  meta.innerHTML = `
    <span class="chip">${esc(S.user.username)}</span>
    <button class="btn ghost small" id="btn-logout">Sign out</button>
  `;
  document.getElementById('btn-tutorial').onclick = () => Tour.start();
  document.getElementById('btn-logout').onclick = () => {
    LS_SET('session', null); S.user = null;
    document.getElementById('app-grain').classList.remove('on');
    document.getElementById('nav-center').innerHTML = '';
    document.getElementById('nav-meta').innerHTML = '<span class="pill">v1.0 · BETA</span>';
    document.getElementById('usage-widget').classList.add('hidden');
    show('view-auth');
  };

  document.getElementById('btn-open-keys').onclick   = () => openKeysSheet(false);
  document.getElementById('btn-banner-keys').onclick = () => openKeysSheet(false);
  document.getElementById('btn-new-voice').onclick   = openNewVoice;

  // Update heading
  const voices = getVoices();
  document.getElementById('dash-heading').textContent =
    voices.length === 0 ? 'Your voices.' : `${voices.length} voice${voices.length !== 1 ? 's' : ''}.`;
  document.getElementById('dash-sub').textContent =
    voices.length === 0
      ? 'No voices yet — create one to get started.'
      : `${configured().length} provider${configured().length !== 1 ? 's' : ''} configured · auto-rotated.`;

  refreshDashboard();
  updateUsageWidget();

  if (freshLogin) {
    LS_SET('tour_seen', true);
    setTimeout(() => Tour.start(true), 400);
  }
}

function refreshDashboard() {
  const voices = getVoices();
  const grid   = document.getElementById('voice-grid');
  grid.innerHTML = '';
  voices.forEach(v => grid.appendChild(buildVoiceCard(v)));

  const banner = document.getElementById('dash-key-banner');
  banner.style.display = configured().length === 0 ? 'flex' : 'none';

  // Keys button label
  const n = configured().length;
  document.getElementById('keys-btn-label').textContent = n ? `${n} key${n !== 1 ? 's' : ''}` : 'Add keys';

  // Heading
  document.getElementById('dash-heading').textContent =
    voices.length === 0 ? 'Your voices.' : `${voices.length} voice${voices.length !== 1 ? 's' : ''}.`;
  document.getElementById('dash-sub').textContent =
    voices.length === 0
      ? 'No voices yet — create one to get started.'
      : `${n} provider${n !== 1 ? 's' : ''} configured · auto-rotated.`;
}

function buildVoiceCard(voice) {
  const card = document.createElement('div');
  card.className = 'voice-card';

  const waveEl = document.createElement('div');
  waveEl.className = 'voice-card-wave';
  const seedVal = voice.id.charCodeAt(0) * 31 + voice.id.charCodeAt(1);
  createStaticWave(waveEl, { bars: 48, height: 44, seed: seedVal });
  card.appendChild(waveEl);

  const nameEl = document.createElement('div');
  nameEl.className = 'voice-card-name';
  nameEl.textContent = voice.name;
  card.appendChild(nameEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'voice-card-meta';
  metaEl.textContent = `${fmtDuration(voice.totalDuration)} · ${voice.sampleCount} sample${voice.sampleCount !== 1 ? 's' : ''}`;
  card.appendChild(metaEl);

  const statusEl = document.createElement('div');
  statusEl.className = `voice-card-status ${voice.sampleCount > 0 ? 'ready' : 'pending'}`;
  statusEl.textContent = voice.sampleCount > 0 ? '● Ready' : '○ No samples yet';
  card.appendChild(statusEl);

  const delBtn = document.createElement('button');
  delBtn.className = 'voice-card-del';
  delBtn.title = 'Delete voice';
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>`;
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${voice.name}"?`)) return;
    for (const p of PROVIDERS) {
      if (voice.providerMaps?.[p.id]) { try { await p.del(voice.providerMaps[p.id]); } catch {} }
    }
    await dbDeleteByVoice(voice.id);
    removeVoice(voice.id);
    toast('Voice deleted.');
    refreshDashboard();
  });
  card.appendChild(delBtn);

  card.addEventListener('click', e => {
    if (e.target.closest('.voice-card-del')) return;
    if (voice.sampleCount > 0) openSpeak(voice);
    else openTrain(voice, 'initial');
  });

  return card;
}

/* ── Keys sheet ─────────────────────────────────────────────────────────── */
const KEY_DEFS = [
  {
    id: 'elevenlabs', label: 'ElevenLabs', sub: '10,000 characters / month free',
    signupUrl: 'https://elevenlabs.io/sign-up',
    docsUrl:   'https://elevenlabs.io/app/settings/api-keys',
    fields: [{ key: 'elevenlabs', label: 'API Key', placeholder: 'sk-…' }],
  },
  {
    id: 'playht', label: 'Play.ht', sub: '12,500 words / month free',
    signupUrl: 'https://play.ht/sign-up/',
    docsUrl:   'https://play.ht/app/user/settings',
    fields: [
      { key: 'playht_secret', label: 'Secret key', placeholder: 'ak-…' },
      { key: 'playht_user',   label: 'User ID',    placeholder: 'user_…' },
    ],
  },
  {
    id: 'cartesia', label: 'Cartesia', sub: '$5 free credit (no card)',
    signupUrl: 'https://play.cartesia.ai/sign-up',
    docsUrl:   'https://play.cartesia.ai/keys',
    fields: [{ key: 'cartesia', label: 'API Key', placeholder: 'sk-…' }],
  },
  {
    id: 'lmnt', label: 'LMNT', sub: '500 utterances / month free',
    signupUrl: 'https://app.lmnt.com/account',
    docsUrl:   'https://app.lmnt.com/account',
    fields: [{ key: 'lmnt', label: 'API Key', placeholder: 'API key…' }],
  },
];

let _keySaveTimer;
function _flushKeys() {
  const obj = {};
  KEY_DEFS.forEach(def => {
    def.fields.forEach(f => {
      obj[f.key] = document.getElementById(`key-input-${f.key}`)?.value.trim() || '';
    });
  });
  Keys.set(obj);
  // Update live status badges
  KEY_DEFS.forEach(def => {
    const allSet = def.fields.every(f => !!Keys.get(f.key));
    const el = document.getElementById(`key-status-${def.id}`);
    if (el) { el.className = `key-row-status ${allSet ? 'set' : 'unset'}`; el.textContent = allSet ? 'Set' : 'Not set'; }
  });
  updateKeysCount();
  updateUsageWidget();
}

let _sheetBackdropHandler = null;

function openKeysSheet(onboarding = false) {
  const sheet     = document.getElementById('keys-sheet');
  const wrap      = document.getElementById('keys-list-wrap');
  const saveBtn   = document.getElementById('btn-keys-save');
  const cancelBtn = document.getElementById('btn-keys-cancel');

  // Unhide first — nothing should be able to prevent this
  sheet.classList.remove('hidden');
  sheet.scrollTop = 0;
  wrap.scrollTop  = 0;

  // Use pinned IDs — avoids ambiguity with .eyebrow elements inside the guide
  document.getElementById('keys-sheet-eyebrow').textContent = onboarding ? 'GET STARTED' : 'SETTINGS';
  document.getElementById('keys-sheet-title').textContent   = onboarding ? 'Add your first key.' : 'API keys';
  saveBtn.innerHTML   = onboarding
    ? `Next <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>`
    : `Done <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>`;
  cancelBtn.textContent = onboarding ? 'Skip for now' : 'Cancel';

  const saved = Keys.all();
  wrap.innerHTML = '';

  // ── Guide ──────────────────────────────────────────────────────────────
  const guide = document.createElement('div');
  guide.className = 'keys-guide';
  guide.innerHTML = `
    <div class="eyebrow" style="margin-bottom:14px">HOW TO ADD A KEY</div>
    <div class="keys-guide-steps">
      <div class="keys-guide-step">
        <span class="keys-guide-num">1</span>
        <span>Pick any provider below — all are <strong>completely free</strong> with no card required.</span>
      </div>
      <div class="keys-guide-step">
        <span class="keys-guide-num">2</span>
        <span>Click <strong>Create free account</strong> to open the provider's signup page in a new tab. Sign up and verify your email.</span>
      </div>
      <div class="keys-guide-step">
        <span class="keys-guide-num">3</span>
        <span>Once you're in, click <strong>Get API key</strong> — it takes you directly to the key settings page.</span>
      </div>
      <div class="keys-guide-step">
        <span class="keys-guide-num">4</span>
        <span>Create a new key, copy it, and paste it into the field below. It saves automatically as you type.</span>
      </div>
      <div class="keys-guide-step">
        <span class="keys-guide-num">5</span>
        <span>Repeat for more providers — Voicey rotates between them so your free quotas last much longer.</span>
      </div>
    </div>
    <div class="keys-guide-divider"></div>
    <div class="eyebrow" style="margin-bottom:12px">EXACTLY WHERE TO FIND EACH KEY</div>
    <div class="keys-guide-tips">
      <div class="keys-guide-tip">
        <span class="keys-guide-tip-label">ElevenLabs</span>
        <span>After signing in → click your <strong>profile icon</strong> (top-right) → <strong>API Keys</strong> → <strong>Create API Key</strong> → copy it.</span>
      </div>
      <div class="keys-guide-tip">
        <span class="keys-guide-tip-label">Play.ht</span>
        <span>After signing in → <strong>Settings</strong> → <strong>API Access</strong>. You need <em>two</em> values: the <strong>Secret Key</strong> and your <strong>User ID</strong> (shown on the same page).</span>
      </div>
      <div class="keys-guide-tip">
        <span class="keys-guide-tip-label">Cartesia</span>
        <span>After signing in → left sidebar → <strong>API Keys</strong> → <strong>New API Key</strong> → give it a name → copy the key immediately (shown only once).</span>
      </div>
      <div class="keys-guide-tip">
        <span class="keys-guide-tip-label">LMNT</span>
        <span>After signing in → <strong>Account</strong> page → scroll to the <strong>API</strong> section → click <strong>Create API Key</strong> → copy it.</span>
      </div>
    </div>
  `;
  wrap.appendChild(guide);

  KEY_DEFS.forEach(def => {
    const allSet = def.fields.every(f => !!saved[f.key]);
    const row = document.createElement('div');
    row.className = 'key-row';

    // Header with live status badge
    const header = document.createElement('div');
    header.className = 'key-row-header';
    header.innerHTML = `
      <div>
        <div class="key-row-label">${def.label}</div>
        <div class="key-row-sub">${def.sub}</div>
      </div>
      <div id="key-status-${def.id}" class="key-row-status ${allSet ? 'set' : 'unset'}">${allSet ? 'Set' : 'Not set'}</div>
    `;
    row.appendChild(header);

    // Signup / manage account links
    const links = document.createElement('div');
    links.className = 'key-row-links';
    links.innerHTML = `
      <a href="${def.signupUrl}" target="_blank" rel="noopener" class="key-link">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Create free account
      </a>
      <a href="${def.docsUrl}" target="_blank" rel="noopener" class="key-link dim">
        Get API key →
      </a>
    `;
    row.appendChild(links);

    // Input fields with autosave
    def.fields.forEach(f => {
      const fieldWrap = document.createElement('div');
      fieldWrap.style.marginTop = '10px';

      const fieldLabel = document.createElement('div');
      fieldLabel.style.cssText = 'font-size:12px;color:var(--ink-low);margin-bottom:6px;font-family:var(--mono);';
      fieldLabel.textContent = f.label;
      fieldWrap.appendChild(fieldLabel);

      const inputWrap = document.createElement('div');
      inputWrap.className = 'key-input-wrap';

      const inp = document.createElement('input');
      inp.type = 'password';
      inp.className = 'input';
      inp.id = `key-input-${f.key}`;
      inp.placeholder = f.placeholder;
      inp.value = saved[f.key] || '';
      inp.autocomplete = 'new-password';
      inp.spellcheck = false;
      inp.readOnly = true;
      inp.addEventListener('focus', () => { inp.readOnly = false; }, { once: true });

      const savedBadge = document.createElement('span');
      savedBadge.className = 'key-saved-badge hidden';
      savedBadge.textContent = '✓ Saved';

      inp.addEventListener('input', () => {
        clearTimeout(_keySaveTimer);
        _keySaveTimer = setTimeout(() => {
          _flushKeys();
          savedBadge.classList.remove('hidden');
          setTimeout(() => savedBadge.classList.add('hidden'), 1500);
        }, 500);
      });

      const reveal = document.createElement('button');
      reveal.className = 'btn-reveal';
      reveal.type = 'button';
      reveal.textContent = 'Show';
      reveal.addEventListener('click', () => {
        inp.type = inp.type === 'password' ? 'text' : 'password';
        reveal.textContent = inp.type === 'password' ? 'Show' : 'Hide';
      });

      inputWrap.appendChild(inp);
      inputWrap.appendChild(reveal);
      fieldWrap.appendChild(inputWrap);
      fieldWrap.appendChild(savedBadge);
      row.appendChild(fieldWrap);
    });

    wrap.appendChild(row);
  });

  updateKeysCount();
  document.getElementById('btn-close-keys').onclick = closeKeysSheet;
  cancelBtn.onclick = closeKeysSheet;
  saveBtn.onclick   = () => { _flushKeys(); closeKeysSheet(); refreshDashboard(); };

  // Replace backdrop listener each time so it never accumulates
  if (_sheetBackdropHandler) sheet.removeEventListener('click', _sheetBackdropHandler);
  _sheetBackdropHandler = e => { if (e.target === sheet) closeKeysSheet(); };
  sheet.addEventListener('click', _sheetBackdropHandler);
}

function closeKeysSheet() {
  document.getElementById('keys-sheet').classList.add('hidden');
}

function updateKeysCount() {
  const n   = configured().length;
  const chip = document.getElementById('keys-count-chip');
  if (chip) chip.textContent = `${n}/4 added`;
}

/* ── New voice view ─────────────────────────────────────────────────────── */
let _newSource = 'mic';

function openNewVoice() {
  _newSource = 'mic';
  S.newRecBlob = null;

  document.getElementById('new-voice-name').value = '';
  document.getElementById('yt-url').value          = '';
  document.getElementById('new-error').classList.add('hidden');
  document.getElementById('btn-new-create').disabled = true;
  document.getElementById('btn-new-create').style.opacity = '0.4';
  document.getElementById('new-rec-label').textContent    = 'Tap to record';
  document.getElementById('new-rec-timer').textContent    = '0:00';
  document.getElementById('new-rec-dot-row').classList.add('hidden');
  document.getElementById('new-rec-redo').classList.add('hidden');
  document.getElementById('new-rec-waveform').innerHTML   = '';
  document.getElementById('new-rec-btn').classList.remove('recording');

  showNewSrc('mic');

  document.getElementById('btn-new-back').onclick   = () => { stopNewRecording(false); refreshDashboard(); show('view-dashboard'); };
  document.getElementById('btn-new-cancel').onclick = () => { stopNewRecording(false); refreshDashboard(); show('view-dashboard'); };

  show('view-new');
}

function showNewSrc(src) {
  _newSource = src;
  document.querySelectorAll('#new-source-tabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.src === src);
  });
  document.getElementById('new-src-mic').classList.toggle('hidden', src !== 'mic');
  document.getElementById('new-src-upload').classList.toggle('hidden', src !== 'upload');
  document.getElementById('new-src-yt').classList.toggle('hidden', src !== 'yt');
}

function initNewVoice() {
  document.getElementById('new-source-tabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-src]');
    if (btn) showNewSrc(btn.dataset.src);
  });

  document.getElementById('new-rec-btn').addEventListener('click', () => {
    if (S.newRecording) stopNewRecording(true);
    else startNewRecording();
  });

  document.getElementById('new-rec-redo').addEventListener('click', () => {
    S.newRecBlob = null;
    document.getElementById('new-rec-label').textContent = 'Tap to record';
    document.getElementById('new-rec-timer').textContent = '0:00';
    document.getElementById('new-rec-redo').classList.add('hidden');
    document.getElementById('new-rec-waveform').innerHTML = '';
    document.getElementById('new-rec-btn').classList.remove('recording');
    document.getElementById('btn-new-create').disabled = true;
    document.getElementById('btn-new-create').style.opacity = '0.4';
  });

  // Drag-and-drop on upload panel
  const drop = document.getElementById('new-src-upload');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleUploadFile(file);
  });
  document.getElementById('upload-file-input').addEventListener('change', e => {
    if (e.target.files[0]) handleUploadFile(e.target.files[0]);
  });

  // Name input enables button
  document.getElementById('new-voice-name').addEventListener('input', checkNewReady);

  document.getElementById('btn-new-create').addEventListener('click', confirmNewVoice);
}

function checkNewReady() {
  const name  = document.getElementById('new-voice-name').value.trim();
  const ready = name.length > 0 && (
    (_newSource === 'mic'    && !!S.newRecBlob) ||
    (_newSource === 'upload' && !!document.getElementById('upload-file-input').files[0]) ||
    (_newSource === 'yt'     && document.getElementById('yt-url').value.trim().length > 0)
  );
  document.getElementById('btn-new-create').disabled       = !ready;
  document.getElementById('btn-new-create').style.opacity  = ready ? '1' : '0.4';
}

function handleUploadFile(file) {
  const label = document.getElementById('upload-label');
  const sub   = document.getElementById('upload-sub');
  label.textContent = file.name;
  sub.textContent   = `${(file.size / 1024 / 1024).toFixed(1)} MB · ${file.type || 'audio'}`;
  checkNewReady();
}

async function startNewRecording() {
  try {
    S.newStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    toast('Microphone access denied.');
    return;
  }

  S.newChunks  = [];
  S.newRecording = true;
  S.newRecSecs   = 0;

  document.getElementById('new-rec-btn').classList.add('recording');
  document.getElementById('new-rec-label').textContent = 'Recording — tap to stop';
  document.getElementById('new-rec-dot-row').classList.remove('hidden');

  // Timer
  S.newRecTimer = setInterval(() => {
    S.newRecSecs++;
    const m = Math.floor(S.newRecSecs / 60), s = S.newRecSecs % 60;
    document.getElementById('new-rec-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  }, 1000);

  // Waveform
  if (!S.audioCtx) {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.analyser  = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 256;
  }
  S.audioCtx.createMediaStreamSource(S.newStream).connect(S.analyser);
  drawNewWaveform();

  const mime = bestMime();
  S.newMediaRec = new MediaRecorder(S.newStream, mime ? { mimeType: mime } : {});
  S.newMediaRec.ondataavailable = e => { if (e.data.size > 0) S.newChunks.push(e.data); };
  S.newMediaRec.onstop = finishNewRecording;
  S.newMediaRec.start();
}

function stopNewRecording(andFinish) {
  if (!S.newRecording) return;
  S.newRecording = false;
  clearInterval(S.newRecTimer);
  stopWaveform();
  if (!andFinish && S.newMediaRec) S.newMediaRec.onstop = null;
  if (S.newMediaRec?.state !== 'inactive') S.newMediaRec?.stop();
  if (S.newStream) { S.newStream.getTracks().forEach(t => t.stop()); S.newStream = null; }
  document.getElementById('new-rec-btn').classList.remove('recording');
  document.getElementById('new-rec-dot-row').classList.add('hidden');
}

function finishNewRecording() {
  const mime = S.newChunks[0]?.type || 'audio/webm';
  const blob = new Blob(S.newChunks, { type: mime });
  if (blob.size < 500) { toast('Recording too short — try again.'); return; }
  S.newRecBlob = blob;
  document.getElementById('new-rec-label').textContent = 'Recording saved ✓';
  document.getElementById('new-rec-redo').classList.remove('hidden');

  // Show static waveform
  const wfEl = document.getElementById('new-rec-waveform');
  wfEl.innerHTML = '';
  wfEl.style.color = 'var(--accent)';
  createStaticWave(wfEl, { bars: 48, height: 48, seed: Date.now() % 9999 });
  checkNewReady();
}

function drawNewWaveform() {
  const el = document.getElementById('new-rec-waveform');
  if (!el) return;
  el.innerHTML = '';
  el.style.cssText = 'display:flex;align-items:center;gap:2px;height:48px;color:var(--accent);width:100%;max-width:420px';

  const barCount = 48;
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const b = document.createElement('span');
    b.style.cssText = 'flex:1;background:currentColor;border-radius:1px;height:4px;transform-origin:center;transition:height 0.05s';
    el.appendChild(b);
    bars.push(b);
  }

  const frame = () => {
    if (!S.newRecording && !S.isRecording) return;
    S.animFrame = requestAnimationFrame(frame);
    if (!S.analyser) return;
    const data = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / barCount);
    bars.forEach((b, i) => {
      const v = data[i * step] / 255;
      b.style.height = `${Math.max(4, v * 100)}%`;
      b.style.opacity = String(0.4 + v * 0.6);
    });
  };
  stopWaveform();
  frame();
}

async function confirmNewVoice() {
  const name  = document.getElementById('new-voice-name').value.trim();
  const errEl = document.getElementById('new-error');
  errEl.classList.add('hidden');
  if (!name) { errEl.textContent = 'Please give your voice a name.'; errEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('btn-new-create');
  btn.disabled = true;

  try {
    const voice = makeVoice(name, _newSource === 'yt' ? 'youtube' : _newSource);

    if (_newSource === 'mic') {
      if (!S.newRecBlob) { errEl.textContent = 'Please record audio first.'; errEl.classList.remove('hidden'); return; }
      const buf = await S.newRecBlob.arrayBuffer();
      await dbPut({ id: uuid(), voiceId: voice.id, data: buf, mime: S.newRecBlob.type || 'audio/webm', name: `rec_${Date.now()}.webm`, createdAt: Date.now() });
      voice.sampleCount   = 1;
      voice.totalDuration = estimateDuration(S.newRecBlob.size, S.newRecBlob.type);
      saveVoice(voice);
      refreshDashboard();
      openTrain(voice, 'initial');
      return;
    }

    if (_newSource === 'upload') {
      const file = document.getElementById('upload-file-input').files[0];
      if (file) {
        const buf = await file.arrayBuffer();
        await dbPut({ id: uuid(), voiceId: voice.id, data: buf, mime: file.type, name: file.name, createdAt: Date.now() });
        voice.sampleCount   = 1;
        voice.totalDuration = estimateDuration(file.size, file.type);
      }
      saveVoice(voice);
      refreshDashboard();
      openSpeak(voice);
      return;
    }

    if (_newSource === 'yt') {
      const url = document.getElementById('yt-url').value.trim();
      btn.textContent = 'Downloading…';
      try {
        const blob = await downloadYouTube(url);
        const buf  = await blob.arrayBuffer();
        await dbPut({ id: uuid(), voiceId: voice.id, data: buf, mime: blob.type || 'audio/mpeg', name: 'youtube.mp3', createdAt: Date.now() });
        voice.sampleCount   = 1;
        voice.totalDuration = estimateDuration(blob.size, blob.type);
      } catch (e) {
        errEl.textContent = e.message; errEl.classList.remove('hidden');
        btn.disabled = false; btn.innerHTML = 'Create &amp; train <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';
        return;
      }
      saveVoice(voice);
      refreshDashboard();
      if (voice.sampleCount > 0) openSpeak(voice);
      else openTrain(voice, 'initial');
    }
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
  }
}

async function downloadYouTube(url) {
  const r = await fetch('https://api.cobalt.tools/api/json', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, aFormat: 'mp3', isAudioOnly: true, disableMetadata: true }),
  });
  if (!r.ok) throw new Error('Could not contact YouTube download service. Try uploading the audio file directly.');
  const d = await r.json();
  if (d.status === 'error' || d.status === 'rate-limit')
    throw new Error(d.text || 'YouTube download failed. Try uploading the audio file directly.');
  const audioR = await fetch(d.url).catch(() => null);
  if (!audioR?.ok)
    throw new Error('Could not fetch YouTube audio (CORS). Download the audio manually and use Upload instead.');
  return audioR.blob();
}

function estimateDuration(size, mime) {
  const bps = (mime || '').includes('wav') ? 32000 : 16000;
  return size / bps;
}

/* ── Train view ─────────────────────────────────────────────────────────── */
function openTrain(voice, mode) {
  S.voice     = voice;
  S.trainMode = mode;
  S.sentences   = mode === 'initial' ? [...INITIAL_SENTENCES] : shuffle([...EXTENDED_SENTENCES]);
  S.sentenceIdx = 0;

  const isImproving = mode === 'extended';
  document.getElementById('train-step-eyebrow').textContent = isImproving ? 'IMPROVING · REFINE' : 'STEP 2 OF 3 · REFINE';
  document.getElementById('btn-train-done').textContent = isImproving ? 'Done improving' : 'Skip training';

  document.getElementById('train-chip').textContent = voice.name;
  document.getElementById('train-counter').textContent =
    mode === 'initial' ? `0 of ${S.sentences.length} prompts` : 'Extended training · press Done when finished';

  showSentence();
  initTrainWaveform();

  document.getElementById('btn-train-done').onclick = () => {
    stopRecording(false);
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    if (mode === 'initial') { refreshDashboard(); show('view-dashboard'); }
    else openSpeak(getVoice(S.voice.id) || S.voice);
  };

  document.getElementById('btn-skip').onclick = () => {
    stopRecording(false);
    nextSentence();
  };

  document.getElementById('btn-record').onclick = () => {
    if (S.isRecording) stopRecording(true);
    else startRecording();
  };

  document.getElementById('btn-next-sentence').onclick = () => {
    if (S.isRecording) stopRecording(true);
    else nextSentence();
  };

  show('view-train');
}

function showSentence() {
  const total = S.trainMode === 'initial' ? S.sentences.length : null;
  const idx   = S.sentenceIdx;

  document.getElementById('train-sentence').textContent  = S.sentences[idx] || '';
  document.getElementById('train-prompt-num').textContent = `PROMPT ${String(idx + 1).padStart(2, '0')}`;
  document.getElementById('train-counter').textContent   =
    total !== null ? `${idx + 1} of ${total} prompts` : `Sample ${idx + 1}`;

  document.getElementById('btn-record').classList.remove('recording');
  document.getElementById('rec-state-label').textContent = 'Start recording';
  document.getElementById('btn-next-sentence').disabled  = true;
  document.getElementById('btn-next-sentence').style.opacity = '0.4';
}

function nextSentence() {
  S.sentenceIdx++;
  if (S.trainMode === 'initial' && S.sentenceIdx >= S.sentences.length) {
    // Training complete — go to speak
    stopWaveform();
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    toast(`Training complete! ${S.voice.sampleCount} samples recorded.`);
    openSpeak(getVoice(S.voice.id) || S.voice);
    return;
  }
  if (S.sentenceIdx >= S.sentences.length) {
    S.sentences   = shuffle([...EXTENDED_SENTENCES]);
    S.sentenceIdx = 0;
  }
  showSentence();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── Audio recording ────────────────────────────────────────────────────── */
function bestMime() {
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

async function startRecording() {
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    toast('Microphone access denied. Please allow microphone use in your browser.');
    return;
  }

  S.audioChunks = [];
  S.isRecording = true;

  if (!S.audioCtx) {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.analyser  = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 256;
  }
  S.audioCtx.createMediaStreamSource(S.stream).connect(S.analyser);
  drawTrainWaveform();

  const mime = bestMime();
  S.mediaRecorder = new MediaRecorder(S.stream, mime ? { mimeType: mime } : {});
  S.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) S.audioChunks.push(e.data); };
  S.mediaRecorder.onstop = () => submitRecording();
  S.mediaRecorder.start();

  document.getElementById('btn-record').classList.add('recording');
  document.getElementById('rec-state-label').textContent = 'Recording — tap to stop';
}

function stopRecording(andSubmit) {
  if (!S.isRecording) return;
  S.isRecording = false;
  if (!andSubmit && S.mediaRecorder) S.mediaRecorder.onstop = null;
  if (S.mediaRecorder?.state !== 'inactive') S.mediaRecorder?.stop();
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  stopWaveform();
  document.getElementById('btn-record').classList.remove('recording');
  document.getElementById('rec-state-label').textContent = 'Start recording';
}

async function submitRecording() {
  const mime = S.audioChunks[0]?.type || 'audio/webm';
  const blob = new Blob(S.audioChunks, { type: mime });
  if (blob.size < 500) { toast('Recording too short — try again.'); showSentence(); return; }

  const btn = document.getElementById('btn-record');
  btn.disabled = true;

  try {
    const buf = await blob.arrayBuffer();
    await dbPut({ id: uuid(), voiceId: S.voice.id, data: buf, mime, name: `rec_${Date.now()}.webm`, createdAt: Date.now() });
    S.voice.sampleCount++;
    S.voice.totalDuration += blob.size / 16000;
    saveVoice(S.voice);
    document.getElementById('btn-next-sentence').disabled = false;
    document.getElementById('btn-next-sentence').style.opacity = '1';
    document.getElementById('rec-state-label').textContent = 'Recorded ✓ — next sentence or re-record';
  } catch (e) {
    toast(`Save error: ${e.message}`);
    showSentence();
  } finally {
    btn.disabled = false;
  }
}

/* ── Waveforms ──────────────────────────────────────────────────────────── */
function initTrainWaveform() {
  const el = document.getElementById('train-waveform');
  if (el) createAnimatedWaveform(el, { bars: 18, height: 36, gap: 3, width: 3, seed: 7, animated: false });
}

function drawTrainWaveform() {
  const el = document.getElementById('train-waveform');
  if (!el) return;
  el.innerHTML = '';
  el.style.cssText = 'display:flex;align-items:center;gap:3px;height:36px;width:140px;color:var(--accent)';

  const barCount = 18;
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const b = document.createElement('span');
    b.style.cssText = 'width:3px;background:currentColor;border-radius:2px;height:4px;transform-origin:center;transition:height 0.06s';
    el.appendChild(b); bars.push(b);
  }

  const frame = () => {
    if (!S.isRecording) return;
    S.animFrame = requestAnimationFrame(frame);
    if (!S.analyser) return;
    const data = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / barCount);
    bars.forEach((b, i) => {
      const v = data[i * step] / 255;
      b.style.height = `${Math.max(4, v * 100)}%`;
    });
  };
  stopWaveform();
  frame();
}

function stopWaveform() {
  if (S.animFrame) { cancelAnimationFrame(S.animFrame); S.animFrame = null; }
}

/* ── Speak view ─────────────────────────────────────────────────────────── */
function openSpeak(voice) {
  S.voice        = voice;
  S.generatedURL = null;

  document.getElementById('speak-voice-name').textContent = voice.name;
  document.getElementById('speak-provider-info').textContent =
    `${voice.sampleCount} sample${voice.sampleCount !== 1 ? 's' : ''} · ${fmtDuration(voice.totalDuration)}`;
  document.getElementById('speak-text').value              = '';
  document.getElementById('char-count').textContent        = '0 / 1500';
  document.getElementById('audio-card').classList.add('hidden');
  document.getElementById('speak-error').classList.add('hidden');
  document.getElementById('audio-player-wrap').classList.add('hidden');

  show('view-speak');

  document.getElementById('speak-back').onclick = () => { refreshDashboard(); show('view-dashboard'); };
  document.getElementById('btn-keep-improving').onclick = () =>
    openTrain(getVoice(voice.id) || voice, 'extended');

  const ta = document.getElementById('speak-text');
  ta.oninput = () => document.getElementById('char-count').textContent = `${ta.value.length} / 1500`;

  document.getElementById('btn-generate').onclick = generateSpeech;
}

async function generateSpeech() {
  const text  = document.getElementById('speak-text').value.trim();
  const errEl = document.getElementById('speak-error');
  errEl.classList.add('hidden');
  if (!text) { errEl.textContent = 'Please enter some text first.'; errEl.classList.remove('hidden'); return; }
  if (!configured().length) {
    errEl.textContent = 'No API keys configured. Click "Add keys" in the top bar.';
    errEl.classList.remove('hidden'); return;
  }

  const btn     = document.getElementById('btn-generate');
  const label   = document.getElementById('generate-label');
  const spinner = document.getElementById('generate-spinner');
  const icon    = document.getElementById('generate-icon');
  btn.disabled  = true;
  spinner.classList.remove('hidden');
  icon.classList.add('hidden');
  document.getElementById('audio-card').classList.add('hidden');

  try {
    label.textContent = 'Uploading voice…';
    const freshVoice = getVoice(S.voice.id) || S.voice;
    await ensureOnProviders(freshVoice);
    S.voice = getVoice(S.voice.id) || freshVoice;

    label.textContent = 'Generating…';
    const blob = await synthesizeRotated(S.voice, text);

    if (S.generatedURL) URL.revokeObjectURL(S.generatedURL);
    S.generatedMime = blob.type || 'audio/mpeg';
    S.generatedURL  = URL.createObjectURL(blob);

    const player = document.getElementById('audio-player');
    player.src   = S.generatedURL;
    player.load();

    // Show card with static waveform
    document.getElementById('audio-card').classList.remove('hidden');
    document.getElementById('audio-player-wrap').classList.remove('hidden');
    document.getElementById('audio-meta').textContent = `via ${configured()[_synthIdx % Math.max(1, configured().length) - 1]?.label || 'provider'} · rotated`;

    const pwEl = document.getElementById('player-wave');
    pwEl.innerHTML = '';
    createStaticWave(pwEl, { bars: 60, height: 36, seed: Date.now() % 9999 });

    const wfWrap = document.getElementById('audio-waveform-wrap');
    wfWrap.innerHTML = '';
    createStaticWave(wfWrap, { bars: 80, height: 64, seed: (Date.now() + 1) % 9999 });

    player.play().catch(() => {});

    // Play button
    const playBtn = document.getElementById('play-btn');
    playBtn.onclick = () => {
      if (player.paused) player.play();
      else player.pause();
    };
    player.onplay  = () => { playBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`; };
    player.onpause = () => { playBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`; };
    player.ontimeupdate = () => {
      const t = player.currentTime, m = Math.floor(t / 60), s = Math.floor(t % 60);
      document.getElementById('player-time').textContent = `${m}:${String(s).padStart(2, '0')}`;
    };

    document.getElementById('btn-download').onclick = () => {
      const ext = S.generatedMime.includes('mpeg') ? 'mp3' : 'wav';
      const a   = document.createElement('a');
      a.href = S.generatedURL; a.download = `${S.voice.name.replace(/\s+/g,'_')}_speech.${ext}`;
      a.click();
    };

    document.getElementById('audio-cost').textContent = `${text.length} characters`;

  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    label.textContent = 'Generate speech';
    spinner.classList.add('hidden');
    icon.classList.remove('hidden');
  }
}

/* ── Tour ───────────────────────────────────────────────────────────────── */
const TOUR_STEPS = [
  {
    view:    'view-dashboard',
    target:  null,
    eyebrow: 'QUICK TUTORIAL · 14 STEPS',
    title:   'Welcome to Voicey.',
    body:    "Clone any voice and generate speech from text — entirely in your browser. Let's walk through every screen and create a demo voice along the way.",
  },
  {
    view:    'view-dashboard',
    target:  '#btn-open-keys',
    pad:     10,
    eyebrow: 'STEP 1 · API KEYS',
    title:   'You need one free API key.',
    body:    "Voicey calls ElevenLabs, Play.ht, Cartesia, and LMNT for synthesis. All four are completely free to start — no credit card. We'll open the key setup when this tutorial ends.",
  },
  {
    view:    'view-dashboard',
    target:  '#btn-new-voice',
    pad:     10,
    eyebrow: 'STEP 2 · CREATE',
    title:   'This button creates a voice.',
    body:    "Tap \"New voice\" to start. Click Next and we'll open the creation screen right now.",
  },
  {
    view:    'view-new',
    setup() {
      try {
        openNewVoice();
        const n = document.getElementById('new-voice-name');
        if (n) { n.value = 'Demo Voice'; }
      } catch(e) {}
    },
    target:  null,
    eyebrow: 'STEP 3 · NEW VOICE SCREEN',
    title:   'Creating a new voice.',
    body:    "Name the voice, then choose how to get the audio: record your mic right here, upload a file, or paste a YouTube URL. We've typed 'Demo Voice' as the name.",
  },
  {
    view:    'view-new',
    target:  '#new-voice-name',
    pad:     10,
    eyebrow: 'STEP 4 · NAME',
    title:   'Give it a descriptive name.',
    body:    "The name appears on the library card. You can call it anything — your name, a colleague's, a character. It can't be changed later so choose carefully.",
  },
  {
    view:    'view-new',
    target:  '#new-source-tabs',
    pad:     8,
    eyebrow: 'STEP 5 · AUDIO SOURCE',
    title:   'Three ways to capture audio.',
    body:    '<b>Mic</b> — record live in the browser, great for your own voice. <b>Upload</b> — drag an MP3 or WAV up to 50 MB. <b>YouTube</b> — paste any public video URL; Voicey extracts the audio automatically.',
  },
  {
    view:    'view-new',
    target:  '#new-rec-btn',
    pad:     14,
    eyebrow: 'STEP 6 · RECORD',
    title:   'Press to start recording.',
    body:    "Tap this button and speak naturally for 60–90 seconds. A live waveform shows while you record. Press again to stop. Hit Redo if you want to try again.",
  },
  {
    view:    'view-dashboard',
    setup() {
      try {
        if (!Tour._demo) {
          const d = makeVoice('Demo Voice', 'mic');
          d.sampleCount   = 6;
          d.totalDuration = 54;
          saveVoice(d);
          Tour._demo = d;
        }
        refreshDashboard();
      } catch(e) {}
    },
    target:  null,
    eyebrow: 'STEP 7 · LIBRARY',
    title:   "Voice saved — it's in your library.",
    body:    "After creation the voice appears as a card. We've added a demo voice so you can see how it looks. Tap any card to open the Speak view for that voice.",
  },
  {
    view:    'view-dashboard',
    target:  '#voice-grid',
    pad:     14,
    eyebrow: 'STEP 8 · VOICE CARDS',
    title:   'Tap a card to speak.',
    body:    "Each card shows the name, sample count, and total recording time. Tap it to go to the Speak view. Use 'Keep improving' on the speak screen to record more training samples.",
  },
  {
    view:    'view-train',
    setup() {
      try {
        if (Tour._demo) openTrain(Tour._demo, 'initial');
      } catch(e) {}
    },
    target:  null,
    eyebrow: 'STEP 9 · TRAINING',
    title:   'Refine with short prompts.',
    body:    "Training gives you one sentence at a time to read aloud. Every recording improves how accurately the AI captures your voice. The more prompts you do, the more natural the output.",
  },
  {
    view:    'view-train',
    target:  '#btn-record',
    pad:     14,
    eyebrow: 'STEP 10 · RECORD PROMPT',
    title:   'Read the sentence. Press record.',
    body:    "Read the sentence shown above, press this button to capture it, then press 'Next prompt' to continue. Press 'Skip training' or 'Done for now' at any time to return to the library.",
  },
  {
    view:    'view-speak',
    setup() {
      try {
        if (Tour._demo) openSpeak(Tour._demo);
      } catch(e) {}
    },
    target:  null,
    eyebrow: 'STEP 11 · SPEAK',
    title:   'Type anything. Hear it back.',
    body:    "The Speak view is where the magic happens. Type up to 1,500 characters — a quote, a message, a script — and press Generate. Voicey routes it through one of your API providers and returns cloned audio.",
  },
  {
    view:    'view-speak',
    target:  '#speak-text',
    pad:     12,
    eyebrow: 'STEP 12 · SCRIPT',
    title:   'Type your script here.',
    body:    "Paste any text. After generating, use the player to listen and save the audio as an MP3. Tap 'Keep improving' to jump back to the training view and record more prompts.",
  },
  {
    view:    'view-dashboard',
    setup()  { try { refreshDashboard(); } catch(e) {} },
    target:  null,
    eyebrow: 'ALL DONE · STEP 13',
    title:   "You're ready.",
    body:    "The Demo Voice is in your library — record more samples to improve it, or create a real voice from scratch. Click 'Get started' to add your first free API key. You can relaunch this tutorial any time from the nav.",
    finish:  true,
  },
];

const Tour = {
  _step:         0,
  _ring:         null,
  _tooltip:      null,
  _demo:         null,
  _autoOpenKeys: false,

  start(autoOpenKeys = false) {
    Tour.end(false);
    Tour._step         = 0;
    Tour._demo         = null;
    Tour._autoOpenKeys = autoOpenKeys;
    Tour._build();
    Tour._render();
  },

  _build() {
    // Use CSS body.tour-active to block clicks while keeping scroll working
    document.body.classList.add('tour-active');

    const ring = document.createElement('div');
    ring.className = 'tour-ring';
    document.body.appendChild(ring);
    Tour._ring = ring;

    const tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';
    document.body.appendChild(tooltip);
    Tour._tooltip = tooltip;
  },

  _render() {
    const step  = TOUR_STEPS[Tour._step];
    const total = TOUR_STEPS.length;

    // Navigate to the step's view, then run its setup
    try { if (step.view)  show(step.view);  } catch(e) {}
    try { if (step.setup) step.setup();     } catch(e) {}

    // Skip step if target element is hidden / missing
    if (step.skipIfHidden && step.target) {
      const el = document.querySelector(step.target);
      if (!el || el.classList.contains('hidden') || el.style.display === 'none' || el.offsetParent === null) {
        Tour._step++;
        if (Tour._step < total) { Tour._render(); return; }
        else { Tour.end(false); return; }
      }
    }

    const isCentered = !step.target;
    const isLast     = Tour._step === total - 1 || !!step.finish;

    // Defer layout reads one frame so the newly-shown view has been painted
    requestAnimationFrame(() => {
      if (!Tour._ring) return;

      if (isCentered) {
        Tour._ring.style.cssText = 'opacity:0;top:50%;left:50%;width:0;height:0;';
      } else {
        const el  = document.querySelector(step.target);
        const pad = step.pad || 12;
        if (el) {
          const r = el.getBoundingClientRect();
          Tour._ring.style.cssText =
            `top:${r.top - pad}px;left:${r.left - pad}px;` +
            `width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;` +
            `opacity:1;border-radius:${getComputedStyle(el).borderRadius || '12px'};`;
        }
      }

      const dots = TOUR_STEPS.map((_, i) =>
        `<span class="tour-dot${i === Tour._step ? ' on' : i < Tour._step ? ' done' : ''}"></span>`
      ).join('');

      Tour._tooltip.innerHTML = `
        <div class="tour-tt-header">
          <span class="eyebrow">${step.eyebrow || `STEP ${Tour._step + 1} OF ${total}`}</span>
          <button class="tour-skip-btn" id="tour-skip">Skip tutorial</button>
        </div>
        <div class="tour-tt-title">${step.title}</div>
        <div class="tour-tt-body">${step.body}</div>
        <div class="tour-tt-footer">
          <div class="tour-dots">${dots}</div>
          <div style="display:flex;gap:8px;align-items:center">
            ${Tour._step > 0 ? '<button class="btn ghost small" id="tour-back">Back</button>' : ''}
            <button class="btn primary small" id="tour-next">
              ${isLast ? 'Get started' : 'Next'}
              ${isLast
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6L9 17l-5-5"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>'}
            </button>
          </div>
        </div>
      `;
      Tour._tooltip.classList.remove('tour-tt-anim');
      void Tour._tooltip.offsetWidth;
      Tour._tooltip.classList.add('tour-tt-anim');

      Tour._positionTooltip(step, isCentered);

      const nextBtn = document.getElementById('tour-next');
      const backBtn = document.getElementById('tour-back');
      const skipBtn = document.getElementById('tour-skip');
      if (nextBtn) nextBtn.onclick = () => isLast ? Tour.end(true) : Tour._advance();
      if (backBtn) backBtn.onclick = () => Tour._retreat();
      if (skipBtn) skipBtn.onclick = () => Tour.end(Tour._autoOpenKeys);
    });
  },

  _advance() {
    Tour._step = Math.min(Tour._step + 1, TOUR_STEPS.length - 1);
    Tour._render();
  },

  _retreat() {
    Tour._step = Math.max(Tour._step - 1, 0);
    Tour._render();
  },

  _positionTooltip(step, isCentered) {
    const TT  = Tour._tooltip;
    const W   = 360;
    const GAP = 22;
    TT.style.width = `${W}px`;

    if (isCentered) {
      TT.style.top       = '50%';
      TT.style.left      = '50%';
      TT.style.transform = 'translate(-50%,-50%)';
      return;
    }

    TT.style.transform = '';
    const el  = document.querySelector(step.target);
    if (!el) return;
    const pad = step.pad || 12;
    const r   = el.getBoundingClientRect();
    const rT  = r.top  - pad;
    const rB  = r.bottom + pad;
    const rL  = r.left - pad;
    const rW  = r.width + pad * 2;

    const spaceBelow = window.innerHeight - rB;
    const spaceAbove = rT;
    const ttH = 230;
    let top;
    if (spaceBelow >= ttH + GAP || spaceBelow >= spaceAbove) {
      top = rB + GAP;
    } else {
      top = rT - GAP - ttH;
    }
    top = Math.max(12, Math.min(top, window.innerHeight - ttH - 12));

    let left = rL + rW / 2 - W / 2;
    left = Math.max(16, Math.min(left, window.innerWidth - W - 16));

    TT.style.top  = `${top}px`;
    TT.style.left = `${left}px`;
  },

  end(openKeys = false) {
    document.body.classList.remove('tour-active');
    [Tour._ring, Tour._tooltip].forEach(el => el?.remove());
    Tour._ring = Tour._tooltip = null;
    if (Tour._demo) { try { removeVoice(Tour._demo.id); } catch(e) {} }
    Tour._demo = null;
    const doOpenKeys = openKeys || Tour._autoOpenKeys;
    Tour._autoOpenKeys = false;
    try { show('view-dashboard'); } catch(e) {}
    try { refreshDashboard(); } catch(e) {}
    if (doOpenKeys) setTimeout(() => { try { openKeysSheet(configured().length === 0); } catch(e) {} }, 300);
  },
};

/* ── Boot ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initNewVoice();

  const userId = LS('session', null);
  if (userId) {
    const user = LS('users', []).find(u => u.id === userId);
    if (user) { S.user = user; initDashboard(); return; }
  }
  show('view-auth');
});
