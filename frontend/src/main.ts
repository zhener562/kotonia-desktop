// kotonia desktop — TypeScript shell over Tauri 2 IPC.
//
// Tauri 2 with `withGlobalTauri: true` exposes:
//   window.__TAURI__.core.invoke(cmd, args)
//   window.__TAURI__.event.listen(name, handler)
//
// Backend commands (see src-tauri/src/commands.rs):
//   auth_status() → { logged_in, server, device_id_prefix }
//   start_login() → { device_code, user_code, verification_uri, expires_in, interval }
//   poll_login({ deviceCode }) → { status: "pending" } | { status: "approved", device_id_prefix }
//   new_session() → "<session_id>"
//   submit_task({ prompt, sessionId, model, engine }) → { task_id, session_id }
//   respond_approval({ approvalId, approved }) → void
//   open_login_help({ url }) → void
//   check_for_update() → null | { version, current_version }
//   install_update() → installs the signed update and restarts
//
// Backend events:
//   "agent_event"      payload: { task_id, event: WireEvent }
//   "approval_request" payload: { approval_id, task_id, command, reason }

interface Window {
  __TAURI__: {
    core: {
      invoke: <T = any>(command: string, args?: Record<string, unknown>) => Promise<T>;
      convertFileSrc: (path: string, protocol?: string) => string;
    };
    event: {
      listen: <T = any>(
        event: string,
        handler: (event: { payload: T }) => void,
      ) => Promise<() => void>;
    };
    dialog?: {
      open: (options: Record<string, unknown>) => Promise<string | null>;
      save: (options: Record<string, unknown>) => Promise<string | null>;
    };
  };
  KotoniaSpeech: {
    stripMarkdown: (text: string) => string;
  };
  webkitAudioContext?: typeof AudioContext;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`required element #${id} was not found`);
  }
  return found as T;
}

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const logEl = element<HTMLDivElement>('log');
const promptForm = element<HTMLFormElement>('prompt-form');
const promptInput = element<HTMLTextAreaElement>('prompt-input');
const promptSubmit = element<HTMLButtonElement>('prompt-submit');
const authStatusEl = element<HTMLDivElement>('auth-status');
const sessionLabelEl = element<HTMLSpanElement>('session-label');
const btnNewSession = element<HTMLButtonElement>('btn-new-session');
const btnClearLog = element<HTMLButtonElement>('btn-clear-log');
const outputModeSelect = element<HTMLSelectElement>('output-mode');
const btnProfile = element<HTMLButtonElement>('btn-profile');
const btnMic = element<HTMLButtonElement>('btn-mic');
const avatarFloating = element<HTMLDivElement>('avatar-floating');
const avatarFrame = element<HTMLImageElement>('avatar-frame');
const avatarResizeHandle = element<HTMLDivElement>('avatar-resize-handle');
const btnMicIcon = element<HTMLSpanElement>('btn-mic-icon');
const btnMicLabel = element<HTMLSpanElement>('btn-mic-label');
const btnTogglePreview = element<HTMLButtonElement>('btn-toggle-preview');
const approvalModal = element<HTMLDivElement>('approval-modal');
const approvalReason = element<HTMLParagraphElement>('approval-reason');
const approvalCommand = element<HTMLPreElement>('approval-command');
const approvalApprove = element<HTMLButtonElement>('approval-approve');
const approvalDeny = element<HTMLButtonElement>('approval-deny');
const loginModal = element<HTMLDivElement>('login-modal');
const loginCode = element<HTMLParagraphElement>('login-code');
const loginStatus = element<HTMLParagraphElement>('login-status');
const loginCancel = element<HTMLButtonElement>('login-cancel');
const loginOpenBrowser = element<HTMLButtonElement>('login-open-browser');
const previewPane = element<HTMLElement>('preview-pane');
const previewIframe = element<HTMLIFrameElement>('preview-iframe');
const previewPath = element<HTMLSpanElement>('preview-path');
const previewRefresh = element<HTMLButtonElement>('preview-refresh');
const previewOpenExternal = element<HTMLButtonElement>('preview-open-external');
const previewClose = element<HTMLButtonElement>('preview-close');
const previewError = element<HTMLDivElement>('preview-error');
const previewErrorMsg = element<HTMLPreElement>('preview-error-msg');
const engineSelect = element<HTMLSelectElement>('engine-select');
const btnWorkspace = element<HTMLButtonElement>('btn-workspace');
const workspacePathEl = element<HTMLSpanElement>('workspace-path');
const profileModal = element<HTMLDivElement>('profile-modal');
const profileForm = element<HTMLFormElement>('profile-form');
const profileNameInput = element<HTMLInputElement>('profile-name');
const profileTaglineInput = element<HTMLInputElement>('profile-tagline');
const profileSystemPromptInput = element<HTMLTextAreaElement>('profile-system-prompt');
const profilePersonaInput = element<HTMLTextAreaElement>('profile-persona');
const profileImagePreview = element<HTMLImageElement>('profile-image-preview');
const profileImagePathEl = element<HTMLParagraphElement>('profile-image-path');
const profilePickImage = element<HTMLButtonElement>('profile-pick-image');
const profileCancel = element<HTMLButtonElement>('profile-cancel');
const profileLoadEve = element<HTMLButtonElement>('profile-load-eve');
const profileResetPrompt = element<HTMLButtonElement>('profile-reset-prompt');

// Default system prompt and the Eve preset, from the Rust side
// (`persona_info`). An empty saved prompt means "use the default", so a
// later change to the default reaches users who never edited it.
let promptDefaults = { system: '', eve: '' };
const personaInfoPromise = invoke<{ default_system_prompt: string; eve_persona: string; default_voice: DesktopVoiceConfig }>('persona_info')
  .then((info) => {
    promptDefaults = { system: info.default_system_prompt, eve: info.eve_persona };
    return info;
  })
  .catch((e) => { appendLog('error', 'persona_info: ' + String(e)); return null; });

let sessionId = null;
let pendingApprovalId = null;
// Task id currently running in the backend. Used to flip the submit
// button between "send" and "cancel" so the user can stop a runaway
// agent without restarting the app.
let activeTaskId = null;
let promptSubmissionPending = false;
const browserStatus = element<HTMLDivElement>('browser-status');
const browserStatusLabel = element<HTMLElement>('browser-status-label');
const browserStatusPage = element<HTMLSpanElement>('browser-status-page');
const browserTakeover = element<HTMLButtonElement>('browser-takeover');

