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

LIMA_VERSION := $(shell cat .lima-version 2>/dev/null || echo 2.0.2)

.PHONY: all build test check clean dev install-deps setup-dev install-hooks \
        build-runtime build-cli build-desktop build-tauri build-mcp build-angular \
        build-swift build-os-cli \
        test-rust test-cli test-desktop test-angular test-mcp test-os test-e2e test-entrypoint test-desktop-build \
        test-e2e-desktop _e2e-macos _e2e-linux _e2e-windows test-e2e-all setup-e2e-vms \
        check-clippy check-desktop-clippy check-angular check-mcp check-fmt \
        check-mcp-lint check-angular-lint check-all \
        coverage coverage-rust coverage-mcp coverage-html \
        audit audit-rust audit-mcp \
        fmt lint status \
        download-lima clean-lima \
        download-nodejs clean-nodejs \
        download-nerdctl-full clean-nerdctl-full \
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
	@echo "── Cargo dependencies ──"
	cargo fetch
	@echo "── MCP server dependencies ──"
	cd mcp-servers && npm install
	@echo "── Angular dependencies ──"
	cd desktop/src && npm install
	@echo "── Git hooks (husky, commitlint) ──"
	npm install
	npx husky
	@echo "\n✅ Dev environment ready. Next:"
	@echo "  make test    # verify everything works"
	@echo "  make dev     # start desktop in dev mode"

# ── Aggregate targets ────────────────────────────────────────────────────────

all: build

build: build-runtime build-cli build-os-cli build-mcp build-angular
	@echo "\n✅ All builds complete"

test: test-rust test-angular test-mcp test-entrypoint test-desktop-build test-desktop
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
	npm install
	npx husky
	@echo "✅ Git hooks installed"

# ── Rust builds ──────────────────────────────────────────────────────────────

build-runtime:
	cargo build -p speedwave-runtime

build-cli:
	cargo build -p speedwave-cli

build-desktop:
	cd desktop/src-tauri && cargo build

build-tauri: build-cli build-angular build-mcp download-nodejs
	@if [ "$$(uname)" = "Darwin" ]; then $(MAKE) download-lima; fi
	@if [ "$$(uname)" = "Linux" ]; then $(MAKE) download-nerdctl-full; fi
	@scripts/bundle-build-context.sh
	mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
else
	cp target/debug/speedwave desktop/src-tauri/cli/speedwave
endif
	cd desktop/src-tauri && cargo tauri build
	@echo "\n✅ Tauri production bundle built"

# ── Swift / native OS CLI builds ─────────────────────────────────────────────

build-swift:
	@if [ "$$(uname)" != "Darwin" ]; then echo "⬚  Skipping Swift build (not macOS)"; exit 0; fi
	@echo "🔨 Building Swift CLI binaries..."
	cd swift-reminders && swift build -c release
	cd swift-calendar && swift build -c release
	cd swift-mail && swift build -c release
	cd swift-notes && swift build -c release
	@echo "✅ Swift CLI binaries built"

build-os-cli: build-swift

# ── MCP servers ──────────────────────────────────────────────────────────────

build-mcp:
	cd mcp-servers && npm run build

# ── Angular frontend ─────────────────────────────────────────────────────────

build-angular:
	cd desktop/src && npx ng build

# ── Rust tests ───────────────────────────────────────────────────────────────

test-rust:
	cargo test -p speedwave-runtime -p speedwave-cli
	@echo "✅ Rust tests passed"

test-cli:
	@echo "🧪 Testing CLI..."
	@cargo test -p speedwave-cli
	@echo "✅ CLI tests passed"

test-desktop: build-cli build-angular build-mcp
	@if [ "$$(uname)" = "Darwin" ] && [ ! -f desktop/src-tauri/lima/bin/limactl ]; then $(MAKE) download-lima; fi
	@if [ "$$(uname)" = "Linux" ] && [ ! -d desktop/src-tauri/nerdctl-full ]; then $(MAKE) download-nerdctl-full; fi
	@if [ ! -f desktop/src-tauri/nodejs/bin/node ] && [ ! -f desktop/src-tauri/nodejs/node.exe ]; then $(MAKE) download-nodejs; fi
	@scripts/bundle-build-context.sh
	@mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	@cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
