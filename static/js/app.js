/* ── State ─────────────────────────────────────────────────────────────────── */
const S = {
  token:        null,
  username:     null,
  voice:        null,    // current voice object
  trainMode:    'initial', // 'initial' | 'extended'
  sentences:    [],
  sentenceIdx:  0,
  isRecording:  false,
  mediaRecorder:null,
  audioChunks:  [],
  stream:       null,
  audioCtx:     null,
  analyser:     null,
  animFrame:    null,
  generatedURL:  null,
  generatedMime: 'audio/mpeg',
};

/* ── API ───────────────────────────────────────────────────────────────────── */
const api = {
  async req(method, path, body, form = false) {
    const headers = {};
    if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
    let bodyData;
    if (form) {
      bodyData = body;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      bodyData = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body: bodyData });
    if (method === 'DELETE' && res.ok) return {};
    if (res.headers.get('content-type')?.includes('audio')) return res.blob();
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  },
  register: (u, p)  => api.req('POST', '/api/auth/register', { username: u, password: p }),
  login:    (u, p)  => api.req('POST', '/api/auth/login',    { username: u, password: p }),
  voices:   ()      => api.req('GET',  '/api/voices'),
  createVoice: (name, source) => api.req('POST', '/api/voices', { name, source }),
  deleteVoice: (id) => api.req('DELETE', `/api/voices/${id}`),
  sentences: (id, mode) => api.req('GET', `/api/voices/${id}/sentences?mode=${mode}`),
  addSample: (id, blob) => {
    const fd = new FormData();
    fd.append('audio', blob, 'recording.webm');
    return api.req('POST', `/api/voices/${id}/samples`, fd, true);
  },
  uploadAudio: (id, file) => {
    const fd = new FormData();
    fd.append('audio', file, file.name);
    return api.req('POST', `/api/voices/${id}/upload`, fd, true);
  },
  youtubeAudio: (id, url)  => api.req('POST', `/api/voices/${id}/youtube`, { url }),
  synthesize:   (id, text) => api.req('POST', `/api/voices/${id}/synthesize`, { text }),
  status: () => api.req('GET', '/api/status'),
};

/* ── View router ───────────────────────────────────────────────────────────── */
function show(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(viewId);
  if (el) el.classList.add('active');
}

/* ── Toast ─────────────────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ── Auth ──────────────────────────────────────────────────────────────────── */
function initAuth() {
  const tabs      = document.querySelectorAll('.tab');
  const form      = document.getElementById('form-auth');
  const submitBtn = document.getElementById('auth-submit');
  const errEl     = document.getElementById('auth-error');
  let   mode      = 'login';

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      mode = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === mode));
      submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      errEl.classList.add('hidden');
    });
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';

    try {
      const res = mode === 'login'
        ? await api.login(username, password)
        : await api.register(username, password);
      S.token    = res.token;
      S.username = res.username;
      localStorage.setItem('vs_token',    S.token);
      localStorage.setItem('vs_username', S.username);
      initDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    }
  });
}

/* ── Dashboard ─────────────────────────────────────────────────────────────── */
async function initDashboard() {
  show('view-dashboard');
  document.getElementById('header-username').textContent = S.username;

  document.getElementById('btn-logout').onclick = () => {
    localStorage.clear();
    S.token = S.username = null;
    show('view-auth');
  };

  await refreshDashboard();
  pollTTSStatus();
}

async function refreshDashboard() {
  const grid = document.getElementById('voice-grid');
  grid.innerHTML = '';
  try {
    const voices = await api.voices();
    voices.forEach(v => grid.appendChild(buildVoiceCard(v)));
  } catch (e) {
    toast('Could not load voices.');
  }
  grid.appendChild(buildNewCard());
}

