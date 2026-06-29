// kotonia desktop — vanilla JS shell over Tauri 2 IPC.
//
// Tauri 2 with `withGlobalTauri: true` exposes:
//   window.__TAURI__.core.invoke(cmd, args)
//   window.__TAURI__.event.listen(name, handler)
//
// Backend commands (see src-tauri/src/commands.rs):
//   auth_status() → { logged_in, server, device_id_prefix }
//   new_session() → "<session_id>"
//   submit_task({ prompt, sessionId, model, engine }) → { task_id, session_id }
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
const btnToggleAvatar = document.getElementById('btn-toggle-avatar');
const btnMic = document.getElementById('btn-mic');
const avatarFloating = document.getElementById('avatar-floating');
const avatarFrame = document.getElementById('avatar-frame');
const avatarResizeHandle = document.getElementById('avatar-resize-handle');
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
const engineSelect = document.getElementById('engine-select');
const btnWorkspace = document.getElementById('btn-workspace');
const workspacePathEl = document.getElementById('workspace-path');

let sessionId = null;
let pendingApprovalId = null;
// Task id currently running in the backend. Used to flip the submit
// button between "send" and "cancel" so the user can stop a runaway
// agent without restarting the app.
let activeTaskId = null;
// Engine the active sessionId was created with. Stays in sync with
// engineSelect.value when the user starts a new session; if they flip the
// selector mid-conversation we discard the old session so the new engine
// gets a fresh agent (Rust would otherwise reuse the cached SessionState
// and silently ignore the change).
let sessionEngine = null;
// Workspace dir the active sessionId was created against. Same change-
// detection pattern as `sessionEngine`: flipping it mid-session would
// have no effect on the cached SessionState, so we force a fresh one.
let sessionWorkspace = null;

// Workspace persisted across launches. `null` = use Rust's default
// (~/.kotonia/desktop/workspace). User picks via the OS directory dialog.
const WORKSPACE_LS_KEY = 'kotonia_desktop_workspace';
let currentWorkspace = (() => {
  try {
    const v = localStorage.getItem(WORKSPACE_LS_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
})();

function renderWorkspaceLabel() {
  // Show the trailing path segments (most informative) when long. The
  // CSS `direction: rtl` + ellipsis truncates from the LEFT, so this
  // value just needs to contain the full path.
  workspacePathEl.textContent = currentWorkspace || '~/.kotonia/desktop/workspace (default)';
  workspacePathEl.title = currentWorkspace || '~/.kotonia/desktop/workspace (default)';
}

async function pickWorkspace() {
  const dialog = window.__TAURI__?.dialog;
  if (!dialog) {
    appendLog('error', 'ダイアログプラグインが見つかりません (tauri-plugin-dialog 未ロード?)');
    return;
  }
  let picked;
  try {
    picked = await dialog.open({
      directory: true,
      multiple: false,
      title: 'workspace ディレクトリを選択',
      defaultPath: currentWorkspace || undefined,
    });
  } catch (e) {
    appendLog('error', 'workspace picker: ' + String(e));
    return;
  }
  if (!picked) return; // user cancelled
  if (picked === currentWorkspace) return; // no change
  currentWorkspace = picked;
  try {
    localStorage.setItem(WORKSPACE_LS_KEY, picked);
  } catch {
    // Private mode etc. — non-fatal, just won't persist across launches.
  }
  renderWorkspaceLabel();
  // Force a new session so Rust builds a fresh agent rooted at the new
  // workspace. The cached SessionState would otherwise keep using the
  // old dir.
  if (sessionId) {
    appendLog(
      'session-new',
      `workspace switched → starting a new session.`,
    );
    sessionId = null;
    sessionEngine = null;
    sessionWorkspace = null;
  }
}

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
const PATH_LINK_KINDS = new Set(['obs', 'final', 'bash', 'text', 'inspect']);

// Accumulator for streamed `text` events between tool calls. We buffer
// them so the Final event can hand a complete utterance to TTS in one
// shot — speaking each chunk on arrival would cancel the previous
// playback mid-sentence (every speakIris call rotates the active
// stream_id, dropping any earlier in-flight chunks).
let streamedTextBuffer = '';

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
    sessionEngine = engineSelect.value;
    sessionWorkspace = currentWorkspace;
    setSessionLabel();
    appendLog(
      'session-new',
      `── new session ${sessionId.slice(0, 8)} (engine: ${sessionEngine}, workspace: ${
        sessionWorkspace || 'default'
      }) ──`,
    );
  }
  return sessionId;
}

