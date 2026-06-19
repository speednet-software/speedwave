# Speedwave v2 — Developer Makefile
#
# Usage:
#   make              — build everything
#   make test         — run all tests
#   make check        — lint + clippy + type-check
#   make check-all    — full quality gate: lint + test + coverage + audit
#   make coverage-html— generate & open HTML coverage reports
#   make audit        — check dependencies for known vulnerabilities
#   make dev          — start desktop in dev mode (Tauri + Angular)
#
# Prerequisites:
#   - Rust toolchain (rustup)
#   - Node.js 20+ (for MCP servers and Angular frontend)
#   - cargo-tauri CLI (cargo install tauri-cli) — for desktop dev/build
#   - cargo-llvm-cov (cargo install cargo-llvm-cov) — for Rust coverage
#   - cargo-audit (cargo install cargo-audit) — for dependency audit
#   - bats-core (brew install bats-core) — for E2E tests (optional)
#   - Swift 5.9+ (macOS only, for native OS CLI binaries)

# Ensure cargo and Homebrew are in PATH even in non-interactive shells
# (git hooks and CI run /bin/sh which does not source ~/.zshenv)
export PATH := $(HOME)/.cargo/bin:/opt/homebrew/bin:$(PATH)

# Windows (Git Bash + GnuWin32 make): npm/npx are bash scripts that the
# bash-via-execve-from-make path cannot invoke directly. Use .cmd variants.
ifeq ($(OS),Windows_NT)
NPM := npm.cmd
NPX := npx.cmd
else
NPM := npm
NPX := npx
endif

# Isolate dev builds from production (~/.speedwave/).
# Unit tests use fake_home/tmpdir — they ignore this variable.
# E2E tests backup/restore this directory (not production ~/.speedwave/).
SPEEDWAVE_DATA_DIR ?= $(HOME)/.speedwave-dev
export SPEEDWAVE_DATA_DIR

LIMA_VERSION := $(shell cat .lima-version 2>/dev/null || echo 2.0.2)

# bats runs serially. `--jobs N` is unsafe here: bundle-build-context.bats mutates
# shared repo paths (mcp-servers/{os,shared}/dist) that cannot be tempdir-isolated,
# so concurrent siblings in one file race and fail. The suites are small; the real
# parallelism win is lane-level (separate task), not per-file bats jobs.

# Hard floor: dev/test must never run against the production data dir, even if a
# user exported SPEEDWAVE_DATA_DIR=~/.speedwave (the `?=` default above only
# applies when it is unset). A data dir whose basename is exactly `.speedwave` is
# production — matched both with a path separator (`*/.speedwave`) and bare
# (`.speedwave`). Portable: pure shell `case`, no installed tool.
guard-not-prod-data-dir:
	@case "$(SPEEDWAVE_DATA_DIR)" in \
	  */.speedwave | .speedwave) \
	    echo "❌ Refusing: SPEEDWAVE_DATA_DIR=$(SPEEDWAVE_DATA_DIR) is the production data dir." >&2; \
	    echo "   Use ~/.speedwave-dev (the default) or another non-production dir." >&2; \
	    exit 1;; \
	esac

.PHONY: all build test check clean dev install-deps setup-dev install-hooks guard-not-prod-data-dir \
        build-runtime build-cli build-desktop build-tauri build-mcp build-angular \
        build-native-macos build-os-cli bundle-native-assets bundle-static-licenses verify-bundled-assets \
        test-rust test-transcription test-cli test-desktop test-angular test-mcp test-os test-swift test-e2e test-entrypoint test-ci test-desktop-build \
        test-build-phase test-rust-run test-angular-run test-mcp-run test-desktop-build-run test-desktop-run test-desktop-group-run test-run-lanes \
        test-e2e-desktop _e2e-macos _e2e-windows test-e2e-all setup-e2e-vms \
        check-clippy check-desktop-clippy check-angular check-mcp check-fmt \
        check-mcp-lint check-angular-lint check-all \
        coverage coverage-rust coverage-mcp coverage-html \
        audit audit-rust audit-mcp audit-desktop \
        fmt lint status \
        download-lima clean-lima \
        download-nodejs clean-nodejs \
        download-wsl-resources clean-wsl-resources

# ── Developer setup (run once after cloning) ─────────────────────────────────

REQUIRED_NODE_MAJOR := 20
REQUIRED_RUST_MINOR := 70

