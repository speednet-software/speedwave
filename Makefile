export PATH := $(HOME)/.cargo/bin:$(subst ::/opt/homebrew/bin,:/opt/homebrew/bin,$(PATH):/opt/homebrew/bin)

ifeq ($(OS),Windows_NT)
NPM := npm.cmd
NPX := npx.cmd
else
NPM := npm
NPX := npx
endif

DEV_INSTANCE ?= dev
DEV_IDENTIFIER ?= pl.speedwave.desktop.$(DEV_INSTANCE)
ifeq ($(DEV_INSTANCE),dev)
DEV_PRODUCT_NAME ?= Speedwave Dev
else
DEV_PRODUCT_NAME ?= Speedwave $(DEV_INSTANCE)
endif
ifneq ($(DEV_INSTANCE),dev)
ifeq ($(origin DEV_PORT),undefined)
DEV_PORT := $(shell printf '%s' '$(DEV_INSTANCE)' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-6 | { read h; echo $$((20000 + 0x$$h % 20000)); })
endif
endif
ifeq ($(strip $(DEV_PORT)),)
DEV_PORT_CONFIG :=
else
DEV_PORT_CONFIG := ,"build":{"devUrl":"http://localhost:$(DEV_PORT)","beforeDevCommand":{"script":"npx ng serve --port $(DEV_PORT)","cwd":"../src"}}
endif
DEV_TAURI_CONFIG = {"identifier":"$(DEV_IDENTIFIER)","productName":"$(DEV_PRODUCT_NAME)"$(DEV_PORT_CONFIG)}
export DEV_TAURI_CONFIG

SPEEDWAVE_DATA_DIR ?= $(HOME)/.speedwave-$(DEV_INSTANCE)
export SPEEDWAVE_DATA_DIR

LIMA_VERSION := $(shell cat .lima-version 2>/dev/null || echo 2.0.2)

ifeq ($(OS),Windows_NT)
BATS_HINT = echo "     Windows: not provisioned — the bats suites run on macOS + CI"
else
BATS_HINT = echo "     Install: brew install bats-core"
endif
REQUIRE_BATS = command -v bats >/dev/null 2>&1 || { echo "❌ bats not found."; $(BATS_HINT); exit 1; }

guard-not-prod-data-dir:
	@case "$(SPEEDWAVE_DATA_DIR)" in \
	  */.speedwave | .speedwave) \
	    echo "❌ Refusing: SPEEDWAVE_DATA_DIR=$(SPEEDWAVE_DATA_DIR) is the production data dir." >&2; \
	    echo "   Use ~/.speedwave-dev (the default) or another non-production dir." >&2; \
	    exit 1;; \
	esac
	@if [ -z "$$(printf '%s' '$(SPEEDWAVE_DATA_DIR)' | tr -d '[:space:]')" ]; then \
	    echo "❌ Refusing: SPEEDWAVE_DATA_DIR is empty/whitespace, which resolves to the production data dir." >&2; \
	    echo "   Use ~/.speedwave-dev (the default) or another non-production dir." >&2; \
	    exit 1; \
	fi

guard-dev-instance:
	@export LC_ALL=C; \
	name='$(DEV_INSTANCE)'; \
	case "$$name" in \
	  ''|*[!a-z0-9-]*|[!a-z]*) \
	    echo "❌ Refusing: DEV_INSTANCE='$$name' must match ^[a-z][a-z0-9-]*$$ (it becomes the Lima VM name via the data-dir basename)." >&2; \
	    exit 1;; \
	esac; \
	if [ $${#name} -gt 54 ]; then \
	    echo "❌ Refusing: DEV_INSTANCE='$$name' is too long (max 54, because 'speedwave-' plus the name must fit 64 chars)." >&2; \
	    exit 1; \
	fi
	@if [ "$(DEV_INSTANCE)" != "dev" ] && [ -z "$(strip $(DEV_PORT))" ]; then \
	    echo "❌ Refusing: DEV_INSTANCE=$(DEV_INSTANCE) resolved to an empty DEV_PORT, so it would reuse the default instance's port." >&2; \
	    echo "   Pass one explicitly: make dev DEV_INSTANCE=$(DEV_INSTANCE) DEV_PORT=4271" >&2; \
	    exit 1; \
	fi
	@case "$(strip $(DEV_PORT))" in \
	  ''|[0-9]|[0-9][0-9]|[0-9][0-9][0-9]|[0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9]) ;; \
	  *) echo "❌ Refusing: DEV_PORT='$(DEV_PORT)' must be a port number." >&2; exit 1;; \
	esac
	@if [ "$(DEV_INSTANCE)" != "dev" ] && [ "$(SPEEDWAVE_DATA_DIR)" != "$(HOME)/.speedwave-$(DEV_INSTANCE)" ]; then \
	    echo "⚠️  DEV_INSTANCE=$(DEV_INSTANCE) but SPEEDWAVE_DATA_DIR=$(SPEEDWAVE_DATA_DIR) comes from the environment, so that is the data dir this instance gets." >&2; \
	fi

