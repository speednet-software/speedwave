---
paths:
  - 'crates/**/*.rs'
  - 'desktop/src-tauri/**/*.rs'
---

# Rust Style Rules

- Logging: use the `log` crate facade — see `.claude/rules/logging.md` for full rules
- `crates/speedwave-runtime/` is pure Rust — no Tauri coupling
