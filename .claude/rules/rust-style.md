---
paths:
  - 'crates/**/*.rs'
  - 'desktop/src-tauri/**/*.rs'
---

# Rust Style Rules

- Use the `log` crate facade (`error!`, `warn!`, `info!`, `debug!`, `trace!`) for all diagnostic output — see `.claude/rules/logging.md` for full details
- Never use `eprintln!` or `println!` for logging (only for direct user-facing CLI output and panic hook fallback)
- Structs containing secrets must not derive `Debug` — implement a manual `Debug` that redacts sensitive fields
- Container/external logs returned to the frontend must pass through `sanitize()` before being sent to the webview
- `crates/speedwave-runtime/` is pure Rust — no Tauri coupling