else
	@cp target/debug/speedwave desktop/src-tauri/cli/speedwave
endif
	cd desktop/src-tauri && cargo test
	@echo "✅ Desktop tests passed"

# ── Angular tests ───────────────────────────────────────────────────────────

test-angular:
	cd desktop/src && npx vitest run
	@echo "✅ Angular tests passed"

# ── MCP server tests ────────────────────────────────────────────────────────

test-mcp: build-mcp
	cd mcp-servers && npm test
	@echo "✅ MCP server tests passed"

test-os:
	cd mcp-servers/os && npx vitest run
	@echo "✅ OS MCP server tests passed"

# ── Coverage ─────────────────────────────────────────────────────────────────

coverage: coverage-rust coverage-mcp coverage-angular
	@echo "\n✅ All coverage reports generated"

coverage-rust:
	@command -v cargo-llvm-cov >/dev/null 2>&1 || { echo "❌ cargo-llvm-cov not found. Install: cargo install cargo-llvm-cov"; exit 1; }
	cargo llvm-cov -p speedwave-runtime -p speedwave-cli --fail-under-lines 70
	@echo "✅ Rust coverage passed (≥70% lines)"

coverage-mcp: build-mcp
	cd mcp-servers && npm run test:coverage
	@echo "✅ MCP coverage passed"

coverage-angular:
	cd desktop/src && npx vitest run --coverage
	@echo "✅ Angular coverage passed (thresholds enforced by vitest.config.ts)"

coverage-html: build-mcp
	@command -v cargo-llvm-cov >/dev/null 2>&1 || { echo "❌ cargo-llvm-cov not found. Install: cargo install cargo-llvm-cov"; exit 1; }
	cargo llvm-cov -p speedwave-runtime -p speedwave-cli --html --output-dir target/coverage/rust
	cd mcp-servers && npm run test:coverage
	cd desktop/src && npx vitest run --coverage
	@echo "\n✅ Coverage reports generated:"
	@echo "  Rust:    target/coverage/rust/html/index.html"
	@echo "  MCP:     mcp-servers/coverage/index.html"
	@echo "  Angular: desktop/src/coverage/index.html"
	@[ "$$(uname)" = "Darwin" ] && open target/coverage/rust/html/index.html || true

# ── E2E tests (requires bats-core) ──────────────────────────────────────────

test-e2e: build-cli
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	SPEEDWAVE_BIN=./target/debug/speedwave-cli bats _tests/e2e/speedwave.bats

test-entrypoint:
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/entrypoint/entrypoint.bats
	bats _tests/entrypoint/install-claude.bats
	bats _tests/entrypoint/statusline.bats
	@echo "✅ Entrypoint tests passed"

test-desktop-build: build-angular build-mcp
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/desktop/desktop-build.bats
	bats _tests/desktop/bundle-build-context.bats
	@echo "✅ Desktop build tests passed"

# ── Desktop E2E tests ────────────────────────────────────────────────────────
# Per-platform: builds debug binary and runs WebdriverIO E2E tests.
# App embeds tauri-plugin-webdriver on port 4445 — no external driver needed.

# Build only: download deps, compile CLI + MCP + Tauri binary. No test run.
# Used by e2e-vm.sh (build as root, test as desktop user with display access).
test-e2e-desktop-build: build-cli build-mcp
	@if [ "$$(uname)" = "Darwin" ] && [ ! -f desktop/src-tauri/lima/bin/limactl ]; then $(MAKE) download-lima; fi
	@if [ "$$(uname)" = "Linux" ] && [ ! -d desktop/src-tauri/nerdctl-full ]; then $(MAKE) download-nerdctl-full; fi
	@if [ ! -f desktop/src-tauri/nodejs/bin/node ] && [ ! -f desktop/src-tauri/nodejs/node.exe ]; then $(MAKE) download-nodejs; fi
	@scripts/bundle-build-context.sh
	@mkdir -p desktop/src-tauri/cli
	@cargo build -p speedwave-cli --release
	@cp target/release/speedwave desktop/src-tauri/cli/speedwave 2>/dev/null || \
	  cp target/release/speedwave.exe desktop/src-tauri/cli/speedwave.exe 2>/dev/null || true
	@echo "── Building release binary with bundle (e2e feature = WebDriver on :4445)..."
	cd desktop/src-tauri && cargo tauri build --features e2e $(if $(TAURI_SIGNING_PRIVATE_KEY),,--no-sign)
	@echo "── Installing E2E deps..."
	cd desktop/e2e && npm install --prefer-offline

