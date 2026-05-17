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

async function ensureOnProviders(voice) {
  const records = await dbGetByVoice(voice.id);
  if (!records.length) throw new Error('No audio samples found.');

  const providers = configured();
  if (!providers.length)
    throw new Error('No API keys configured. Open Settings (⚙) and add at least one key.');

  const needsUpload =
    voice.uploadedSampleCount < voice.sampleCount ||
    !providers.some(p => voice.providerMaps[p.id]);

  if (!needsUpload) return voice.providerMaps;

  // Delete stale provider voices
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
    try { return await p.synth(voice.providerMaps[p.id], text); }
    catch (e) { errors.push(`${p.label}: ${e.message}`); }
  }
  throw new Error('All providers failed.\n' + errors.join('\n'));
}

/* ── Training sentences ──────────────────────────────────────────────────────── */
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

/* ── View router ─────────────────────────────────────────────────────────────── */
function show(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

/* ── Toast ───────────────────────────────────────────────────────────────────── */
let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ── Auth view ───────────────────────────────────────────────────────────────── */
function initAuth() {
  const tabs   = document.querySelectorAll('.tab');
  const form   = document.getElementById('form-auth');
  const submit = document.getElementById('auth-submit');
  const err    = document.getElementById('auth-error');
  let mode     = 'login';

  tabs.forEach(t => t.addEventListener('click', () => {
    mode = t.dataset.tab;
    tabs.forEach(x => x.classList.toggle('active', x.dataset.tab === mode));
    submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    err.classList.add('hidden');
  }));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    err.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = mode === 'login' ? 'Signing in…' : 'Creating…';
    try {
      S.user = mode === 'login'
        ? await loginUser(username, password)
        : await registerUser(username, password);
      LS_SET('session', S.user.id);
      initDashboard();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    }
  });
}

/* ── Dashboard ───────────────────────────────────────────────────────────────── */
function initDashboard() {
  show('view-dashboard');
  document.getElementById('header-username').textContent = S.user.username;

  document.getElementById('btn-logout').onclick = () => {
    LS_SET('session', null); S.user = null; show('view-auth');
  };
  document.getElementById('btn-settings').onclick       = openSettings;
  document.getElementById('btn-banner-settings').onclick = openSettings;

  refreshDashboard();
}

function refreshDashboard() {
  renderProviderBadges();
  const voices = getVoices();
  const grid   = document.getElementById('voice-grid');
  grid.innerHTML = '';
  voices.forEach(v => grid.appendChild(buildVoiceCard(v)));
  grid.appendChild(buildNewCard());

  const banner = document.getElementById('no-keys-banner');
  banner.classList.toggle('hidden', configured().length > 0);
}

function renderProviderBadges() {
  const wrap = document.getElementById('provider-badges');
  wrap.innerHTML = '';
  configured().forEach(p => {
    const b = document.createElement('span');
    b.className = 'provider-badge';
    b.textContent = p.label;
    wrap.appendChild(b);
  });
}

function buildVoiceCard(voice) {
  const srcIcon = {
    microphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>`,
    upload:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    youtube:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>`,
  }[voice.source] || '';

  const card = document.createElement('div');
  card.className = 'voice-card';
  card.innerHTML = `
    <div class="voice-card-icon">${srcIcon}</div>
    <div class="voice-card-name">${esc(voice.name)}</div>
    <div class="voice-card-meta">
      <span>${fmtDuration(voice.totalDuration)}</span>
      <span>·</span>
      <span>${voice.sampleCount} sample${voice.sampleCount !== 1 ? 's' : ''}</span>
    </div>
    <div class="voice-card-status ${voice.sampleCount > 0 ? 'ready' : 'pending'}">
      ${voice.sampleCount > 0 ? 'Ready' : 'No samples yet'}
    </div>
    <button class="voice-card-del" title="Delete">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/>
      </svg>
    </button>
  `;

  card.querySelector('.voice-card-del').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${voice.name}"?`)) return;
    // Delete from providers
    for (const p of PROVIDERS) {
      if (voice.providerMaps?.[p.id]) {
        try { await p.del(voice.providerMaps[p.id]); } catch {}
      }
    }
    await dbDeleteByVoice(voice.id);
    removeVoice(voice.id);
    toast('Voice deleted.');
    refreshDashboard();
  });

  card.addEventListener('click', e => {
    if (e.target.closest('.voice-card-del')) return;
    if (voice.sampleCount > 0) openSpeak(voice);
    else openTrain(voice, 'initial');
  });

  return card;
}

