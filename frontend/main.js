// kotonia desktop — vanilla JS shell over Tauri 2 IPC.
//
// Tauri 2 with `withGlobalTauri: true` exposes:
//   window.__TAURI__.core.invoke(cmd, args)
//   window.__TAURI__.event.listen(name, handler)
//
// Backend commands (see src-tauri/src/commands.rs):
//   auth_status() → { logged_in, server, device_id_prefix }
//   new_session() → "<session_id>"
//   submit_task({ prompt, sessionId, model }) → { task_id, session_id }
//   respond_approval({ approvalId, approved }) → void
//   open_login_help() → void
//
// Backend events:
//   "agent_event"      payload: { task_id, event: WireEvent }
//   "approval_request" payload: { approval_id, task_id, command, reason }

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const logEl = document.getElementById('log');
const promptForm = document.getElementById('prompt-form');
const promptInput = document.getElementById('prompt-input');
const promptSubmit = document.getElementById('prompt-submit');
const authStatusEl = document.getElementById('auth-status');
const sessionLabelEl = document.getElementById('session-label');
const btnNewSession = document.getElementById('btn-new-session');
const btnClearLog = document.getElementById('btn-clear-log');
const btnToggleVoice = document.getElementById('btn-toggle-voice');
const btnMic = document.getElementById('btn-mic');
const btnMicIcon = document.getElementById('btn-mic-icon');
const btnMicLabel = document.getElementById('btn-mic-label');
const btnTogglePreview = document.getElementById('btn-toggle-preview');
const approvalModal = document.getElementById('approval-modal');
const approvalReason = document.getElementById('approval-reason');
const approvalCommand = document.getElementById('approval-command');
const approvalApprove = document.getElementById('approval-approve');
const approvalDeny = document.getElementById('approval-deny');
const previewPane = document.getElementById('preview-pane');
const previewIframe = document.getElementById('preview-iframe');
const previewPath = document.getElementById('preview-path');
const previewRefresh = document.getElementById('preview-refresh');
const previewOpenExternal = document.getElementById('preview-open-external');
const previewClose = document.getElementById('preview-close');
const previewError = document.getElementById('preview-error');
const previewErrorMsg = document.getElementById('preview-error-msg');

let sessionId = null;
let pendingApprovalId = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Matches absolute (/foo), home (~/foo), and explicit relative (./foo, ../foo)
// paths. The lookbehind blocks matches preceded by a letter/digit/underscore
// (unicode-aware), `:`, `/`, or `.` so URLs (`https://...`), email addresses,
// numeric ratios (`2.5/3`), and mid-path slashes don't get linkified.
// The body is "anything not whitespace or quoting/bracket-ish" so CJK
// directory names (`~/ドキュメント/...`) survive — purely ASCII regex would
// truncate at the first non-ASCII byte.
const PATH_RE =
  /(?<![\p{L}\p{N}_:/.])(?:~\/|\.{1,2}\/|\/)[^\s'"`<>()\\[\]{}]+/gu;

// Trailing sentence/code punctuation that's almost certainly NOT part of the
// path itself. Stripped from the linked region, then re-appended outside.
const TRAILING_PUNCT_RE = /[.,:;)\]'"`]+$/;

function linkifyPaths(text) {
  const parts = [];
  let lastIndex = 0;
  let m;
  // Reset state in case the global regex was previously stepped.
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    parts.push(escapeHtml(text.slice(lastIndex, m.index)));

    let core = m[0];
    let tail = '';
    const trail = core.match(TRAILING_PUNCT_RE);
    if (trail) {
      core = core.slice(0, -trail[0].length);
      tail = trail[0];
    }

    // Single-char results like a bare `/` aren't useful to linkify.
    if (core.length >= 2) {
      const isPlayable = /\.html?$/i.test(core);
      const link =
        `<a href="#" class="path-link" data-path="${escapeAttr(core)}"` +
        ` title="Ctrl+クリック (macOS は Cmd) で OS の既定アプリで開く">` +
        `${escapeHtml(core)}</a>`;
      const playBtn = isPlayable
        ? `<button class="preview-link-btn" data-preview-path="${escapeAttr(core)}"` +
          ` title="右ペインのプレビューで開く (HTML)">▶ play</button>`
        : '';
      parts.push(link + playBtn + escapeHtml(tail));
    } else {
      parts.push(escapeHtml(m[0]));
    }

    lastIndex = m.index + m[0].length;
  }
  parts.push(escapeHtml(text.slice(lastIndex)));
  return parts.join('');
}