setup-dev:
	@echo "🔍 Checking developer environment...\n"
	@FAIL=0; \
	\
	echo "── Rust ──"; \
	if command -v rustc >/dev/null 2>&1; then \
		RUST_VER=$$(rustc --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'); \
		RUST_MINOR=$$(echo "$$RUST_VER" | cut -d. -f2); \
		if [ "$$RUST_MINOR" -ge $(REQUIRED_RUST_MINOR) ]; then \
			echo "  ✅ rustc $$RUST_VER"; \
		else \
			echo "  ⚠️  rustc $$RUST_VER (recommended: 1.$(REQUIRED_RUST_MINOR)+, run: rustup update)"; \
		fi; \
	else \
		echo "  ❌ rustc not found"; \
		echo "     Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; \
		FAIL=1; \
	fi; \
	\
	if command -v cargo >/dev/null 2>&1; then \
		echo "  ✅ cargo $$(cargo --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"; \
	else \
		echo "  ❌ cargo not found (installed with rustup)"; \
		FAIL=1; \
	fi; \
	\
	echo ""; \
	echo "── Node.js ──"; \
	if command -v node >/dev/null 2>&1; then \
		NODE_VER=$$(node --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'); \
		NODE_MAJOR=$$(echo "$$NODE_VER" | cut -d. -f1); \
		if [ "$$NODE_MAJOR" -ge $(REQUIRED_NODE_MAJOR) ]; then \
			echo "  ✅ node $$NODE_VER"; \
		else \
			echo "  ❌ node $$NODE_VER (requires $(REQUIRED_NODE_MAJOR)+)"; \
			echo "     Install: https://nodejs.org or brew install node"; \
			FAIL=1; \
		fi; \
	else \
		echo "  ❌ node not found"; \
		echo "     Install: https://nodejs.org or brew install node"; \
		FAIL=1; \
	fi; \
	\
	if command -v npm >/dev/null 2>&1; then \
		echo "  ✅ npm $$(npm --version)"; \
	else \
		echo "  ❌ npm not found (installed with node)"; \
		FAIL=1; \
	fi; \
	\
	echo ""; \
	echo "── Tauri CLI ──"; \
	if command -v cargo-tauri >/dev/null 2>&1; then \
		echo "  ✅ cargo-tauri $$(cargo tauri --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 'installed')"; \
	else \
		echo "  📦 cargo-tauri not found — installing..."; \
		cargo install tauri-cli && echo "  ✅ cargo-tauri installed" || { echo "  ❌ cargo-tauri install failed"; FAIL=1; }; \
	fi; \
	\
	echo ""; \
	echo "── Optional tools ──"; \
	if command -v bats >/dev/null 2>&1; then \
		echo "  ✅ bats $$(bats --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"; \
	else \
		echo "  ⬚  bats not found (needed for: make test-e2e)"; \
		echo "     Install: brew install bats-core"; \
	fi; \
	\
	echo ""; \
	echo "── macOS system deps (Tauri) ──"; \
	if [ "$$(uname)" = "Darwin" ]; then \
		if xcode-select -p >/dev/null 2>&1; then \
			echo "  ✅ Xcode Command Line Tools"; \
		else \
			echo "  ❌ Xcode CLT not found"; \
			echo "     Install: xcode-select --install"; \
			FAIL=1; \
		fi; \
	else \
		echo "  ⬚  skipped (not macOS)"; \
	fi; \
	\
	echo ""; \
	if [ "$$FAIL" -eq 1 ]; then \
		echo "❌ Missing required tools — fix the items above and re-run: make setup-dev"; \
		exit 1; \
	else \
		echo "✅ All required tools present — installing dependencies...\n"; \
	fi
	@echo "── Cargo dependencies (runtime + CLI) ──"
	cargo fetch
	@echo "── Cargo dependencies (desktop) ──"
	cd desktop/src-tauri && cargo fetch
	@echo "── MCP server dependencies ──"
	cd mcp-servers && $(NPM) ci
	@echo "── Angular dependencies ──"
	cd desktop/src && $(NPM) ci
	@echo "── E2E test dependencies ──"
	cd desktop/e2e && $(NPM) ci
	@echo "── Git hooks (husky, commitlint) ──"
	$(NPM) ci
	$(NPX) husky
	@echo "\n✅ Dev environment ready. Next:"
	@echo "  make test    # verify everything works"
	@echo "  make dev     # start desktop in dev mode"

# ── Aggregate targets ────────────────────────────────────────────────────────

all: build

build: build-runtime build-cli build-os-cli build-mcp build-angular
	@echo "\n✅ All builds complete"

# build-once + parallel-run. CI never calls this aggregate (it calls standalone
# test-X targets, which keep their own build prereqs and are left untouched).
# Phase 1 (sequential): guard + test-build-phase stage every shared artifact
#   exactly once, so no two lanes ever build the same dist/target concurrently.
# Phase 2 (parallel): a recursive `$(MAKE) -jN test-run-lanes` fans out the
#   pure run-only lanes. test-mcp-run + test-desktop-build-run + test-desktop-run
#   are grouped SERIAL (they share-mutate mcp-servers/*/dist via
#   bundle-build-context.sh reads + bundle-build-context.bats's --ci rebuild —
#   the same footgun that broke bats --jobs). A failing lane fails the whole
#   `make test`: each `$(MAKE)` is its own recipe line, and the sub-make runs
#   without -k, so the first non-zero exit aborts. Override fan-out width with
#   `make test TEST_LANES_JOBS=N`.
TEST_LANES_JOBS ?= 4
test: guard-not-prod-data-dir
	@"$(MAKE)" test-build-phase
	@"$(MAKE)" -j$(TEST_LANES_JOBS) test-run-lanes
	@echo "\n✅ All tests passed"

check: check-clippy check-desktop-clippy check-fmt check-mcp check-mcp-lint check-angular-lint
	@echo "\n✅ All checks passed"

clean:
	cargo clean
	rm -rf desktop/src/dist desktop/src/node_modules/.cache
	cd mcp-servers && rm -rf node_modules/*/dist */dist
	@echo "✅ Clean"

# ── Install dependencies (alias for setup-dev) ──────────────────────────────

install-deps: setup-dev

# ── Git hooks ────────────────────────────────────────────────────────────────

install-hooks:
	$(NPM) install
	$(NPX) husky
	@echo "✅ Git hooks installed"

# ── Rust builds ──────────────────────────────────────────────────────────────

build-runtime:
	cargo build -p speedwave-runtime

build-cli:
	cargo build -p speedwave-cli

# Release-profile build of the CLI, used as a dependency of `build-tauri`
# so the bundled CLI shipped inside the .app/.exe/.dmg is a release
# binary. With a debug binary, the `SPEEDWAVE_ALLOW_UNSIGNED` bypass in
# `signing::unsigned_bypass_active` would still be live in shipped
# artifacts (it is `cfg(debug_assertions)`-gated, which only flips off
# in the release profile). Keep `build-cli` (debug) untouched so
# `make dev` and ad-hoc developer runs are not slowed down.
build-cli-release:
	cargo build -p speedwave-cli --release

# Regenerates desktop/src-tauri/windows/installer-hooks.nsh from its template
# + sweep.ps1 + firewall.ps1 (see scripts/generate-installer-nsh.sh). Cheap and
# idempotent — safe to call unconditionally before any build that ships an
# installer (Windows NSIS or MSI) or runs installer_hooks drift detector tests.
generate-installer-nsh:
	@bash scripts/generate-installer-nsh.sh

build-desktop: generate-installer-nsh
	cd desktop/src-tauri && cargo build

build-tauri: build-cli-release build-angular build-mcp build-os-cli download-nodejs generate-installer-nsh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" download-lima; fi
	@if [ "$(OS)" = "Windows_NT" ]; then "$(MAKE)" download-wsl-resources; fi
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	@"$(MAKE)" bundle-static-licenses
	mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	cp target/release/speedwave.exe desktop/src-tauri/cli/speedwave.exe
