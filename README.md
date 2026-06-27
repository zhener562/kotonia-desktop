# kotonia-desktop

Tauri 2 shell around `kotonia-cli`'s agent loop.

The agent loop runs **in-process** so the model can drive the user's PC
directly via bash. LLM inference is **not bundled**: completions go to
`https://kotonia.ai/api/v1/chat/completions` using the `device_token`
written by `kotonia-cli login` (under `~/.kotonia/daemon.json`). This means
the desktop binary stays small and the heavy GPU work happens on the
hosted backend.

## Status (T0.5 MVP)

- single-window vanilla HTML/JS shell
- prompt input + event log + approval modal
- per-session worktree-less `in_place` workspace under
  `~/.kotonia/desktop/workspace/`
- approval mode: `allowlist` (gates destructive shell commands)
- session history persisted to `~/.kotonia/sessions/<id>.jsonl`
  (auto-resumed on session id reuse)
- multi-turn within one session id; `新規` button starts a fresh session
- **Ctrl+click (macOS は Cmd+click) で path を OS の既定アプリで開く**:
  observation / final-answer / bash 行のテキストを path-shaped token で
  scan して clickable span にする。`/`, `~/`, `./`, `../` で始まるトークン
  を拾う。`https://...` 等の URL は弾く (lookbehind)。plain click は
  選択コピー用に no-op。
- **`.html` / `.htm` パスの隣に `▶ play` ボタン**: クリックで右ペインに
  iframe を出してその場で開ける。Tauri 2 の asset protocol 経由 (
  `tauri.conf.json:app.security.assetProtocol` に scope 設定済み:
  `~/.kotonia/desktop/workspace/**` + `/tmp/**`)。
  iframe は `sandbox="allow-scripts allow-same-origin allow-pointer-lock"`
  なので JS は動く + `localStorage` で hi-score 保存もできる + マウス
  ロック (FPS 風) も使える。閉じると `about:blank` に飛ばすので BGM や
  アニメーションの CPU が残らない。再生中の HTML は ↻ で再読み込み、
  ↗ で OS の既定アプリへ、× で閉じる。トップバーの `▶ プレビュー` トグル
  で同じ HTML を再表示できる (初めて HTML を見たあとに出現)。

Not yet shipped: workspace directory picker, model selector,
`/chat/personas` style character UI, voice / Ditto, kotonia.ai webview
(T1 milestones).

## Prerequisites

### Linux dev deps

```sh
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  librsvg2-dev \
  libxdo-dev \
  libssl-dev \
  libdbus-1-dev \
  libayatana-appindicator3-dev \
  build-essential pkg-config \
  curl wget file
```

`libdbus-1-dev` is pulled in via Tauri 2's `muda` (menu) crate even when
no tray/menu features are explicitly enabled — without it the build fails
at `libdbus-sys`. Runtime libs (`libwebkit2gtk-4.1-0`, `libssl3t64`, etc.)
should already be present from the rest of the project's setup.

### Tauri CLI

```sh
cargo install tauri-cli --version "^2.0"
```

### Login to kotonia.ai

The desktop app reads the device token left behind by:

```sh
kotonia-cli login
```

(opens a verification URL, polls for approval, writes
`~/.kotonia/daemon.json`). Without that file `submit_task` returns an
explicit "not logged in" error.

## Run (dev)

```sh
cd crates/kotonia-desktop/src-tauri
cargo tauri dev
```

The first build pulls down Tauri's full dep tree (~150 crates, 5-10 min on
the first compile). Subsequent runs are fast.

## Build (release, unbundled)

```sh
cd crates/kotonia-desktop/src-tauri
cargo build --release
```

Binary at `target/release/kotonia-desktop`.

For installer/bundle output:

```sh
cargo tauri build
```

That step needs proper signing config + a real icon set (see
`tauri.conf.json:bundle.icon`); the bundled `icons/icon.png` is a 32×32
placeholder.

## Architecture

```
Tauri WebView (frontend/index.html + main.js)
   │
   │ invoke('submit_task', { prompt, sessionId })
   ▼
#[tauri::command] commands::submit_task
   │
   │ tokio::spawn
   ▼
SessionState (per session_id)
   │
   ├── DispatchAgent::ReAct(Agent)
   │       Provider = kotonia (https://kotonia.ai/api/v1, device_token)
   │
   ├── EventSink → TauriEventSink → app.emit("agent_event", ...)
   │
   └── ApprovalHandler → TauriApprovalHandler
           │
           │ app.emit("approval_request", ...) + block on mpsc
           ▼
     [JS modal] → invoke('respond_approval', { approvalId, approved })
           │
           ▼
     std::sync::mpsc::Sender<bool>.send(...)
           │
           ▼
     run_turn resumes
```

`SessionRegistry` (RwLock<HashMap>) keeps each session's `Agent` alive
across `submit_task` calls so multi-turn conversations thread through the
same in-memory message history and the same `~/.kotonia/sessions/<id>.jsonl`
on disk.

## Known limits / future work

- Workspace is hardcoded to `~/.kotonia/desktop/workspace/`. T1 = picker.
- Model is hardcoded to `kotonia-gemma4-26b`. T1 = selector.
- No "character chat" UI surface yet; this is the bare ReAct console. T1
  embeds the existing `/chat/studio` web UI in a second webview, sharing
  the kotonia.ai session cookie for full persona/voice access.
- No session GC; abandoned sessions accumulate in
  `~/.kotonia/sessions/*.jsonl`. Mirror the daemon's 30 min idle GC in T1.
- macOS / Windows code signing not wired. Linux runs fine unsigned.
- **Linux IME (preedit) — known upstream issue, ship-blocking only on
  Linux/Wayland+ibus**: typing Japanese in the textarea shows the
  committed string fine but the preedit (henkan-chu underlined chars)
  is invisible until Enter commits. Reproduced on Ubuntu 24.04 + GNOME
  Wayland + ibus-mozc + WebKitGTK 2.52.3. macOS WKWebView and Windows
  WebView2 are unaffected.
  - Env knobs you can try at launch (none restored preedit on the
    primary tested setup, may help on others):
    - `GDK_BACKEND=x11` — go through XWayland instead of native
      Wayland. Side effect: HiDPI fractional scaling on Wayland is
      lost.
    - `WEBKIT_FORCE_SANDBOX=0` — disable the WebProcess sandbox in
      case it blocks the IBus AF_UNIX socket. Side effect: less
      isolation for the WebView (matters mainly if you load
      untrusted remote HTML — not relevant here).
    - `WEBKIT_DISABLE_DMABUF_RENDERER=1` /
      `WEBKIT_DISABLE_COMPOSITING_MODE=1` — rendering path overrides.
    - `GTK_IM_MODULE=xim` — **do not use with ibus-mozc**, breaks
      input entirely on Ubuntu's default setup.
  - Workarounds if you really need to type long Japanese now: compose
    in an external editor and paste. T1 may add a "compose in
    $EDITOR" button if this becomes a recurring problem.