async function takeOverBrowser() {
  browserTakeover.disabled = true;
  try {
    if (!(await cancelActiveTask())) return;
    browserStatusLabel.textContent = '手動操作中';
    appendLog('info', 'ブラウザ操作を引き継ぎました。別ウィンドウで操作し、会話で「続けて」と伝えてください。');
    promptInput.focus();
  } finally {
    browserTakeover.disabled = false;
  }
}
browserTakeover.addEventListener('click', takeOverBrowser);
element<HTMLButtonElement>('approval-takeover').addEventListener('click', takeOverBrowser);
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

interface UpdateInfo {
  version: string;
  current_version: string;
  install_blocker: string | null;
}

async function checkForUpdate() {
  let update: UpdateInfo | null;
  try {
    update = await invoke<UpdateInfo | null>('check_for_update');
  } catch (e) {
    // Offline startup is normal. Keep the failure in the developer console
    // rather than adding a red row to every disconnected session.
    console.warn('update check failed', e);
    return;
  }
  if (!update) return;

  appendLog(
    'info',
    `Kotonia Desktop ${update.version} を利用できます（現在 ${update.current_version}）。`,
  );
  if (update.install_blocker) {
    appendLog('error', `更新の準備が必要です: ${update.install_blocker}`);
    window.alert(update.install_blocker);
    return;
  }

  const accepted = window.confirm(
    `Kotonia Desktop ${update.version} に更新しますか？\n\n` +
      '署名を検証してインストールした後、アプリを再起動します。',
  );
  if (!accepted) return;

  appendLog('info', '最新版をダウンロードしてインストールしています…');
  try {
    await invoke('install_update');
  } catch (e) {
    appendLog('error', `自動更新に失敗しました: ${String(e)}`);
  }
}

const PROFILE_LS_KEY = 'kotonia_desktop_profile_v1';
const DEFAULT_PROFILE = {
  name: 'Eve',
  tagline: 'kotonia desktop',
  systemPrompt: '',
  persona: '',
  avatarPath: '',
};
let profile = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_LS_KEY) || '{}');
    return { ...DEFAULT_PROFILE, ...saved };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
})();
let draftAvatarPath = profile.avatarPath;

function profileAvatarSrc() {
  return profile.avatarPath ? convertFileSrc(profile.avatarPath) : 'persona/eve.png';
}

function applyProfile() {
  const avatar = document.getElementById('persona-avatar') as HTMLImageElement | null;
  const name = document.getElementById('persona-name');
  const tagline = document.getElementById('persona-tagline');
  const src = profileAvatarSrc();
  if (avatar) {
    avatar.src = src;
    avatar.alt = profile.name;
  }
  if (name) name.textContent = profile.name;
  if (tagline) tagline.textContent = profile.tagline;
  document.title = `${profile.name || 'Kotonia'} · kotonia`;
  profileImagePreview.src = src;
  profileImagePathEl.textContent = profile.avatarPath || 'Eve の既定画像';
  setAvatarFrameSrc(src, false);
}

function openProfileEditor() {
  draftAvatarPath = profile.avatarPath;
  profileNameInput.value = profile.name;
  profileTaglineInput.value = profile.tagline;
  profileSystemPromptInput.value = profile.systemPrompt || promptDefaults.system;
  profilePersonaInput.value = profile.persona;
  profileImagePreview.src = profileAvatarSrc();
  profileImagePathEl.textContent = profile.avatarPath || 'Eve の既定画像';
  profileModal.classList.remove('hidden');
}