else
	cp target/release/speedwave desktop/src-tauri/cli/speedwave
	chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" verify-bundled-assets
	cd desktop/src-tauri && cargo tauri build
	@echo "\n✅ Tauri production bundle built"

# ── Native OS CLI builds (macOS: Swift, Windows: Rust — planned) ─────────────

build-native-macos:
	@if [ "$$(uname)" != "Darwin" ]; then \
		echo "⬚  Skipping macOS native build (not macOS)"; \
	else \
		echo "🔨 Building macOS native CLI binaries..." && \
		cd $(CURDIR)/native/macos/reminders && swift build -c release && \
		cd $(CURDIR)/native/macos/calendar && swift build -c release && \
		cd $(CURDIR)/native/macos/mail && swift build -c release && \
		cd $(CURDIR)/native/macos/notes && swift build -c release && \
		cd $(CURDIR)/native/macos/audio-capture && swift build -c release && \
		echo "✅ macOS native CLI binaries built"; \
	fi

build-os-cli: build-native-macos

test-swift:
	@if [ "$$(uname)" != "Darwin" ]; then \
		echo "⬚  Skipping Swift tests (not macOS)"; \
	else \
		for pkg in shared reminders calendar mail notes audio-capture; do \
			echo "Testing $$pkg..." && \
			(cd $(CURDIR)/native/macos/$$pkg && swift test) || exit 1; \
		done && \
		echo "✅ Swift tests passed"; \
	fi

bundle-native-assets:
	@bash scripts/bundle-native-assets.sh

# Copy the static third-party licenses we keep in-repo (whisper.cpp,
# onnxruntime, cpal, transcription model weights — ADR-056) into the bundled
# THIRD-PARTY-LICENSES/ dir, alongside the lima/nodejs/nerdctl licenses the
# download-* targets fetch there. The static dir is VCS-tracked; the bundled
# dir is generated.
bundle-static-licenses:
	@mkdir -p desktop/src-tauri/THIRD-PARTY-LICENSES
	@cp desktop/src-tauri/licenses-static/* desktop/src-tauri/THIRD-PARTY-LICENSES/
	@echo "✅ Static third-party licenses copied into THIRD-PARTY-LICENSES/"

verify-bundled-assets:
ifeq ($(OS),Windows_NT)
	@bash scripts/verify-bundled-assets.sh windows
else
	@if [ "$$(uname)" = "Darwin" ]; then \
		bash scripts/verify-bundled-assets.sh macos; \
	else \
		echo "Unsupported host for bundled asset verification"; \
		exit 1; \
	fi
endif

# ── MCP servers ──────────────────────────────────────────────────────────────

build-mcp:
	cd mcp-servers && $(NPM) run build

# ── Angular frontend ─────────────────────────────────────────────────────────

build-angular:
	cd desktop/src && $(NPX) ng build

# ── Rust tests ───────────────────────────────────────────────────────────────

# Run a cargo command ($(1)) against an isolated throwaway data dir, then clean
# up. Each run gets its OWN dir so tests never touch the shared production
# ~/.speedwave and parallel worktrees never collide. We capture the `mktemp -d`
# result DIRECTLY and guard it (`|| exit 1`), then put the data dir UNDER it —
# so cleanup always removes the captured dir, never a path derived via dirname.
# (A `mktemp -d` that returns empty must not let cleanup expand to `rm -rf /`.)
# The basename `speedwave-test` is regex-valid (^[a-z][a-z0-9-]{0,63}$) — a bare
# `mktemp -d` basename (tmp.XXXX) is NOT and would panic instance-name
# derivation. With isolation the suite is parallel-safe, so the old
# `--test-threads=1` cap is gone.
define RUN_CARGO_ISOLATED
	d=$$(mktemp -d) || exit 1; mkdir -p "$$d/speedwave-test"; \
	  SPEEDWAVE_DATA_DIR="$$d/speedwave-test" $(1); \
	  rc=$$?; rm -rf "$$d"; exit $$rc
endef

# ── Aggregate-only parallel infrastructure (used ONLY by `make test`) ─────────
# CI invokes the standalone test-X targets, which keep their own build prereqs.
# These build-once + run-only variants exist so the aggregate can build shared
# artifacts ONCE (sequentially) then fan the run phases out in parallel.

# Sequential build phase: every shared build the run lanes need, once, in
# dependency order. Mirrors the build-side of test-desktop (the heaviest lane)
# so its run variant can assume everything is staged. NOT used by CI.
test-build-phase: generate-installer-nsh build-cli build-angular build-mcp build-os-cli
	@if [ "$$(uname)" = "Darwin" ] && [ ! -s desktop/src-tauri/lima/bin/limactl ]; then "$(MAKE)" download-lima; fi
	@if [ "$(OS)" = "Windows_NT" ] && [ ! -s desktop/src-tauri/wsl/nerdctl-full.tar.gz ]; then "$(MAKE)" download-wsl-resources; fi
	@if [ ! -s desktop/src-tauri/nodejs/bin/node ] && [ ! -s desktop/src-tauri/nodejs/node.exe ]; then "$(MAKE)" download-nodejs; fi
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	@mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	@cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
else
	@cp target/debug/speedwave desktop/src-tauri/cli/speedwave
	@chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" verify-bundled-assets
	@echo "✅ Build phase complete"

# Pure run-only lanes — NO build prereqs (test-build-phase staged everything).
test-rust-run:
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime -p speedwave-cli)
	"$(MAKE)" test-transcription
	@echo "✅ Rust tests passed"

test-angular-run: test-angular

test-mcp-run:
	cd mcp-servers && $(NPM) test
	@echo "✅ MCP server tests passed"

test-desktop-build-run:
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/desktop/desktop-build.bats _tests/desktop/bundle-build-context.bats \
	  _tests/desktop/guard-prod-data-dir.bats _tests/desktop/verify-bundled-assets.bats \
	  _tests/desktop/sign-bundled-binaries.bats _tests/desktop/release-workflow-signing.bats \
	  _tests/desktop/info-plist.bats _tests/desktop/entitlements-reminders.bats
	@echo "✅ Desktop build tests passed"

test-desktop-run:
	$(call RUN_CARGO_ISOLATED,sh -c 'cd desktop/src-tauri && cargo test')
	@echo "✅ Desktop tests passed"

# Serial group: every lane that touches REAL repo paths. test-desktop-run's
# bundle-build-context.sh READS mcp-servers/*/dist; bundle-build-context.bats's
# `--ci` test (in test-desktop-build-run) transiently RENAMES + rebuilds those
# same dirs; test-mcp-run consumes them. Concurrent = the bats --jobs footgun,
# so run these three back-to-back. Each `$(MAKE)` is its own command — first
# non-zero exit aborts the recipe, so failures propagate.
test-desktop-group-run:
	@"$(MAKE)" test-mcp-run
	@"$(MAKE)" test-desktop-build-run
	@"$(MAKE)" test-desktop-run