async function startNewSession() {
  sessionId = await invoke('new_session');
  sessionEngine = engineSelect.value;
  sessionWorkspace = currentWorkspace;
  setSessionLabel();
  appendLog(
    'session-new',
    `── new session ${sessionId.slice(0, 8)} (engine: ${sessionEngine}, workspace: ${
      sessionWorkspace || 'default'
    }) ──`,
  );
}

// Inline notice that Claude Code's headless mode runs with
// `--dangerously-skip-permissions` — approvals never reach the modal and
// the Iris persona prompt is dropped. Surface once per engine flip so
// the operator can't miss it.
function renderEngineWarning() {
  const engine = engineSelect.value;
  if (engine === 'claude-code') {
    appendLog(
      'engine-warn',
      'engine = claude-code (headless): 承認モーダルは表示されず ' +
        '`--dangerously-skip-permissions` で動きます。Iris ペルソナの ' +
        '指示も適用されません — Claude Code 自身の prompt と tool が走ります。',
    );
  }
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

  // Engine flip mid-session: drop the cached session so Rust constructs
  // a fresh DispatchAgent with the new engine. Otherwise get_or_create_session
  // hits the cache and silently keeps using the original engine.
  if (sessionId && sessionEngine && sessionEngine !== engineSelect.value) {
    appendLog(
      'session-new',
      `engine switched ${sessionEngine} → ${engineSelect.value}; starting a new session.`,
    );
    sessionId = null;
    sessionEngine = null;
    sessionWorkspace = null;
  }

  const sid = await ensureSession();
  const engine = engineSelect.value;
  const workspacePath = currentWorkspace; // null → backend uses default
  promptSubmit.disabled = true;
  try {
    const res = await invoke('submit_task', {
      prompt,
      sessionId: sid,
      model: null,
      engine,
      workspacePath,
    });
    appendLog(
      'task-submit',
      `▶ task ${res.task_id.slice(0, 8)} (session ${res.session_id.slice(0, 8)})\n${prompt}`,
    );
    promptInput.value = '';
    setActiveTask(res.task_id);
  } catch (e) {
    appendLog('submit-error', String(e));
    setActiveTask(null);
  } finally {
    promptSubmit.disabled = false;
    promptInput.focus();
  }
}

function setActiveTask(taskId) {
  activeTaskId = taskId;
  if (taskId) {
    promptSubmit.textContent = '中止';
    promptSubmit.classList.add('cancel-mode');
  } else {
    promptSubmit.textContent = '送信';
    promptSubmit.classList.remove('cancel-mode');
  }
}

async function cancelActiveTask() {
  if (!activeTaskId) return;
  const tid = activeTaskId;
  // Optimistically reset UI; an aborted tokio task won't emit `done`,
  // so we can't wait for backend confirmation to flip back.
  setActiveTask(null);
  try {
    const wasRunning = await invoke('cancel_task', { taskId: tid });
    appendLog(
      'session-new',
      wasRunning
        ? `■ cancelled task ${tid.slice(0, 8)}`
        : `(task ${tid.slice(0, 8)} already finished)`,
    );
  } catch (e) {
    appendLog('error', 'cancel: ' + String(e));
  }
}

function submitOrCancel() {
  if (activeTaskId) {
    cancelActiveTask();
  } else {
    submitTask();
  }
}

// Enter to submit (or cancel mid-task), Shift+Enter for newline.
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitOrCancel();
  }
});

promptForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitOrCancel();
});

btnNewSession.addEventListener('click', startNewSession);
btnClearLog.addEventListener('click', () => {
  logEl.innerHTML = '';
});

engineSelect.addEventListener('change', renderEngineWarning);
btnWorkspace.addEventListener('click', pickWorkspace);

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

// ── Avatar (Ditto lip-sync) mode ─────────────────────────────────────
// Enabling this routes the agent's spoken answer through
// `/api/voice/ditto/tts/stream/avatar` instead of the plain TTS path,
// so the floating Iris portrait animates in time with the audio. Voice
// must also be ON for audio to actually play; we don't force-link the
// two toggles (a user might want to see the avatar while muted, e.g.
// for a screen capture).

