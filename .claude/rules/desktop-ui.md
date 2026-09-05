---
paths:
  - 'desktop/src/**'
  - 'desktop/src-tauri/src/main.rs'
  - 'desktop/src-tauri/src/chat.rs'
  - 'desktop/src-tauri/tauri.conf.json'
---

# Desktop UI Rules (Angular + Tauri)

- **Zoneless + OnPush: service state read by a template MUST be a signal.** A template reading a plain service property renders stale — nothing schedules change detection. New service fields consumed by templates are signals (or computed) from day one.
- **Rust ↔ TS model mirrors are silent-failure surfaces:** Tauri command return types and their `models/*.ts` counterparts must match exactly — the JSON deserializer silently drops unknown/mismatched fields. Update both sides in the same commit; for a new mirrored constant/union add an `include_str!` cross-read test on the Rust side (grep `_matches_ts` for the pattern).
- **State-tree rendering:** a new `MessageBlock` variant lands in Rust first, then `models/state-tree.ts::MessageBlockState`, then a renderer arm in `chat-state.service.ts::stateBlocksToMessageBlocks` — its default arm surfaces unknown kinds as error blocks in front of the user, which is the only drift catch.
- **Model catalog:** Anthropic model strings come from `AnthropicModelsService` (backed by `list_anthropic_models`) — never hard-code a model id in Angular.
- **Beta gate:** work-in-progress Desktop surfaces ship behind the beta toggle — `BetaService` signal + the beta-enabled route guard. The flag (`ui.beta_enabled`) is user-config-only (repo `.speedwave.json` cannot set it) and is a UI visibility gate, never a security boundary.
- **Tray menu:** any new variable input to the tray menu goes into `TrayMenuState` and rebuilds through the single `refresh_tray_menu` path — a second rebuild path silently drops the other inputs.
- **CSP:** the webview CSP in `tauri.conf.json` is load-bearing on Windows (WebView2 enforces strictly; WKWebView is lenient) — e.g. `img-src 'self' blob: data:` is what makes pasted images render; changes are pinned by a test in `main.rs`.
- **TypeScript in `desktop/src` is capped by Angular's peer range** (`@angular/compiler-cli` declares it, e.g. `>=6.0 <6.1` for v22): a TypeScript bump beyond that range cannot install, so Dependabot majors for `typescript` here are rejected until an Angular major lifts the cap (`ignore` rule in `dependabot.yml`). Angular packages peer-pin each other to the exact version — bump the whole set in one PR via `ng update`, never one package.
- **`ng serve` gives a `PORT` env var priority over `angular.json` (Angular 22+)** while Tauri's `devUrl` stays fixed at the same port — `make dev` therefore launches Tauri under `env -u PORT` (guard: `_tests/desktop/dev-server-port.bats`, which also pins `angular.json` serve port ↔ `tauri.conf.json` `devUrl`).
- **`~/.claude/settings.json` in the container must stay a writable copy, not a symlink into a read-only mount** — Claude Code writes to it (`/effort`, `/model`).
