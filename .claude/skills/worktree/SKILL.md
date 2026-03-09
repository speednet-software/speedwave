---
name: worktree
description: Manage git worktrees for parallel feature development with isolated dependency installs.
disable-model-invocation: true
argument-hint: 'new | list | close <branch-name>'
allowed-tools: Bash(git *), Bash(make *), Bash(npm *), Bash(cargo *), Bash(cat *), Bash(sleep *), Bash(mkdir *), Bash(rm *), Bash(which *), Bash(ln *), Bash(cd *), Bash(ls *), Bash(lsof *), Bash(pkill *), AskUserQuestion, Read, Write, Glob
---

Manage git worktrees for parallel feature development on Speedwave. Parse `$ARGUMENTS` to determine the subcommand.

**All dev commands go through the root Makefile** — never call `cargo`, `npm run`, or `npx` directly for operations that have a `make` target.

## Constants

- **MAIN_REPO**: Output of `git -C "$PWD" rev-parse --show-toplevel` when running from the main repo, or the main worktree root. Resolve once at the start of every subcommand.
- **WORKTREES_DIR**: `$MAIN_REPO/../$(basename $MAIN_REPO)-worktrees` — sibling directory named after the repo with a `-worktrees` suffix.
- **BASE_PORT_ANGULAR**: 4200
- **PORT_OFFSET_STEP**: 10

## Subcommands

### `new` — Create a new worktree with isolated dependencies

1. **Parse branch name.** If no branch name follows `new`, ask the user using AskUserQuestion. Suggest conventional prefixes:
   - `feat/` — new feature (e.g. `feat/ide-bridge`)
   - `fix/` — bug fix (e.g. `fix/lima-timeout`)
   - `refactor/` — code refactoring
   - `chore/` — maintenance tasks
     The user should pick a prefix or type a full name via "Other".

2. **Validate** — branch name must not be empty.

3. **Ensure worktrees directory exists:**

   ```bash
   mkdir -p $WORKTREES_DIR
   ```

4. **Fetch & create worktree.** Try fetching from origin first; if origin has no `dev` branch (empty remote), fall back to local `dev`:

   ```bash
   cd $MAIN_REPO && git fetch origin dev 2>/dev/null \
     && git worktree add $WORKTREES_DIR/<branch> -b <branch> origin/dev \
     || git worktree add $WORKTREES_DIR/<branch> -b <branch> dev
   ```

   If the worktree or branch already exists, report the error — do not force overwrite.

5. **Allocate dev port.** Scan all `.worktree.json` files under `WORKTREES_DIR` (use Glob pattern `$WORKTREES_DIR/**/.worktree.json`). Read each file and collect `ports.angular` values. Find the max Angular port, then compute the next:

   ```
   offset       = (max_angular_port - 4200) + 10   (or 10 if no worktrees exist)
   angular_port = 4200 + offset
   ```

   The Angular dev port is the only port that needs isolation (Tauri dev server). Rust cargo builds and MCP server tests don't bind to persistent ports.

   Example for offset=10: Angular=4210.
   Example for offset=20: Angular=4220.

6. **Write `.worktree.json`** at the worktree root (`WORKTREES_DIR/<branch>/.worktree.json`):

   ```json
   {
     "branch": "<branch>",
     "basedOn": "dev",
     "ports": {
       "angular": <angular_port>
     },
     "createdAt": "<ISO timestamp>"
   }
   ```

7. **Install dependencies.** The worktree gets source files from git but not `node_modules` or `target/`. Install everything:

   ```bash
   cd <worktree_path> && make setup-dev
   ```

   If `make setup-dev` fails, report the error and stop.

8. **Build MCP servers.** `make setup-dev` installs npm packages but does not compile TypeScript. MCP servers import from `shared/dist/` which must be built before tests can run:

   ```bash
   cd <worktree_path> && make build-mcp
   ```

9. **Run tests to verify the worktree is healthy:**

   ```bash
   cd <worktree_path> && make test
   ```

   If tests fail, warn the user but don't block — they may want to start working anyway.

10. **Print summary and Claude Code launch command:**

    ```
    Worktree ready: <branch> (based on dev)

    Path:     <worktree_path>
    Angular:  http://localhost:<angular_port>

    Quick start:
      cd <worktree_path>
      make dev          # Start desktop in dev mode (Tauri + Angular)
      make test         # Run all tests
      make check        # Lint + clippy + type-check
      make status       # Quick health check

    Note: Angular dev server will use port <angular_port>.
    To set the port, run: cd <worktree_path> && TAURI_DEV_SERVER_PORT=<angular_port> make dev
    Or modify desktop/src/angular.json "serve.options.port" to <angular_port>.

    Launch Claude Code in this worktree:
      cd <worktree_path> && claude --dangerously-skip-permissions "Pracujesz w worktree <branch> projektu Speedwave. Angular dev server uzywa portu <angular_port>. Przed uruchomieniem make dev ustaw port: zmien desktop/src/angular.json serve.options.port na <angular_port>, albo uzyj TAURI_DEV_SERVER_PORT=<angular_port> make dev. Wszystkie komendy przez Makefile: make dev, make test, make check, make build. Po kazdej zmianie uruchom make test zeby zweryfikowac ze nic nie zepsules."
    ```

### `list` — List all worktrees with info

1. Run `git -C $MAIN_REPO worktree list`.
2. For each worktree path listed, check if `.worktree.json` exists using the Read tool.
3. Display each worktree with its info:
   ```
   /Users/.../speedwave                            [main]           (main repo)
   /Users/.../speedwave-worktrees/feat/ide-bridge   [feat/ide-bridge]  Angular:4210
   /Users/.../speedwave-worktrees/fix/lima-timeout   [fix/lima-timeout]  Angular:4220
   /Users/.../speedwave-worktrees/chore/cleanup      [chore/cleanup]     (no config)
   ```

### `close` — Remove a worktree

1. **Parse branch name.** If no branch name follows `close`, run `git -C $MAIN_REPO worktree list` and present the non-main worktrees as options in AskUserQuestion.

2. **Kill any running dev processes** for that worktree:

   ```bash
   pkill -f "<worktree_path>" 2>/dev/null || true
   lsof -ti:<angular_port> | xargs kill -9 2>/dev/null || true
   ```

   (Read `.worktree.json` first to get the angular port; skip port kill if no config exists.)

3. **Remove the worktree:**

   ```bash
   git -C $MAIN_REPO worktree remove --force <worktree_path>
   ```

   If this fails due to directory issues, fall back to:

   ```bash
   rm -rf <worktree_path> && git -C $MAIN_REPO worktree prune
   ```

4. **Delete the branch:**

   ```bash
   git -C $MAIN_REPO branch -d <branch>
   ```

   If branch deletion fails (unmerged changes), inform the user and ask whether to force delete with `-D`.

5. **Print confirmation** with what was removed (worktree path, branch name).

## No subcommand

If `$ARGUMENTS` is empty or doesn't match `new`, `list`, or `close`, ask the user what they want to do using AskUserQuestion with options: "Create new worktree", "List worktrees", "Close worktree".
