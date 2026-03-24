# Auth Gate Before Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the app from hanging when the user clicks "New Conversation" without completing Claude Code authentication.

**Architecture:** Add a Claude auth verification phase to `ProjectStateService.ensureContainersRunning()` — after containers are started but before status becomes `'ready'`. Backend `start_chat` gets a pre-flight auth check that returns a clear error instead of hanging. The shell overlay shows an "auth required" state with a button to open the auth terminal.

**Tech Stack:** Rust (Tauri backend), Angular (frontend), Vitest (Angular tests), Rust `#[test]` (backend tests)

---

## Root Cause

When Claude Code inside the container has not been authenticated (no OAuth / no API key), calling `start_chat` spawns `claude` which blocks on stdin waiting for interactive login. The frontend awaits stream-json on stdout that never comes. Result: permanent hang.

The app has no auth gate — `SetupState::is_complete()` does not check `claude_authorized`, the setup wizard has no auth step, and `start_chat` does not verify auth before spawning.

## Fix Strategy

Two layers:

1. **Backend** (`start_chat`): Check `claude auth status` before spawning the interactive session. Return a typed error `"Claude is not authenticated"` so the frontend can handle it.

2. **Frontend** (`ProjectStateService` + `ShellComponent`): After containers reach `'ready'`, verify auth via the existing `get_auth_status` command. If not authenticated, show an `'auth_required'` overlay with an "Authenticate" button that calls `open_auth_terminal`. Poll for auth completion.

## Files to modify

| File                                                         | Change                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `desktop/src-tauri/src/main.rs:63`                           | Add auth pre-flight check in `start_chat`                              |
| `desktop/src/src/app/services/project-state.service.ts`      | Add `'auth_required'` status + auth check phase after containers ready |
| `desktop/src/src/app/shell/shell.component.ts`               | Add auth_required overlay with "Authenticate" button                   |
| `desktop/src/src/app/services/project-state.service.spec.ts` | Tests for new auth phase                                               |
| `desktop/src/src/app/shell/shell.component.spec.ts`          | Tests for auth_required overlay                                        |
| `desktop/src-tauri/src/main.rs` (tests)                      | Test that start_chat rejects unauthed projects                         |
| `docs/architecture/security.md`                              | Document auth gate                                                     |

---

### Task 1: Backend — auth pre-flight in `start_chat`

**Files:**

- Modify: `desktop/src-tauri/src/main.rs:62-75`

The `start_chat` Tauri command currently calls `ChatSession::start()` directly, which spawns `claude` without verifying auth. Add a check using the existing `setup_wizard::check_claude_auth()` function. This runs `claude auth status` inside the container — it exits with code 0 if authed, non-zero otherwise. It does NOT hang (unlike the interactive `claude` session).

- [ ] **Step 1: Write the failing test**

In `desktop/src-tauri/src/main.rs` test module, add a source-level structural test (follows the established pattern from `setup_wizard.rs`):

```rust
#[test]
fn start_chat_checks_auth_before_session_start() {
    let source = include_str!("main.rs");
    // Extract the start_chat function body
    let fn_start = source
        .find("fn start_chat(")
        .expect("start_chat function must exist");
    let body_start = source[fn_start..]
        .find('{')
        .map(|i| fn_start + i)
        .expect("start_chat must have a body");
    // Find matching closing brace (count nesting)
    let mut depth = 0u32;
    let mut body_end = body_start;
    for (i, ch) in source[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = body_start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &source[body_start..=body_end];

    let auth_pos = body
        .find("check_claude_auth")
        .expect("start_chat must call check_claude_auth before starting session");
    let start_pos = body
        .find("session.start(")
        .expect("start_chat must call session.start()");

    assert!(
        auth_pos < start_pos,
        "check_claude_auth must come BEFORE session.start()"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-rust` (or `cargo test --package speedwave-desktop start_chat_checks_auth`)
Expected: FAIL — `start_chat must call check_claude_auth`

- [ ] **Step 3: Implement the auth check**

In `desktop/src-tauri/src/main.rs`, modify `start_chat` (line 62-75):

```rust
#[tauri::command]
fn start_chat(
    project: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<SharedChatSession>,
) -> Result<(), String> {
    check_project(&project)?;

    // Pre-flight: verify Claude is authenticated before spawning an
    // interactive session.  `claude auth status` exits quickly with a
    // non-zero code when not authed — no hang risk.
    let authed = setup_wizard::check_claude_auth(&project).map_err(|e| e.to_string())?;
    if !authed {
        return Err("Claude is not authenticated. Please authenticate first.".to_string());
    }

    let mut session = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    session.stop().map_err(|e| e.to_string())?;
    *session = ChatSession::new(&project);
    session.start(app_handle, None).map_err(|e| e.to_string())
}
```