# The fan-out set parallelized by `make test`. Everything here is mutually
# shared-path-safe after test-build-phase; the one lane that touches real repo
# paths is the serial test-desktop-group-run.
test-run-lanes: test-rust-run test-angular-run test-entrypoint \
                test-desktop-config test-ci test-desktop-group-run

test-rust:
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime -p speedwave-cli)
	@# The `audio-transcription` feature (host-side meeting transcription, ADR-056)
	@# is off by default — the CLI never enables it — so the default run above
	@# doesn't compile the `transcription` module. Test it explicitly here.
	"$(MAKE)" test-transcription
	@echo "✅ Rust tests passed"

test-transcription:
	@echo "🧪 Testing speedwave-runtime with the audio-transcription feature..."
	@# Only the `transcription` module is gated behind this feature (see
	@# `src/lib.rs` — `#[cfg(feature = "audio-transcription")] pub mod transcription;`).
	@# The rest of the crate (compose, plugin, build, …) is identical with or
	@# without the feature and is already exercised by `test-rust`. Without the
	@# `transcription::` filter, cargo re-runs the whole suite a second time
	@# (~100 compose tests at ~5s each), which alone blows past the CI job budget.
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime --features audio-transcription transcription::)
	@echo "✅ audio-transcription tests passed"

# Runs the mcp-os upgrade-path test against the *real* bundled worker (not the
# stub). Gated behind the `mcp-os-bundle-e2e` feature — never `#[ignore]`,
# which nothing in the pipeline runs. `build-mcp` produces the source dists;
# `bundle-build-context.sh` stages them into desktop/src-tauri/mcp-os/ with the
# @speedwave/mcp-shared tree the worker resolves at runtime; then we run only
# that one test under the feature.
test-mcp-os-bundle: build-mcp
	@echo "🧪 Staging the real mcp-os worker bundle..."
	@bash scripts/bundle-build-context.sh
	@echo "🧪 Running the mcp-os upgrade-path test against the bundled worker..."
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime --features mcp-os-bundle-e2e upgrade_path_with_real_bundled_mcp_os)
	@echo "✅ mcp-os bundle upgrade-path test passed"

test-cli:
	@echo "🧪 Testing CLI..."
	@cargo test -p speedwave-cli
	@echo "✅ CLI tests passed"

test-desktop: build-cli build-angular build-mcp build-os-cli generate-installer-nsh
	@if [ "$$(uname)" = "Darwin" ] && [ ! -s desktop/src-tauri/lima/bin/limactl ]; then "$(MAKE)" download-lima; fi
	@if [ "$(OS)" = "Windows_NT" ] && [ ! -s desktop/src-tauri/wsl/nerdctl-full.tar.gz ]; then "$(MAKE)" download-wsl-resources; fi
	@if [ ! -s desktop/src-tauri/nodejs/bin/node ] && [ ! -s desktop/src-tauri/nodejs/node.exe ]; then "$(MAKE)" download-nodejs; fi
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	@mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	@cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
else
	@cp target/debug/speedwave desktop/src-tauri/cli/speedwave
	@chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" verify-bundled-assets
	$(call RUN_CARGO_ISOLATED,sh -c 'cd desktop/src-tauri && cargo test')
	@# The bundle is staged above (bundle-build-context.sh + build-mcp), so run
	@# the mcp-os upgrade-path test against the real worker here (Unix-only, like
	@# its `#[cfg(all(unix, feature = "mcp-os-bundle-e2e"))]` gate). Never
	@# `#[ignore]`d — this is the make invocation that actually runs it.
	@if [ "$(OS)" != "Windows_NT" ]; then "$(MAKE)" test-mcp-os-bundle; fi
	@echo "✅ Desktop tests passed"

# ── Angular tests ───────────────────────────────────────────────────────────

test-angular:
	cd desktop/src && $(NPX) ng test --no-watch --runner-config vitest.config.ts
	@echo "✅ Angular tests passed"

# ── MCP server tests ────────────────────────────────────────────────────────

test-mcp: build-mcp
	cd mcp-servers && $(NPM) test
	@echo "✅ MCP server tests passed"

test-os: build-mcp
	cd mcp-servers/os && $(NPX) vitest run
	@echo "✅ OS MCP server tests passed"

# pytest for the office worker's Python support-scripts. Builds a throwaway venv from
# mcp-servers/office/requirements.txt (+ pytest). Heavy (matplotlib/numpy) — not part of
# `make test`; run it explicitly, or rely on the office image build to exercise the scripts.
# Tests that need a real matplotlib render self-skip on too-new Python interpreters.
test-mcp-office-py:
	@PY=$$(command -v python3.12 || command -v python3.11 || command -v python3); \
	VENV="$${TMPDIR:-/tmp}/office-test-venv-$$$$"; \
	echo "  building office Python test venv ($$PY) at $$VENV..."; \
	"$$PY" -m venv --clear "$$VENV"; \
	"$$VENV/bin/pip" install -q --upgrade pip; \
	"$$VENV/bin/pip" install -q -r mcp-servers/office/requirements.txt pytest; \
	"$$VENV/bin/python" -m pytest mcp-servers/office/scripts -q; \
	rm -rf "$$VENV"
	@echo "✅ Office Python script tests passed"

# ── Coverage ─────────────────────────────────────────────────────────────────

coverage: coverage-rust coverage-mcp coverage-angular
	@echo "\n✅ All coverage reports generated"

coverage-rust:
	@command -v cargo-llvm-cov >/dev/null 2>&1 || { echo "❌ cargo-llvm-cov not found. Install: cargo install cargo-llvm-cov"; exit 1; }
	cargo llvm-cov -p speedwave-runtime -p speedwave-cli --fail-under-lines 70
	@echo "✅ Rust coverage passed (≥70% lines)"