async function pickProfileImage() {
  const dialog = window.__TAURI__?.dialog;
  if (!dialog) return;
  const picked = await dialog.open({
    directory: false,
    multiple: false,
    title: 'プロフィールの顔画像を選択',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (!picked) return;
  draftAvatarPath = picked;
  profileImagePreview.src = convertFileSrc(picked);
  profileImagePathEl.textContent = picked;
}

function avatarIdForProfile(character = profile) {
  if (!character.avatarPath) return 'eve';
  let hash = 2166136261;
  for (const char of character.avatarPath) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `desktop-profile-${(hash >>> 0).toString(16)}`;
}

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
  if (DesktopUI.switching) return;
  await stopSpeech();
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
    if (!(await releaseSessionBrowser())) return;
    sessionId = null;
    sessionEngine = null;
    sessionWorkspace = null;
    DesktopUI.sessionModel = null;
    setSessionLabel();
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
  /(?<![\p{L}\p{N}_:/.])(?:(?:~\/|\.{1,2}\/|\/)[^\s'"`<>()\\[\]{}]+|[A-Za-z]:[\\/][^\s'"`<>()[\]{}]+)/gu;

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
// playback mid-sentence (each utterance rotates the active
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
  return line;
}

function setSessionLabel() {
  DesktopUI.rememberSession();
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

async function releaseSessionBrowser(): Promise<boolean> {
  if (activeTaskId && !(await cancelActiveTask())) return false;
  try {
    if (sessionId) await invoke('close_browser', { sessionId });
  } catch (error) {
    appendLog('error', 'ブラウザを閉じられませんでした: ' + String(error));
    return false;
  }
  browserStatus.hidden = true;
  return true;
}

async function startNewSession() {
  if (DesktopUI.switching) return;
  await stopSpeech();
  DesktopUI.sessionModel = null;
  if (!(await releaseSessionBrowser())) return;
  sessionId = await invoke('new_session');
  sessionEngine = engineSelect.value;
  sessionWorkspace = currentWorkspace;
  setSessionLabel();
  logEl.replaceChildren();
  streamedTextBuffer = '';
  appendLog(
    'session-new',
    `── new session ${sessionId.slice(0, 8)} (engine: ${sessionEngine}, workspace: ${
      sessionWorkspace || 'default'
    }) ──`,
  );
}

// Inline notice that Claude Code's headless mode runs with
// `--dangerously-skip-permissions` — approvals never reach the modal and
// the Eve persona prompt is dropped. Surface once per engine flip so
// the operator can't miss it.
function renderEngineWarning() {
  const engine = engineSelect.value;
  if (engine === 'claude-code') {
    appendLog(
      'engine-warn',
      'engine = claude-code (headless): 承認モーダルは表示されず ' +
        '`--dangerously-skip-permissions` で動きます。Eve ペルソナの ' +
        '指示も適用されません — Claude Code 自身の prompt と tool が走ります。',
    );
  }
}

async function loadPersona() {
  applyProfile();
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
        '未ログイン &nbsp;<button id="auth-login-trigger" type="button" class="auth-login-btn">ログイン</button>';
      authStatusEl.className = 'auth-status unauthed';
    }
  } catch (e) {
    authStatusEl.textContent = 'auth check failed: ' + String(e);
    authStatusEl.className = 'auth-status unauthed';
  }
}

// ── Login (device-code pairing, driven from the GUI) ───────────────────
// Same flow as `kotonia-cli login`, but polled on a JS timer instead of a
// blocking loop, so a user who never installed the CLI can still pair.
let loginPollTimer = null;

function stopLoginPoll() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

function hideLoginModal() {
  stopLoginPoll();
  loginModal.classList.add('hidden');
}

async function startLogin() {
  loginCode.textContent = '――――――';
  loginStatus.textContent = '準備中…';
  loginStatus.className = 'login-status';
  loginOpenBrowser.onclick = null;
  loginModal.classList.remove('hidden');

  let session;
  try {
    session = await invoke('start_login');
  } catch (e) {
    loginStatus.textContent = 'エラー: ' + String(e);
    loginStatus.className = 'login-status error';
    return;
  }

  loginCode.textContent = session.user_code;
  loginStatus.textContent = `ブラウザで承認するまで待機中… (${Math.max(1, Math.round(session.expires_in / 60))} 分で失効)`;
  loginOpenBrowser.onclick = () => {
    invoke('open_login_help', { url: session.verification_uri }).catch((e) => {
      console.error('open_login_help failed', e);
    });
  };
  // Fire once immediately too — most users won't notice the button.
  invoke('open_login_help', { url: session.verification_uri }).catch(() => {});

  stopLoginPoll();
  loginPollTimer = setInterval(async () => {
    try {
      const result = await invoke('poll_login', { deviceCode: session.device_code });
      if (result.status === 'approved') {
        stopLoginPoll();
        loginStatus.textContent = `承認されました (device ${result.device_id_prefix}…)`;
        loginStatus.className = 'login-status approved';
        await refreshAuth();
        setTimeout(hideLoginModal, 900);
      }
      // status === 'pending' → keep waiting silently.
    } catch (e) {
      stopLoginPoll();
      loginStatus.textContent = 'エラー: ' + String(e);
      loginStatus.className = 'login-status error';
    }
  }, Math.max(session.interval, 1) * 1000);
}

function showApproval(req) {
  pendingApprovalId = req.approval_id;
  approvalReason.textContent = req.reason || '';
  approvalCommand.textContent = req.command || '';
  element<HTMLButtonElement>('approval-takeover').hidden = browserStatus.hidden ||
    !(req.command || '').startsWith('browser ');
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
  if (promptSubmissionPending || DesktopUI.switching) return;
  promptSubmissionPending = true;
  try { await submitTaskOnce(); }
  finally { promptSubmissionPending = false; }
}

async function submitTaskOnce() {
  await DesktopUI.ready;
  if (DesktopUI.switching) return;
  await stopSpeech();
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
    if (!(await releaseSessionBrowser())) return;
    sessionId = null;
    sessionEngine = null;
    sessionWorkspace = null;
  }

  const sid = await ensureSession();
  const engine = engineSelect.value;
  const workspacePath = currentWorkspace; // null → backend uses default
  promptSubmit.disabled = true;
  const submittingTaskId = crypto.randomUUID();
  setActiveTask(submittingTaskId);
  appendLog('task-submit', `あなた\n${prompt}`);
  try {
    await invoke('submit_task', {
      prompt,
      sessionId: sid,
      model: DesktopUI.sessionModel,
      taskId: submittingTaskId,
      desktopProfile: profile,
      voice: DesktopUI.voice,
      engine,
      workspacePath,
      systemPrompt: profile.systemPrompt,
      persona: profile.persona,
      home: homeMode,
    });
    DesktopUI.markSessionSaved(sid);
    promptInput.value = '';
    // The task ID was installed before invoke; early events are already live.
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
    if (!browserStatus.hidden) browserStatusLabel.textContent = 'ブラウザ・待機中';
  }
}

async function cancelActiveTask() {
  await stopSpeech();
  if (!activeTaskId) return true;
  const tid = activeTaskId;
  // Optimistically reset UI; an aborted tokio task won't emit `done`,
  // so we can't wait for backend confirmation to flip back.
  setActiveTask(null);
  try {
    const wasRunning = await invoke('cancel_task', { taskId: tid });
    pendingApprovalId = null;
    approvalModal.classList.add('hidden');
    connectorModal.classList.add('hidden');
    siteModal.classList.add('hidden');
    appendLog(
      'session-new',
      wasRunning
        ? `■ cancelled task ${tid.slice(0, 8)}`
        : `(task ${tid.slice(0, 8)} already finished)`,
    );
    return true;
  } catch (e) {
    appendLog('error', 'cancel: ' + String(e));
    setActiveTask(tid);
    return false;
  }
}

function submitOrCancel() {
  if (activeTaskId) {
    cancelActiveTask();
  } else {
    void submitTask().catch((e) => appendLog('submit-error', String(e)));
  }
}

// macOS の WKWebView は、日本語 IME の変換確定 Enter でも keydown 時点の
// isComposing が false になることがある。CompositionEvent を別途追跡し、
// WebKit の IME 用 keyCode (229) も送信対象から除外する。
let promptIsComposing = false;

promptInput.addEventListener('compositionstart', () => {
  promptIsComposing = true;
});

promptInput.addEventListener('compositionend', () => {
  promptIsComposing = false;
});

// Enter to submit (or cancel mid-task), Shift+Enter for newline.
promptInput.addEventListener('keydown', (e) => {
  const isImeComposition =
    promptIsComposing || e.isComposing || e.keyCode === 229;

  if (e.key === 'Enter' && !e.shiftKey && !isImeComposition) {
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

engineSelect.addEventListener('change', () => { DesktopUI.sessionModel = null; void stopSpeech(); renderEngineWarning(); });
btnWorkspace.addEventListener('click', pickWorkspace);
btnProfile.addEventListener('click', openProfileEditor);
profileCancel.addEventListener('click', () => profileModal.classList.add('hidden'));
profileLoadEve.addEventListener('click', () => {
  profilePersonaInput.value = promptDefaults.eve;
});
profileResetPrompt.addEventListener('click', () => {
  profileSystemPromptInput.value = promptDefaults.system;
});
profilePickImage.addEventListener('click', () => {
  pickProfileImage().catch((e) => appendLog('error', 'profile image: ' + String(e)));
});
profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await stopSpeech();
  const previousPrompt = `${profile.systemPrompt}\n${profile.persona}`;
  profile = {
    name: profileNameInput.value.trim() || 'Kotonia',
    tagline: profileTaglineInput.value.trim(),
    // Saved unchanged from the default → store '' so it keeps following it.
    systemPrompt:
      profileSystemPromptInput.value.trim() === promptDefaults.system.trim()
        ? ''
        : profileSystemPromptInput.value.trim(),
    persona: profilePersonaInput.value.trim(),
    avatarPath: draftAvatarPath,
  };
  try { localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(profile)); } catch {}
  profileModal.classList.add('hidden');
  applyProfile();
  if (sessionId && previousPrompt !== `${profile.systemPrompt}\n${profile.persona}`) {
    if (!(await releaseSessionBrowser())) return;
    sessionId = null;
    sessionEngine = null;
    sessionWorkspace = null;
    setSessionLabel();
    DesktopUI.sessionModel = null;
    appendLog('session-new', 'profile prompt changed → starting a new session.');
  } else if (DesktopUI.hasSavedSession() && DesktopUI.voice) {
    try { await invoke('save_session_preferences', { sessionId, profile, voice: DesktopUI.voice }); }
    catch (e) { appendLog('error', '会話のプロフィールを保存できません: ' + String(e)); }
  }
});

// ── TTS playback (Eve voice) ─────────────────────────────────────────
// Audio is initialized on a user gesture — autoplay policies in WebKit refuse to
// schedule audio until a user gesture creates / resumes an
// AudioContext. The toggle click doubles as that gesture.

let voiceEnabled = false;
let ttsAudioCtx = null;
let ttsNextStartTime = 0;
let ttsActiveStreamId = null;

function setVoiceEnabled(enabled) {
  voiceEnabled = enabled;
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
    void stopSpeech();
    if (ttsAudioCtx && ttsAudioCtx.state === 'running') {
      ttsAudioCtx.suspend().catch(() => {});
    }
    // Drop the active stream so any in-flight chunks from the backend
    // are ignored even if the toggle flips back on quickly.
    ttsActiveStreamId = null;
  }
}