let avatarEnabled = false;
const STATIC_AVATAR_SRC = 'persona/iris.png';
let activeFrameUrl = null;
let prevFrameUrl = null;

function setAvatarEnabled(enabled) {
  avatarEnabled = enabled;
  btnToggleAvatar.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  if (enabled) {
    avatarFloating.classList.remove('hidden');
    avatarFloating.setAttribute('aria-hidden', 'false');
    // Reset to the bundled still image when re-shown so the user
    // doesn't see the last (frozen) frame from a previous talk.
    setAvatarFrameSrc(STATIC_AVATAR_SRC, /*isBlob*/ false);
  } else {
    avatarFloating.classList.add('hidden');
    avatarFloating.classList.remove('speaking');
    avatarFloating.setAttribute('aria-hidden', 'true');
    setAvatarFrameSrc(STATIC_AVATAR_SRC, /*isBlob*/ false);
  }
}

function setAvatarFrameSrc(src, isBlob) {
  // Revoke the previous frame's object URL after the next paint so we
  // don't pile up Blobs in memory at 25fps. We keep one URL behind the
  // live one in case the <img> hasn't decoded yet when the new URL is
  // assigned.
  if (prevFrameUrl) {
    URL.revokeObjectURL(prevFrameUrl);
  }
  prevFrameUrl = activeFrameUrl;
  activeFrameUrl = isBlob ? src : null;
  avatarFrame.src = src;
}

btnToggleAvatar.addEventListener('click', () => setAvatarEnabled(!avatarEnabled));

// ── Draggable + resizable avatar (aspect-ratio locked) ───────────────
// Stored under `kotonia_avatar_layout` in localStorage so the next
// launch picks up where the user left off. Aspect ratio is pinned to
// the iris.png portrait shape (2:3), so resize only takes a width
// and computes height from it.

const AVATAR_LAYOUT_KEY = 'kotonia_avatar_layout';
const AVATAR_ASPECT = 2 / 3;   // width / height
const AVATAR_MIN_W = 120;
const AVATAR_MAX_W = 720;
const AVATAR_VIEWPORT_MARGIN = 8;

function clampAvatarLayout(layout) {
  const width = Math.max(
    AVATAR_MIN_W,
    Math.min(
      AVATAR_MAX_W,
      Math.min(layout.width, window.innerWidth - AVATAR_VIEWPORT_MARGIN * 2)
    )
  );
  const height = Math.round(width / AVATAR_ASPECT);
  const maxX = Math.max(0, window.innerWidth - width - AVATAR_VIEWPORT_MARGIN);
  const maxY = Math.max(0, window.innerHeight - height - AVATAR_VIEWPORT_MARGIN);
  return {
    x: Math.max(AVATAR_VIEWPORT_MARGIN, Math.min(maxX, layout.x)),
    y: Math.max(AVATAR_VIEWPORT_MARGIN, Math.min(maxY, layout.y)),
    width,
    height,
  };
}

function applyAvatarLayout(layout) {
  // Switch from the CSS default (right/bottom anchoring) to explicit
  // left/top so drag offsets compose cleanly.
  avatarFloating.style.left = layout.x + 'px';
  avatarFloating.style.top = layout.y + 'px';
  avatarFloating.style.right = 'auto';
  avatarFloating.style.bottom = 'auto';
  avatarFloating.style.width = layout.width + 'px';
  avatarFloating.style.height = layout.height + 'px';
}

function saveAvatarLayout(layout) {
  try {
    localStorage.setItem(
      AVATAR_LAYOUT_KEY,
      JSON.stringify({ x: layout.x, y: layout.y, width: layout.width }),
    );
  } catch {}
}