coverage-mcp: build-mcp
	cd mcp-servers && $(NPM) run test:coverage
	@echo "✅ MCP coverage passed"

coverage-angular:
	cd desktop/src && $(NPX) ng test --no-watch --coverage
	@echo "✅ Angular coverage passed"

coverage-html: build-mcp
	@command -v cargo-llvm-cov >/dev/null 2>&1 || { echo "❌ cargo-llvm-cov not found. Install: cargo install cargo-llvm-cov"; exit 1; }
	cargo llvm-cov -p speedwave-runtime -p speedwave-cli --html --output-dir target/coverage/rust
	cd mcp-servers && $(NPM) run test:coverage
	cd desktop/src && $(NPX) ng test --no-watch --coverage
	@echo "\n✅ Coverage reports generated:"
	@echo "  Rust:    target/coverage/rust/html/index.html"
	@echo "  MCP:     mcp-servers/coverage/index.html"
	@echo "  Angular: desktop/src/coverage/index.html"
	@[ "$$(uname)" = "Darwin" ] && open target/coverage/rust/html/index.html || true

# ── E2E tests (requires bats-core) ──────────────────────────────────────────

test-e2e: build-cli
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	SPEEDWAVE_BIN=./target/debug/speedwave bats _tests/e2e/speedwave.bats
	SPEEDWAVE_BIN=./target/debug/speedwave bats _tests/e2e/plugin-tamper.bats

# Plugin tamper / signature-bypass E2E. Runs against the *release* CLI
# so the `SPEEDWAVE_ALLOW_UNSIGNED` debug bypass is verified to be
# compiled out — see ADR-051 ("Build hygiene").
test-e2e-plugin-tamper-release: build-cli-release
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	SPEEDWAVE_BIN=./target/release/speedwave bats _tests/e2e/plugin-tamper.bats

test-entrypoint:
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/entrypoint/entrypoint.bats _tests/entrypoint/install-claude.bats \
	  _tests/entrypoint/statusline.bats _tests/entrypoint/osc52-copy.bats
	@echo "✅ Entrypoint tests passed"

test-ci:
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/ci/validate-pr-title-main.bats _tests/ci/plan-loop-context.bats
	@echo "✅ CI workflow tests passed"

test-desktop-build: build-angular build-mcp
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/desktop/desktop-build.bats _tests/desktop/bundle-build-context.bats \
	  _tests/desktop/guard-prod-data-dir.bats _tests/desktop/verify-bundled-assets.bats \
	  _tests/desktop/sign-bundled-binaries.bats _tests/desktop/release-workflow-signing.bats \
	  _tests/desktop/info-plist.bats _tests/desktop/entitlements-reminders.bats
	@echo "✅ Desktop build tests passed"

# Fast config validation — stable, runs in `make test`.
test-desktop-config:
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/desktop/updater-config.bats _tests/desktop/version-consistency.bats
	@echo "✅ Desktop config tests passed"

# Release gate — uses gh shim, CI-only. NOT in `make test` to prevent shim
# edge cases from breaking unrelated PRs.
test-release-gate:
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	@command -v jq >/dev/null 2>&1 || { echo "❌ jq not found. Install: brew install jq"; exit 1; }
	bats _tests/desktop/verify-release-assets.bats
	@echo "✅ Release-gate tests passed"

# ── Desktop E2E tests ────────────────────────────────────────────────────────
# Per-platform: builds release binary (with `e2e` feature flag for WebDriver support) and runs WebdriverIO E2E tests.
# App embeds tauri-plugin-webdriver on port 4445 — no external driver needed.

# Build only: download deps, compile CLI + MCP + Tauri binary. No test run.
# Used by e2e-vm.sh (build as root, test as desktop user with display access).
test-e2e-desktop-build: build-cli build-mcp build-os-cli
	@if [ "$$(uname)" = "Darwin" ] && [ ! -s desktop/src-tauri/lima/bin/limactl ]; then "$(MAKE)" download-lima; fi
	@if [ "$(OS)" = "Windows_NT" ] && [ ! -s desktop/src-tauri/wsl/nerdctl-full.tar.gz ]; then "$(MAKE)" download-wsl-resources; fi
	@if [ ! -f desktop/src-tauri/nodejs/bin/node ] && [ ! -f desktop/src-tauri/nodejs/node.exe ]; then "$(MAKE)" download-nodejs; fi
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	@mkdir -p desktop/src-tauri/cli
	@cargo build -p speedwave-cli --release
ifeq ($(OS),Windows_NT)
	@cp target/release/speedwave.exe desktop/src-tauri/cli/speedwave.exe 2>/dev/null || true
else
	@cp target/release/speedwave desktop/src-tauri/cli/speedwave
	@chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" verify-bundled-assets
	@echo "── Building release binary with bundle (e2e feature = WebDriver on :4445)..."
	cd desktop/src-tauri && cargo tauri build --features e2e $(if $(TAURI_SIGNING_PRIVATE_KEY),,--no-sign)
	@echo "── Installing E2E deps..."
	cd desktop/e2e && $(NPM) install --prefer-offline

# Full E2E: build + run tests using the installed app artifact.
test-e2e-desktop: test-e2e-desktop-build
	@echo "── Running E2E specs..."
	@"$(MAKE)" _e2e-run
	@echo "✅ Desktop E2E tests passed"

E2E_BINARY = desktop/src-tauri/target/release/speedwave-desktop