// ── Avatar (Ditto lip-sync) mode ─────────────────────────────────────
// Enabling this routes the agent's spoken answer through
// `/api/v1/avatars/{avatar_id}/speech` instead of the plain TTS path,
// so the floating Eve portrait animates in time with the audio. Voice
// must also be ON for audio to actually play; we don't force-link the
// two toggles (a user might want to see the avatar while muted, e.g.
// for a screen capture).

let avatarEnabled = false;
let activeFrameUrl = null;
let prevFrameUrl = null;

function setAvatarEnabled(enabled) {
  avatarEnabled = enabled;
  if (enabled) {
    avatarFloating.classList.remove('hidden');
    avatarFloating.setAttribute('aria-hidden', 'false');
    // Reset to the bundled still image when re-shown so the user
    // doesn't see the last (frozen) frame from a previous talk.
    setAvatarFrameSrc(profileAvatarSrc(), /*isBlob*/ false);
  } else {
    avatarFloating.classList.add('hidden');
    avatarFloating.classList.remove('speaking');
    avatarFloating.setAttribute('aria-hidden', 'true');
    setAvatarFrameSrc(profileAvatarSrc(), /*isBlob*/ false);
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

const OUTPUT_MODE_LS_KEY = 'kotonia_desktop_output_mode';

function setOutputMode(mode) {
  const normalized = mode === 'voice' || mode === 'avatar' ? mode : 'text';
  outputModeSelect.value = normalized;
  setVoiceEnabled(normalized !== 'text');
  setAvatarEnabled(normalized === 'avatar');
  try { localStorage.setItem(OUTPUT_MODE_LS_KEY, normalized); } catch {}
}

outputModeSelect.addEventListener('change', () => setOutputMode(outputModeSelect.value));

// ── Draggable + resizable avatar (aspect-ratio locked) ───────────────
// Stored under `kotonia_avatar_layout` in localStorage so the next
// launch picks up where the user left off. Aspect ratio is pinned to
// the eve.png portrait shape (2:3), so resize only takes a width
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

// Legacy markers are hidden in temporary streaming previews. Final display,
// history, and speech all use the normalized blocks returned by Rust.
const VOICE_MARKER_RE = /\{\{\s*VOICE\s*:\s*([\s\S]*?)\}\}/gi;
const SPEAK_MARKER_RE = /\{\{\s*SPEAK\s*:\s*([\s\S]*?)\}\}/gi;

function extractSpeechMarkers(text) {
  let direction = null;
  let spoken = null;
  const clean = String(text ?? '')
    .replace(VOICE_MARKER_RE, (_, dir) => {
      if (direction === null) {
        const d = String(dir).replace(/\s+/g, ' ').trim();
        if (d) direction = d;
      }
      return '';
    })
    .replace(SPEAK_MARKER_RE, (_, say) => {
      if (spoken === null) {
        const s = String(say).replace(/\s+/g, ' ').trim();
        if (s) spoken = s;
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { direction, spoken, clean };
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

// Every audio packet is decoded in arrival order; stream identity is checked
// after async decode too, so stop/switch cannot schedule an obsolete buffer.
let speechEpoch = 0;
let audioDecodeQueue: Promise<void> = Promise.resolve();
const activeAudioSources = new Set<AudioBufferSourceNode>();
const pendingFrameTimers = new Set<ReturnType<typeof setTimeout>>();
let audioFinishTimer: ReturnType<typeof setTimeout> | null = null;
let streamWaiter: { id: string; resolve: (complete: boolean) => void; reject: (error: Error) => void } | null = null;
let activeSpeechPortrait = '';

function ensureAudioContext() {
  if (!ttsAudioCtx) ttsAudioCtx = new AudioContext();
  if (ttsAudioCtx.state === 'suspended') void ttsAudioCtx.resume();
}

async function stopSpeech(): Promise<number> {
  const epoch = ++speechEpoch;
  const streamToCancel = ttsActiveStreamId;
  ttsActiveStreamId = null;
  streamWaiter?.resolve(false); streamWaiter = null;
  if (audioFinishTimer !== null) clearTimeout(audioFinishTimer);
  audioFinishTimer = null;
  for (const timer of pendingFrameTimers) clearTimeout(timer);
  pendingFrameTimers.clear();
  for (const source of activeAudioSources) { try { source.stop(); } catch {} }
  activeAudioSources.clear();
  audioDecodeQueue = Promise.resolve();
  dittoAudioBuffer = []; dittoAwaitingFirstFrame = false; activeStreamWantsDitto = false;
  ttsNextStartTime = ttsAudioCtx?.currentTime ?? 0;
  avatarFloating.classList.remove('speaking');
  setAvatarFrameSrc(profileAvatarSrc(), false);
  document.querySelectorAll('.response-block.speaking').forEach((el) => el.classList.remove('speaking'));
  element('btn-stop-speech').hidden = true;
  DesktopUI.stopSamples();
  await invoke('cancel_speech', { streamId: streamToCancel });
  return epoch;
}

element('btn-stop-speech').addEventListener('click', () => { void stopSpeech().catch((e) => appendLog('error', String(e))); });

function failSpeech(streamId: string, error: Error) {
  if (streamId !== ttsActiveStreamId) return;
  streamWaiter?.reject(error); streamWaiter = null;
}

function queueAudioChunk(bytes: Uint8Array, streamId: string) {
  audioDecodeQueue = audioDecodeQueue.then(async () => {
    if (streamId !== ttsActiveStreamId) return;
    const context: AudioContext = ttsAudioCtx;
    const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (streamId !== ttsActiveStreamId) return;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    activeAudioSources.add(source);
    source.onended = () => { activeAudioSources.delete(source); source.disconnect(); };
    const startAt = Math.max(ttsNextStartTime, context.currentTime + 0.01);
    source.start(startAt); ttsNextStartTime = startAt + buffer.duration;
  }).catch((e) => failSpeech(streamId, e instanceof Error ? e : new Error(String(e))));
}

async function playResponse(message: DesktopMessage, config: DesktopVoiceConfig, character = profile, audioOnly = false) {
  ensureAudioContext();
  const epoch = await stopSpeech();
  if (epoch !== speechEpoch) return;
  if (!config) throw new Error('声の設定が読み込まれていません');
  const capturedVoice = JSON.parse(JSON.stringify(config));
  const capturedCharacter = { ...character };
  const useAvatar = avatarEnabled && !audioOnly;
  const groups: { text: string; direction?: string; speaker?: string; indexes: number[] }[] = [];
  for (const [index, block] of (message.response?.blocks ?? []).entries()) {
    if (block.type !== 'speech') continue;
    const text = window.KotoniaSpeech.stripMarkdown(block.text);
    if (!text) continue;
    const previous = groups[groups.length - 1];
    if (previous && previous.direction === block.delivery && previous.speaker === block.speaker) {
      previous.text += '\n\n' + text; previous.indexes.push(index);
    } else groups.push({ text, direction: block.delivery, speaker: block.speaker, indexes: [index] });
  }
  const article = [...document.querySelectorAll<HTMLElement>('.response-message')].find((el) => el.dataset.messageId === message.id);
  element('btn-stop-speech').hidden = false;
  try {
    for (const group of groups) {
      if (epoch !== speechEpoch) return;
      const prepared = await invoke<DesktopPreparedSpeech>('prepare_speech', { text: group.text, voice: capturedVoice });
      if (epoch !== speechEpoch) return;
      article?.querySelectorAll<HTMLElement>('.response-block').forEach((part) => part.classList.toggle('speaking', group.indexes.includes(Number(part.dataset.blockIndex))));
      for (const text of prepared.chunks) {
        if (epoch !== speechEpoch) return;
        const streamId = crypto.randomUUID();
        ttsActiveStreamId = streamId;
        dittoAudioBuffer = []; dittoAwaitingFirstFrame = useAvatar; activeStreamWantsDitto = useAvatar;
        dittoStreamStartMs = 0; dittoFrameIndex = 0;
        ttsNextStartTime = ttsAudioCtx.currentTime;
        activeSpeechPortrait = capturedCharacter.avatarPath ? convertFileSrc(capturedCharacter.avatarPath) : 'persona/eve.png';
        if (useAvatar) setAvatarFrameSrc(activeSpeechPortrait, false);
        const completed = new Promise<boolean>((resolve, reject) => { streamWaiter = { id: streamId, resolve, reject }; });
        // Register completion before invoke; even immediate errors and first
        // packets are now correlated with an already-active stream.
        const args = { text, voice: capturedVoice, instruct: group.direction, streamId,
          ...(useAvatar ? { avatarId: avatarIdForProfile(capturedCharacter), avatarPath: capturedCharacter.avatarPath || null } : {}) };
        void invoke(useAvatar ? 'ditto_speak' : 'tts_speak', args).catch((e) => failSpeech(streamId, new Error(String(e))));
        if (!(await completed)) return;
      }
    }
  } catch (e) {
    if (epoch === speechEpoch) { appendLog('error', '音声を再生できません: ' + String(e)); await stopSpeech(); }
  } finally {
    if (epoch === speechEpoch) {
      ttsActiveStreamId = null; streamWaiter = null;
      element('btn-stop-speech').hidden = true;
      article?.querySelectorAll('.speaking').forEach((part) => part.classList.remove('speaking'));
      avatarFloating.classList.remove('speaking'); setAvatarFrameSrc(profileAvatarSrc(), false);
    }
  }
}

listen('tts_chunk', (msg) => {
  const p = msg.payload;
  if (!p || p.stream_id !== ttsActiveStreamId) return;
  const bytes = base64ToUint8Array(p.wav_base64);
  if (activeStreamWantsDitto && dittoAwaitingFirstFrame) dittoAudioBuffer.push(bytes);
  else queueAudioChunk(bytes, p.stream_id);
});

listen('ditto_frame', (msg) => {
  const p = msg.payload;
  if (!p || p.stream_id !== ttsActiveStreamId || !activeStreamWantsDitto) return;
  if (dittoAwaitingFirstFrame) {
    dittoAwaitingFirstFrame = false;
    ttsNextStartTime = ttsAudioCtx.currentTime;
    for (const bytes of dittoAudioBuffer.splice(0)) queueAudioChunk(bytes, p.stream_id);
    dittoStreamStartMs = performance.now(); dittoFrameIndex = 0;
  }
  const blob = new Blob([base64ToUint8Array(p.jpeg_base64)], { type: 'image/jpeg' });
  const delay = Math.max(0, dittoStreamStartMs + (dittoFrameIndex++ * 1000) / DITTO_FPS - performance.now());
  const timer = setTimeout(() => {
    pendingFrameTimers.delete(timer);
    if (p.stream_id !== ttsActiveStreamId || !avatarEnabled) return;
    setAvatarFrameSrc(URL.createObjectURL(blob), true); avatarFloating.classList.add('speaking');
  }, delay);
  pendingFrameTimers.add(timer);
});

listen('tts_error', (msg) => {
  if (msg.payload?.stream_id === ttsActiveStreamId) failSpeech(msg.payload.stream_id, new Error(msg.payload.message ?? 'unknown TTS error'));
});

listen('tts_done', async (msg) => {
  const streamId = msg.payload?.stream_id;
  if (streamId !== ttsActiveStreamId) return;
  // A stream with audio but no video is still audible; never strand its queue.
  if (dittoAwaitingFirstFrame) {
    dittoAwaitingFirstFrame = false;
    for (const bytes of dittoAudioBuffer.splice(0)) queueAudioChunk(bytes, streamId);
  }
  await audioDecodeQueue;
  if (streamId !== ttsActiveStreamId) return;
  const remainingMs = Math.max(0, (ttsNextStartTime - ttsAudioCtx.currentTime) * 1000);
  audioFinishTimer = setTimeout(() => {
    if (streamId !== ttsActiveStreamId) return;
    const waiter = streamWaiter; streamWaiter = null; waiter?.resolve(true);
  }, remainingMs + 20);
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
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('この WebView は AudioContext に対応していません');
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error(
        'この WebView ではマイク入力 API が利用できません。macOS 版は最新版に更新して、システム設定 > プライバシーとセキュリティ > マイクで kotonia-desktop を許可してください。'
      );
    }
    // Request 16 kHz to match Whisper / Qwen3-ASR's native rate and
    // sidestep the JS-side resampling that downsampling 48 kHz would
    // require. Browsers may ignore the requested rate; we honor
    // whatever ctx.sampleRate ends up at in the WAV header.
    micAudioCtx = new AudioContextCtor({ sampleRate: 16000 });
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

// Delegated: the login button is re-rendered into authStatusEl's innerHTML
// on every refreshAuth() tick, so a directly-attached listener would be
// lost each time.
authStatusEl.addEventListener('click', (e) => {
  const target = e.target as Element | null;
  if (target?.id === 'auth-login-trigger') startLogin();
});
loginCancel.addEventListener('click', hideLoginModal);

// Ctrl/Cmd+click on a detected path link opens it with the OS default app
// via the `open_path` Tauri command. Plain click is intentionally a no-op
// so users can still drag-select the path text for copy.
// ▶ play buttons next to .html / .htm paths load that file into the
// preview pane via the asset:// protocol (configured in tauri.conf.json).
logEl.addEventListener('click', async (e) => {
  const target = e.target as Element | null;
  const playBtn = target?.closest<HTMLElement>('.preview-link-btn');
  if (playBtn) {
    e.preventDefault();
    const path = playBtn.dataset.previewPath;
    if (path) openPreview(path);
    return;
  }
  const link = target?.closest<HTMLElement>('.path-link');
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
  const url = convertFileSrc(resolved) + '?t=' + Date.now();
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
  if (!ev || msg.payload?.task_id !== activeTaskId) return;
  switch (ev.kind) {
    case 'browser': {
      // Ignore late browser events from a task that the user has stopped.
      if (msg.payload?.task_id !== activeTaskId) break;
      browserStatus.hidden = ev.status === 'closed';
      browserStatusLabel.textContent = ev.status === 'running'
        ? `ブラウザ・${ev.action} 実行中`
        : ev.status === 'error' ? 'ブラウザ・確認が必要' : 'ブラウザ';
      browserStatusPage.textContent = [ev.title, ev.url].filter(Boolean).join(' — ');
      appendLog(ev.error ? 'error' : 'info', `[browser ${ev.action}: ${ev.status}] ${ev.title || ''} ${ev.url || ''}${ev.error ? '\n' + ev.error : ''}`);
      break;
    }
    case 'iteration_start':
      appendLog('iter', `── iter ${ev.iteration}/${ev.max} ──`);
      // New iteration = new turn boundary. Drop any leftover streamed
      // text from a previous (possibly aborted) turn.
      streamedTextBuffer = '';
      break;
    case 'llm_thinking':
      appendLog('thinking', '· thinking');
      break;
    case 'text': {
      // Display without the speech markers; keep the raw text in the buffer
      // so the final-step extraction still finds VOICE/SPEAK (claude-code
      // path speaks from the buffer, not `ev.answer`).
      const shown = extractSpeechMarkers(ev.text).clean;
      if (shown) { const row = appendLog('text', shown); row.dataset.streamTask = msg.payload.task_id; }
      streamedTextBuffer += (streamedTextBuffer ? '\n\n' : '') + ev.text;
      break;
    }
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
      for (const row of logEl.querySelectorAll<HTMLElement>('[data-stream-task]')) {
        if (row.dataset.streamTask === msg.payload.task_id) row.remove();
      }
      const message: DesktopMessage = ev.message ?? {
        id: msg.payload.task_id,
        role: 'assistant', content: ev.answer || streamedTextBuffer,
        response: ev.response, voice: ev.voice ?? DesktopUI.voice,
      };
      DesktopUI.renderResponse(message);
      if (voiceEnabled) void playResponse(message, message.voice ?? DesktopUI.voice).catch((e) => appendLog('error', String(e)));
      streamedTextBuffer = '';
      break;
    }
    case 'malformed':
      appendLog('malformed', `[malformed] ${ev.excerpt}`);
      break;
    case 'context_compacted': {
      // kotonia-cli folded older turns to stay inside the model's window.
      const parts = [];
      if (ev.stubbed > 0) parts.push(`${ev.stubbed} old outputs stubbed`);
      if (ev.summarised > 0) parts.push(`${ev.summarised} older messages summarised`);
      if (ev.summary_failed) parts.push('summary failed, outputs stubbed instead');
      const detail = parts.length ? `, ${parts.join(', ')}` : '';
      appendLog(
        'info',
        `[context compacted: ~${ev.before_tokens.toLocaleString()} → ~${ev.after_tokens.toLocaleString()} tokens${detail}]`,
      );
      break;
    }
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

listen('history_error', (msg) => { appendLog('error', '会話を保存できません: ' + String(msg.payload?.message)); });

listen('approval_request', (msg) => {
  if (msg.payload) showApproval(msg.payload);
});

// ── Windows without Git: commands run in the bundled BusyBox ─────────
// Works straight after install; Git for Windows is offered, not required.

const shellNotice = element<HTMLDivElement>('shell-notice');
const shellNoticeText = element<HTMLSpanElement>('shell-notice-text');
const SHELL_NOTICE_LS_KEY = 'kotonia_shell_notice_dismissed';

async function showShellNotice() {
  try {
    const info = await invoke('shell_info');
    if (info.os !== 'windows' || info.shell === 'bash') return;
    if (info.shell === 'busybox') {
      if (localStorage.getItem(SHELL_NOTICE_LS_KEY) === '1') return;
      shellNoticeText.textContent =
        'Git for Windows が入っていないので、同梱の簡易シェル (BusyBox) でコマンドを動かしています。このままでも使えます。Git を入れると使えるコマンドが増えます (入れた後はアプリを再起動)。';
    } else {
      shellNoticeText.textContent =
        'コマンドを動かすシェルが見つかりません。Git for Windows を入れてアプリを再起動してください。';
    }
    shellNotice.hidden = false;
  } catch {}
}

element<HTMLButtonElement>('shell-notice-help').addEventListener('click', () => {
  void invoke('open_login_help', { url: 'https://gitforwindows.org/' });
});
element<HTMLButtonElement>('shell-notice-close').addEventListener('click', () => {
  shellNotice.hidden = true;
  try { localStorage.setItem(SHELL_NOTICE_LS_KEY, '1'); } catch {}
});
void showShellNotice();

// ── this folder's memory ─────────────────────────────────────────────
// kotonia-cli keeps notes per work folder (~/.kotonia/projects) and shares
// USER.md across folders. The agent writes them through its `memory` tool;
// here the user reads and corrects them, and decides which mail accounts
// the agent may read in this folder.

const btnMemory = element<HTMLButtonElement>('btn-memory');
const memoryModal = element<HTMLDivElement>('memory-modal');
const memoryFolder = element<HTMLParagraphElement>('memory-folder');
const memoryFolderText = element<HTMLTextAreaElement>('memory-folder-text');
const memoryUserText = element<HTMLTextAreaElement>('memory-user-text');
const memoryMail = element<HTMLUListElement>('memory-mail');
const memoryClose = element<HTMLButtonElement>('memory-close');
const memorySave = element<HTMLButtonElement>('memory-save');

function renderMemoryMail(accounts: { id: string; email: string }[], allowed: string[]) {
  if (!accounts.length) {
    memoryMail.replaceChildren(
      Object.assign(document.createElement('li'), {
        textContent: 'つながっているメールはありません (ホームモードの会話で頼まれたときに連携できます)',
      }),
    );
    return;
  }
  memoryMail.replaceChildren(
    ...accounts.map((a) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'memory-mail-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = allowed.includes(a.id);
      box.addEventListener('change', async () => {
        try {
          await invoke('project_set_mail', {
            workspacePath: currentWorkspace,
            connector: a.id,
            allow: box.checked,
          });
          appendLog('info', box.checked
            ? `このフォルダで ${a.email} のメールを読めるようにしました (次の会話から)`
            : `このフォルダから ${a.email} のメールを外しました (次の会話から)`);
        } catch (e) {
          box.checked = !box.checked;
          appendLog('error', 'メールの許可を変更できません: ' + String(e));
        }
      });
      label.append(box, document.createTextNode(a.email));
      li.append(label);
      return li;
    }),
  );
}

async function openMemory() {
  try {
    const st = await invoke('project_status', { workspacePath: currentWorkspace });
    memoryFolder.textContent = `フォルダ: ${st.root}`;
    memoryFolder.title = `保存先: ${st.dir}`;
    memoryFolderText.value = st.memory;
    memoryUserText.value = st.user;
    renderMemoryMail(st.mail_accounts, st.mail_allowed);
    memoryModal.classList.remove('hidden');
  } catch (e) {
    appendLog('error', '記憶を読めません: ' + String(e));
  }
}

btnMemory.addEventListener('click', () => { void openMemory(); });
memoryClose.addEventListener('click', () => memoryModal.classList.add('hidden'));
memorySave.addEventListener('click', async () => {
  try {
    await invoke('project_save', {
      workspacePath: currentWorkspace,
      memory: memoryFolderText.value,
      user: memoryUserText.value,
    });
    memoryModal.classList.add('hidden');
    appendLog('info', '記憶を保存しました (次の会話から反映されます)');
  } catch (e) {
    appendLog('error', '記憶を保存できません: ' + String(e));
  }
});

// ── home mode (resident agent) ──────────────────────────────────────
// Mirrors kotonia-cli's `--home` + `home run`: memory files and connectors
// in the session prompt, the heartbeat running while the app is open, and
// the agent asking for accounts / unfamiliar sites through the modals below.

const HOME_LS_KEY = 'kotonia_home_mode';
const btnHomeToggle = element<HTMLButtonElement>('btn-home-toggle');
const btnHomePanel = element<HTMLButtonElement>('btn-home-panel');
const homeBadge = element<HTMLSpanElement>('home-badge');
const homeModal = element<HTMLDivElement>('home-modal');
const homeStatusLine = element<HTMLParagraphElement>('home-status-line');
const homeHeartbeat = element<HTMLSelectElement>('home-heartbeat');
const homeFeed = element<HTMLUListElement>('home-feed');
const homeConnectors = element<HTMLUListElement>('home-connectors');
const homeSites = element<HTMLUListElement>('home-sites');
const homeClose = element<HTMLButtonElement>('home-close');
const connectorModal = element<HTMLDivElement>('connector-modal');
const connectorForm = element<HTMLFormElement>('connector-form');
const connectorTitle = element<HTMLHeadingElement>('connector-title');
const connectorReason = element<HTMLParagraphElement>('connector-reason');
const connectorConsent = element<HTMLUListElement>('connector-consent');
const connectorHelp = element<HTMLParagraphElement>('connector-help');
const connectorHelpLink = element<HTMLButtonElement>('connector-help-link');
const connectorFields = element<HTMLDivElement>('connector-fields');
const connectorCancel = element<HTMLButtonElement>('connector-cancel');
const siteModal = element<HTMLDivElement>('site-modal');
const siteHost = element<HTMLParagraphElement>('site-host');
const siteUrl = element<HTMLPreElement>('site-url');

let homeMode = false;
try {
  homeMode = localStorage.getItem(HOME_LS_KEY) === '1';
} catch {}
let unseenFeed = 0;
let pendingConnectorId: string | null = null;
let pendingSiteId: string | null = null;

const FEED_KIND_LABEL = {
  heartbeat: '定期チェック',
  reminder: 'リマインダー',
  stale_reminder: '期限切れのリマインダー',
  approval_needed: '承認が要るため止めた操作',
  error: 'エラー',
};

function renderHomeButtons() {
  btnHomeToggle.textContent = homeMode ? '🏠 ホーム: オン' : '🏠 ホーム: オフ';
  btnHomeToggle.classList.toggle('on', homeMode);
  btnHomePanel.hidden = !homeMode;
  homeBadge.hidden = unseenFeed === 0;
  homeBadge.textContent = String(unseenFeed);
}

function feedLine(item) {
  const li = document.createElement('li');
  li.className = `kind-${item.kind}`;
  const meta = document.createElement('span');
  meta.className = 'feed-meta';
  const when = new Date(item.ts).toLocaleString();
  meta.textContent = `${when} · ${FEED_KIND_LABEL[item.kind] || item.kind}`;
  li.appendChild(meta);
  li.appendChild(document.createTextNode(item.text));
  return li;
}

async function refreshHomePanel() {
  try {
    const st = await invoke('home_status');
    const hb = st.heartbeat_every_min ? `${st.heartbeat_every_min} 分ごと (次: ${st.next_due})` : 'オフ';
    homeStatusLine.textContent =
      `${st.dir} · 定期チェック ${hb} · 時間帯 ${st.active_hours} · ` +
      (st.runner_running ? 'このアプリで実行中' : '停止中');
    homeHeartbeat.value = String(st.heartbeat_every_min || 0);
    if (![...homeHeartbeat.options].some((o) => o.value === homeHeartbeat.value)) {
      const opt = document.createElement('option');
      opt.value = homeHeartbeat.value;
      opt.textContent = `${homeHeartbeat.value} 分ごと`;
      homeHeartbeat.appendChild(opt);
    }
    homeFeed.replaceChildren(...(st.feed.length ? st.feed.map(feedLine) : [Object.assign(document.createElement('li'), { textContent: 'まだ何もありません' })]));
    const li = (t) => Object.assign(document.createElement('li'), { textContent: t });
    homeConnectors.replaceChildren(...(st.connectors.length ? st.connectors.map((t) => li(t.replace(/^- /, '').replace(/`/g, ''))) : [li('まだありません (会話の中で必要になったときに頼まれます)')]));
    homeSites.replaceChildren(...(st.web_sites.length ? st.web_sites.map(li) : [li('ありません (定期チェック中のネットアクセスは止まります)')]));
  } catch (e) {
    homeStatusLine.textContent = 'ホームの状態を読めません: ' + String(e);
  }
}

async function startHomeRunner() {
  try {
    await invoke('home_start_runner');
  } catch (e) {
    appendLog('error', '定期チェックを開始できません: ' + String(e));
  }
}

async function setHomeMode(on: boolean) {
  homeMode = on;
  try { localStorage.setItem(HOME_LS_KEY, on ? '1' : '0'); } catch {}
  renderHomeButtons();
  if (on) {
    await startHomeRunner();
  } else {
    try { await invoke('home_stop_runner'); } catch {}
  }
  // The session prompt differs with and without home, so start fresh.
  await startNewSession();
  appendLog('info', on ? 'ホームモード: 記憶ファイルとつながりを使います' : 'ホームモードを切りました');
}

btnHomeToggle.addEventListener('click', () => { void setHomeMode(!homeMode); });
btnHomePanel.addEventListener('click', async () => {
  unseenFeed = 0;
  renderHomeButtons();
  await refreshHomePanel();
  homeModal.classList.remove('hidden');
});
homeClose.addEventListener('click', () => homeModal.classList.add('hidden'));
homeHeartbeat.addEventListener('change', async () => {
  try {
    await invoke('home_set_heartbeat', { minutes: Number(homeHeartbeat.value) });
  } catch (e) {
    appendLog('error', '定期チェックの設定に失敗: ' + String(e));
  }
  await refreshHomePanel();
});

listen('home_feed', (msg) => {
  const item = msg.payload;
  if (!item) return;
  if (!homeModal.classList.contains('hidden')) {
    homeFeed.prepend(feedLine(item));
  } else {
    unseenFeed += 1;
    renderHomeButtons();
  }
  if (item.kind === 'heartbeat' || item.kind === 'reminder') {
    appendLog('info', `🏠 ${FEED_KIND_LABEL[item.kind]}: ${item.text}`);
  }
});

listen('home_runner_stopped', (msg) => {
  appendLog('error', '定期チェックが止まりました: ' + String(msg.payload));
});

// Connector card: the agent asked for an account mid-turn. The secret is
// typed here and sent once to the backend, which writes it to the vault.
function showConnectorCard(req) {
  const card = req.card || {};
  pendingConnectorId = req.request_id;
  connectorTitle.textContent = `接続: ${card.title || ''}`;
  connectorReason.textContent = card.reason || '';
  connectorConsent.replaceChildren(...(card.consent || []).map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  connectorHelp.textContent = card.help || '';
  connectorHelpLink.hidden = !card.help_url;
  connectorHelpLink.textContent = card.help_url || '';
  connectorHelpLink.onclick = () => { void invoke('open_login_help', { url: card.help_url }); };
  connectorFields.replaceChildren(...(card.fields || []).map((f) => {
    const label = document.createElement('label');
    label.textContent = f.label + (f.secret ? ' (この PC の保管庫に入り、AI には渡りません)' : '');
    const input = document.createElement('input');
    input.name = f.key;
    input.type = f.secret ? 'password' : 'text';
    input.autocomplete = 'off';
    input.value = f.default || '';
    label.appendChild(input);
    return label;
  }));
  connectorModal.classList.remove('hidden');
  (connectorFields.querySelector('input[value=""]') as HTMLInputElement | null)?.focus();
}

async function answerConnector(values) {
  const id = pendingConnectorId;
  pendingConnectorId = null;
  connectorModal.classList.add('hidden');
  // Drop the typed secret from the DOM right away.
  connectorFields.replaceChildren();
  if (!id) return;
  try {
    await invoke('respond_connector', { requestId: id, values });
  } catch (e) {
    appendLog('error', 'connector respond failed: ' + String(e));
  }
}

connectorForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const values = {};
  connectorFields.querySelectorAll('input').forEach((i) => { values[(i as HTMLInputElement).name] = (i as HTMLInputElement).value; });
  void answerConnector(values);
});
connectorCancel.addEventListener('click', () => { void answerConnector(null); });
listen('connector_request', (msg) => { if (msg.payload) showConnectorCard(msg.payload); });

// Unfamiliar site (home mode): once / always / deny, like Muse.
async function answerSite(decision: string) {
  const id = pendingSiteId;
  pendingSiteId = null;
  siteModal.classList.add('hidden');
  if (!id) return;
  try {
    await invoke('respond_site', { requestId: id, decision });
  } catch (e) {
    appendLog('error', 'site respond failed: ' + String(e));
  }
}
element<HTMLButtonElement>('site-once').addEventListener('click', () => { void answerSite('once'); });
element<HTMLButtonElement>('site-always').addEventListener('click', () => { void answerSite('always'); });
element<HTMLButtonElement>('site-deny').addEventListener('click', () => { void answerSite('deny'); });
listen('site_request', (msg) => {
  const req = msg.payload;
  if (!req) return;
  pendingSiteId = req.request_id;
  siteHost.textContent = `${req.host} を開きますか？`;
  siteUrl.textContent = req.url;
  siteModal.classList.remove('hidden');
});

renderHomeButtons();
// Home runner startup follows the restored conversation in DesktopUI.init.

// Boot.
loadPersona();
let initialOutputMode = 'text';
try {
  initialOutputMode = localStorage.getItem(OUTPUT_MODE_LS_KEY) || 'text';
} catch {}
setOutputMode(initialOutputMode);
window.addEventListener('pointerdown', () => {
  if ((voiceEnabled || ttsActiveStreamId) && ttsAudioCtx?.state === 'suspended') {
    ttsAudioCtx.resume().catch(() => {});
  }
});
refreshAuth();
setInterval(refreshAuth, 60_000);
setSessionLabel();
renderWorkspaceLabel();
void checkForUpdate();
void DesktopUI.init();
