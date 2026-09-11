# Commands — always via Makefile, never cargo/npm directly

```bash
make setup-dev         # first-time: prerequisites + all dependencies
make setup-dev-windows # Windows only dev setup (requires admin, self-elevates):
                       # - Installs Chocolatey toolchain and pinned Vulkan SDK (machine-wide VULKAN_SDK).
                       # - Reports missing items at the end without aborting configuration early.
                       # - Enables long paths machine-wide (registry and system Git config).
                       # - Writes ~/msvc-env.sh (MSVC env + CMAKE_GENERATOR=Ninja).
                       # - Writes gitignored desktop/src-tauri/.cargo/config.toml with short target-dir.
                       # - Never modifies committed <repo>/.cargo/config.toml.
make test           # all tests (Rust + Angular + MCP + entrypoint + desktop + proxy) — optional locally; CI runs it
make check-fmt      # fmt (root + desktop + proxy) + prettier — the pre-push hook gate, no builds/tests
make check          # lint + clippy + type-check + format — thorough local pass; CI runs the same checks as separate steps
make check-all      # check + test + coverage + audit
make dev            # desktop dev mode (Tauri + Angular hot reload)
make dev DEV_INSTANCE=speed-533
                    # second dev instance: own data dir (~/.speedwave-speed-533, own Lima VM),
                    # own bundle id (pl.speedwave.desktop.speed-533) and an ng serve port
                    # derived from the name (DEV_PORT=<port> overrides it), and its own
                    # CLI on PATH (~/.local/bin/speedwave-speed-533; production keeps
                    # ~/.local/bin/speedwave).
                    # One per worktree, so testing a branch does not stop the instance you work in.
make dev-config     # print the resolved data dir / identifier / TAURI_CONFIG without starting anything
make build          # build everything
make fmt / status / audit / coverage-html
```

Granular: `test-rust`, `test-cli`, `test-angular`, `test-mcp`, `test-os`, `test-swift`, `test-desktop`, `test-desktop-run`, `test-proxy`, `test-transcription`, `test-entrypoint`, `test-desktop-build`, `test-desktop-config`, `test-ci`, `test-e2e`, `test-e2e-desktop`, `test-e2e-audio`, `test-e2e-plugin-tamper-release`, `test-e2e-all`, `test-engine-contract`, `test-e2e-update-dirty`, `test-mcp-office-py`, `test-mcp-os-bundle`, `test-release-gate`, `setup-e2e-vms` · `build-runtime`, `build-cli`, `build-cli-release`, `build-desktop`, `build-native-macos`, `build-os-cli`, `build-mcp`, `build-angular`, `build-tauri`, `bundle-native-assets`, `bundle-static-licenses`, `verify-bundled-assets` · `check-clippy`, `check-desktop-clippy`, `check-fmt`, `check-mcp`, `check-mcp-lint`, `check-angular`, `check-angular-lint` · `coverage-rust`, `coverage-mcp`, `coverage-angular` · `audit-rust`, `audit-mcp`, `audit-desktop` · `download-lima`, `download-nodejs`, `download-wsl-resources` (+ `clean-*`) · `generate-installer-nsh`, `lint`, `install-deps`, `install-hooks`, `clean`.