function loadAvatarLayout() {
  try {
    const raw = localStorage.getItem(AVATAR_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function restoreAvatarLayout() {
  const saved = loadAvatarLayout();
  if (!saved) return; // CSS default (right:20 bottom:110) stays in effect
  applyAvatarLayout(clampAvatarLayout({ ...saved, height: saved.width / AVATAR_ASPECT }));
}

restoreAvatarLayout();
window.addEventListener('resize', () => {
  // Re-clamp on viewport changes so the avatar doesn't end up off-screen.
  const layout = loadAvatarLayout();
  if (layout) applyAvatarLayout(clampAvatarLayout({ ...layout, height: layout.width / AVATAR_ASPECT }));
});

// Drag-anywhere-on-the-portrait to reposition. Resize handle has its
// own pointer logic and stops propagation so the two gestures don't
// collide.
let dragState = null;
avatarFloating.addEventListener('pointerdown', (e) => {
  if (e.target === avatarResizeHandle) return; // resize handler takes over
  if (e.button !== 0) return; // primary mouse button only
  dragState = {
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    origX: avatarFloating.offsetLeft,
    origY: avatarFloating.offsetTop,
    width: avatarFloating.offsetWidth,
    height: avatarFloating.offsetHeight,
  };
  avatarFloating.setPointerCapture(e.pointerId);
  e.preventDefault();
});

avatarFloating.addEventListener('pointermove', (e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const dx = e.clientX - dragState.startClientX;
  const dy = e.clientY - dragState.startClientY;
  applyAvatarLayout(
    clampAvatarLayout({
      x: dragState.origX + dx,
      y: dragState.origY + dy,
      width: dragState.width,
      height: dragState.height,
    }),
  );
});

avatarFloating.addEventListener('pointerup', (e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  saveAvatarLayout({
    x: avatarFloating.offsetLeft,
    y: avatarFloating.offsetTop,
    width: avatarFloating.offsetWidth,
  });
  try { avatarFloating.releasePointerCapture(e.pointerId); } catch {}
  dragState = null;
});

// Resize handle: drag the bottom-right corner. Width follows mouse, height
// derived from AVATAR_ASPECT — there's no separate vertical drag.
let resizeState = null;
avatarResizeHandle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.stopPropagation(); // prevent drag-state from also firing
  resizeState = {
    pointerId: e.pointerId,
    startClientX: e.clientX,
    origWidth: avatarFloating.offsetWidth,
    origX: avatarFloating.offsetLeft,
    origY: avatarFloating.offsetTop,
  };
  avatarResizeHandle.setPointerCapture(e.pointerId);
  e.preventDefault();
});

avatarResizeHandle.addEventListener('pointermove', (e) => {
  if (!resizeState || e.pointerId !== resizeState.pointerId) return;
  const dx = e.clientX - resizeState.startClientX;
  applyAvatarLayout(
    clampAvatarLayout({
      x: resizeState.origX,
      y: resizeState.origY,
      width: resizeState.origWidth + dx,
      height: (resizeState.origWidth + dx) / AVATAR_ASPECT,
    }),
  );
});

avatarResizeHandle.addEventListener('pointerup', (e) => {
  if (!resizeState || e.pointerId !== resizeState.pointerId) return;
  saveAvatarLayout({
    x: avatarFloating.offsetLeft,
    y: avatarFloating.offsetTop,
    width: avatarFloating.offsetWidth,
  });
  try { avatarResizeHandle.releasePointerCapture(e.pointerId); } catch {}
  resizeState = null;
});

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

// Ditto-mode sync state.
//
// Two separate sync problems are happening at once and need different
// fixes:
//
// 1. Audio leads face at the START: the first audio chunk arrives
//    before the first frame is generated (frame gen is slower than
//    audio synthesis). Fix: buffer incoming audio until the first
//    `ditto_frame` lands, then flush.
//
// 2. Face exhausts before audio at the END: audio is scheduled into
//    the AudioContext FUTURE (chunk N plays at startAt+sum(durations)),
//    while frames are *displayed* in real time as they arrive. The
//    ditto server emits frames as fast as the GPU can produce them
//    (bursty, much faster than the 25 fps playback rate), so the
//    client races through all 50 frames in ~200 ms while the
//    corresponding audio is still queued out 2 seconds ahead. By the
//    time audio actually plays, frames have all been displayed and
//    the face freezes on the last frame. Fix: pace frame display to
//    the intended fps relative to a known start wall-clock — each
//    frame's `setTimeout` defers display so frame N appears at
//    `streamStart + N / FPS` regardless of when the bytes arrived.
const DITTO_FPS = 25;
let activeStreamWantsDitto = false;
let dittoAwaitingFirstFrame = false;
let dittoAudioBuffer = [];
let dittoStreamStartMs = 0;
let dittoFrameIndex = 0;

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function playAudioChunk(wavBytes) {
  try {
    const audioBuffer = await ttsAudioCtx.decodeAudioData(wavBytes.buffer);
    const source = ttsAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ttsAudioCtx.destination);
    const startAt = Math.max(ttsNextStartTime, ttsAudioCtx.currentTime + 0.01);
    source.start(startAt);
    ttsNextStartTime = startAt + audioBuffer.duration;
  } catch (e) {
    console.error('audio chunk play failed', e);
  }
}