guard-dev-port: guard-dev-instance
	@if [ "$(DEV_INSTANCE)" != "dev" ]; then \
	    echo "▶ dev instance $(DEV_INSTANCE): $(SPEEDWAVE_DATA_DIR), $(DEV_IDENTIFIER), http://localhost:$(DEV_PORT)"; \
	fi
	@if [ -n "$(strip $(DEV_PORT))" ] && command -v node >/dev/null 2>&1; then \
	    node -e 'const s=require("net").createServer();s.once("error",e=>{console.error("❌ Refusing: port "+process.argv[1]+" is already in use ("+e.code+"). Pick another: make dev DEV_INSTANCE=$(DEV_INSTANCE) DEV_PORT=<port>");process.exit(1)});s.once("listening",()=>s.close());s.listen(Number(process.argv[1]),"127.0.0.1")' $(DEV_PORT) || exit 1; \
	fi

dev-config: guard-dev-instance
	@printf 'DEV_INSTANCE=%s\n' '$(DEV_INSTANCE)'
	@printf 'SPEEDWAVE_DATA_DIR=%s\n' '$(SPEEDWAVE_DATA_DIR)'
	@printf 'TAURI_CONFIG=%s\n' "$$DEV_TAURI_CONFIG"

.PHONY: all build test check clean dev dev-config install-deps setup-dev setup-dev-windows install-hooks guard-not-prod-data-dir guard-dev-instance guard-dev-port \
        build-runtime build-cli build-desktop build-tauri build-mcp build-angular \
        build-native-macos build-os-cli bundle-native-assets bundle-static-licenses verify-bundled-assets stage-vulkan-windows \
        test-rust test-transcription test-cli test-desktop test-angular test-mcp test-os test-swift test-e2e test-entrypoint test-ci test-desktop-build \
        test-build-phase test-rust-run test-angular-run test-mcp-run test-desktop-build-run test-desktop-run test-run-lanes test-proxy \
        test-e2e-desktop _e2e-macos _e2e-windows test-e2e-all test-e2e-audio setup-e2e-vms \
        test-e2e-plugin-tamper-release test-engine-contract test-e2e-update-dirty \
        check-clippy check-desktop-clippy check-proxy-clippy check-angular check-mcp check-fmt \
        check-mcp-lint check-angular-lint check-all \
        coverage coverage-rust coverage-mcp coverage-html \
        audit audit-rust audit-mcp audit-desktop \
        fmt lint status \
        download-lima clean-lima \
        download-nodejs clean-nodejs \
        download-wsl-resources clean-wsl-resources

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
	bash scripts/check-node-version.sh "$(NODE_VERSION)" || FAIL=1; \
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
	echo "── Git hooks ──"; \
	if command -v gitleaks >/dev/null 2>&1; then \
		echo "  ✅ gitleaks $$(gitleaks version 2>/dev/null || echo installed)"; \
	else \
		echo "  ❌ gitleaks not found — the pre-commit hook rejects every commit without it"; \
		echo "     Install: brew install gitleaks (macOS) / make setup-dev-windows (Windows)"; \
		FAIL=1; \
	fi; \
	\
	echo ""; \
	echo "── Optional tools ──"; \
	if command -v bats >/dev/null 2>&1; then \
		echo "  ✅ bats $$(bats --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"; \
	else \
		echo "  ⬚  bats not found (needed for: make test-e2e)"; \
		$(BATS_HINT); \
	fi; \
	\
	echo ""; \
	echo "── PII engine (WASM) ──"; \
	if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then \
		echo "  ✅ rustup target wasm32-unknown-unknown"; \
	else \
		echo "  📦 wasm32-unknown-unknown target not found, installing..."; \
		rustup target add wasm32-unknown-unknown && echo "  ✅ wasm32-unknown-unknown installed" || { echo "  ❌ target install failed"; FAIL=1; }; \
	fi; \
	if command -v wasm-pack >/dev/null 2>&1; then \
		echo "  ✅ wasm-pack $$(wasm-pack --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 'installed')"; \
	else \
		echo "  📦 wasm-pack not found, installing..."; \
		if npm install -g wasm-pack >/dev/null 2>&1 && command -v wasm-pack >/dev/null 2>&1; then \
			echo "  ✅ wasm-pack installed (npm)"; \
		elif cargo install wasm-pack; then \
			echo "  ✅ wasm-pack installed (cargo)"; \
		else \
			echo "  ❌ wasm-pack install failed"; FAIL=1; \
		fi; \
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
	echo "── Windows build deps (whisper Vulkan + MSVC) ──"; \
	bash scripts/check-windows-build-deps.sh; \
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