# Full E2E: build + run tests using the installed app artifact.
test-e2e-desktop: test-e2e-desktop-build
	@echo "── Running E2E specs..."
	@$(MAKE) _e2e-run
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
#   Linux:  ~/.speedwave/, ~/.local/share/{containerd,buildkit,nerdctl}/,
#           ~/.config/systemd/user/containerd.service
#   Windows: not supported for local E2E (use scripts/e2e-vm.sh windows)
_e2e-run:
	@echo "── Killing any existing Speedwave instances..."
	@pkill -f speedwave-desktop 2>/dev/null || true
	@pkill -f 'mcp-os.*index.js' 2>/dev/null || true
	@pkill -9 -f limactl 2>/dev/null || true
	@if [ "$$(uname)" = "Linux" ]; then \
		systemctl --user stop containerd 2>/dev/null || true; \
	fi
	@sleep 1
	@mkdir -p /tmp/speedwave-e2e-project
	@E2E_BAK=$$HOME/.speedwave.e2e-bak; \
	backup_dir() { \
		if [ -d "$$1" ]; then rm -rf "$$2"; mv "$$1" "$$2"; fi; \
	}; \
	restore_dir() { \
		rm -rf "$$1" 2>/dev/null || true; \
		if [ -d "$$2" ]; then mv "$$2" "$$1"; fi; \
	}; \
	backup_dir "$$HOME/.speedwave" "$$E2E_BAK"; \
	if [ "$$(uname)" = "Darwin" ]; then \
		backup_dir "$$HOME/Library/Caches/lima" "$$HOME/Library/Caches/lima.e2e-bak"; \
	elif [ "$$(uname)" = "Linux" ]; then \
		backup_dir "$$HOME/.local/share/containerd" "$$HOME/.local/share/containerd.e2e-bak"; \
		backup_dir "$$HOME/.local/share/buildkit" "$$HOME/.local/share/buildkit.e2e-bak"; \
		backup_dir "$$HOME/.local/share/nerdctl" "$$HOME/.local/share/nerdctl.e2e-bak"; \
		if [ -f "$$HOME/.config/systemd/user/containerd.service" ]; then \
			mv "$$HOME/.config/systemd/user/containerd.service" "$$HOME/.config/systemd/user/containerd.service.e2e-bak"; \
		fi; \
	fi; \
	restore_state() { \
		pkill -f speedwave-desktop 2>/dev/null || true; \
		pkill -f 'mcp-os.*index.js' 2>/dev/null || true; \
		pkill -9 -f limactl 2>/dev/null || true; \
		if [ "$$(uname)" = "Linux" ]; then \
			systemctl --user stop containerd 2>/dev/null || true; \
		fi; \
		sleep 1; \
		restore_dir "$$HOME/.speedwave" "$$E2E_BAK"; \
		if [ "$$(uname)" = "Darwin" ]; then \
			restore_dir "$$HOME/Library/Caches/lima" "$$HOME/Library/Caches/lima.e2e-bak"; \
		elif [ "$$(uname)" = "Linux" ]; then \
			restore_dir "$$HOME/.local/share/containerd" "$$HOME/.local/share/containerd.e2e-bak"; \
			restore_dir "$$HOME/.local/share/buildkit" "$$HOME/.local/share/buildkit.e2e-bak"; \
			restore_dir "$$HOME/.local/share/nerdctl" "$$HOME/.local/share/nerdctl.e2e-bak"; \
			if [ -f "$$HOME/.config/systemd/user/containerd.service.e2e-bak" ]; then \
				mv "$$HOME/.config/systemd/user/containerd.service.e2e-bak" "$$HOME/.config/systemd/user/containerd.service"; \
			fi; \
			systemctl --user daemon-reload 2>/dev/null || true; \
			systemctl --user start containerd 2>/dev/null || true; \
		fi; \
	}; \
	$(E2E_BINARY) & APP_PID=$$!; \
	trap "kill $$APP_PID 2>/dev/null; restore_state" EXIT; \
	for i in $$(seq 1 30); do curl -sf http://127.0.0.1:4445/status >/dev/null 2>&1 && break; sleep 1; done; \
	cd desktop/e2e && E2E_PROJECT_DIR=/tmp/speedwave-e2e-project npx wdio run wdio.conf.ts; \
	E2E_EXIT=$$?; \
	kill $$APP_PID 2>/dev/null; \
	restore_state; \
	trap - EXIT; \
	exit $$E2E_EXIT