# All platforms: app embeds tauri-plugin-webdriver on port 4445.
# Launch app, wait for WebDriver ready, run wdio, cleanup.
#
# Moves ALL Speedwave state aside so the app sees a completely fresh system,
# then restores everything after the test (success or failure, including Ctrl-C).
#
# State directories per platform:
#   macOS:  ~/.speedwave/, ~/Library/Caches/lima/
#   Windows: not supported for local E2E (use scripts/e2e-vm.sh windows)
_e2e-run:
	@echo "── Killing any existing Speedwave instances..."
	@pkill -f speedwave-desktop 2>/dev/null || true
	@pkill -f 'mcp-os.*index.js' 2>/dev/null || true
	@pkill -9 -f limactl 2>/dev/null || true
	@sleep 1
	@E2E_PROJECT_DIR="$${TMPDIR:-/tmp}/speedwave-e2e-project-$$$$"; \
	E2E_SECOND_PROJECT_DIR="$$E2E_PROJECT_DIR-2"; \
	rm -rf "$$E2E_PROJECT_DIR" "$$E2E_SECOND_PROJECT_DIR"; \
	mkdir -p "$$E2E_PROJECT_DIR" "$$E2E_SECOND_PROJECT_DIR"; \
	E2E_BAK=$$SPEEDWAVE_DATA_DIR.e2e-bak; \
	backup_dir() { \
		if [ -d "$$1" ]; then rm -rf "$$2"; mv "$$1" "$$2"; fi; \
	}; \
	restore_dir() { \
		if [ -d "$$2" ]; then rm -rf "$$1" 2>/dev/null || true; mv "$$2" "$$1"; fi; \
	}; \
	backup_dir "$$SPEEDWAVE_DATA_DIR" "$$E2E_BAK"; \
	if [ "$$(uname)" = "Darwin" ]; then \
		backup_dir "$$HOME/Library/Caches/lima" "$$HOME/Library/Caches/lima.e2e-bak"; \
	fi; \
	restore_state() { \
		pkill -f speedwave-desktop 2>/dev/null || true; \
		pkill -f 'mcp-os.*index.js' 2>/dev/null || true; \
		pkill -9 -f limactl 2>/dev/null || true; \
		sleep 1; \
		restore_dir "$$SPEEDWAVE_DATA_DIR" "$$E2E_BAK"; \
		if [ "$$(uname)" = "Darwin" ]; then \
			restore_dir "$$HOME/Library/Caches/lima" "$$HOME/Library/Caches/lima.e2e-bak"; \
		fi; \
		rm -rf "$$E2E_PROJECT_DIR" "$$E2E_SECOND_PROJECT_DIR"; \
	}; \
	$(E2E_BINARY) & APP_PID=$$!; \
	trap "kill $$APP_PID 2>/dev/null; restore_state" EXIT; \
	for i in $$(seq 1 30); do curl -sf http://127.0.0.1:4445/status >/dev/null 2>&1 && break; sleep 1; done; \
	cd desktop/e2e && E2E_PROJECT_DIR="$$E2E_PROJECT_DIR" E2E_SECOND_PROJECT_DIR="$$E2E_SECOND_PROJECT_DIR" npx wdio run wdio.conf.ts; \
	E2E_EXIT=$$?; \
	kill $$APP_PID 2>/dev/null; \
	restore_state; \
	trap - EXIT; \
	exit $$E2E_EXIT

# Run E2E on a single platform via SSH to dedicated test machines
_e2e-macos:
	@bash scripts/e2e-vm.sh macos

_e2e-windows:
	@bash scripts/e2e-vm.sh windows

# Run E2E on all platforms via SSH to dedicated test machines
test-e2e-all:
	@bash scripts/e2e-vm.sh all

# Provision test machines for E2E testing (one-time setup)
setup-e2e-vms:
	@bash scripts/e2e-vm-setup.sh all

# ── Linting ──────────────────────────────────────────────────────────────────

check-clippy:
	cargo clippy -p speedwave-runtime -p speedwave-cli -- -D warnings
	@# The `audio-transcription` feature is off by default, so the line above
	@# doesn't lint the `transcription` module — clippy it explicitly too.
	cargo clippy -p speedwave-runtime --features audio-transcription -- -D warnings
	@echo "✅ Clippy: 0 warnings"

check-desktop-clippy: build-angular build-mcp
	@bash scripts/bundle-build-context.sh
	@bash scripts/create-desktop-stubs.sh
	cd desktop/src-tauri && SPEEDWAVE_ALLOW_BUNDLE_STUBS=1 cargo clippy -- -D warnings
	@echo "✅ Desktop clippy: 0 warnings"

check-mcp:
	@echo "  Building mcp-servers/shared (required by other workspaces)..."
	@cd mcp-servers/shared && $(NPX) tsc
	@for ws in shared hub slack sharepoint redmine gitlab github atlassian office os oauth; do \
		echo "  tsc --noEmit mcp-servers/$$ws"; \
		(cd mcp-servers/$$ws && $(NPX) tsc --noEmit) || exit 1; \
	done
	@echo "✅ MCP type-check done"

check-angular:
	cd desktop/src && $(NPX) ng build --configuration production
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/desktop/desktop-build.bats
	@echo "✅ Angular production build + desktop path verification OK"

check-fmt:
	cargo fmt --all -- --check
	$(NPX) prettier --check 'mcp-servers/*/src/**/*.ts' 'desktop/src/src/**/*.ts' '*.md'
	@echo "✅ Format check passed"

check-mcp-lint:
	cd mcp-servers && $(NPX) eslint .
	@echo "✅ MCP ESLint passed"

check-angular-lint:
	cd desktop/src && $(NPX) eslint 'src/**/*.ts'
	@echo "✅ Angular ESLint passed"

# ── Security audit ────────────────────────────────────────────────────────────

audit: audit-rust audit-mcp audit-desktop
	@echo "\n✅ No known vulnerabilities"

audit-rust:
	@command -v cargo-audit >/dev/null 2>&1 || { echo "❌ cargo-audit not found. Install: cargo install cargo-audit"; exit 1; }
	cargo audit
	cargo audit --file desktop/src-tauri/Cargo.lock
	@echo "✅ Rust dependencies: no vulnerabilities"

audit-mcp:
	cd mcp-servers && $(NPM) audit --omit=dev
	@echo "✅ MCP dependencies: no vulnerabilities"

audit-desktop:
	cd desktop/src && $(NPM) audit --omit=dev
	@echo "✅ Desktop dependencies: no vulnerabilities"

# ── Full quality gate (run before push) ──────────────────────────────────────

check-all: check test coverage audit
	@echo "\n✅ Full quality gate passed — safe to push"

# ── Formatting ───────────────────────────────────────────────────────────────

fmt:
	cargo fmt --all
	$(NPX) prettier --write 'mcp-servers/*/src/**/*.ts' 'desktop/src/src/**/*.ts' '*.md'
	@echo "✅ Formatted"