setup-dev-windows:
	@case "$$(uname -s 2>/dev/null)" in \
	  MINGW*|MSYS*|CYGWIN*) ;; \
	  *) echo "❌ setup-dev-windows is Windows-only (run from Git Bash)."; exit 1;; \
	esac
	@ps="$${SYSTEMROOT:-C:\\Windows}"; ps="$${ps//\\//}/System32/WindowsPowerShell/v1.0/powershell.exe"; \
	 "$$ps" -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dev-windows.ps1

all: build

build: build-runtime build-cli build-os-cli build-mcp build-angular
	@echo "\n✅ All builds complete"

TEST_LANES_JOBS ?= 4
test: guard-not-prod-data-dir
	@"$(MAKE)" test-build-phase
	@"$(MAKE)" -j$(TEST_LANES_JOBS) test-run-lanes
	@echo "\n✅ All tests passed"

check: check-clippy check-desktop-clippy check-proxy-clippy check-fmt check-mcp check-mcp-lint check-angular-lint
	@echo "\n✅ All checks passed"

clean:
	cargo clean
	cd desktop/src-tauri && cargo clean
	rm -rf desktop/src/dist desktop/src/node_modules/.cache
	cd mcp-servers && rm -rf node_modules/*/dist */dist
	rm -rf native/macos/*/.build
	@echo "✅ Clean"

install-deps: setup-dev

install-hooks:
	$(NPM) install
	$(NPX) husky
	@echo "✅ Git hooks installed"

build-runtime:
	cargo build -p speedwave-runtime

build-cli:
	cargo build -p speedwave-cli

build-cli-release:
	cargo build -p speedwave-cli --release

generate-installer-nsh:
	@bash scripts/generate-installer-nsh.sh

build-desktop: generate-installer-nsh
	@if [ "$(OS)" = "Windows_NT" ]; then bash scripts/check-vulkan-path-budget.sh; fi
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
	@"$(MAKE)" stage-vulkan-windows
else
	cp target/release/speedwave desktop/src-tauri/cli/speedwave
	chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" verify-bundled-assets
	cd desktop/src-tauri && cargo tauri build
	@echo "\n✅ Tauri production bundle built"

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

bundle-static-licenses:
	@mkdir -p desktop/src-tauri/THIRD-PARTY-LICENSES
	@cp desktop/src-tauri/licenses-static/* desktop/src-tauri/THIRD-PARTY-LICENSES/
	@echo "✅ Static third-party licenses copied into THIRD-PARTY-LICENSES/"

stage-vulkan-windows:
	@bash scripts/check-vulkan-path-budget.sh
	@bash scripts/stage-vulkan-runtime.sh

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

build-mcp:
	cd mcp-servers && $(NPM) run build

build-angular:
	cd desktop/src && $(NPX) ng build

define RUN_CARGO_ISOLATED
	d=$$(mktemp -d) || exit 1; mkdir -p "$$d/speedwave-test"; \
	  SPEEDWAVE_DATA_DIR="$$d/speedwave-test" $(1); \
	  rc=$$?; rm -rf "$$d"; exit $$rc
endef

test-build-phase: generate-installer-nsh build-cli build-angular build-mcp build-os-cli
	@if [ "$$(uname)" = "Darwin" ] && [ ! -s desktop/src-tauri/lima/bin/limactl ]; then "$(MAKE)" download-lima; fi
	@if [ "$(OS)" = "Windows_NT" ] && [ ! -s desktop/src-tauri/wsl/nerdctl-full.tar.gz ]; then "$(MAKE)" download-wsl-resources; fi
	@if [ ! -s desktop/src-tauri/nodejs/bin/node ] && [ ! -s desktop/src-tauri/nodejs/node.exe ]; then "$(MAKE)" download-nodejs; fi
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	@mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	@cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
	@"$(MAKE)" stage-vulkan-windows
else
	@cp target/debug/speedwave desktop/src-tauri/cli/speedwave
	@chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" bundle-static-licenses
	@"$(MAKE)" verify-bundled-assets
	@echo "✅ Build phase complete"

test-rust-run: guard-not-prod-data-dir
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime -p speedwave-cli --features speedwave-runtime/test-support)
	"$(MAKE)" test-transcription
	@echo "✅ Rust tests passed"

test-angular-run: test-angular

test-mcp-run:
	cd mcp-servers && $(NPM) test
	@echo "✅ MCP server tests passed"

DESKTOP_BUILD_BATS := _tests/desktop/desktop-build.bats _tests/desktop/bundle-build-context.bats \
  _tests/desktop/guard-prod-data-dir.bats _tests/desktop/verify-bundled-assets.bats \
  _tests/desktop/sign-bundled-binaries.bats _tests/desktop/release-workflow-signing.bats \
  _tests/desktop/sign-windows-binaries.bats _tests/desktop/setup-dev-windows.bats \
  _tests/desktop/info-plist.bats _tests/desktop/entitlements-reminders.bats \
  _tests/desktop/main-app-entitlements.bats _tests/desktop/native-cli-info-plist.bats \
  _tests/desktop/transcription-bundle.bats _tests/desktop/build-native-macos.bats \
  _tests/desktop/bundle-native-assets.bats _tests/desktop/vulkan-scripts.bats \
  _tests/desktop/dev-server-port.bats _tests/desktop/check-windows-build-deps.bats

test-desktop-build-run:
	@$(REQUIRE_BATS)
	bats --print-output-on-failure $(DESKTOP_BUILD_BATS)
	@echo "✅ Desktop build tests passed"

test-desktop-run: guard-not-prod-data-dir
	$(call RUN_CARGO_ISOLATED,sh -c 'cd desktop/src-tauri && cargo test')
	@echo "✅ Desktop tests passed"

test-run-lanes: test-rust-run test-angular-run test-entrypoint test-desktop-config test-ci \
                test-mcp-run test-desktop-build-run test-desktop-run test-proxy

test-proxy: guard-not-prod-data-dir
	cd containers/proxy && cargo test --locked
	@echo "✅ proxy tests passed"

test-rust: guard-not-prod-data-dir
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime -p speedwave-cli --features speedwave-runtime/test-support)
	"$(MAKE)" test-transcription
	@echo "✅ Rust tests passed"

test-transcription: guard-not-prod-data-dir
	@if [ "$(OS)" = "Windows_NT" ]; then bash scripts/check-vulkan-path-budget.sh "$(CURDIR)" "root workspace build dir"; fi
	@echo "🧪 Testing speedwave-runtime with the audio-transcription feature..."
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime --features audio-transcription transcription::)
	@echo "✅ audio-transcription tests passed"

test-mcp-os-bundle: build-mcp guard-not-prod-data-dir
	@echo "🧪 Staging the real mcp-os worker bundle..."
	@bash scripts/bundle-build-context.sh
	@echo "🧪 Running the mcp-os upgrade-path test against the bundled worker..."
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime --features mcp-os-bundle-e2e upgrade_path_with_real_bundled_mcp_os)
	@echo "✅ mcp-os bundle upgrade-path test passed"

test-cli: guard-not-prod-data-dir
	@echo "🧪 Testing CLI..."
	$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-cli)
	@echo "✅ CLI tests passed"

test-desktop: build-cli build-angular build-mcp build-os-cli generate-installer-nsh guard-not-prod-data-dir
	@if [ "$$(uname)" = "Darwin" ] && [ ! -s desktop/src-tauri/lima/bin/limactl ]; then "$(MAKE)" download-lima; fi
	@if [ "$(OS)" = "Windows_NT" ] && [ ! -s desktop/src-tauri/wsl/nerdctl-full.tar.gz ]; then "$(MAKE)" download-wsl-resources; fi
	@if [ ! -s desktop/src-tauri/nodejs/bin/node ] && [ ! -s desktop/src-tauri/nodejs/node.exe ]; then "$(MAKE)" download-nodejs; fi
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	@mkdir -p desktop/src-tauri/cli
ifeq ($(OS),Windows_NT)
	@cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
	@"$(MAKE)" stage-vulkan-windows
else
	@cp target/debug/speedwave desktop/src-tauri/cli/speedwave
	@chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" bundle-static-licenses
	@"$(MAKE)" verify-bundled-assets
	$(call RUN_CARGO_ISOLATED,sh -c 'cd desktop/src-tauri && cargo test')
	@if [ "$(OS)" != "Windows_NT" ]; then "$(MAKE)" test-mcp-os-bundle; fi
	@echo "✅ Desktop tests passed"

test-angular:
	cd desktop/src && $(NPX) ng test --no-watch
	@echo "✅ Angular tests passed"

test-mcp: build-mcp
	cd mcp-servers && $(NPM) test
	@echo "✅ MCP server tests passed"

test-os: build-mcp
	cd mcp-servers/os && $(NPX) vitest run
	@echo "✅ OS MCP server tests passed"

test-mcp-office-py:
	@PY=$$(command -v python3.12 || command -v python3.11 || command -v python3); \
	VENV="$${TMPDIR:-/tmp}/office-test-venv-$$$$"; \
	echo "  building office Python test venv ($$PY) at $$VENV..."; \
	"$$PY" -m venv --clear "$$VENV"; \
	"$$VENV/bin/pip" install -q --upgrade pip; \
	"$$VENV/bin/pip" install -q -r mcp-servers/office/requirements.txt pytest; \
	"$$VENV/bin/python" -m pytest mcp-servers/office/scripts -q; status=$$?; \
	rm -rf "$$VENV"; exit $$status
	@echo "✅ Office Python script tests passed"

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
	"$(MAKE)" coverage-angular
	@echo "\n✅ Coverage reports generated:"
	@echo "  Rust:    target/coverage/rust/html/index.html"
	@echo "  MCP:     mcp-servers/coverage/index.html"
	@echo "  Angular: desktop/src/coverage/speedwave-desktop-ui/index.html"
	@[ "$$(uname)" = "Darwin" ] && open target/coverage/rust/html/index.html || true

test-e2e: build-cli
	@$(REQUIRE_BATS)
	bats _tests/e2e/e2e-vm-excludes.bats
	SPEEDWAVE_BIN=./target/debug/speedwave bats _tests/e2e/speedwave.bats
	SPEEDWAVE_BIN=./target/debug/speedwave bats _tests/e2e/plugin-tamper.bats

test-e2e-plugin-tamper-release: build-cli-release
	@$(REQUIRE_BATS)
	SPEEDWAVE_BIN=./target/release/speedwave bats _tests/e2e/plugin-tamper.bats

ENGINE_CONTRACT_EXEC ?= env LIMA_HOME=$(HOME)/.speedwave-dev/lima /Applications/Speedwave.app/Contents/Resources/lima/bin/limactl shell speedwave-dev -- sudo

test-engine-contract:
	@$(REQUIRE_BATS)
	ENGINE_EXEC="$(ENGINE_CONTRACT_EXEC)" bats --print-output-on-failure _tests/e2e/engine-contract.bats

test-e2e-update-dirty: build-cli
	@test -n "$(SPW_E2E_PROJECT)" || { echo "SPW_E2E_PROJECT is required (e.g. make test-e2e-update-dirty SPW_E2E_PROJECT=speedwave)"; exit 1; }
	ENGINE_EXEC="$(ENGINE_CONTRACT_EXEC)" SPEEDWAVE_DATA_DIR=$(HOME)/.speedwave-dev \
	SPW_E2E_PROJECT="$(SPW_E2E_PROJECT)" SPEEDWAVE_BIN=$(CURDIR)/target/debug/speedwave \
	bats --print-output-on-failure _tests/e2e/update-dirty-state.bats

test-entrypoint:
	@$(REQUIRE_BATS)
	bats _tests/entrypoint/entrypoint.bats _tests/entrypoint/install-claude.bats \
	  _tests/entrypoint/statusline.bats _tests/entrypoint/osc52-copy.bats
	@echo "✅ Entrypoint tests passed"

test-ci:
	@$(REQUIRE_BATS)
	bats _tests/ci/validate-pr-title-main.bats _tests/ci/windows-only-test-list.bats \
	  _tests/ci/rust-coverage-gates.bats _tests/ci/dependabot-cargo-workspaces.bats \
	  _tests/ci/composite-action-pins.bats _tests/ci/node-version-pin.bats \
	  _tests/ci/bats-assertion-hygiene.bats _tests/ci/ci-gate.bats \
	  _tests/ci/angular-coverage-gates.bats _tests/ci/makefile-path-precedence.bats \
	  _tests/ci/bats-suite-wiring.bats _tests/ci/repo-ignores.bats
	@echo "✅ CI workflow tests passed"

test-desktop-build: build-angular build-mcp
	@$(REQUIRE_BATS)
	bats --print-output-on-failure $(DESKTOP_BUILD_BATS)
	@echo "✅ Desktop build tests passed"

test-native-cli-plist:
	@$(REQUIRE_BATS)
	bats --print-output-on-failure _tests/desktop/native-cli-info-plist.bats
	@echo "✅ Native CLI embedded-plist tests passed"

test-desktop-config:
	@$(REQUIRE_BATS)
	bats _tests/desktop/updater-config.bats _tests/desktop/version-consistency.bats \
	  _tests/desktop/backmerge-alignment.bats _tests/desktop/e2e-rig-deps.bats \
	  _tests/desktop/ps1-utf8-bom.bats _tests/desktop/installer-reset.bats
	@echo "✅ Desktop config tests passed"

test-release-gate:
	@$(REQUIRE_BATS)
	@command -v jq >/dev/null 2>&1 || { echo "❌ jq not found. Install: brew install jq"; exit 1; }
	bats _tests/desktop/verify-release-assets.bats
	@echo "✅ Release-gate tests passed"

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
	@"$(MAKE)" stage-vulkan-windows
else
	@cp target/release/speedwave desktop/src-tauri/cli/speedwave
	@chmod +x desktop/src-tauri/cli/speedwave
endif
	@"$(MAKE)" bundle-static-licenses
	@"$(MAKE)" verify-bundled-assets
	@echo "── Building release binary with bundle (e2e feature = WebDriver on :4445)..."
	cd desktop/src-tauri && cargo tauri build --features e2e $(if $(TAURI_SIGNING_PRIVATE_KEY),,--no-sign)
	@echo "── Installing E2E deps..."
	cd desktop/e2e && $(NPM) install --prefer-offline

test-e2e-desktop: test-e2e-desktop-build
	@echo "── Running E2E specs..."
	@"$(MAKE)" _e2e-run
	@echo "✅ Desktop E2E tests passed"

E2E_BINARY = $(shell bash scripts/cargo-target-dir.sh desktop/src-tauri)/release/speedwave-desktop

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

_e2e-macos:
	@bash scripts/e2e-vm.sh macos

_e2e-windows:
	@bash scripts/e2e-vm.sh windows

test-e2e-all:
	@bash scripts/e2e-vm.sh all

test-e2e-audio:
	@bash scripts/e2e-vm.sh windows-audio

setup-e2e-vms:
	@bash scripts/e2e-vm-setup.sh all

check-clippy:
	cargo clippy -p speedwave-runtime -p speedwave-cli --all-targets -- -D warnings
	cargo clippy -p speedwave-runtime --all-targets --features test-support,audio-transcription -- -D warnings
	@echo "✅ Clippy: 0 warnings"

check-desktop-clippy: build-angular build-mcp
	@if [ "$(OS)" = "Windows_NT" ]; then bash scripts/check-vulkan-path-budget.sh; fi
	@bash scripts/bundle-build-context.sh
	@bash scripts/create-desktop-stubs.sh
	cd desktop/src-tauri && SPEEDWAVE_ALLOW_BUNDLE_STUBS=1 cargo clippy -- -D warnings
	@echo "✅ Desktop clippy: 0 warnings"

check-proxy-clippy:
	cd containers/proxy && cargo clippy --all-targets --locked -- -D warnings
	@echo "✅ Proxy clippy: 0 warnings"

check-mcp:
	@echo "  Building mcp-servers/shared (required by other workspaces)..."
	@cd mcp-servers/shared && $(NPX) tsc
	@echo "  Building PII engine wasm artifact (policies/src/engine.ts imports it)..."
	@cd mcp-servers/policies && $(NPM) run build:wasm
	@echo "  Building mcp-servers/policies (required by hub)..."
	@cd mcp-servers/policies && $(NPX) tsc
	@for ws in shared policies hub slack sharepoint redmine gitlab github atlassian office os oauth; do \
		echo "  tsc --noEmit mcp-servers/$$ws"; \
		(cd mcp-servers/$$ws && $(NPX) tsc --noEmit) || exit 1; \
	done
	@echo "✅ MCP type-check done"

check-angular:
	cd desktop/src && $(NPX) ng build --configuration production
	@$(REQUIRE_BATS)
	bats _tests/desktop/desktop-build.bats
	@echo "✅ Angular production build + desktop path verification OK"

PRETTIER_GLOBS := 'mcp-servers/*/src/**/*.ts' 'desktop/src/src/**/*.ts' '*.md'