async function speakIris(text) {
  if (!voiceEnabled || !ttsAudioCtx) return;
  const speakable = preprocessForSpeech(text || '');
  if (!speakable) return;
  // Reset per-stream sync state BEFORE invoke, so any in-flight chunk
  // from a previous stream that beats us to the listener is correctly
  // discarded by the stream_id check.
  dittoAudioBuffer = [];
  dittoAwaitingFirstFrame = avatarEnabled;
  activeStreamWantsDitto = avatarEnabled;
  dittoStreamStartMs = 0;
  dittoFrameIndex = 0;
  try {
    const command = avatarEnabled ? 'ditto_speak' : 'tts_speak';
    const streamId = await invoke(command, { text: speakable });
    ttsActiveStreamId = streamId;
    // Reset the playback head so the new utterance starts immediately
    // rather than queueing behind a previous (stale) stream that had
    // advanced ttsNextStartTime into the future.
    ttsNextStartTime = ttsAudioCtx.currentTime;
  } catch (e) {
    appendLog('error', 'TTS: ' + String(e));
    activeStreamWantsDitto = false;
    dittoAwaitingFirstFrame = false;
  }
}

listen('tts_chunk', async (msg) => {
  const payload = msg.payload;
  if (!payload || payload.stream_id !== ttsActiveStreamId) return;
  if (!ttsAudioCtx || ttsAudioCtx.state !== 'running') return;

  const wavBytes = base64ToUint8Array(payload.wav_base64);

  // Ditto path: hold audio until the first frame lands so face + voice
  // start in lockstep. Pure-TTS path: schedule immediately.
  if (activeStreamWantsDitto && dittoAwaitingFirstFrame) {
    dittoAudioBuffer.push(wavBytes);
    return;
  }
  await playAudioChunk(wavBytes);
});

listen('ditto_frame', async (msg) => {
  const payload = msg.payload;
  if (!payload || payload.stream_id !== ttsActiveStreamId) return;

  const blob = new Blob([base64ToUint8Array(payload.jpeg_base64)], {
    type: 'image/jpeg',
  });

  // First frame: flush whatever audio chunks we've been holding so
  // they start playing in the same tick the frame becomes visible.
  // Also pin the wall-clock origin for the subsequent FPS-paced
  // display scheduling — every later frame is timed relative to here.
  if (dittoAwaitingFirstFrame) {
    dittoAwaitingFirstFrame = false;
    ttsNextStartTime = ttsAudioCtx ? ttsAudioCtx.currentTime : 0;
    for (const wavBytes of dittoAudioBuffer.splice(0)) {
      await playAudioChunk(wavBytes);
    }
    dittoStreamStartMs = performance.now();
    dittoFrameIndex = 0;
  }

  if (!avatarEnabled) return; // toggle flipped off mid-stream

  // Pace frame display to a fixed FPS instead of "as soon as bytes
  // arrive". Without this the ditto server's bursty GPU output (50
  // frames in 200 ms) would display all frames before the audio —
  // which is queued into the AudioContext future — actually plays,
  // and the face would freeze on the last frame for the remaining
  // seconds of audio.
  const myFrameIndex = dittoFrameIndex++;
  const targetMs = dittoStreamStartMs + (myFrameIndex * 1000) / DITTO_FPS;
  const delayMs = Math.max(0, targetMs - performance.now());
  const streamIdAtSchedule = ttsActiveStreamId;

  setTimeout(() => {
    // Bail if a new speak superseded us before this frame's slot.
    if (ttsActiveStreamId !== streamIdAtSchedule) return;
    if (!avatarEnabled) return;
    const url = URL.createObjectURL(blob);
    setAvatarFrameSrc(url, /*isBlob*/ true);
    avatarFloating.classList.add('speaking');
  }, delayMs);
});