# Run E2E on all platforms via SSH to dedicated test machines (Tailscale network)
test-e2e-all:
	@scripts/e2e-vm.sh all

# Provision test machines for E2E testing (one-time setup)
setup-e2e-vms:
	@scripts/e2e-vm-setup.sh all

# ── Linting ──────────────────────────────────────────────────────────────────

check-clippy:
	cargo clippy -p speedwave-runtime -p speedwave-cli -- -D warnings
	@echo "✅ Clippy: 0 warnings"

check-desktop-clippy: build-angular build-mcp
	@if [ "$$(uname)" = "Darwin" ] && [ ! -f desktop/src-tauri/lima/bin/limactl ]; then $(MAKE) download-lima; fi
	@if [ "$$(uname)" = "Linux" ] && [ ! -d desktop/src-tauri/nerdctl-full ]; then $(MAKE) download-nerdctl-full; fi
	@scripts/bundle-build-context.sh
	cd desktop/src-tauri && cargo clippy -- -D warnings
	@echo "✅ Desktop clippy: 0 warnings"

check-mcp:
	@echo "  Building mcp-servers/shared (required by other workspaces)..."
	@cd mcp-servers/shared && npx tsc
	@for ws in shared hub slack sharepoint redmine gitlab os; do \
		echo "  tsc --noEmit mcp-servers/$$ws"; \
		(cd mcp-servers/$$ws && npx tsc --noEmit) || exit 1; \
	done
	@echo "✅ MCP type-check done"

check-angular:
	cd desktop/src && npx ng build --configuration production
	@command -v bats >/dev/null 2>&1 || { echo "❌ bats not found. Install: brew install bats-core"; exit 1; }
	bats _tests/desktop/desktop-build.bats
	@echo "✅ Angular production build + desktop path verification OK"

check-fmt:
	cargo fmt --all -- --check
	npx prettier --check 'mcp-servers/*/src/**/*.ts' 'desktop/src/src/**/*.ts' '*.md'
	@echo "✅ Format check passed"

check-mcp-lint:
	cd mcp-servers && npx eslint .
	@echo "✅ MCP ESLint passed"

check-angular-lint:
	cd desktop/src && npx eslint 'src/**/*.ts'
	@echo "✅ Angular ESLint passed"

# ── Security audit ────────────────────────────────────────────────────────────

audit: audit-rust audit-mcp
	@echo "\n✅ No known vulnerabilities"

audit-rust:
	@command -v cargo-audit >/dev/null 2>&1 || { echo "❌ cargo-audit not found. Install: cargo install cargo-audit"; exit 1; }
	cargo audit
	@echo "✅ Rust dependencies: no vulnerabilities"

audit-mcp:
	cd mcp-servers && npm audit --omit=dev
	@echo "✅ MCP dependencies: no vulnerabilities"

# ── Full quality gate (run before push) ──────────────────────────────────────

check-all: check test coverage audit
	@echo "\n✅ Full quality gate passed — safe to push"