function buildNewCard() {
  const card = document.createElement('div');
  card.className = 'voice-card voice-card-new';
  card.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    <span>New Voice</span>
  `;
  card.addEventListener('click', openCreateModal);
  return card;
}

/* ── Settings view ───────────────────────────────────────────────────────────── */
function openSettings() {
  // Populate fields from saved keys
  const k = Keys.all();
  document.getElementById('key-elevenlabs').value     = k.elevenlabs     || '';
  document.getElementById('key-playht-secret').value  = k.playht_secret  || '';
  document.getElementById('key-playht-user').value    = k.playht_user    || '';
  document.getElementById('key-cartesia').value       = k.cartesia       || '';
  document.getElementById('key-lmnt').value           = k.lmnt           || '';
  show('view-settings');
}

function initSettings() {
  document.getElementById('settings-back').onclick = () => {
    refreshDashboard();
    show('view-dashboard');
  };

  // Show/hide toggles
  document.querySelectorAll('.btn-reveal').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.for);
      if (!inp) return;
      inp.type       = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? 'Show' : 'Hide';
    });
  });

  document.getElementById('btn-save-keys').addEventListener('click', () => {
    Keys.set({
      elevenlabs:    document.getElementById('key-elevenlabs').value.trim(),
      playht_secret: document.getElementById('key-playht-secret').value.trim(),
      playht_user:   document.getElementById('key-playht-user').value.trim(),
      cartesia:      document.getElementById('key-cartesia').value.trim(),
      lmnt:          document.getElementById('key-lmnt').value.trim(),
    });
    toast('Keys saved.');
    refreshDashboard();
    show('view-dashboard');
  });
}

/* ── Create voice modal ─────────────────────────────────────────────────────── */
let _newSource = 'microphone';

function openCreateModal() {
  _newSource = 'microphone';
  document.getElementById('new-voice-name').value = '';
  document.getElementById('yt-url').value = '';
  document.getElementById('create-error').classList.add('hidden');
  document.getElementById('panel-upload').classList.add('hidden');
  document.getElementById('panel-youtube').classList.add('hidden');
  document.querySelectorAll('.source-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.source === 'microphone'));
  document.getElementById('modal-create').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-voice-name').focus(), 50);
}
function closeCreateModal() {
  document.getElementById('modal-create').classList.add('hidden');
}

function initCreateModal() {
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _newSource = btn.dataset.source;
      document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-upload').classList.toggle('hidden', _newSource !== 'upload');
      document.getElementById('panel-youtube').classList.toggle('hidden', _newSource !== 'youtube');
    });
  });

  document.getElementById('btn-create-cancel').addEventListener('click', closeCreateModal);
  document.getElementById('modal-create').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-create')) closeCreateModal();
  });

  document.getElementById('btn-create-confirm').addEventListener('click', async () => {
    const name  = document.getElementById('new-voice-name').value.trim();
    const errEl = document.getElementById('create-error');
    errEl.classList.add('hidden');
    if (!name) { errEl.textContent = 'Please give your voice a name.'; errEl.classList.remove('hidden'); return; }

    const btn = document.getElementById('btn-create-confirm');
    btn.disabled = true; btn.textContent = 'Creating…';

    try {
      const voice = makeVoice(name, _newSource);

      if (_newSource === 'upload') {
        const file = document.getElementById('upload-file-input').files[0];
        if (file) {
          const buf = await file.arrayBuffer();
          await dbPut({ id: uuid(), voiceId: voice.id, data: buf, mime: file.type, name: file.name, createdAt: Date.now() });
          voice.sampleCount   = 1;
          voice.totalDuration = estimateDuration(file.size, file.type);
        }
        saveVoice(voice);
        closeCreateModal();
        refreshDashboard();
        openSpeak(voice);
        return;
      }

      if (_newSource === 'youtube') {
        const url = document.getElementById('yt-url').value.trim();
        if (url) {
          btn.textContent = 'Downloading…';
          try {
            const blob = await downloadYouTube(url);
            const buf  = await blob.arrayBuffer();
            await dbPut({ id: uuid(), voiceId: voice.id, data: buf, mime: blob.type || 'audio/mpeg', name: 'youtube.mp3', createdAt: Date.now() });
            voice.sampleCount   = 1;
            voice.totalDuration = estimateDuration(blob.size, blob.type);
            voice.source        = 'youtube';
          } catch (e) {
            errEl.textContent = e.message;
            errEl.classList.remove('hidden');
            btn.disabled = false; btn.textContent = 'Create & Train';
            return;
          }
        }
        saveVoice(voice);
        closeCreateModal();
        refreshDashboard();
        if (voice.sampleCount > 0) openSpeak(voice);
        else openTrain(voice, 'initial');
        return;
      }

      saveVoice(voice);
      closeCreateModal();
      refreshDashboard();
      openTrain(voice, 'initial');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = 'Create & Train';
    }
  });
}

async function downloadYouTube(url) {
  // cobalt.tools is a free, CORS-enabled media download API
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

/* ── Train view ──────────────────────────────────────────────────────────────── */
function openTrain(voice, mode) {
  S.voice     = voice;
  S.trainMode = mode;

  document.getElementById('train-voice-name').textContent = voice.name;
  document.getElementById('train-mode-label').textContent =
    mode === 'initial' ? 'Quick Training' : 'Extended Training';
  document.getElementById('btn-train-done').classList.toggle('hidden', mode === 'initial');

  document.getElementById('train-intro').classList.remove('hidden');
  document.getElementById('train-session').classList.add('hidden');
  document.getElementById('train-complete').classList.add('hidden');

  show('view-train');

  document.getElementById('train-back').onclick = () => {
    stopRecording(false);
    refreshDashboard();
    show('view-dashboard');
  };
  document.getElementById('btn-train-done').onclick = () => {
    stopRecording(false);
    finishTraining();
  };
  document.getElementById('btn-start-train').onclick = startTrainSession;
}

function startTrainSession() {
  S.sentences   = S.trainMode === 'initial'
    ? [...INITIAL_SENTENCES]
    : shuffle([...EXTENDED_SENTENCES]);
  S.sentenceIdx = 0;

  document.getElementById('train-intro').classList.add('hidden');
  document.getElementById('train-session').classList.remove('hidden');
  document.getElementById('train-complete').classList.add('hidden');

  showSentence();
  initWaveform();

  document.getElementById('btn-skip').onclick = () => {
    stopRecording(false);
    nextSentence();
  };
  document.getElementById('btn-record').onclick = () => {
    if (S.isRecording) stopRecording(true);
    else startRecording();
  };
}

function showSentence() {
  const total = S.trainMode === 'initial' ? S.sentences.length : null;
  const idx   = S.sentenceIdx;

  document.getElementById('train-sentence').textContent = S.sentences[idx] || '';
  document.getElementById('train-counter').textContent  =
    total !== null ? `Sentence ${idx + 1} of ${total}` : `Sample ${idx + 1}`;
  document.getElementById('train-progress').style.width =
    total !== null ? `${(idx / total) * 100}%` : '100%';

  updateQualityBadge();

  const btn   = document.getElementById('btn-record');
  const label = document.getElementById('record-label');
  btn.classList.remove('recording');
  label.textContent = 'Press to record';
}

function updateQualityBadge() {
  const dur = S.voice?.totalDuration || 0;
  const el  = document.getElementById('train-quality');
  if (dur === 0)    { el.className = 'quality-badge q0'; el.textContent = ''; }
  else if (dur < 30){ el.className = 'quality-badge q1'; el.textContent = 'Getting started'; }
  else if (dur < 120){ el.className = 'quality-badge q2'; el.textContent = 'Good quality'; }
  else if (dur < 300){ el.className = 'quality-badge q2'; el.textContent = 'Great quality'; }
  else               { el.className = 'quality-badge q3'; el.textContent = 'Excellent quality'; }
}

function nextSentence() {
  S.sentenceIdx++;
  if (S.trainMode === 'initial' && S.sentenceIdx >= S.sentences.length) { finishTraining(); return; }
  if (S.sentenceIdx >= S.sentences.length) {
    S.sentences   = shuffle([...EXTENDED_SENTENCES]);
    S.sentenceIdx = 0;
  }
  showSentence();
}

function finishTraining() {
  stopWaveform();
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  document.getElementById('train-session').classList.add('hidden');
  document.getElementById('train-complete').classList.remove('hidden');
  document.getElementById('train-complete-sub').textContent =
    `${fmtDuration(S.voice?.totalDuration || 0)} collected across ${S.voice?.sampleCount || 0} samples.`;
  document.getElementById('btn-go-speak').onclick          = () => openSpeak(getVoice(S.voice.id) || S.voice);
  document.getElementById('btn-continue-from-complete').onclick = () =>
    openTrain(getVoice(S.voice.id) || S.voice, 'extended');
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── Audio recording ─────────────────────────────────────────────────────────── */
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
    S.analyser.fftSize = 512;
  }
  S.audioCtx.createMediaStreamSource(S.stream).connect(S.analyser);
  drawWaveform();

  const mime = bestMime();
  S.mediaRecorder = new MediaRecorder(S.stream, mime ? { mimeType: mime } : {});
  S.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) S.audioChunks.push(e.data); };
  S.mediaRecorder.onstop = () => submitRecording();
  S.mediaRecorder.start();

  document.getElementById('btn-record').classList.add('recording');
  document.getElementById('record-label').textContent = 'Recording — press to stop';
}

function stopRecording(andSubmit) {
  if (!S.isRecording) return;
  S.isRecording = false;
  if (!andSubmit && S.mediaRecorder) S.mediaRecorder.onstop = null;
  if (S.mediaRecorder?.state !== 'inactive') S.mediaRecorder?.stop();
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  stopWaveform();
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
    S.voice.totalDuration += blob.size / 16000; // rough estimate
    saveVoice(S.voice);
    nextSentence();
  } catch (e) {
    toast(`Save error: ${e.message}`);
    showSentence();
  } finally {
    btn.disabled = false;
    document.getElementById('btn-record').classList.remove('recording');
    document.getElementById('record-label').textContent = 'Press to record';
  }
}

/* ── Waveform ────────────────────────────────────────────────────────────────── */
function initWaveform() {
  const c = document.getElementById('waveform-canvas');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

function drawWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;

  const frame = () => {
    S.animFrame = requestAnimationFrame(frame);
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, W, H);

    if (!S.analyser) {
      ctx.strokeStyle = '#252525'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      return;
    }

    const buf = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteTimeDomainData(buf);
    ctx.strokeStyle = S.isRecording ? '#ff4d4d' : '#333333';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const sw = W / buf.length;
    buf.forEach((v, i) => {
      const y = ((v / 128) * H) / 2;
      i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sw, y);
    });
    ctx.lineTo(W, H / 2); ctx.stroke();
  };

  stopWaveform();
  frame();
}

function stopWaveform() {
  if (S.animFrame) { cancelAnimationFrame(S.animFrame); S.animFrame = null; }
}

/* ── Speak view ──────────────────────────────────────────────────────────────── */
function openSpeak(voice) {
  S.voice        = voice;
  S.generatedURL = null;

  document.getElementById('speak-voice-name').textContent  = voice.name;
  document.getElementById('speak-voice-stats').textContent =
    `${fmtDuration(voice.totalDuration)} · ${voice.sampleCount} sample${voice.sampleCount !== 1 ? 's' : ''}`;
  document.getElementById('speak-text').value = '';
  document.getElementById('char-count').textContent = '0 / 1500';
  document.getElementById('audio-section').classList.add('hidden');
  document.getElementById('speak-error').classList.add('hidden');

  show('view-speak');

  document.getElementById('speak-back').onclick = () => { refreshDashboard(); show('view-dashboard'); };
  document.getElementById('btn-continue-training').onclick = () =>
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
    errEl.textContent = 'No API keys configured. Open Settings (⚙ in the top bar) to add keys.';
    errEl.classList.remove('hidden'); return;
  }

  const btn     = document.getElementById('btn-generate');
  const label   = document.getElementById('generate-label');
  const spinner = document.getElementById('generate-spinner');
  btn.disabled  = true;
  spinner.classList.remove('hidden');
  document.getElementById('audio-section').classList.add('hidden');

  try {
    label.textContent = 'Preparing voice…';
    const freshVoice = getVoice(S.voice.id) || S.voice;
    await ensureOnProviders(freshVoice);
    S.voice = getVoice(S.voice.id) || freshVoice;

    label.textContent = 'Generating speech…';
    const blob = await synthesizeRotated(S.voice, text);

    if (S.generatedURL) URL.revokeObjectURL(S.generatedURL);
    S.generatedMime = blob.type || 'audio/mpeg';
    S.generatedURL  = URL.createObjectURL(blob);

    const player = document.getElementById('audio-player');
    player.src   = S.generatedURL;
    player.load();
    document.getElementById('audio-section').classList.remove('hidden');
    player.play().catch(() => {});

    document.getElementById('btn-download').onclick = () => {
      const ext = S.generatedMime.includes('mpeg') ? 'mp3' : 'wav';
      const a   = document.createElement('a');
      a.href = S.generatedURL; a.download = `${S.voice.name.replace(/\s+/g,'_')}_speech.${ext}`;
      a.click();
    };
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    label.textContent = 'Generate Speech';
    spinner.classList.add('hidden');
  }
}

/* ── Boot ────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initSettings();
  initCreateModal();

  const userId = LS('session', null);
  if (userId) {
    const user = LS('users', []).find(u => u.id === userId);
    if (user) { S.user = user; initDashboard(); return; }
  }
  show('view-auth');
});
