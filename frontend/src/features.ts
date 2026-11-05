interface DesktopVoiceConfig {
  schema_version: number;
  engine: 'voxcpm' | 'irodori' | 'voicevox';
  language: string;
  speed: number;
  voxcpm_design: string;
  voxcpm_ref_id: string;
  voxcpm_seed: number | null;
  irodori_caption: string;
  irodori_ref_id: string;
  irodori_seed: number | null;
  voicevox_speaker: number;
  base_instruct: string;
  irodori_readings: boolean;
  reading_overrides: Record<string, string>;
}
interface DesktopResponseBlock {
  type: 'speech' | 'narration' | 'artifact';
  text: string;
  speaker?: string;
  delivery?: string;
}
interface DesktopResponse { version: number; blocks: DesktopResponseBlock[]; }
interface DesktopMessage {
  id: string;
  role: string;
  content: string;
  response?: DesktopResponse;
  voice?: DesktopVoiceConfig;
  created_at?: string;
}
interface DesktopContext {
  workspace: string;
  engine: string;
  model: string;
  profile: typeof DEFAULT_PROFILE | null;
  voice: DesktopVoiceConfig;
  home: boolean;
}
interface DesktopSession {
  id: string;
  context: DesktopContext;
  messages: DesktopMessage[];
}
interface DesktopSessionSummary {
  id: string; title: string; preview: string; updated_at: string;
  character: string; workspace: string; engine: string; legacy: boolean;
}
interface DesktopPreparedSpeech {
  plan: { text: string; changes: { source: string; reading: string }[]; spelled_words: string[] };
  chunks: string[];
}