function buildVoiceCard(voice) {
  const card = document.createElement('div');
  card.className = 'voice-card';

  const srcIcon = {
    microphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
    </svg>`,
    upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>`,
    youtube: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
      <polyline points="17 2 12 7 7 2"/>
    </svg>`,
  }[voice.source] || '';

  const dur = fmtDuration(voice.total_duration);
  const statusText = voice.ready ? 'Ready' : 'No samples yet';
  const statusCls  = voice.ready ? 'ready' : 'pending';

  card.innerHTML = `
    <div class="voice-card-icon">${srcIcon}</div>
    <div class="voice-card-name">${esc(voice.name)}</div>
    <div class="voice-card-meta">
      <span>${dur}</span>
      <span>·</span>
      <span>${voice.sample_count} sample${voice.sample_count !== 1 ? 's' : ''}</span>
    </div>
    <div class="voice-card-status ${statusCls}">${statusText}</div>
    <button class="voice-card-del" title="Delete voice" data-id="${voice.id}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/>
      </svg>
    </button>
  `;

  card.querySelector('.voice-card-del').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`Delete "${voice.name}"?`)) return;
    try {
      await api.deleteVoice(voice.id);
      toast('Voice deleted.');
      refreshDashboard();
    } catch (err) {
      toast(err.message);
    }
  });

  card.addEventListener('click', () => {
    if (voice.ready) {
      openSpeak(voice);
    } else {
      openTrain(voice, 'initial');
    }
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
  card.addEventListener('click', () => openCreateModal());
  return card;
}

/* ── TTS status polling ─────────────────────────────────────────────────────── */
async function pollTTSStatus() {
  const chip = document.getElementById('tts-status');
  try {
    const s = await api.status();
    chip.classList.remove('hidden', 'loading', 'ready', 'error');
    if (s.any_configured) {
      const names = s.providers.join(', ');
      chip.textContent = `APIs: ${names}`;
      chip.classList.add('ready');
    } else {
      chip.textContent = 'No API keys configured — see .env';
      chip.classList.add('error');
    }
  } catch {
    chip.classList.add('hidden');
  }
}

/* ── Create voice modal ────────────────────────────────────────────────────── */
let selectedSource = 'microphone';

function openCreateModal() {
  selectedSource = 'microphone';
  document.getElementById('new-voice-name').value = '';
  document.getElementById('yt-url').value = '';
  document.getElementById('create-error').classList.add('hidden');
  document.getElementById('panel-upload').classList.add('hidden');
  document.getElementById('panel-youtube').classList.add('hidden');
  document.querySelectorAll('.source-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.source === 'microphone');
  });
  document.getElementById('modal-create').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-voice-name').focus(), 50);
}

function closeCreateModal() {
  document.getElementById('modal-create').classList.add('hidden');
}

function initCreateModal() {
  document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedSource = btn.dataset.source;
      document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-upload').classList.toggle('hidden', selectedSource !== 'upload');
      document.getElementById('panel-youtube').classList.toggle('hidden', selectedSource !== 'youtube');
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

    if (!name) {
      errEl.textContent = 'Please give your voice a name.';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('btn-create-confirm');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    try {
      const voice = await api.createVoice(name, selectedSource);
      closeCreateModal();

      if (selectedSource === 'upload') {
        const file = document.getElementById('upload-file-input').files[0];
        if (file) {
          toast('Uploading and processing audio…');
          try {
            await api.uploadAudio(voice.id, file);
            toast('Audio uploaded. Voice ready.');
          } catch (err) {
            toast(`Upload error: ${err.message}`);
          }
          await refreshDashboard();
          openSpeak(voice);
          return;
        }
      } else if (selectedSource === 'youtube') {
        const url = document.getElementById('yt-url').value.trim();
        if (url) {
          toast('Downloading from YouTube… this may take a moment.');
          try {
            const res = await api.youtubeAudio(voice.id, url);
            voice.sample_count   = res.sample_count;
            voice.total_duration = res.total_duration;
            voice.ready = true;
            toast('YouTube audio imported. Voice ready.');
          } catch (err) {
            toast(`YouTube error: ${err.message}`);
          }
          await refreshDashboard();
          openSpeak(voice);
          return;
        }
      }

      await refreshDashboard();
      openTrain(voice, 'initial');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create & Train';
    }
  });
}

/* ── Training view ─────────────────────────────────────────────────────────── */
async function openTrain(voice, mode) {
  S.voice     = voice;
  S.trainMode = mode;

  document.getElementById('train-voice-name').textContent = voice.name;
  document.getElementById('train-mode-label').textContent =
    mode === 'initial' ? 'Quick Training' : 'Extended Training';

  // Show/hide "Done improving" button for extended mode
  document.getElementById('btn-train-done').classList.toggle('hidden', mode === 'initial');

  // Reset UI
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

  document.getElementById('btn-start-train').onclick = () => {
    startTrainSession();
  };
}

async function startTrainSession() {
  const mode = S.trainMode;
  document.getElementById('train-intro').classList.add('hidden');
  document.getElementById('train-session').classList.remove('hidden');
  document.getElementById('train-complete').classList.add('hidden');

  try {
    const res = await api.sentences(S.voice.id, mode);
    S.sentences   = res.sentences;
    S.sentenceIdx = 0;
  } catch {
    toast('Could not load sentences.');
    return;
  }

  showSentence();
  initWaveform();

  document.getElementById('btn-skip').onclick = () => {
    stopRecording(false);
    nextSentence(false);
  };

  document.getElementById('btn-record').onclick = () => {
    if (S.isRecording) {
      stopRecording(true);
    } else {
      startRecording();
    }
  };
}

function showSentence() {
  const total = S.trainMode === 'initial' ? S.sentences.length : null;
  const idx   = S.sentenceIdx;

  document.getElementById('train-sentence').textContent = S.sentences[idx] || '';

  if (total !== null) {
    document.getElementById('train-counter').textContent = `Sentence ${idx + 1} of ${total}`;
    document.getElementById('train-progress').style.width = `${((idx) / total) * 100}%`;
  } else {
    document.getElementById('train-counter').textContent = `Sample ${idx + 1}`;
    document.getElementById('train-progress').style.width = '100%';
  }

  updateQualityBadge();

  const btn   = document.getElementById('btn-record');
  const label = document.getElementById('record-label');
  btn.classList.remove('recording');
  label.textContent = 'Press to record';
}

function updateQualityBadge() {
  const dur  = S.voice?.total_duration || 0;
  const el   = document.getElementById('train-quality');
  if (dur === 0)          { el.className = 'quality-badge q0'; el.textContent = ''; }
  else if (dur < 30)      { el.className = 'quality-badge q1'; el.textContent = 'Getting started'; }
  else if (dur < 120)     { el.className = 'quality-badge q2'; el.textContent = 'Good quality'; }
  else if (dur < 300)     { el.className = 'quality-badge q2'; el.textContent = 'Great quality'; }
  else                    { el.className = 'quality-badge q3'; el.textContent = 'Excellent quality'; }
}

function nextSentence(recorded) {
  S.sentenceIdx++;

  if (S.trainMode === 'initial' && S.sentenceIdx >= S.sentences.length) {
    finishTraining();
    return;
  }

  // For extended mode, if we run out, shuffle and restart the pool
  if (S.sentenceIdx >= S.sentences.length) {
    const pool = [...S.sentences];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    S.sentences   = pool;
    S.sentenceIdx = 0;
  }

  showSentence();
}

function finishTraining() {
  stopWaveform();
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }

  document.getElementById('train-session').classList.add('hidden');
  document.getElementById('train-complete').classList.remove('hidden');

  const dur = S.voice?.total_duration || 0;
  document.getElementById('train-complete-sub').textContent =
    `${fmtDuration(dur)} of voice audio collected across ${S.voice?.sample_count || 0} samples.`;

  document.getElementById('btn-go-speak').onclick = () => openSpeak(S.voice);
  document.getElementById('btn-continue-from-complete').onclick = () => {
    S.voice.ready = true;
    openTrain(S.voice, 'extended');
  };
}

/* ── Audio recording ────────────────────────────────────────────────────────── */
async function startRecording() {
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    toast('Microphone access denied. Please allow microphone use.');
    return;
  }

  S.audioChunks  = [];
  S.isRecording  = true;

  // Connect analyser
  if (!S.audioCtx) {
    S.audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    S.analyser  = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 512;
  }
  const src = S.audioCtx.createMediaStreamSource(S.stream);
  src.connect(S.analyser);
  drawWaveform();

  // Preferred codec for wider compatibility
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
      ? 'audio/ogg;codecs=opus'
      : '';

  S.mediaRecorder = new MediaRecorder(S.stream, mimeType ? { mimeType } : {});
  S.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) S.audioChunks.push(e.data); };
  S.mediaRecorder.onstop = () => submitRecording();
  S.mediaRecorder.start();

  const btn   = document.getElementById('btn-record');
  const label = document.getElementById('record-label');
  btn.classList.add('recording');
  label.textContent = 'Recording — press to stop';
}

async function stopRecording(andSubmit) {
  if (!S.isRecording) return;
  S.isRecording = false;

  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    if (!andSubmit) {
      S.mediaRecorder.onstop = null; // don't submit
    }
    S.mediaRecorder.stop();
  }

  if (S.stream) {
    S.stream.getTracks().forEach(t => t.stop());
    S.stream = null;
  }

  stopWaveform();
}

async function submitRecording() {
  const blob = new Blob(S.audioChunks, { type: 'audio/webm' });
  if (blob.size < 1000) {
    toast('Recording too short — please try again.');
    showSentence();
    return;
  }

  const btn = document.getElementById('btn-record');
  btn.disabled = true;

  try {
    const res = await api.addSample(S.voice.id, blob);
    S.voice.sample_count   = res.sample_count;
    S.voice.total_duration = res.total_duration;
    S.voice.ready = true;
    nextSentence(true);
  } catch (err) {
    toast(`Upload error: ${err.message}`);
    showSentence();
  } finally {
    btn.disabled = false;
  }
}

/* ── Waveform ────────────────────────────────────────────────────────────────── */
function initWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const W      = canvas.width;
  const H      = canvas.height;

  function draw() {
    S.animFrame = requestAnimationFrame(draw);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, W, H);

    if (!S.analyser) {
      // flat line when idle
      ctx.strokeStyle = '#252525';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      return;
    }

    const bufLen = S.analyser.frequencyBinCount;
    const data   = new Uint8Array(bufLen);
    S.analyser.getByteTimeDomainData(data);

    const color = S.isRecording ? '#ff4d4d' : '#333333';
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();

    const sliceW = W / bufLen;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 128.0;
      const y = (v * H) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
      x += sliceW;
    }
    ctx.lineTo(W, H / 2);
    ctx.stroke();
  }

  stopWaveform();
  draw();
}

function stopWaveform() {
  if (S.animFrame) {
    cancelAnimationFrame(S.animFrame);
    S.animFrame = null;
  }
}

/* ── Speak view ─────────────────────────────────────────────────────────────── */
function openSpeak(voice) {
  S.voice = voice;
  S.generatedURL = null;

  document.getElementById('speak-voice-name').textContent  = voice.name;
  document.getElementById('speak-voice-stats').textContent =
    `${fmtDuration(voice.total_duration)} · ${voice.sample_count} sample${voice.sample_count !== 1 ? 's' : ''}`;

  document.getElementById('speak-text').value = '';
  document.getElementById('char-count').textContent = '0 / 1500';
  document.getElementById('audio-section').classList.add('hidden');
  document.getElementById('speak-error').classList.add('hidden');

  show('view-speak');

  document.getElementById('speak-back').onclick = () => {
    refreshDashboard();
    show('view-dashboard');
  };

  document.getElementById('btn-continue-training').onclick = () => {
    openTrain(voice, 'extended');
  };

  const textarea = document.getElementById('speak-text');
  textarea.addEventListener('input', () => {
    document.getElementById('char-count').textContent = `${textarea.value.length} / 1500`;
  });

  document.getElementById('btn-generate').onclick = generateSpeech;
}

async function generateSpeech() {
  const text  = document.getElementById('speak-text').value.trim();
  const errEl = document.getElementById('speak-error');
  errEl.classList.add('hidden');

  if (!text) {
    errEl.textContent = 'Please enter some text first.';
    errEl.classList.remove('hidden');
    return;
  }

  const btn     = document.getElementById('btn-generate');
  const label   = document.getElementById('generate-label');
  const spinner = document.getElementById('generate-spinner');
  btn.disabled     = true;
  label.textContent = 'Generating…';
  spinner.classList.remove('hidden');

  document.getElementById('audio-section').classList.add('hidden');

  try {
    const blob = await api.synthesize(S.voice.id, text);
    if (S.generatedURL) URL.revokeObjectURL(S.generatedURL);
    S.generatedMime = blob.type || 'audio/mpeg';
    S.generatedURL  = URL.createObjectURL(blob);

    const player = document.getElementById('audio-player');
    player.src = S.generatedURL;
    player.load();

    document.getElementById('audio-section').classList.remove('hidden');
    player.play().catch(() => {});

    document.getElementById('btn-download').onclick = () => {
      const ext = S.generatedMime.includes('mpeg') ? 'mp3' : 'wav';
      const a   = document.createElement('a');
      a.href     = S.generatedURL;
      a.download = `${S.voice.name.replace(/\s+/g, '_')}_speech.${ext}`;
      a.click();
    };
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled      = false;
    label.textContent = 'Generate Speech';
    spinner.classList.add('hidden');
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────────── */
function fmtDuration(s) {
  if (!s || s === 0) return '0s';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Boot ───────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initCreateModal();
  initAuth();

  // Restore session
  const token    = localStorage.getItem('vs_token');
  const username = localStorage.getItem('vs_username');
  if (token && username) {
    S.token    = token;
    S.username = username;
    initDashboard();
  } else {
    show('view-auth');
  }
});