Add the import at the top of the file if not already present:

```rust
use super::setup_wizard;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `make test-rust`
Expected: PASS

- [ ] **Step 5: Run clippy**

Run: `make check-clippy`
Expected: No new warnings

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/main.rs
git commit -m "fix(desktop): add auth pre-flight check in start_chat to prevent hang"
```

---

### Task 2: Frontend — add `auth_required` status to ProjectStateService

**Files:**

- Modify: `desktop/src/src/app/services/project-state.service.ts`
- Test: `desktop/src/src/app/services/project-state.service.spec.ts`

After containers are running (`status = 'ready'`), check auth via the existing `get_auth_status` Tauri command. If not authenticated, set `status = 'auth_required'` instead of `'ready'`.

- [ ] **Step 1: Write the failing tests**

Add to `desktop/src/src/app/services/project-state.service.spec.ts`:

```typescript
describe('auth gate', () => {
  it('transitions to auth_required when Claude is not authenticated', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_bundle_reconcile_state':
          return { in_progress: false, last_error: null };
        case 'run_system_check':
          return undefined;
        case 'check_containers_running':
          return true;
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: false };
        default:
          return undefined;
      }
    };

    await service.init();
    expect(service.status).toBe('auth_required');
  });

  it('transitions to ready when Claude is authenticated', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_bundle_reconcile_state':
          return { in_progress: false, last_error: null };
        case 'run_system_check':
          return undefined;
        case 'check_containers_running':
          return true;
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: true };
        default:
          return undefined;
      }
    };

    await service.init();
    expect(service.status).toBe('ready');
  });

  it('transitions to ready when API key is configured', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_bundle_reconcile_state':
          return { in_progress: false, last_error: null };
        case 'run_system_check':
          return undefined;
        case 'check_containers_running':
          return true;
        case 'get_auth_status':
          return { api_key_configured: true, oauth_authenticated: false };
        default:
          return undefined;
      }
    };

    await service.init();
    expect(service.status).toBe('ready');
  });

  it('retryAuth re-checks auth and transitions to ready when authed', async () => {
    let authResponse = { api_key_configured: false, oauth_authenticated: false };
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_bundle_reconcile_state':
          return { in_progress: false, last_error: null };
        case 'run_system_check':
          return undefined;
        case 'check_containers_running':
          return true;
        case 'get_auth_status':
          return authResponse;
        default:
          return undefined;
      }
    };

    await service.init();
    expect(service.status).toBe('auth_required');

    // Simulate user completing auth
    authResponse = { api_key_configured: false, oauth_authenticated: true };
    await service.retryAuth();
    expect(service.status).toBe('ready');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `make test-angular`
Expected: FAIL — `auth_required` is not a valid `ProjectStatus`, `retryAuth` does not exist

- [ ] **Step 3: Add `auth_required` status and auth check logic**

Modify `desktop/src/src/app/services/project-state.service.ts`:

1. Add `'auth_required'` to `ProjectStatus` type (line 6-15):

```typescript
export type ProjectStatus =
  | 'loading'
  | 'system_check'
  | 'check_failed'
  | 'checking'
  | 'starting'
  | 'rebuilding'
  | 'auth_required'
  | 'ready'
  | 'switching'
  | 'error';
```

2. Add the `AuthStatusResponse` interface (after the type):

```typescript
interface AuthStatusResponse {
  api_key_configured: boolean;
  oauth_authenticated: boolean;
}
```

3. In `ensureContainersRunning()`, after `this.status = 'ready'` (line 148), add auth check:

Replace lines 148-149:

```typescript
this.status = 'ready';
```

With:

```typescript
// Phase 3: verify Claude authentication before declaring ready
const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
  project: this.activeProject,
});
if (auth.api_key_configured || auth.oauth_authenticated) {
  this.status = 'ready';
} else {
  this.status = 'auth_required';
}
```

4. Add `retryAuth()` method (after `dismissError()`):

```typescript
  /** Re-checks Claude auth status after user completes authentication. */
  async retryAuth(): Promise<void> {
    if (!this.activeProject) return;
    try {
      const auth = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', {
        project: this.activeProject,
      });
      if (auth.api_key_configured || auth.oauth_authenticated) {
        this.status = 'ready';
        this.notifyChange();
        this.notifyReady();
        this.notifySettled();
      }
    } catch {
      // Auth check failed — stay in auth_required
    }
  }