namespace DesktopUI {
  const VOICE_KEY = 'kotonia_desktop_voice_v1';
  const LAST_SESSION_KEY = 'kotonia_desktop_last_session';
  export let voice: DesktopVoiceConfig;
  export let ready: Promise<void> = Promise.resolve();
  export let switching = false;
  let rememberEnabled = false;
  const savedSessionIds = new Set<string>();
  export let sessionModel: string | null = null;
  let summaries: DesktopSessionSummary[] = [];
  let historyGeneration = 0;
  let voiceGeneration = 0;
  let draft: DesktopVoiceConfig;
  let refVoices: { ref_id: string; label: string; description?: string }[] = [];
  let sampleAudio: HTMLAudioElement | null = null;
  let sampleUrl: string | null = null;

  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const input = (id: string) => element<HTMLInputElement>(id);
  const select = (id: string) => element<HTMLSelectElement>(id);
  const textArea = (id: string) => element<HTMLTextAreaElement>(id);
  const button = (label: string, action: () => void | Promise<void>) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => { void Promise.resolve(action()).catch((e) => appendLog('error', String(e))); });
    return b;
  };

  function showDialog(id: string) {
    const dialog = element<HTMLDivElement>(id);
    dialog.classList.remove('hidden');
    (dialog.querySelector('input, select, button') as HTMLElement | null)?.focus();
  }
  function hideDialog(id: string, trigger: string) {
    element(id).classList.add('hidden'); element(trigger).focus();
  }

  export function rememberSession() {
    if (!rememberEnabled) return;
    try {
      if (sessionId && savedSessionIds.has(sessionId)) localStorage.setItem(LAST_SESSION_KEY, sessionId);
      else localStorage.removeItem(LAST_SESSION_KEY);
    } catch (e) { appendLog('error', '会話の再開先を保存できません: ' + String(e)); }
  }

  export function markSessionSaved(id: string) { savedSessionIds.add(id); rememberSession(); }
  export function hasSavedSession() { return !!sessionId && savedSessionIds.has(sessionId); }

  function busy(on: boolean) {
    switching = on;
    document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('.top-actions button, .top-actions select').forEach((b) => { b.disabled = on; });
    promptSubmit.disabled = on;
    promptInput.disabled = on;
  }

  export async function openSession(id: string, startup = false) {
    if (switching) return;
    busy(true);
    try {
      const saved = await invoke<DesktopSession>('open_session', { sessionId: id });
      if (!(await releaseSessionBrowser())) return;
      await stopSpeech();
      closePreview();
      currentWorkspace = saved.context.workspace;
      sessionWorkspace = currentWorkspace;
      sessionEngine = saved.context.engine;
      sessionModel = saved.context.model;
      engineSelect.value = sessionEngine;
      if (saved.context.profile) {
        profile = { ...DEFAULT_PROFILE, ...saved.context.profile };
        voice = copy(saved.context.voice);
        try {
          localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(profile));
          localStorage.setItem(VOICE_KEY, JSON.stringify(voice));
        } catch (e) { appendLog('error', '復元した設定を保存できません: ' + String(e)); }
      }
      try { localStorage.setItem(WORKSPACE_LS_KEY, currentWorkspace); } catch (e) { appendLog('error', String(e)); }
      homeMode = saved.context.home;
      try { localStorage.setItem(HOME_LS_KEY, homeMode ? '1' : '0'); } catch (e) { appendLog('error', String(e)); }
      if (homeMode) await startHomeRunner();
      else await invoke('home_stop_runner');
      renderHomeButtons();
      sessionId = saved.id;
      savedSessionIds.add(saved.id);
      setSessionLabel(); renderWorkspaceLabel(); applyProfile();
      logEl.replaceChildren();
      if (!saved.context.profile) appendLog('info', '以前の会話を開きました。作業フォルダとエンジンを復元しました。保存されていないプロフィールと声には現在の設定を使います。');
      for (const message of saved.messages) {
        if (message.role === 'assistant' && message.response) renderResponse(message, saved.context.profile ?? profile);
        else appendLog('text', `あなた\n${message.content}`);
      }
      element('history-modal').classList.add('hidden');
      rememberSession();
    } catch (e) {
      const message = '履歴を開けません: ' + String(e);
      element('history-status').textContent = message;
      if (startup) appendLog('error', message);
      if (startup) {
        try { localStorage.removeItem(LAST_SESSION_KEY); } catch {}
      }
    } finally { busy(false); promptInput.focus(); }
  }

  async function exportSession(summary: DesktopSessionSummary) {
    const dialog = window.__TAURI__.dialog;
    if (!dialog?.save) throw new Error('保存ダイアログを利用できません');
    const filename = summary.title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60) || 'conversation';
    const outputPath = await dialog.save({ defaultPath: `${filename}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!outputPath) return;
    await invoke('export_session', { sessionId: summary.id, outputPath });
    element('history-status').textContent = '会話全文を書き出しました。';
  }

  function renderHistory() {
    const query = input('history-search').value.trim().toLocaleLowerCase();
    const matches = summaries.filter((s) => `${s.title} ${s.preview} ${s.character} ${s.workspace}`.toLocaleLowerCase().includes(query));
    const list = element('history-list');
    list.replaceChildren();
    for (const summary of matches) {
      const row = document.createElement('div'); row.className = 'history-row' + (summary.id === sessionId ? ' current' : '');
      const open = button('', () => openSession(summary.id)); open.className = 'history-open';
      const title = document.createElement('strong'); title.textContent = summary.title;
      const preview = document.createElement('small'); preview.textContent = summary.preview;
      const meta = document.createElement('small');
      meta.textContent = `${summary.character} · ${new Date(summary.updated_at).toLocaleString()} · ${summary.engine}\n${summary.workspace}`;
      open.append(title, preview, meta);
      const save = button('全文を書き出す', async () => {
        save.disabled = true;
        try { await exportSession(summary); }
        catch (e) { element('history-status').textContent = '書き出せません: ' + String(e); }
        finally { save.disabled = false; }
      }); save.className = 'history-export';
      row.append(open, save); list.append(row);
    }
    element('history-status').textContent = matches.length ? `${matches.length}件の会話` : '会話がありません。';
  }

  async function refreshHistory() {
    const generation = ++historyGeneration;
    element('history-status').textContent = '履歴を読み込み中…';
    try {
      const result = await invoke<DesktopSessionSummary[]>('list_sessions');
      if (generation !== historyGeneration) return;
      summaries = result; renderHistory();
    } catch (e) { if (generation === historyGeneration) element('history-status').textContent = '履歴を読み込めません。再読み込みしてください: ' + String(e); }
  }

  function refId(config: DesktopVoiceConfig) { return config.engine === 'irodori' ? config.irodori_ref_id : config.voxcpm_ref_id; }
  function description(config: DesktopVoiceConfig) { return config.engine === 'irodori' ? config.irodori_caption : config.voxcpm_design; }
  function voiceStatus(message: string) { element('voice-settings-status').textContent = message; }

  function readDraft(): DesktopVoiceConfig {
    const next = copy(draft);
    next.engine = select('voice-engine').value as DesktopVoiceConfig['engine'];
    next.language = select('voice-language').value;
    next.speed = Number(input('voice-speed').value);
    next.irodori_readings = input('voice-readings-enabled').checked;
    next.reading_overrides = {};
    for (const [index, line] of textArea('voice-reading-overrides').value.split('\n').entries()) {
      if (!line.trim()) continue;
      const position = line.indexOf('=');
      if (position <= 0) throw new Error(`読み辞書の${index + 1}行目を「英語表記=読み」で入力してください`);
      const word = line.slice(0, position).trim();
      const reading = line.slice(position + 1).trim();
      if (!reading) throw new Error(`読み辞書の${index + 1}行目に読みを入力してください`);
      next.reading_overrides[word] = reading;
    }
    if (next.engine === 'voicevox') {
      next.voicevox_speaker = Number(select('voicevox-speaker').value);
    } else {
      const seed = input('voice-seed').value.trim();
      const value = seed ? Number(seed) : null;
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 2147483647)) throw new Error('シードは0〜2147483647の整数で入力してください');
      if (next.engine === 'irodori') {
        next.irodori_caption = textArea('voice-description').value;
        next.irodori_ref_id = select('voice-reference').value;
        next.irodori_seed = value;
      } else {
        next.voxcpm_design = textArea('voice-description').value;
        next.voxcpm_ref_id = select('voice-reference').value;
        next.voxcpm_seed = value;
      }
    }
    return next;
  }

  function fillDraft() {
    select('voice-engine').value = draft.engine;
    select('voice-language').value = draft.language;
    select('voice-language').disabled = draft.engine === 'irodori' || draft.engine === 'voicevox';
    input('voice-speed').value = String(draft.speed);
    textArea('voice-description').value = description(draft);
    input('voice-seed').value = String((draft.engine === 'irodori' ? draft.irodori_seed : draft.voxcpm_seed) ?? '');
    input('voice-readings-enabled').checked = draft.irodori_readings;
    textArea('voice-reading-overrides').value = Object.entries(draft.reading_overrides).map(([k, v]) => `${k}=${v}`).join('\n');
    element('voice-reference-fields').hidden = draft.engine === 'voicevox';
    element('voicevox-fields').hidden = draft.engine !== 'voicevox';
    element('irodori-reading-fields').hidden = draft.engine !== 'irodori';
    refVoices = [];
    const ref = select('voice-reference');
    ref.replaceChildren(new Option('声の特徴から生成（音色は変わることがあります）', ''));
    if (refId(draft)) ref.add(new Option(`保存済み: ${refId(draft)}`, refId(draft)));
    ref.value = refId(draft);
    const speaker = select('voicevox-speaker');
    speaker.replaceChildren(new Option(`話者 ID ${draft.voicevox_speaker}`, String(draft.voicevox_speaker)));
  }

  async function loadVoices() {
    const engine = select('voice-engine').value;
    const generation = voiceGeneration;
    voiceStatus('声の一覧を読み込み中…');
    try {
      if (engine === 'voicevox') {
        const result = await invoke<{ name: string; styles: { name: string; id: number }[] }[]>('voicevox_speakers');
        if (generation !== voiceGeneration || select('voice-engine').value !== engine) return;
        const speaker = select('voicevox-speaker'); const saved = speaker.value;
        speaker.replaceChildren();
        for (const sp of result) for (const style of sp.styles) speaker.add(new Option(`${sp.name} — ${style.name}`, String(style.id)));
        if (![...speaker.options].some((o) => o.value === saved)) speaker.add(new Option(`保存済み ID ${saved}`, saved));
        speaker.value = saved;
      } else {
        const result = await invoke<{ voices: typeof refVoices }>('list_ref_voices', { engine });
        if (generation !== voiceGeneration || select('voice-engine').value !== engine) return;
        refVoices = result.voices;
        const ref = select('voice-reference'); const saved = ref.value;
        ref.replaceChildren(new Option('声の特徴から生成（音色は変わることがあります）', ''));
        for (const v of refVoices) ref.add(new Option(v.label || v.ref_id, v.ref_id));
        if (saved && !refVoices.some((v) => v.ref_id === saved)) ref.add(new Option(`一覧にない保存済みの声: ${saved}`, saved));
        ref.value = saved;
      }
      voiceStatus('');
    } catch (e) { if (generation === voiceGeneration) voiceStatus('声を読み込めません。設定はそのままです。一覧を更新して再試行できます: ' + String(e)); }
  }

  export function stopSamples() {
    sampleAudio?.pause(); sampleAudio = null;
    if (sampleUrl) URL.revokeObjectURL(sampleUrl);
    sampleUrl = null;
  }
  async function playSample(base64: string) {
    await stopSpeech(); stopSamples();
    sampleUrl = URL.createObjectURL(new Blob([base64ToUint8Array(base64)], { type: 'audio/wav' }));
    sampleAudio = new Audio(sampleUrl);
    sampleAudio.addEventListener('ended', stopSamples, { once: true });
    await sampleAudio.play();
  }

  function readingText(result: DesktopPreparedSpeech) {
    const changes = result.plan.changes.map((c) => `${c.source} → ${c.reading}`).join('\n');
    const unknown = result.plan.spelled_words.length ? `\n\nアルファベットで読む語: ${result.plan.spelled_words.join('、')}\n自然な読みにするには読み辞書に追加してください。` : '';
    return result.plan.text + (changes ? '\n\n読み替え:\n' + changes : '') + unknown;
  }

  async function previewDraft(play: boolean) {
    const config = readDraft();
    await invoke('validate_voice', { voice: config });
    const text = textArea('voice-test-text').value;
    const result = await invoke<DesktopPreparedSpeech>('prepare_speech', { text, voice: config });
    const preview = element('voice-reading-preview'); preview.hidden = false; preview.textContent = readingText(result);
    if (play) await playResponse({ id: 'voice-preview', role: 'assistant', content: text, response: { version: 1, blocks: [{ type: 'speech', text }] } }, config, profile, true);
  }

  async function makeCandidates() {
    const config = readDraft(); await invoke('validate_voice', { voice: config });
    const generation = ++voiceGeneration;
    const container = element('voice-candidates'); container.replaceChildren();
    const makeButton = element<HTMLButtonElement>('voice-make-candidates'); makeButton.disabled = true;
    voiceStatus('声の候補を作っています…');
    try {
      const result = await invoke<{ candidates: { audio_b64: string; token: string }[]; expires_at: number }>('make_voice_candidates', { engine: config.engine, description: description(config), language: config.language });
      if (generation !== voiceGeneration) return;
      for (const [index, candidate] of result.candidates.entries()) {
        const row = document.createElement('div'); row.className = 'voice-candidate';
        const play = button(`▶ 候補${index + 1}`, async () => { await playSample(candidate.audio_b64); });
        const choose = button('この声を使う', async () => {
          if (generation !== voiceGeneration) return;
          if (result.expires_at && Date.now() / 1000 > result.expires_at) { voiceStatus('候補の有効期限が切れました。候補を作り直してください。'); return; }
          choose.disabled = true;
          voiceStatus('選んだ声を保存しています…');
          try {
            const chosen = await invoke<{ ref_id: string; seed?: number }>('choose_voice_candidate', { engine: config.engine, label: input('voice-label').value.trim() || profile.name || 'Desktopの声', audioB64: candidate.audio_b64, token: candidate.token });
            if (generation !== voiceGeneration) return;
            draft = readDraft();
            if (config.engine === 'irodori') { draft.irodori_ref_id = chosen.ref_id; draft.irodori_caption = config.irodori_caption; }
            else { draft.voxcpm_ref_id = chosen.ref_id; draft.voxcpm_design = config.voxcpm_design; draft.voxcpm_seed = chosen.seed ?? config.voxcpm_seed; }
            fillDraft(); container.replaceChildren(); stopSamples();
            await loadVoices(); voiceStatus('声を登録し、選択しました。「保存」で会話に適用します。');
          } catch (e) { voiceStatus('声を保存できません: ' + String(e)); }
          finally { choose.disabled = false; }
        });
        row.append(play, choose); container.append(row);
      }
      voiceStatus('聴き比べて、使う声を選んでください。');
    } catch (e) { if (generation === voiceGeneration) voiceStatus('候補を作れません: ' + String(e)); }
    finally { makeButton.disabled = false; }
  }

  export function renderResponse(message: DesktopMessage, character = profile) {
    const response = message.response;
    if (!response) return;
    const article = document.createElement('article'); article.className = 'response-message'; article.dataset.messageId = message.id;
    const heading = document.createElement('h3'); heading.textContent = character.name || 'アシスタント'; article.append(heading);
    for (const [index, block] of response.blocks.entries()) {
      const part = document.createElement('div'); part.className = `response-block response-${block.type}`; part.dataset.blockIndex = String(index);
      // Paths remain visible/copyable and use the same escaped link renderer
      // as the agent log. No model-provided HTML is evaluated.
      part.innerHTML = linkifyPaths(block.text);
      if (block.type === 'speech' && block.speaker && block.speaker !== heading.textContent) {
        const speaker = document.createElement('strong'); speaker.textContent = block.speaker + '\n'; part.prepend(speaker);
      }
      article.append(part);
    }
    if (response.blocks.some((b) => b.type === 'speech')) {
      const actions = document.createElement('div'); actions.className = 'message-actions';
      actions.append(button(message.voice ? '▶ 当時の声で再生' : '▶ 再生', () => playResponse(message, message.voice ?? voice, character)));
      if (message.voice) actions.append(button('現在の声で再生', () => playResponse(message, voice, profile)));
      const preview = document.createElement('pre'); preview.className = 'reading-preview'; preview.hidden = true;
      actions.append(button('読みを確認', async () => {
        preview.hidden = false; preview.textContent = '読みを確認中…';
        try {
          const prepared = await Promise.all(response.blocks.filter((b) => b.type === 'speech').map((b) => invoke<DesktopPreparedSpeech>('prepare_speech', { text: window.KotoniaSpeech.stripMarkdown(b.text), voice: message.voice ?? voice })));
          preview.textContent = prepared.map(readingText).join('\n\n');
        } catch (e) { preview.textContent = String(e); }
      }));
      article.append(actions, preview);
    }
    logEl.append(article); logEl.scrollTop = logEl.scrollHeight;
  }

  export function init() {
    ready = (async () => {
      const info = await personaInfoPromise;
      if (!info) throw new Error('声の初期設定を読み込めませんでした');
      voice = info.default_voice;
      try {
        const saved = localStorage.getItem(VOICE_KEY);
        if (saved) voice = await invoke<DesktopVoiceConfig>('validate_voice', { voice: JSON.parse(saved) });
      } catch (e) { appendLog('error', '保存済みの声を読み込めないため既定の声を使います: ' + String(e)); }
      element('btn-history').addEventListener('click', () => { showDialog('history-modal'); void refreshHistory(); });
      element('history-close').addEventListener('click', () => hideDialog('history-modal', 'btn-history'));
      element('history-refresh').addEventListener('click', () => { void refreshHistory(); });
      input('history-search').addEventListener('input', renderHistory);
      element('btn-voice-settings').addEventListener('click', () => {
        ++voiceGeneration; stopSamples(); draft = copy(voice); fillDraft();
        input('voice-label').value = profile.name || 'Desktopの声';
        element('voice-candidates').replaceChildren(); element('voice-reading-preview').hidden = true;
        showDialog('voice-settings-modal'); void loadVoices();
      });
      const closeVoice = () => { ++voiceGeneration; stopSamples(); void stopSpeech().catch((e) => appendLog('error', String(e))); hideDialog('voice-settings-modal', 'btn-voice-settings'); };
      element('voice-settings-close').addEventListener('click', closeVoice);
      select('voice-engine').addEventListener('change', () => {
        const nextEngine = select('voice-engine').value as DesktopVoiceConfig['engine'];
        select('voice-engine').value = draft.engine;
        try { draft = readDraft(); } catch (e) { voiceStatus(String(e)); return; }
        draft.engine = nextEngine;
        if (nextEngine !== 'voxcpm') draft.language = 'ja';
        ++voiceGeneration; stopSamples(); fillDraft(); element('voice-candidates').replaceChildren(); void loadVoices();
      });
      select('voice-reference').addEventListener('change', () => {
        const picked = refVoices.find((v) => v.ref_id === select('voice-reference').value);
        if (picked) textArea('voice-description').value = picked.description || '';
      });
      for (const id of ['voice-description', 'voice-language']) element(id).addEventListener('input', () => { ++voiceGeneration; element('voice-candidates').replaceChildren(); });
      element('voice-reload').addEventListener('click', () => { void loadVoices(); });
      element('voicevox-reload').addEventListener('click', () => { void loadVoices(); });
      element('voice-seed-roll').addEventListener('click', () => { input('voice-seed').value = String(crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff); });
      element('voice-sample').addEventListener('click', async () => {
        try {
          const ref = select('voice-reference').value;
          if (!ref) throw new Error('登録済みの声を選んでください');
          await playSample(await invoke<string>('voice_sample', { engine: select('voice-engine').value, refId: ref }));
        } catch (e) { voiceStatus(String(e)); }
      });
      element('voice-make-candidates').addEventListener('click', () => { void makeCandidates().catch((e) => voiceStatus(String(e))); });
      element('voice-preview-reading').addEventListener('click', () => { void previewDraft(false).catch((e) => voiceStatus(String(e))); });
      element('voice-test-play').addEventListener('click', () => { void previewDraft(true).catch((e) => voiceStatus(String(e))); });
      element<HTMLFormElement>('voice-settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const next = readDraft();
          const validated = await invoke<DesktopVoiceConfig>('validate_voice', { voice: next });
          if (hasSavedSession()) await invoke('save_session_preferences', { sessionId, profile, voice: validated });
          localStorage.setItem(VOICE_KEY, JSON.stringify(validated));
          await stopSpeech(); voice = validated; closeVoice();
        } catch (e) { voiceStatus('設定を保存できません: ' + String(e)); }
      });
      document.addEventListener('keydown', (event) => {
        const dialog = ['voice-settings-modal', 'history-modal'].map((id) => element(id)).find((el) => !el.classList.contains('hidden'));
        if (event.key === 'Tab' && dialog) {
          const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter((el) => el.offsetParent !== null);
          const first = focusable[0]; const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
        }
        if (event.key === 'Escape') {
          if (!element('voice-settings-modal').classList.contains('hidden')) closeVoice();
          else if (!element('history-modal').classList.contains('hidden')) hideDialog('history-modal', 'btn-history');
        }
      });
      let previous: string | null = null;
      try { previous = localStorage.getItem(LAST_SESSION_KEY); } catch {}
      if (previous) await openSession(previous, true);
      else if (homeMode) await startHomeRunner();
      rememberEnabled = true;
    })().catch((e) => { appendLog('error', String(e)); });
    return ready;
  }
}