// kinds whose body is agent-generated text that commonly contains paths.
// System messages, slash-command echoes, errors, etc. stay plain-escaped.
const PATH_LINK_KINDS = new Set(['obs', 'final', 'bash']);

function appendLog(kind, body) {
  const line = document.createElement('div');
  line.className = `log-line log-${kind}`;
  const ts = new Date().toISOString().slice(11, 19);
  const bodyHtml = PATH_LINK_KINDS.has(kind)
    ? linkifyPaths(body)
    : escapeHtml(body);
  line.innerHTML =
    `<span class="ts">${ts}</span>` +
    `<pre class="body">${bodyHtml}</pre>`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setSessionLabel() {
  if (sessionId) {
    sessionLabelEl.textContent = `session: ${sessionId.slice(0, 12)}…`;
  } else {
    sessionLabelEl.textContent = 'session: —';
  }
}

async function ensureSession() {
  if (!sessionId) {
    sessionId = await invoke('new_session');
    setSessionLabel();
    appendLog('session-new', `── new session ${sessionId.slice(0, 8)} ──`);
  }
  return sessionId;
}

async function startNewSession() {
  sessionId = await invoke('new_session');
  setSessionLabel();
  appendLog('session-new', `── new session ${sessionId.slice(0, 8)} ──`);
}

async function loadPersona() {
  try {
    const info = await invoke('persona_info');
    const avatar = document.getElementById('persona-avatar');
    const name = document.getElementById('persona-name');
    const tagline = document.getElementById('persona-tagline');
    if (avatar && info.avatar_url) {
      avatar.src = info.avatar_url;
      avatar.alt = info.display_name ?? '';
    }
    if (name) name.textContent = info.display_name ?? '';
    if (tagline) tagline.textContent = info.tagline ?? '';
    if (info.display_name) {
      document.title = info.display_name + ' · kotonia';
    }
  } catch (e) {
    // Persona is decorative — don't block startup if the call fails.
    console.error('persona_info failed', e);
  }
}

async function refreshAuth() {
  try {
    const status = await invoke('auth_status');
    if (status.logged_in) {
      const dev = status.device_id_prefix ?? '';
      authStatusEl.textContent = `${status.server ?? 'kotonia.ai'}  ·  device ${dev}…`;
      authStatusEl.className = 'auth-status authed';
    } else {
      authStatusEl.innerHTML =
        '未ログイン: ターミナルで <code>kotonia-cli login</code> を実行してください';
      authStatusEl.className = 'auth-status unauthed';
    }
  } catch (e) {
    authStatusEl.textContent = 'auth check failed: ' + String(e);
    authStatusEl.className = 'auth-status unauthed';
  }
}

function showApproval(req) {
  pendingApprovalId = req.approval_id;
  approvalReason.textContent = req.reason || '';
  approvalCommand.textContent = req.command || '';
  approvalModal.classList.remove('hidden');
}

async function respondApproval(approved) {
  if (!pendingApprovalId) return;
  const approvalId = pendingApprovalId;
  pendingApprovalId = null;
  approvalModal.classList.add('hidden');
  try {
    await invoke('respond_approval', { approvalId, approved });
    appendLog('info', `${approved ? 'approved' : 'denied'} [${approvalId.slice(0, 8)}]`);
  } catch (e) {
    appendLog('error', 'approval respond failed: ' + String(e));
  }
}

async function submitTask() {
  const raw = promptInput.value;
  const prompt = raw.trim();
  if (!prompt) return;

  // Local-only slash commands.
  if (prompt === '/new') {
    promptInput.value = '';
    await startNewSession();
    return;
  }
  if (prompt === '/clear') {
    promptInput.value = '';
    logEl.innerHTML = '';
    return;
  }
  if (prompt === '/help') {
    promptInput.value = '';
    appendLog(
      'info',
      [
        '/help                   このヘルプ',
        '/new                    新しいセッション (履歴クリア)',
        '/clear                  画面ログをクリア',
        'それ以外                エージェントにタスクとして送る',
      ].join('\n'),
    );
    return;
  }

  const sid = await ensureSession();
  promptSubmit.disabled = true;
  try {
    const res = await invoke('submit_task', {
      prompt,
      sessionId: sid,
      model: null,
    });
    appendLog(
      'task-submit',
      `▶ task ${res.task_id.slice(0, 8)} (session ${res.session_id.slice(0, 8)})\n${prompt}`,
    );
    promptInput.value = '';
  } catch (e) {
    appendLog('submit-error', String(e));
  } finally {
    promptSubmit.disabled = false;
    promptInput.focus();
  }
}

// Enter to submit, Shift+Enter for newline.
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitTask();
  }
});

promptForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitTask();
});

btnNewSession.addEventListener('click', startNewSession);
btnClearLog.addEventListener('click', () => {
  logEl.innerHTML = '';
});

// ── TTS playback (Iris voice) ────────────────────────────────────────
// Toggle is OFF by default — autoplay policies in WebKit refuse to
// schedule audio until a user gesture creates / resumes an
// AudioContext. The toggle click doubles as that gesture.

let voiceEnabled = false;
let ttsAudioCtx = null;
let ttsNextStartTime = 0;
let ttsActiveStreamId = null;

function setVoiceEnabled(enabled) {
  voiceEnabled = enabled;
  btnToggleVoice.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btnToggleVoice.textContent = enabled ? '🔊 voice' : '🔇 voice';
  if (enabled) {
    // Lazily create the AudioContext inside the user gesture so
    // browsers don't block it. Resume if it was suspended after a
    // previous toggle-off.
    if (!ttsAudioCtx) {
      try {
        ttsAudioCtx = new AudioContext();
      } catch (e) {
        appendLog('error', 'AudioContext unavailable: ' + String(e));
        voiceEnabled = false;
        return;
      }
    }
    if (ttsAudioCtx.state === 'suspended') ttsAudioCtx.resume();
    ttsNextStartTime = ttsAudioCtx.currentTime;
  } else {
    if (ttsAudioCtx && ttsAudioCtx.state === 'running') {
      ttsAudioCtx.suspend().catch(() => {});
    }
    // Drop the active stream so any in-flight chunks from the backend
    // are ignored even if the toggle flips back on quickly.
    ttsActiveStreamId = null;
  }
}

btnToggleVoice.addEventListener('click', () => setVoiceEnabled(!voiceEnabled));

// TTS-direction text cleanup. The displayed log keeps the full
// original answer (with code blocks, paths, etc.) — these filters
// only apply to what gets handed to the synthesizer, because reading
// a 500-line HTML file or "スラッシュ ホーム スラッシュ ゼヘナ
// スラッシュ ドット コトニア スラッシュ デスクトップ スラッシュ
// ワークスペース スラッシュ シューティング ゲーム ドット エイチ
// ティー エム エル" out loud is a UX disaster.
//
// Same regex as `linkifyPaths` — keep them in sync.
const PATH_RE_FOR_SPEECH =
  /(?<![\p{L}\p{N}_:/.])(?:~\/|\.{1,2}\/|\/)[^\s'"`<>()\\[\]{}]+/gu;
const TRAILING_PUNCT_FOR_SPEECH = /[.,:;)\]'"`]+$/;