check-fmt:
	cargo fmt --all -- --check
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --all -- --check
	cargo fmt --manifest-path containers/proxy/Cargo.toml --all -- --check
	$(NPX) prettier --check $(PRETTIER_GLOBS)
	@echo "✅ Format check passed"

check-mcp-lint:
	cd mcp-servers && $(NPX) eslint .
	@echo "✅ MCP ESLint passed"

check-angular-lint:
	cd desktop/src && $(NPX) eslint 'src/**/*.ts'
	@echo "✅ Angular ESLint passed"

audit: audit-rust audit-mcp audit-desktop
	@echo "\n✅ No known vulnerabilities"

AUDIT_IGNORE := --ignore RUSTSEC-2026-0194 --ignore RUSTSEC-2026-0195 --ignore RUSTSEC-2024-0429

audit-rust:
	@command -v cargo-audit >/dev/null 2>&1 || { echo "❌ cargo-audit not found. Install: cargo install cargo-audit"; exit 1; }
	cargo audit $(AUDIT_IGNORE)
	cargo audit $(AUDIT_IGNORE) --file desktop/src-tauri/Cargo.lock
	@echo "✅ Rust dependencies: no vulnerabilities"

NPM_AUDIT_LEVEL := high

audit-mcp:
	cd mcp-servers && $(NPM) audit --audit-level=$(NPM_AUDIT_LEVEL) --omit=dev
	@echo "✅ MCP dependencies: no vulnerabilities"