lint:
	cargo clippy -p speedwave-runtime -p speedwave-cli -- -D warnings
	cd desktop/src-tauri && cargo clippy -- -D warnings
	cd mcp-servers && $(NPX) eslint --fix .
	cd desktop/src && $(NPX) eslint --fix 'src/**/*.ts'
	@echo "✅ All lints passed"

# ── Lima bundling (macOS Desktop .app only) ──────────────────────────────────

download-lima:
	@echo "Downloading Lima $(LIMA_VERSION)..."
	@mkdir -p desktop/src-tauri/lima desktop/src-tauri/THIRD-PARTY-LICENSES
	@ARCH=$$(uname -m); \
	case "$$ARCH" in \
		arm64|aarch64) LIMA_ARCH="Darwin-arm64" ;; \
		x86_64) LIMA_ARCH="Darwin-x86_64" ;; \
		*) echo "Unsupported architecture: $$ARCH"; exit 1 ;; \
	esac; \
	TARBALL="lima-$(LIMA_VERSION)-$$LIMA_ARCH.tar.gz"; \
	URL="https://github.com/lima-vm/lima/releases/download/v$(LIMA_VERSION)/$$TARBALL"; \
	SUMS_URL="https://github.com/lima-vm/lima/releases/download/v$(LIMA_VERSION)/SHA256SUMS"; \
	echo "  Downloading $$URL"; \
	curl -fsSL "$$URL" -o "/tmp/$$TARBALL" && \
	curl -fsSL "$$SUMS_URL" -o /tmp/lima-SHA256SUMS && \
	echo "  Verifying SHA256 checksum..." && \
	EXPECTED=$$(grep "$$TARBALL" /tmp/lima-SHA256SUMS | awk '{print $$1}') && \
	ACTUAL=$$( (sha256sum "/tmp/$$TARBALL" 2>/dev/null || shasum -a 256 "/tmp/$$TARBALL") | awk '{print $$1}') && \
	if [ "$$EXPECTED" != "$$ACTUAL" ]; then \
		echo "CHECKSUM MISMATCH! Expected $$EXPECTED, got $$ACTUAL"; exit 1; \
	fi && \
	echo "  Checksum OK" && \
	tar -xzf "/tmp/$$TARBALL" -C desktop/src-tauri/lima/ --strip-components=1 && \
	rm -f "/tmp/$$TARBALL" /tmp/lima-SHA256SUMS
	@cp desktop/src-tauri/lima/share/doc/lima/LICENSE \
		desktop/src-tauri/THIRD-PARTY-LICENSES/lima-LICENSE 2>/dev/null || true
	@curl -fsSL "https://raw.githubusercontent.com/lima-vm/lima/v$(LIMA_VERSION)/NOTICE" \
		-o desktop/src-tauri/THIRD-PARTY-LICENSES/lima-NOTICE 2>/dev/null || true
	@echo "  ✅ Lima $(LIMA_VERSION) ready"

clean-lima:
	rm -rf desktop/src-tauri/lima desktop/src-tauri/THIRD-PARTY-LICENSES

# ── Node.js bundling (all platforms — mcp-os worker) ─────────────────────────

NODE_VERSION := $(shell cat .node-version 2>/dev/null || echo 24.14.0)

download-nodejs:
	@NODE_BIN=desktop/src-tauri/nodejs/bin/node; \
	case "$$(uname -s)" in MINGW*|MSYS*|CYGWIN*) NODE_BIN=desktop/src-tauri/nodejs/node.exe ;; esac; \
	if [ -s "$$NODE_BIN" ] && "$$NODE_BIN" --version >/dev/null 2>&1; then \
		echo "  ✅ Node.js already present — skipping download"; \
		exit 0; \
	fi; \
	echo "Downloading Node.js $(NODE_VERSION)..."; \
	mkdir -p desktop/src-tauri/nodejs desktop/src-tauri/nodejs/bin desktop/src-tauri/THIRD-PARTY-LICENSES; \
	ARCH=$$(uname -m); \
	case "$$ARCH" in \
		arm64|aarch64) NODE_ARCH="arm64" ;; \
		x86_64) NODE_ARCH="x64" ;; \
		*) echo "Unsupported architecture: $$ARCH"; exit 1 ;; \
	esac; \
	case "$$(uname -s)" in \
		Darwin) NODE_PLATFORM="darwin"; NODE_EXT="tar.gz"; NODE_BIN="bin/node"; NODE_DEST="desktop/src-tauri/nodejs/bin/node" ;; \
		MINGW*|MSYS*|CYGWIN*) NODE_PLATFORM="win"; NODE_EXT="zip"; NODE_BIN="node.exe"; NODE_DEST="desktop/src-tauri/nodejs/node.exe" ;; \
		*) echo "Unsupported OS: $$(uname -s)"; exit 1 ;; \
	esac; \
	ARCHIVE="node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH.$$NODE_EXT"; \
	URL="https://nodejs.org/dist/v$(NODE_VERSION)/$$ARCHIVE"; \
	SUMS_URL="https://nodejs.org/dist/v$(NODE_VERSION)/SHASUMS256.txt"; \
	echo "  Downloading $$URL"; \
	curl -fsSL "$$URL" -o "/tmp/$$ARCHIVE" && \
	curl -fsSL "$$SUMS_URL" -o /tmp/nodejs-SHASUMS256.txt && \
	echo "  Verifying SHA256 checksum..." && \
	EXPECTED=$$(grep "$$ARCHIVE" /tmp/nodejs-SHASUMS256.txt | awk '{print $$1}') && \
	[ -n "$$EXPECTED" ] || { echo "CHECKSUM NOT FOUND for $$ARCHIVE in SHASUMS256.txt"; exit 1; } && \
	ACTUAL=$$( (sha256sum "/tmp/$$ARCHIVE" 2>/dev/null || shasum -a 256 "/tmp/$$ARCHIVE") | awk '{print $$1}') && \
	if [ "$$EXPECTED" != "$$ACTUAL" ]; then \
		echo "CHECKSUM MISMATCH! Expected $$EXPECTED, got $$ACTUAL"; exit 1; \
	fi && \
	echo "  Checksum OK" && \
	if [ "$$NODE_PLATFORM" = "win" ]; then \
		mkdir -p /tmp/nodejs-extract && \
		unzip -q "/tmp/$$ARCHIVE" "node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/$$NODE_BIN" -d /tmp/nodejs-extract && \
		cp "/tmp/nodejs-extract/node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/$$NODE_BIN" "$$NODE_DEST" && \
		unzip -q "/tmp/$$ARCHIVE" "node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/LICENSE" -d /tmp/nodejs-extract 2>/dev/null || true && \
		[ -f "/tmp/nodejs-extract/node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/LICENSE" ] && \
			cp "/tmp/nodejs-extract/node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/LICENSE" desktop/src-tauri/THIRD-PARTY-LICENSES/nodejs-LICENSE || true; \
		rm -rf /tmp/nodejs-extract; \
	else \
		tar -xzf "/tmp/$$ARCHIVE" --strip-components=2 -C desktop/src-tauri/nodejs/bin/ \
			"node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/$$NODE_BIN" && \
		chmod +x "$$NODE_DEST" && \
		tar -xzf "/tmp/$$ARCHIVE" --strip-components=1 -C /tmp/ \
			"node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/LICENSE" 2>/dev/null && \
		cp /tmp/LICENSE desktop/src-tauri/THIRD-PARTY-LICENSES/nodejs-LICENSE 2>/dev/null || true; \
		rm -f /tmp/LICENSE; \
	fi; \
	rm -f "/tmp/$$ARCHIVE" /tmp/nodejs-SHASUMS256.txt
	@echo "  ✅ Node.js $(NODE_VERSION) ready"