// URL detection. Run *before* the path filter so a URL's `/foo/bar`
// tail doesn't get caught by the path regex first. The host (incl. port
// — `localhost:8000` is meaningful) is kept; everything after the next
// `/`, `?`, or `#` is dropped.
const URL_RE_FOR_SPEECH = /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>()\\[\]{}]+/giu;
function extractSpeakableHost(url) {
  const m = url.match(/^[a-z]+:\/\/([^/?#]+)/i);
  return m ? m[1] : url;
}

function preprocessForSpeech(text) {
  // 1. Drop fenced code blocks entirely. Keep a brief mention so the
  //    user hears that *something* was emitted.
  let cleaned = text.replace(/```(\w+)?\n?[\s\S]*?```/g, (_, lang) => {
    return lang ? `(${lang} コードブロックは省略)` : '(コードブロックは省略)';
  });

  // 1.5. Collapse URLs to their host. Must run before the path filter
  //      so the URL's `/foo/bar` tail isn't treated as a separate path.
  //      `https://github.com/zhener562/kotonia` → `github.com`,
  //      `http://localhost:8000/api/v1/...` → `localhost:8000`.
  cleaned = cleaned.replace(URL_RE_FOR_SPEECH, (match) => {
    const trail = match.match(TRAILING_PUNCT_FOR_SPEECH);
    const core = trail ? match.slice(0, -trail[0].length) : match;
    const tail = trail ? trail[0] : '';
    return extractSpeakableHost(core) + tail;
  });

  // 2. Collapse absolute / home / relative path tokens to their basename.
  //    `/home/.../foo.html` → `foo.html`, `~/.kotonia/x.txt` → `x.txt`,
  //    `./output/y.json` → `y.json`. Trailing sentence punctuation stays
  //    outside the basename (`foo.html、` → `foo.html` + `、`).
  cleaned = cleaned.replace(PATH_RE_FOR_SPEECH, (match) => {
    const trail = match.match(TRAILING_PUNCT_FOR_SPEECH);
    const core = trail ? match.slice(0, -trail[0].length) : match;
    const tail = trail ? trail[0] : '';
    const segments = core.split('/').filter((s) => s.length > 0);
    const basename = segments.pop();
    // Fall back to the original token if there's nothing to read
    // (a lone `/` or `~/`); cleaner than emitting an empty string.
    return (basename && basename.length > 0 ? basename : core) + tail;
  });

  // 3. Hard cap on overall spoken length. Trim at the last sentence
  //    boundary so the spoken version doesn't end mid-word.
  cleaned = cleaned.trim();
  if (cleaned.length > 1000) {
    const head = cleaned.slice(0, 1000);
    const lastStop = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('. '),
      head.lastIndexOf('\n'),
    );
    cleaned = (lastStop > 200 ? head.slice(0, lastStop + 1) : head) +
      ' (続きは画面で)';
  }
  return cleaned;
}

async function speakIris(text) {
  if (!voiceEnabled || !ttsAudioCtx) return;
  const speakable = preprocessForSpeech(text || '');
  if (!speakable) return;
  try {
    const streamId = await invoke('tts_speak', { text: speakable });
    // The latest call wins — older streams' chunks will be filtered
    // out by the stream_id check in the tts_chunk handler.
    ttsActiveStreamId = streamId;
    // Reset the playback head so the new utterance starts immediately
    // rather than queueing behind a previous (now-stale) stream that
    // had advanced ttsNextStartTime into the future.
    ttsNextStartTime = ttsAudioCtx.currentTime;
  } catch (e) {
    appendLog('error', 'TTS: ' + String(e));
  }
}

listen('tts_chunk', async (msg) => {
  const payload = msg.payload;
  if (!payload || payload.stream_id !== ttsActiveStreamId) return;
  if (!ttsAudioCtx || ttsAudioCtx.state !== 'running') return;
  try {
    // base64 → ArrayBuffer. atob + Uint8Array.from is the most
    // compatible route; the browser-native atob handles big strings
    // (~50KB / WAV chunk) just fine.
    const bin = atob(payload.wav_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // decodeAudioData mutates / detaches the buffer, so clone if you
    // need it after this call. We don't.
    const audioBuffer = await ttsAudioCtx.decodeAudioData(bytes.buffer);
    const source = ttsAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ttsAudioCtx.destination);
    const startAt = Math.max(ttsNextStartTime, ttsAudioCtx.currentTime + 0.01);
    source.start(startAt);
    ttsNextStartTime = startAt + audioBuffer.duration;
  } catch (e) {
    console.error('tts chunk decode/play failed', e);
  }
});

listen('tts_error', (msg) => {
  if (msg.payload?.stream_id !== ttsActiveStreamId) return;
  appendLog('error', `TTS: ${msg.payload?.message ?? 'unknown error'}`);
});

listen('tts_done', (msg) => {
  if (msg.payload?.stream_id !== ttsActiveStreamId) return;
  // No-op for now. Future: emit a 'finished talking' UI state.
});

// ── Mic capture → STT → prompt textarea (dictation mode) ─────────────
// Click 🎙️ to start, click again or Esc to stop. The transcript is
// dropped into the prompt textarea so the user can review / edit it
// before sending — agent execution is high-stakes (bash on the user's
// PC), so we deliberately do NOT auto-submit on transcription. No VAD
// either: the user controls when to stop.

let micState = 'idle'; // 'idle' | 'recording' | 'transcribing'
let micStream = null;
let micAudioCtx = null;
let micProcessor = null;
let micSource = null;
let micSamples = []; // Float32Array chunks, concat on stop
let micSampleRate = 16000;
let micStartedAt = 0;
let micElapsedTimer = null;

function setMicState(state) {
  micState = state;
  if (state === 'idle') {
    btnMic.removeAttribute('data-state');
    btnMicIcon.textContent = '🎙️';
    btnMicLabel.textContent = ' mic';
    btnMic.disabled = false;
  } else if (state === 'recording') {
    btnMic.setAttribute('data-state', 'recording');
    btnMicIcon.textContent = '🔴';
    btnMicLabel.textContent = ' 0.0s';
    btnMic.disabled = false;
  } else if (state === 'transcribing') {
    btnMic.setAttribute('data-state', 'transcribing');
    btnMicIcon.textContent = '⏳';
    btnMicLabel.textContent = ' …';
    btnMic.disabled = true;
  }
}

function tickElapsed() {
  if (micState !== 'recording') return;
  const sec = (Date.now() - micStartedAt) / 1000;
  // Update only the label span — never touch the button element itself.
  // WebKitGTK appears to drop the occasional click on a button whose
  // own textContent is being replaced on a 100ms tick (click hit-test
  // race during DOM mutation). Isolating the high-frequency mutation
  // into a child node resolves the "stop button only works on the
  // Nth try" symptom we saw.
  btnMicLabel.textContent = ` ${sec.toFixed(1)}s`;
}

async function startMic() {
  if (micState !== 'idle') return;
  try {
    // Request 16 kHz to match Whisper / Qwen3-ASR's native rate and
    // sidestep the JS-side resampling that downsampling 48 kHz would
    // require. Browsers may ignore the requested rate; we honor
    // whatever ctx.sampleRate ends up at in the WAV header.
    micAudioCtx = new AudioContext({ sampleRate: 16000 });
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micSource = micAudioCtx.createMediaStreamSource(micStream);
    // ScriptProcessorNode is deprecated but works everywhere. Migrate
    // to AudioWorkletNode if WebKitGTK starts logging warnings.
    micProcessor = micAudioCtx.createScriptProcessor(4096, 1, 1);
    micProcessor.onaudioprocess = (e) => {
      // Clone the channel data — the buffer is recycled on the next
      // tick, so a slice() (not just reference) is required.
      micSamples.push(e.inputBuffer.getChannelData(0).slice());
    };
    micSource.connect(micProcessor);
    // ScriptProcessorNode needs to be connected to destination to fire
    // onaudioprocess in some browsers. We mute the output by relying on
    // the WebView's silent processor path.
    micProcessor.connect(micAudioCtx.destination);
    micSampleRate = micAudioCtx.sampleRate;
    micSamples = [];
    micStartedAt = Date.now();
    setMicState('recording');
    micElapsedTimer = setInterval(tickElapsed, 100);
  } catch (e) {
    appendLog('error', `mic 起動失敗: ${String(e?.message ?? e)}`);
    await cleanupMic();
    setMicState('idle');
  }
}

async function cleanupMic() {
  if (micElapsedTimer) {
    clearInterval(micElapsedTimer);
    micElapsedTimer = null;
  }
  if (micProcessor) {
    try { micProcessor.disconnect(); } catch {}
    micProcessor.onaudioprocess = null;
    micProcessor = null;
  }
  if (micSource) {
    try { micSource.disconnect(); } catch {}
    micSource = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (micAudioCtx) {
    try { await micAudioCtx.close(); } catch {}
    micAudioCtx = null;
  }
}

function concatSamples(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function float32ToWav(samples, sampleRate) {
  // Standard 16-bit PCM mono WAV. 44-byte header + samples*2 bytes.
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM fmt chunk size
  view.setUint16(20, 1, true);           // format = PCM
  view.setUint16(22, 1, true);           // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (rate * channels * 2)
  view.setUint16(32, 2, true);           // block align (channels * 2)
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buf);
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function stopMicAndTranscribe() {
  if (micState !== 'recording') return;
  // Flip state BEFORE awaiting cleanup so a second click that lands
  // during the (slow) `AudioContext.close()` await can't re-enter and
  // double-trigger this whole pipeline.
  const chunks = micSamples;
  const rate = micSampleRate;
  setMicState('transcribing');
  await cleanupMic();

  try {
    const samples = concatSamples(chunks);
    if (samples.length < rate * 0.2) {
      // <200ms — almost certainly accidental press; don't bother the
      // STT server. Reset and bail.
      setMicState('idle');
      appendLog('info', '録音が短すぎました (< 200ms)、転写を skip');
      return;
    }
    const wav = float32ToWav(samples, rate);
    const wavBase64 = bytesToBase64(wav);
    const result = await invoke('stt_transcribe', { wavBase64 });
    const text = (result?.text ?? '').trim();
    if (!text) {
      appendLog('info', '転写が空でした (無音 / ハルシ抑止により破棄)');
      setMicState('idle');
      return;
    }
    // Append (not replace) so the user can stack multiple dictations
    // into a single prompt — speak a bit, think, speak more, edit,
    // then Enter. A space joins runs only when the existing value
    // doesn't already end with whitespace/newline.
    const existing = promptInput.value;
    const needsSep = existing.length > 0 && !/[\s]$/.test(existing);
    const newValue = existing + (needsSep ? ' ' : '') + text;
    promptInput.value = newValue;
    promptInput.focus();
    promptInput.setSelectionRange(newValue.length, newValue.length);
    appendLog('info', `📝 ${text}  (${result?.elapsed_ms ?? '?'}ms)`);
  } catch (e) {
    appendLog('error', `STT 失敗: ${String(e?.message ?? e)}`);
  } finally {
    setMicState('idle');
  }
}

async function cancelMic() {
  if (micState !== 'recording') return;
  await cleanupMic();
  setMicState('idle');
  appendLog('info', 'mic 録音をキャンセル');
}

btnMic.addEventListener('click', () => {
  if (micState === 'idle') startMic();
  else if (micState === 'recording') stopMicAndTranscribe();
  // transcribing: button disabled, no-op
});

// Esc cancels recording (discards audio entirely). Doesn't interfere
// with normal prompt typing because we only act when actually recording.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && micState === 'recording') {
    e.preventDefault();
    cancelMic();
  }
});

approvalApprove.addEventListener('click', () => respondApproval(true));
approvalDeny.addEventListener('click', () => respondApproval(false));

// Ctrl/Cmd+click on a detected path link opens it with the OS default app
// via the `open_path` Tauri command. Plain click is intentionally a no-op
// so users can still drag-select the path text for copy.
// ▶ play buttons next to .html / .htm paths load that file into the
// preview pane via the asset:// protocol (configured in tauri.conf.json).
logEl.addEventListener('click', async (e) => {
  const playBtn = e.target.closest && e.target.closest('.preview-link-btn');
  if (playBtn) {
    e.preventDefault();
    const path = playBtn.dataset.previewPath;
    if (path) openPreview(path);
    return;
  }
  const link = e.target.closest && e.target.closest('.path-link');
  if (!link) return;
  e.preventDefault();
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (!ctrlOrCmd) return;
  const path = link.dataset.path;
  if (!path) return;
  try {
    await invoke('open_path', { path });
  } catch (err) {
    appendLog('error', `open failed: ${String(err)}`);
  }
});

// ── Preview pane ─────────────────────────────────────────────────────
// State: the currently displayed path (for refresh / open-external),
// and whether the user has interacted with the pane at all (so the
// top-bar toggle button only appears once an HTML has been previewed,
// keeping the UI minimal for non-game sessions).

let currentPreviewPath = null;

async function openPreview(path) {
  previewPane.classList.remove('hidden');
  btnTogglePreview.hidden = false;
  btnTogglePreview.textContent = '◀ プレビュー';
  previewPath.textContent = path;
  previewPath.title = path;

  // Resolve through the Rust side so that:
  //   - `./foo.html` is anchored to the workspace cwd
  //   - missing file / scope-violation comes back as a clear error
  //   - silent asset:// 404s in the iframe are replaced with a real
  //     human-readable error overlay
  let resolved;
  try {
    resolved = await invoke('resolve_preview_path', { path });
  } catch (err) {
    currentPreviewPath = path;
    previewIframe.src = 'about:blank';
    previewIframe.classList.add('hidden');
    previewError.classList.remove('hidden');
    previewErrorMsg.textContent = String(err);
    return;
  }

  currentPreviewPath = resolved;
  previewPath.textContent = resolved;
  previewPath.title = resolved;
  previewError.classList.add('hidden');
  previewIframe.classList.remove('hidden');
  // Cache-bust suffix so re-opening the same path after a regen reloads
  // the file from disk instead of showing the WebView's cached copy.
  const url = convertFileSrc(resolved) + '#t=' + Date.now();
  previewIframe.src = url;
}

function closePreview() {
  previewPane.classList.add('hidden');
  // Drop the iframe src so a game with audio / animation stops eating
  // CPU while the pane is hidden. The path stays in `currentPreviewPath`
  // so the top-bar toggle can reopen the same content.
  previewIframe.src = 'about:blank';
  btnTogglePreview.textContent = '▶ プレビュー';
}

function togglePreview() {
  if (previewPane.classList.contains('hidden')) {
    if (currentPreviewPath) openPreview(currentPreviewPath);
  } else {
    closePreview();
  }
}

previewRefresh.addEventListener('click', () => {
  if (currentPreviewPath) openPreview(currentPreviewPath);
});

previewOpenExternal.addEventListener('click', async () => {
  if (!currentPreviewPath) return;
  try {
    await invoke('open_path', { path: currentPreviewPath });
  } catch (err) {
    appendLog('error', `open failed: ${String(err)}`);
  }
});

previewClose.addEventListener('click', closePreview);
btnTogglePreview.addEventListener('click', togglePreview);

// Render incoming agent events.
listen('agent_event', (msg) => {
  const ev = msg.payload?.event;
  if (!ev) return;
  switch (ev.kind) {
    case 'iteration_start':
      appendLog('iter', `── iter ${ev.iteration}/${ev.max} ──`);
      break;
    case 'llm_thinking':
      appendLog('thinking', '· thinking');
      break;
    case 'bash':
      appendLog('bash', `$ ${ev.command}`);
      break;
    case 'bash_skipped':
      appendLog('skipped', `[skipped: ${ev.reason}]  ${ev.command}`);
      break;
    case 'observation': {
      const header = ev.timed_out
        ? `[exit ${ev.exit_code} • TIMED OUT]`
        : ev.truncated
        ? `[exit ${ev.exit_code} • truncated]`
        : `[exit ${ev.exit_code}]`;
      appendLog('obs', `${header}\n${(ev.combined || '').trimEnd()}`);
      break;
    }
    case 'final':
      appendLog('final', `══ final ══\n${ev.answer}`);
      speakIris(ev.answer);
      break;
    case 'malformed':
      appendLog('malformed', `[malformed] ${ev.excerpt}`);
      break;
    case 'error':
      appendLog('error', `[error] ${ev.message}`);
      break;
    case 'done':
      appendLog(
        'done',
        `── done after ${ev.iterations} iter${ev.iterations === 1 ? '' : 's'} — ${
          ev.success ? '✓' : '✗'
        } ──`,
      );
      break;
    default:
      appendLog('info', `[unknown event] ${JSON.stringify(ev)}`);
  }
});

listen('approval_request', (msg) => {
  if (msg.payload) showApproval(msg.payload);
});

// Boot.
loadPersona();
refreshAuth();
setInterval(refreshAuth, 5000);
setSessionLabel();