audit-desktop:
	cd desktop/src && $(NPM) audit --audit-level=$(NPM_AUDIT_LEVEL) --omit=dev
	@echo "✅ Desktop dependencies: no vulnerabilities"

check-all: check test coverage audit
	@echo "\n✅ Full quality gate passed — safe to push"

fmt:
	cargo fmt --all
	cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --all
	cargo fmt --manifest-path containers/proxy/Cargo.toml --all
	$(NPX) prettier --write $(PRETTIER_GLOBS)
	@echo "✅ Formatted"

lint:
	cargo clippy -p speedwave-runtime -p speedwave-cli -- -D warnings
	cd desktop/src-tauri && cargo clippy -- -D warnings
	cd mcp-servers && $(NPX) eslint --fix .
	cd desktop/src && $(NPX) eslint --fix 'src/**/*.ts'
	@echo "✅ All lints passed"

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
	@bash scripts/prune-bundled-lima.sh desktop/src-tauri
	@cp desktop/src-tauri/lima/share/doc/lima/LICENSE \
		desktop/src-tauri/THIRD-PARTY-LICENSES/lima-LICENSE 2>/dev/null || true
	@curl -fsSL "https://raw.githubusercontent.com/lima-vm/lima/v$(LIMA_VERSION)/NOTICE" \
		-o desktop/src-tauri/THIRD-PARTY-LICENSES/lima-NOTICE 2>/dev/null || true
	@echo "  ✅ Lima $(LIMA_VERSION) ready"