clean-nodejs:
	rm -rf desktop/src-tauri/nodejs

# ── Windows offline bundle resources (WSL2 nerdctl-full + Ubuntu rootfs) ─────

NERDCTL_FULL_VERSION     := $(shell grep -A1 '^pub const NERDCTL_FULL_VERSION' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
NERDCTL_FULL_SHA256_AMD64 := $(shell grep -A1 '^pub const NERDCTL_FULL_SHA256_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
WSL_ROOTFS_URL_AMD64     := $(shell grep -A1 '^pub const WSL_ROOTFS_URL_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
WSL_ROOTFS_SHA256_AMD64  := $(shell grep -A1 '^pub const WSL_ROOTFS_SHA256_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')

# Downloads the nerdctl-full tarball and Ubuntu rootfs for bundling inside the
# Windows NSIS installer. Run `make download-wsl-resources` before `make build-tauri`
# on Windows, or in CI for windows-latest builds.

download-wsl-resources:
	@echo "Downloading Windows offline bundle resources..."
	@mkdir -p desktop/src-tauri/wsl
	@echo "  Downloading nerdctl-full $(NERDCTL_FULL_VERSION) for WSL2..."
	@curl -fsSL "https://github.com/containerd/nerdctl/releases/download/v$(NERDCTL_FULL_VERSION)/nerdctl-full-$(NERDCTL_FULL_VERSION)-linux-amd64.tar.gz" \
		-o desktop/src-tauri/wsl/nerdctl-full.tar.gz
	@echo "  Verifying nerdctl-full SHA256 checksum..."
	@echo "$(NERDCTL_FULL_SHA256_AMD64)  desktop/src-tauri/wsl/nerdctl-full.tar.gz" | sha256sum -c -
	@echo "  Downloading Ubuntu rootfs for WSL2..."
	@curl -fsSL "$(WSL_ROOTFS_URL_AMD64)" \
		-o desktop/src-tauri/wsl/ubuntu-rootfs.tar.gz
	@echo "  Verifying Ubuntu rootfs SHA256 checksum..."
	@echo "$(WSL_ROOTFS_SHA256_AMD64)  desktop/src-tauri/wsl/ubuntu-rootfs.tar.gz" | sha256sum -c -
	@echo "  ✅ Windows offline resources ready"

clean-wsl-resources:
	rm -rf desktop/src-tauri/wsl

# ── Development ──────────────────────────────────────────────────────────────

ifeq ($(OS),Windows_NT)
dev: guard-not-prod-data-dir download-nodejs download-wsl-resources generate-installer-nsh
	@command -v cargo-tauri >/dev/null 2>&1 || { echo "❌ cargo-tauri not found. Install: cargo install tauri-cli"; exit 1; }
	@"$(MAKE)" build-cli && "$(MAKE)" build-os-cli && "$(MAKE)" build-mcp
	@echo "Preparing build context..."
	@bash scripts/bundle-build-context.sh
	mkdir -p desktop/src-tauri/cli
	cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
	@"$(MAKE)" verify-bundled-assets
	@bash scripts/dev-tauri-windows.sh
else
dev: guard-not-prod-data-dir build-cli build-os-cli build-mcp download-nodejs generate-installer-nsh
	@command -v cargo-tauri >/dev/null 2>&1 || { echo "❌ cargo-tauri not found. Install: cargo install tauri-cli"; exit 1; }
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" download-lima; fi
	@echo "Preparing build context..."
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	mkdir -p desktop/src-tauri/cli
	cp target/debug/speedwave desktop/src-tauri/cli/speedwave
	chmod +x desktop/src-tauri/cli/speedwave
	@"$(MAKE)" verify-bundled-assets
	cd desktop/src-tauri && SPEEDWAVE_RESOURCES_DIR="$$(pwd)" SPEEDWAVE_ALLOW_UNSIGNED=1 TAURI_CONFIG='{"identifier":"pl.speedwave.desktop.dev","productName":"Speedwave Dev"}' cargo tauri dev
endif

# ── Quick status ─────────────────────────────────────────────────────────────

status:
	@echo "=== Rust ==="
	@cargo test -p speedwave-runtime -p speedwave-cli 2>&1 | grep "test result" || true
	@echo "\n=== Clippy ==="
	@echo "Warnings: $$(cargo clippy -p speedwave-runtime -p speedwave-cli 2>&1 | grep -c '^warning' || echo 0)"
	@echo "\n=== MCP Servers ==="
	@cd mcp-servers && $(NPM) test 2>&1 | grep -E "Tests|Test Files" | tail -2 || true
	@echo "\n=== Angular ==="
	@cd desktop/src && $(NPX) ng build 2>&1 | tail -1 || true