listen('tts_error', (msg) => {
  if (msg.payload?.stream_id !== ttsActiveStreamId) return;
  appendLog('error', `TTS: ${msg.payload?.message ?? 'unknown error'}`);
  // Clean up sync state so the next stream isn't stuck waiting.
  dittoAwaitingFirstFrame = false;
  activeStreamWantsDitto = false;
  dittoAudioBuffer = [];
});

listen('tts_done', (msg) => {
  if (msg.payload?.stream_id !== ttsActiveStreamId) return;
  if (!activeStreamWantsDitto) return;

  const closingStreamId = msg.payload.stream_id;

  // `tts_done` fires the moment the upstream stream body closes, NOT
  // when the audio finishes playing. We've been queueing chunks into
  // the AudioContext scheduler — `ttsNextStartTime` is the absolute
  // ctx-time at which the LAST queued chunk ends. Compute the gap
  // between "now" and "audio actually done" and defer the avatar
  // revert until then (plus a small tail so the mouth doesn't snap
  // shut on the final phoneme).
  const remainingMs = ttsAudioCtx
    ? Math.max(0, (ttsNextStartTime - ttsAudioCtx.currentTime) * 1000)
    : 0;
  const tailMs = 300;

  setTimeout(() => {
    // Skip the revert if a new stream has started in the meantime —
    // we don't want to clobber a fresh speak that the user fired
    // before the previous audio finished draining.
    if (ttsActiveStreamId !== closingStreamId) return;
    avatarFloating.classList.remove('speaking');
    setAvatarFrameSrc(STATIC_AVATAR_SRC, /*isBlob*/ false);
  }, remainingMs + tailMs);
});

listen('ditto_register_error', (msg) => {
  appendLog('error', `avatar 登録失敗: ${msg.payload?.message ?? 'unknown'} — face モードは使えませんが他は動きます`);
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
    // Pass the active workspace so relative paths like `./cute_woman.png`
    // (typical agent observation output) resolve against the agent's
    // cwd, not the desktop process cwd.
    await invoke('open_path', { path, workspacePath: currentWorkspace });
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
    resolved = await invoke('resolve_preview_path', {
      path,
      workspacePath: currentWorkspace,
    });
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
      // New iteration = new turn boundary. Drop any leftover streamed
      // text from a previous (possibly aborted) turn.
      streamedTextBuffer = '';
      break;
    case 'llm_thinking':
      appendLog('thinking', '· thinking');
      break;
    case 'text':
      appendLog('text', ev.text);
      streamedTextBuffer += (streamedTextBuffer ? '\n\n' : '') + ev.text;
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
    case 'inspect_image': {
      const kb = ev.size_bytes ? `${Math.round(ev.size_bytes / 1024)} KB` : '0 KB';
      if (ev.error) {
        appendLog('inspect', `[inspect_image] ✗ ${ev.path} — ${ev.error}`);
      } else {
        appendLog('inspect', `[inspect_image] ✓ ${ev.path} (${kb}) — attached to next turn`);
      }
      break;
    }
    case 'final': {
      // Claude Code streams its text via `text` events; the `final`
      // body arrives empty in that path (claude_code.rs dedups it).
      // Fall back to the streamed buffer so TTS still has content.
      const spoken = ev.answer || streamedTextBuffer;
      const display = ev.answer ? `══ final ══\n${ev.answer}` : '══ final ══';
      appendLog('final', display);
      speakIris(spoken);
      streamedTextBuffer = '';
      break;
    }
    case 'malformed':
      appendLog('malformed', `[malformed] ${ev.excerpt}`);
      break;
    case 'error':
      appendLog('error', `[error] ${ev.message}`);
      // Backend may emit `error` without a following `done` (e.g. agent
      // run_turn returned Err). Clear active state defensively so the
      // submit button doesn't stay stuck on "中止".
      if (msg.payload?.task_id === activeTaskId) {
        setActiveTask(null);
      }
      break;
    case 'done':
      appendLog(
        'done',
        `── done after ${ev.iterations} iter${ev.iterations === 1 ? '' : 's'} — ${
          ev.success ? '✓' : '✗'
        } ──`,
      );
      if (msg.payload?.task_id === activeTaskId) {
        setActiveTask(null);
      }
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
renderWorkspaceLabel();