clean-lima:
	rm -rf desktop/src-tauri/lima desktop/src-tauri/THIRD-PARTY-LICENSES

NODE_VERSION := $(shell cat .node-version)

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

NERDCTL_FULL_VERSION     := $(shell grep -A1 '^pub const NERDCTL_FULL_VERSION' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
NERDCTL_FULL_SHA256_AMD64 := $(shell grep -A1 '^pub const NERDCTL_FULL_SHA256_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
WSL_ROOTFS_URL_AMD64     := $(shell grep -A1 '^pub const WSL_ROOTFS_URL_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')
WSL_ROOTFS_SHA256_AMD64  := $(shell grep -A1 '^pub const WSL_ROOTFS_SHA256_AMD64' crates/speedwave-runtime/src/consts.rs | grep '"' | sed 's/.*"\(.*\)".*/\1/')

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

ifeq ($(OS),Windows_NT)
dev: guard-not-prod-data-dir guard-dev-port download-nodejs download-wsl-resources generate-installer-nsh
	@command -v cargo-tauri >/dev/null 2>&1 || { echo "❌ cargo-tauri not found. Install: cargo install tauri-cli"; exit 1; }
	@"$(MAKE)" build-cli && "$(MAKE)" build-os-cli && "$(MAKE)" build-mcp
	@echo "Preparing build context..."
	@bash scripts/bundle-build-context.sh
	mkdir -p desktop/src-tauri/cli
	cp target/debug/speedwave.exe desktop/src-tauri/cli/speedwave.exe
	@"$(MAKE)" stage-vulkan-windows
	@"$(MAKE)" bundle-static-licenses
	@"$(MAKE)" verify-bundled-assets
	@bash scripts/dev-tauri-windows.sh
else
dev: guard-not-prod-data-dir guard-dev-port build-cli build-os-cli build-mcp download-nodejs generate-installer-nsh
	@command -v cargo-tauri >/dev/null 2>&1 || { echo "❌ cargo-tauri not found. Install: cargo install tauri-cli"; exit 1; }
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" download-lima; fi
	@echo "Preparing build context..."
	@bash scripts/bundle-build-context.sh
	@if [ "$$(uname)" = "Darwin" ]; then "$(MAKE)" bundle-native-assets; fi
	mkdir -p desktop/src-tauri/cli
	cp target/debug/speedwave desktop/src-tauri/cli/speedwave
	chmod +x desktop/src-tauri/cli/speedwave
	@"$(MAKE)" bundle-static-licenses
	@"$(MAKE)" verify-bundled-assets
	cd desktop/src-tauri && env -u PORT SPEEDWAVE_RESOURCES_DIR="$$(pwd)" SPEEDWAVE_ALLOW_UNSIGNED=1 TAURI_CONFIG="$$DEV_TAURI_CONFIG" cargo tauri dev --config "$$DEV_TAURI_CONFIG"
endif

status: guard-not-prod-data-dir
	@echo "=== Rust ==="
	@$(call RUN_CARGO_ISOLATED,cargo test -p speedwave-runtime -p speedwave-cli --features speedwave-runtime/test-support 2>&1 | grep "test result" || true)
	@echo "\n=== Clippy ==="
	@echo "Warnings: $$(cargo clippy -p speedwave-runtime -p speedwave-cli 2>&1 | grep -c '^warning' || echo 0)"
	@echo "\n=== MCP Servers ==="
	@cd mcp-servers && $(NPM) test 2>&1 | grep -E "Tests|Test Files" | tail -2 || true
	@echo "\n=== Angular ==="
	@cd desktop/src && $(NPX) ng build 2>&1 | tail -1 || true
