// Run after build:frontend with an installed Playwright module:
// KOTONIA_PLAYWRIGHT_MODULE=/path/to/@playwright/test node --test frontend/tests/desktop-ui.e2e.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const playwright = require(process.env.KOTONIA_PLAYWRIGHT_MODULE
  ? path.resolve(process.env.KOTONIA_PLAYWRIGHT_MODULE) : '@playwright/test');
const { expect } = playwright;
const root = path.resolve(__dirname, '..');
let server;
let origin;
before(async () => {
  server = http.createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) throw new Error('outside frontend');
      const content = await fs.readFile(file);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html');
      response.end(content);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function mockIPC(page, restore = false) {
  await page.addInitScript(({ restore }) => {
    const voice = {
      engine: 'voxcpm', language: 'ja', speed: 1,
      voxcpm_design: '落ち着いた声', voxcpm_ref_id: '', voxcpm_seed: null,
      irodori_caption: '落ち着いた声', irodori_ref_id: '', irodori_seed: null,
      voicevox_speaker: 1, base_instruct: '', irodori_readings: true, reading_overrides: {},
    };
    const profile = { name: '過去のキャラ', tagline: '以前の会話', systemPrompt: 'old rules', persona: 'old persona', avatarPath: '' };
    const oldVoice = { ...voice, engine: 'irodori', irodori_ref_id: 'ref-old', irodori_seed: 42 };
    const response = { version: 1, blocks: [{ type: 'speech', speaker: '過去のキャラ', text: 'GitHubのAPIを確認しました。' }, { type: 'artifact', text: '/tmp/result.html' }] };
    const old = { id: 's_old', context: { workspace: '/tmp/original', engine: 'claude-code', model: 'claude-code', profile, voice: oldVoice, home: false }, messages: [{ id: 'm_old', role: 'assistant', content: 'transport', response, voice: oldVoice }] };
    const listeners = {};
    window.ipcCalls = []; window.startedAudio = []; window.stoppedAudio = 0;
    window.testStreamMode = 'normal'; window.testDecodeDelay = 0;
    window.emitDesktop = (name, payload) => (listeners[name] || []).forEach((handler) => handler({ payload }));
    window.__TAURI__ = {
      core: {
        convertFileSrc: (p) => '/persona/eve.png',
        invoke: async (command, args = {}) => {
          window.ipcCalls.push({ command, args: JSON.parse(JSON.stringify(args)) });
          switch (command) {
            case 'persona_info': return { default_system_prompt: 'default rules', eve_persona: 'Eve persona', default_voice: voice };
            case 'auth_status': return { logged_in: true, server: 'mock', device_id_prefix: 'abcd' };
            case 'shell_info': return { kind: 'bash', path: '/bin/bash', is_busybox: false };
            case 'check_for_update': return null;
            case 'cancel_speech': return null;
            case 'close_browser': return null;
            case 'home_stop_runner': return null;
            case 'validate_voice': return args.voice;
            case 'save_session_preferences': old.context.voice = args.voice; return null;
            case 'new_session': return 's_fresh';
            case 'list_sessions':
              if (window.failNextHistory) { window.failNextHistory = false; throw new Error('history offline'); }
              return [{ id: 's_old', title: '以前の相談', preview: '過去の回答', updated_at: '2026-11-05T00:00:00Z', character: profile.name, workspace: '/tmp/original', engine: 'claude-code', legacy: false }];
            case 'open_session': return old;
            case 'export_session':
              if (window.failNextExport) { window.failNextExport = false; throw new Error('disk full'); }
              return null;
            case 'list_ref_voices':
              if (window.failNextVoices) { window.failNextVoices = false; throw new Error('voices offline'); }
              return { voices: [{ ref_id: 'voice-1', label: '選べる声', description: 'やわらかな声' }] };
            case 'voicevox_speakers': return [{ name: '話者', styles: [{ id: 7, name: '普通' }] }];
            case 'voice_sample': return 'UklGRg==';
            case 'make_voice_candidates': return { candidates: [1, 2, 3].map((i) => ({ audio_b64: 'UklGRg==', token: `token-${i}` })), expires_at: 4000000000 };
            case 'choose_voice_candidate': return { ref_id: 'voice-made', seed: 123 };
            case 'prepare_speech': {
              const text = args.voice.engine === 'irodori' && args.voice.irodori_readings ? args.text.replace(/GitHub/g, 'ギットハブ').replace(/API/g, 'エーピーアイ') : args.text;
              return { plan: { text, changes: text !== args.text ? [{ source: 'GitHub', reading: 'ギットハブ' }] : [], spelled_words: [] }, chunks: [text] };
            }
            case 'tts_speak': case 'ditto_speak': {
              window.emitDesktop('tts_chunk', { stream_id: args.streamId, wav_base64: 'AQ==' });
              if (window.testStreamMode === 'normal') window.emitDesktop('tts_done', { stream_id: args.streamId });
              return args.streamId;
            }
            case 'submit_task': {
              // Events can beat the IPC response back to the frontend.
              const message = { id: 'm_live', role: 'assistant', content: 'raw', response: { version: 1, blocks: [{ type: 'speech', text: '修正しました。', delivery: '穏やかに' }, { type: 'artifact', text: '/tmp/result.html' }] }, voice: args.voice };
              window.emitDesktop('agent_event', { task_id: args.taskId, event: { kind: 'final', answer: '', message } });
              window.emitDesktop('agent_event', { task_id: args.taskId, event: { kind: 'done', iterations: 1, success: true } });
              return { task_id: args.taskId, session_id: args.sessionId };
            }
            default: return null;
          }
        },
      },
      event: { listen: async (name, handler) => { (listeners[name] ||= []).push(handler); return () => {}; } },
      dialog: { open: async () => '/tmp/chosen', save: async () => '/tmp/conversation.md' },
    };
    class FakeAudioContext {
      state = 'running'; destination = {}; start = performance.now();
      get currentTime() { return (performance.now() - this.start) / 1000; }
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async decodeAudioData(bytes) { await new Promise((r) => setTimeout(r, window.testDecodeDelay)); return { duration: 0.03, id: new Uint8Array(bytes)[0] }; }
      createBufferSource() {
        return { connect() {}, disconnect() {}, start() { window.startedAudio.push(this.buffer.id); setTimeout(() => this.onended?.(), 30); }, stop() { window.stoppedAudio++; this.onended?.(); } };
      }
    }
    window.AudioContext = FakeAudioContext;
    window.Audio = class { addEventListener() {} pause() {} async play() {} };
    if (restore) localStorage.setItem('kotonia_desktop_last_session', 's_old');
  }, { restore });
  await page.goto(origin);
  await page.waitForFunction(() => window.DesktopUI?.voice && !window.DesktopUI.switching);
  await page.evaluate(() => window.DesktopUI.ready);
}

for (const browserName of (process.env.KOTONIA_E2E_BROWSERS || 'chromium,webkit').split(',')) {
  test(`${browserName}: history, voice, and speech lifecycle`, async (t) => {
    const browser = await playwright[browserName].launch({ headless: true });
    try {
      await t.test('restores the saved workspace/engine/profile and handles early final events', async () => {
        const page = await browser.newPage();
        await mockIPC(page, true);
        await expect(page.locator('#persona-name')).toHaveText('過去のキャラ');
        await expect(page.locator('#workspace-path')).toHaveText('/tmp/original');
        await expect(page.locator('#engine-select')).toHaveValue('claude-code');
        await expect(page.locator('.response-speech')).toHaveText('GitHubのAPIを確認しました。');
        await page.locator('#prompt-input').fill('続けて'); await page.locator('#prompt-submit').click();
        await expect(page.locator('.response-speech').last()).toHaveText('修正しました。');
        await expect(page.locator('#prompt-submit')).toHaveText('送信');
        const submit = await page.evaluate(() => window.ipcCalls.find((c) => c.command === 'submit_task').args);
        assert.equal(submit.workspacePath, '/tmp/original'); assert.equal(submit.engine, 'claude-code');
        assert.equal(submit.voice.irodori_ref_id, 'ref-old'); assert.equal(submit.model, 'claude-code');
        await page.close();
      });
      await t.test('history loading/export failures are retryable without switching the conversation', async () => {
        const page = await browser.newPage(); await mockIPC(page);
        await page.evaluate(() => { window.failNextHistory = true; window.failNextExport = true; });
        await page.locator('#btn-history').click(); await expect(page.locator('#history-status')).toContainText('読み込めません');
        await page.locator('#history-refresh').click(); await expect(page.locator('.history-open')).toContainText('以前の相談');
        await page.locator('.history-export').click(); await expect(page.locator('#history-status')).toContainText('disk full');
        await page.locator('.history-export').click(); await expect(page.locator('#history-status')).toContainText('全文を書き出しました');
        await expect(page.locator('#session-label')).toHaveText('session: —');
        await page.locator('.history-open').click(); await expect(page.locator('#workspace-path')).toHaveText('/tmp/original');
        await page.close();
      });
      await t.test('voice selection, design candidates, reading preview, and save all use runtime settings', async () => {
        const page = await browser.newPage(); await mockIPC(page);
        await page.locator('#btn-voice-settings').click(); await page.locator('#voice-engine').selectOption('irodori');
        await expect(page.locator('#voice-reference option[value="voice-1"]')).toHaveCount(1);
        await page.locator('#voice-reference').selectOption('voice-1');
        await expect(page.locator('#voice-description')).toHaveValue('やわらかな声');
        await page.locator('#voice-preview-reading').click(); await expect(page.locator('#voice-reading-preview')).toContainText('ギットハブ');
        await page.locator('#voice-make-candidates').click(); await expect(page.locator('.voice-candidate')).toHaveCount(3);
        await page.locator('.voice-candidate').first().getByText('この声を使う').click();
        await expect(page.locator('#voice-reference')).toHaveValue('voice-made');
        await page.locator('#voice-reading-overrides').fill('MyTool=マイツール');
        await page.locator('#voice-speed').fill('1.25');
        await page.locator('#voice-settings-form').getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.locator('#voice-settings-modal')).toBeHidden();
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kotonia_desktop_voice_v1')));
        assert.equal(saved.engine, 'irodori'); assert.equal(saved.irodori_ref_id, 'voice-made');
        assert.equal(saved.reading_overrides.MyTool, 'マイツール'); assert.equal(saved.speed, 1.25);
        await page.close();
      });
      await t.test('replay sends speech blocks only, and stop rejects packets still being decoded', async () => {
        const page = await browser.newPage(); await mockIPC(page, true);
        await page.getByText('▶ 当時の声で再生', { exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.ipcCalls.filter((c) => c.command === 'tts_speak').length)).toBe(1);
        await expect(page.locator('#btn-stop-speech')).toBeHidden();
        const first = await page.evaluate(() => window.ipcCalls.find((c) => c.command === 'tts_speak').args);
        assert.equal(first.text, 'ギットハブのエーピーアイを確認しました。');
        assert.equal(first.voice.irodori_ref_id, 'ref-old'); assert.ok(!first.text.includes('result.html'));
        await page.evaluate(() => { window.testStreamMode = 'hold'; window.testDecodeDelay = 200; window.startedAudio = []; });
        await page.getByText('▶ 当時の声で再生', { exact: true }).click();
        await expect(page.locator('#btn-stop-speech')).toBeVisible();
        await page.locator('#btn-stop-speech').click();
        await page.waitForTimeout(300);
        assert.deepEqual(await page.evaluate(() => window.startedAudio), []);
        const commands = await page.evaluate(() => window.ipcCalls.map((c) => c.command));
        assert.ok(commands.includes('cancel_speech'));
        await page.close();
      });
      await t.test('saving a new voice preserves the old message voice and Avatar uses the selected settings', async () => {
        const page = await browser.newPage(); await mockIPC(page, true);
        await page.locator('#btn-voice-settings').click();
        await page.locator('#voice-engine').selectOption('voxcpm');
        await page.locator('#voice-reference').selectOption('voice-1');
        await page.locator('#voice-speed').fill('1.2');
        await page.locator('#voice-settings-form').getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.locator('#voice-settings-modal')).toBeHidden();
        const prefs = await page.evaluate(() => window.ipcCalls.find((c) => c.command === 'save_session_preferences').args);
        assert.equal(prefs.voice.engine, 'voxcpm'); assert.equal(prefs.voice.voxcpm_ref_id, 'voice-1');
        await page.locator('#output-mode').selectOption('avatar');
        await page.getByText('現在の声で再生', { exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.ipcCalls.filter((c) => c.command === 'ditto_speak').length)).toBe(1);
        await expect(page.locator('#btn-stop-speech')).toBeHidden();
        const avatar = await page.evaluate(() => window.ipcCalls.find((c) => c.command === 'ditto_speak').args);
        assert.equal(avatar.voice.engine, 'voxcpm'); assert.equal(avatar.voice.voxcpm_ref_id, 'voice-1');
        assert.equal(avatar.voice.speed, 1.2); assert.ok(avatar.text.includes('GitHub'));
        await page.getByText('▶ 当時の声で再生', { exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.ipcCalls.filter((c) => c.command === 'ditto_speak').length)).toBe(2);
        const previous = await page.evaluate(() => window.ipcCalls.filter((c) => c.command === 'ditto_speak')[1].args);
        assert.equal(previous.voice.irodori_ref_id, 'ref-old'); assert.equal(previous.voice.engine, 'irodori');
        await page.close();
      });
      await t.test('a catalog outage keeps saved voice IDs, and late task events cannot change restored history', async () => {
        const page = await browser.newPage(); await mockIPC(page, true);
        await page.evaluate(() => { window.failNextVoices = true; });
        await page.locator('#btn-voice-settings').click();
        await expect(page.locator('#voice-settings-status')).toContainText('voices offline');
        await expect(page.locator('#voice-reference')).toHaveValue('ref-old');
        await page.locator('#voice-reload').click();
        await expect(page.locator('#voice-reference option[value="voice-1"]')).toHaveCount(1);
        await expect(page.locator('#voice-reference')).toHaveValue('ref-old');
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.emitDesktop('agent_event', { task_id: 'old-task', event: { kind: 'final', response: { version: 1, blocks: [{ type: 'speech', text: '遅れてきた回答' }] } } }));
        await expect(page.locator('.response-speech')).toHaveCount(1);
        await expect(page.locator('.response-speech')).toHaveText('GitHubのAPIを確認しました。');
        await page.close();
      });
      await t.test('an empty new conversation can save a voice without inventing a persisted history record', async () => {
        const page = await browser.newPage(); await mockIPC(page, true);
        await page.locator('#btn-new-session').click();
        await expect(page.locator('.response-message')).toHaveCount(0);
        assert.equal(await page.evaluate(() => localStorage.getItem('kotonia_desktop_last_session')), null);
        await page.locator('#btn-voice-settings').click(); await page.locator('#voice-speed').fill('1.4');
        await page.locator('#voice-settings-form').getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.locator('#voice-settings-modal')).toBeHidden();
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kotonia_desktop_voice_v1')).speed), 1.4);
        assert.equal(await page.evaluate(() => window.ipcCalls.filter((c) => c.command === 'save_session_preferences').length), 0);
        await page.close();
      });
      await t.test('the settings remain usable at 390px width', async () => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); await mockIPC(page);
        await page.locator('#btn-voice-settings').click();
        await page.locator('#voice-engine').selectOption('irodori');
        await expect(page.locator('#voice-reading-overrides')).toBeVisible();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        if (process.env.KOTONIA_E2E_SCREENSHOTS) {
          await fs.mkdir(process.env.KOTONIA_E2E_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.KOTONIA_E2E_SCREENSHOTS, `${browserName}-voice-settings.png`) });
        }
        await page.keyboard.press('Escape'); await expect(page.locator('#voice-settings-modal')).toBeHidden();
        await page.close();
      });
    } finally { await browser.close(); }
  });
}