# ── Formatting ───────────────────────────────────────────────────────────────

fmt:
	cargo fmt --all
	npx prettier --write 'mcp-servers/*/src/**/*.ts' 'desktop/src/src/**/*.ts' '*.md'
	@echo "✅ Formatted"

lint:
	cargo clippy -p speedwave-runtime -p speedwave-cli -- -D warnings
	cd desktop/src-tauri && cargo clippy -- -D warnings
	cd mcp-servers && npx eslint --fix .
	cd desktop/src && npx eslint --fix 'src/**/*.ts'
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
	ACTUAL=$$(shasum -a 256 "/tmp/$$TARBALL" | awk '{print $$1}') && \
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
	@echo "Downloading Node.js $(NODE_VERSION)..."
	@mkdir -p desktop/src-tauri/nodejs/bin desktop/src-tauri/THIRD-PARTY-LICENSES
	@ARCH=$$(uname -m); \
	case "$$ARCH" in \
		arm64|aarch64) NODE_ARCH="arm64" ;; \
		x86_64) NODE_ARCH="x64" ;; \
		*) echo "Unsupported architecture: $$ARCH"; exit 1 ;; \
	esac; \
	case "$$(uname -s)" in \
		Darwin) NODE_PLATFORM="darwin" ;; \
		Linux) NODE_PLATFORM="linux" ;; \
		*) echo "Unsupported OS: $$(uname -s)"; exit 1 ;; \
	esac; \
	TARBALL="node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH.tar.gz"; \
	URL="https://nodejs.org/dist/v$(NODE_VERSION)/$$TARBALL"; \
	SUMS_URL="https://nodejs.org/dist/v$(NODE_VERSION)/SHASUMS256.txt"; \
	echo "  Downloading $$URL"; \
	curl -fsSL "$$URL" -o "/tmp/$$TARBALL" && \
	curl -fsSL "$$SUMS_URL" -o /tmp/nodejs-SHASUMS256.txt && \
	echo "  Verifying SHA256 checksum..." && \
	EXPECTED=$$(grep "$$TARBALL" /tmp/nodejs-SHASUMS256.txt | awk '{print $$1}') && \
	[ -n "$$EXPECTED" ] || { echo "CHECKSUM NOT FOUND for $$TARBALL in SHASUMS256.txt"; exit 1; } && \
	ACTUAL=$$(shasum -a 256 "/tmp/$$TARBALL" | awk '{print $$1}') && \
	if [ "$$EXPECTED" != "$$ACTUAL" ]; then \
		echo "CHECKSUM MISMATCH! Expected $$EXPECTED, got $$ACTUAL"; exit 1; \
	fi && \
	echo "  Checksum OK" && \
	tar -xzf "/tmp/$$TARBALL" --strip-components=2 -C desktop/src-tauri/nodejs/bin/ \
		"node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/bin/node" && \
	chmod +x desktop/src-tauri/nodejs/bin/node && \
	tar -xzf "/tmp/$$TARBALL" --strip-components=1 -C /tmp/ \
		"node-v$(NODE_VERSION)-$$NODE_PLATFORM-$$NODE_ARCH/LICENSE" 2>/dev/null && \
	cp /tmp/LICENSE desktop/src-tauri/THIRD-PARTY-LICENSES/nodejs-LICENSE 2>/dev/null || true && \
	rm -f "/tmp/$$TARBALL" /tmp/nodejs-SHASUMS256.txt /tmp/LICENSE
	@echo "  ✅ Node.js $(NODE_VERSION) ready"

clean-nodejs:
	rm -rf desktop/src-tauri/nodejs

# ── nerdctl-full bundling (Linux Desktop .deb only) ──────────────────────────