```

5. Add `'auth_required'` to the guard in `ensureContainersRunning()` (line 108-112):

```typescript
if (
  this.status === 'system_check' ||
  this.status === 'checking' ||
  this.status === 'starting' ||
  this.status === 'auth_required'
) {
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make test-angular`
Expected: All new tests PASS. Existing tests may need adjustment if they assert `status === 'ready'` after containers start — they now need to mock `get_auth_status` to return an authenticated response.

- [ ] **Step 5: Fix any broken existing tests**

Existing tests in `project-state.service.spec.ts` that expect `status = 'ready'` after `ensureContainersRunning` will break because `get_auth_status` is not mocked. Add `get_auth_status` to the default mock handler in existing tests:

```typescript
case 'get_auth_status':
  return { api_key_configured: false, oauth_authenticated: true };
```

- [ ] **Step 6: Run check**

Run: `make check`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add desktop/src/src/app/services/project-state.service.ts desktop/src/src/app/services/project-state.service.spec.ts
git commit -m "fix(desktop): add auth gate in ProjectStateService before declaring ready"
```

---

### Task 3: Frontend — auth_required overlay in ShellComponent

**Files:**

- Modify: `desktop/src/src/app/shell/shell.component.ts`
- Test: `desktop/src/src/app/shell/shell.component.spec.ts`

Add an overlay for `'auth_required'` status that shows a message and an "Authenticate" button calling `open_auth_terminal`.

- [ ] **Step 1: Write the failing tests**

Add to `desktop/src/src/app/shell/shell.component.spec.ts`:

```typescript
it('shows auth-required overlay when status is auth_required', async () => {
  await component.ngOnInit();
  projectState.status = 'auth_required';
  component['cdr'].markForCheck();
  fixture.detectChanges();

  const overlay = fixture.nativeElement.querySelector('[data-testid="blocking-auth-required"]');
  expect(overlay).not.toBeNull();
  expect(overlay.textContent).toContain('Authentication Required');
});

it('auth-required overlay has authenticate button', async () => {
  await component.ngOnInit();
  projectState.status = 'auth_required';
  component['cdr'].markForCheck();
  fixture.detectChanges();

  const btn = fixture.nativeElement.querySelector('[data-testid="auth-authenticate-btn"]');
  expect(btn).not.toBeNull();
});

it('auth-required overlay has check-status button', async () => {
  await component.ngOnInit();
  projectState.status = 'auth_required';
  component['cdr'].markForCheck();
  fixture.detectChanges();

  const btn = fixture.nativeElement.querySelector('[data-testid="auth-check-btn"]');
  expect(btn).not.toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `make test-angular`
Expected: FAIL — `blocking-auth-required` not found

- [ ] **Step 3: Add auth_required overlay to template**

In `desktop/src/src/app/shell/shell.component.ts`, add new `@else if` block after the `check_failed` block (after line 47, before the `error` block at line 48):

```html
} @else if (projectState.status === 'auth_required') {
<div
  class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-sw-bg-darkest"
  data-testid="blocking-auth-required"
>
  <span class="text-sw-accent text-lg font-mono font-bold">Authentication Required</span>
  <p class="mt-4 max-w-lg text-center font-mono text-sm text-sw-text-muted">
    Claude Code needs to be authenticated before you can start a conversation. Click "Authenticate"
    to open a terminal and complete the login.
  </p>
  <div class="mt-6 flex gap-3">
    <button
      class="px-6 py-2.5 rounded text-sm font-semibold font-mono border-none cursor-pointer transition-colors bg-sw-accent text-white hover:bg-sw-accent-hover"
      data-testid="auth-authenticate-btn"
      (click)="openAuthTerminal()"
    >
      Authenticate
    </button>
    <button
      class="px-6 py-2.5 rounded text-sm font-semibold font-mono border border-sw-border bg-transparent text-sw-text cursor-pointer transition-colors hover:bg-sw-bg-dark"
      data-testid="auth-check-btn"
      (click)="checkAuth()"
    >
      Check Status
    </button>
  </div>
</div>
```

Add the `TauriService` inject and methods to the component class:

```typescript
private tauri = inject(TauriService);

/** Opens a native terminal for Claude OAuth login. */
async openAuthTerminal(): Promise<void> {
  const project = this.projectState.activeProject;
  if (project) {
    try {
      await this.tauri.invoke('open_auth_terminal', { project });
    } catch (err) {
      this.projectState.error = `Failed to open terminal: ${err}`;
      this.cdr.markForCheck();
    }
  }
}

/** Re-checks auth status after user completes authentication. */
async checkAuth(): Promise<void> {
  await this.projectState.retryAuth();
  this.cdr.markForCheck();
}
```

Add `TauriService` import:

```typescript
import { TauriService } from '../services/tauri.service';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make test-angular`
Expected: PASS

- [ ] **Step 5: Run check**

Run: `make check`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add desktop/src/src/app/shell/shell.component.ts desktop/src/src/app/shell/shell.component.spec.ts
git commit -m "fix(desktop): add auth_required overlay with authenticate button"
```

---

### Task 4: Frontend — handle auth error in ChatStateService

**Files:**

- Modify: `desktop/src/src/app/services/chat-state.service.ts:115-127`
- Test: `desktop/src/src/app/services/chat-state.service.spec.ts`

When `start_chat` returns the new `"Claude is not authenticated"` error from Task 1, surface it as `auth_required` status instead of generic error.

- [ ] **Step 1: Write the failing test**

Add to `desktop/src/src/app/services/chat-state.service.spec.ts`:

```typescript
it('surfaces auth error as auth_required status', async () => {
  const projectState = TestBed.inject(ProjectStateService);
  await projectState.init();

  mockTauri.invokeHandler = async (cmd: string) => {
    if (cmd === 'start_chat')
      throw new Error('Claude is not authenticated. Please authenticate first.');
    if (cmd === 'list_projects')
      return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
    return undefined;
  };

  await service.init();
  expect(projectState.status).toBe('auth_required');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-angular`
Expected: FAIL — `projectState.status` is `'error'` not `'auth_required'`

- [ ] **Step 3: Update error handling in startChatSession**

In `desktop/src/src/app/services/chat-state.service.ts`, modify `startChatSession()` (lines 115-127):

```typescript
  private async startChatSession(): Promise<void> {
    const project = this.projectState.activeProject;
    if (project) {
      try {
        await this.tauri.invoke('start_chat', { project });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('not authenticated')) {
          this.projectState.status = 'auth_required';
        } else {
          console.error('Failed to start chat session:', err);
          this.projectState.status = 'error';
          this.projectState.error = `Failed to start chat session: ${err}`;
        }
        this.notifyChange();
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make test-angular`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/src/src/app/services/chat-state.service.ts desktop/src/src/app/services/chat-state.service.spec.ts
git commit -m "fix(desktop): route auth errors from start_chat to auth_required status"
```

---

### Task 5: Documentation

**Files:**

- Modify: `docs/architecture/security.md`

- [ ] **Step 1: Add auth gate section**

In `docs/architecture/security.md`, add after the "OS Prerequisite Checks" section:

```markdown
### Authentication Gate

Claude Code must be authenticated (OAuth or API key) before the app allows
chat access. This is enforced at two layers:

- **Backend (`start_chat`):** Runs `claude auth status` inside the container
  before spawning an interactive session. Returns an error if not authenticated,
  preventing the hang that would occur if Claude prompts for interactive login
  on stdin while the frontend waits for stream-json on stdout.

- **Frontend (`ProjectStateService`):** After containers are running, checks
  `get_auth_status`. If neither OAuth nor API key is configured, sets status to
  `auth_required` which shows an overlay with an "Authenticate" button. The
  button opens a native terminal (`open_auth_terminal`) for the user to complete
  OAuth login via the CLI.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/security.md
git commit -m "docs: document auth gate before chat access"
```

---

### Task 6: Integration verification

- [ ] **Step 1: Run full test suite**

Run: `make test`
Expected: All tests pass (Rust + Angular + MCP + entrypoint)

- [ ] **Step 2: Run full check**

Run: `make check`
Expected: Clean (clippy + lint + type-check + format)

- [ ] **Step 3: Manual test**

1. `make dev` — start app
2. Verify: after setup, if Claude is not authenticated, you see "Authentication Required" overlay
3. Click "Authenticate" — native terminal opens with `speedwave` CLI
4. Complete OAuth in terminal
5. Click "Check Status" — overlay disappears, chat is accessible
6. Click "New Conversation" — chat starts normally

---

## Verification

```bash
make test          # all tests pass
make check         # clippy clean
```

Manual test:

1. Fresh setup → auth overlay appears before chat
2. After auth → overlay disappears → chat works
3. If auth revoked → `start_chat` returns error → overlay reappears
