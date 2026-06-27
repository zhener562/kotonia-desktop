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

async function speakIris(text) {
  if (!voiceEnabled || !ttsAudioCtx) return;
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  try {
    const streamId = await invoke('tts_speak', { text: trimmed });
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