NERDCTL_FULL_VERSION     := $(shell grep -A1 '^pub const NERDCTL_FULL_VERSION' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
NERDCTL_FULL_SHA256_AMD64 := $(shell grep -A1 '^pub const NERDCTL_FULL_SHA256_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
WSL_ROOTFS_URL_AMD64     := $(shell grep -A1 '^pub const WSL_ROOTFS_URL_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
WSL_ROOTFS_SHA256_AMD64  := $(shell grep -A1 '^pub const WSL_ROOTFS_SHA256_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')

download-nerdctl-full:
	@echo "Downloading nerdctl-full $(NERDCTL_FULL_VERSION)..."
	@mkdir -p desktop/src-tauri/nerdctl-full desktop/src-tauri/THIRD-PARTY-LICENSES
	@ARCH=$$(uname -m); \
	case "$$ARCH" in \
		x86_64|amd64) NERDCTL_ARCH="amd64" ;; \
		aarch64|arm64) NERDCTL_ARCH="arm64" ;; \
		*) echo "Unsupported architecture: $$ARCH"; exit 1 ;; \
	esac; \
	TARBALL="nerdctl-full-$(NERDCTL_FULL_VERSION)-linux-$$NERDCTL_ARCH.tar.gz"; \
	URL="https://github.com/containerd/nerdctl/releases/download/v$(NERDCTL_FULL_VERSION)/$$TARBALL"; \
	SUMS_URL="https://github.com/containerd/nerdctl/releases/download/v$(NERDCTL_FULL_VERSION)/SHA256SUMS"; \
	echo "  Downloading $$URL"; \
	curl -fsSL "$$URL" -o "/tmp/$$TARBALL" && \
	curl -fsSL "$$SUMS_URL" -o /tmp/nerdctl-SHA256SUMS && \
	echo "  Verifying SHA256 checksum..." && \
	EXPECTED=$$(grep "$$TARBALL" /tmp/nerdctl-SHA256SUMS | awk '{print $$1}') && \
	ACTUAL=$$(shasum -a 256 "/tmp/$$TARBALL" | awk '{print $$1}') && \
	if [ "$$EXPECTED" != "$$ACTUAL" ]; then \
		echo "CHECKSUM MISMATCH! Expected $$EXPECTED, got $$ACTUAL"; exit 1; \
	fi && \
	echo "  Checksum OK" && \
	tar -xzf "/tmp/$$TARBALL" -C desktop/src-tauri/nerdctl-full/ && \
	rm -f "/tmp/$$TARBALL" /tmp/nerdctl-SHA256SUMS
	@cp desktop/src-tauri/nerdctl-full/share/doc/nerdctl-full/LICENSE \
		desktop/src-tauri/THIRD-PARTY-LICENSES/nerdctl-full-LICENSE 2>/dev/null || \
	cp desktop/src-tauri/nerdctl-full/share/doc/nerdctl/LICENSE \
		desktop/src-tauri/THIRD-PARTY-LICENSES/nerdctl-full-LICENSE 2>/dev/null || true
	@echo "  ✅ nerdctl-full $(NERDCTL_FULL_VERSION) ready"

clean-nerdctl-full:
	rm -rf desktop/src-tauri/nerdctl-full

# ── Windows offline bundle resources (WSL2 nerdctl-full + Ubuntu rootfs) ─────
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

dev: build-cli build-swift build-mcp
	@command -v cargo-tauri >/dev/null 2>&1 || { echo "❌ cargo-tauri not found. Install: cargo install tauri-cli"; exit 1; }
	@echo "Preparing build context..."
	@scripts/bundle-build-context.sh
	mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
else
	cp target/debug/speedwave desktop/src-tauri/cli/speedwave
endif
	cd desktop/src-tauri && cargo tauri dev

# ── Quick status ─────────────────────────────────────────────────────────────

status:
	@echo "=== Rust ==="
	@cargo test -p speedwave-runtime -p speedwave-cli 2>&1 | grep "test result" || true
	@echo "\n=== Clippy ==="
	@echo "Warnings: $$(cargo clippy -p speedwave-runtime -p speedwave-cli 2>&1 | grep -c '^warning' || echo 0)"
	@echo "\n=== MCP Servers ==="
	@cd mcp-servers && npm test 2>&1 | grep -E "Tests|Test Files" | tail -2 || true
	@echo "\n=== Angular ==="
	@cd desktop/src && npx ng build 2>&1 | tail -1 || true
