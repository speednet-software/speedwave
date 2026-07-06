# Commands — always via Makefile, never cargo/npm directly

```bash
make setup-dev      # first-time: prerequisites + all dependencies
make test           # all tests (Rust + Angular + MCP + entrypoint + desktop) — optional locally; CI runs it
make check-fmt      # fmt (root + desktop + proxy) + prettier — the pre-push hook gate, no builds/tests
make check          # lint + clippy + type-check + format — thorough local pass; CI runs it
make check-all      # check + test + coverage + audit
make dev            # desktop dev mode (Tauri + Angular hot reload)
make build          # build everything
make fmt / status / audit / coverage-html
```

Granular: `test-rust`, `test-cli`, `test-angular`, `test-mcp`, `test-os`, `test-swift`, `test-desktop`, `test-desktop-run`, `test-proxy`, `test-transcription`, `test-entrypoint`, `test-desktop-build`, `test-ci`, `test-e2e`, `test-e2e-desktop`, `test-e2e-audio`, `test-e2e-plugin-tamper-release`, `test-e2e-all`, `test-mcp-office-py`, `test-mcp-os-bundle`, `test-release-gate`, `setup-e2e-vms` · `build-runtime`, `build-cli`, `build-cli-release`, `build-desktop`, `build-native-macos`, `build-os-cli`, `build-mcp`, `build-angular`, `build-tauri`, `bundle-native-assets`, `verify-bundled-assets` · `check-clippy`, `check-desktop-clippy`, `check-fmt`, `check-mcp`, `check-mcp-lint`, `check-angular`, `check-angular-lint` · `coverage-rust`, `coverage-mcp`, `coverage-angular` · `audit-rust`, `audit-mcp`, `audit-desktop` · `download-lima`, `download-nodejs`, `download-wsl-resources` (+ `clean-*`) · `generate-installer-nsh`, `lint`, `install-deps`, `install-hooks`, `clean`.
