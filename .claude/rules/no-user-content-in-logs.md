---
paths:
  - 'crates/**/*.rs'
  - 'desktop/src-tauri/**/*.rs'
  - 'desktop/src/**/*.ts'
  - 'mcp-servers/**/*.ts'
  - 'containers/compose.template.yml'
---

# No user content in logs

**User work content never reaches a log. Log the name, the identifier and the size.** The secret sanitizer (`log_sanitizer.rs`) knows the shapes of secrets (tokens, API keys, authorization headers). Work content has no shape: a password in a config file, a value from a `.env`, a customer's data, a page the agent wrote. Those pass the sanitizer untouched, and the diagnostics ZIP ships whatever the logs hold. This rule applies to Rust (`crates/`, `desktop/src-tauri/`), the Angular app (`desktop/src/`) and the Node containers (`mcp-servers/`) alike.

## What counts as user content

- Tool inputs and results, including a truncated preview of either.
- Chat text, the model's reply text, thinking text.
- Commands the agent runs and the content of files and pages it reads or writes.
- Names and paths of files the user attached or pasted.
- URLs with a query string or a fragment, and any other value the user typed into a parameter.
- Exception messages that can echo any of the above. `JSON.parse` errors quote a slice of the input; an HTTP client error quotes the response body; a worker error quotes the resource.

## What may be logged

- Tool name, service name, category (`[READ]`, `[WRITE]`, `[DELETE]`), call id, tab id, session id.
- Parameter names, with the length of each value, never the value: `os.createReminder(keys name:23,notes:23)`.
- Lengths, byte counts, counts of items, booleans such as "last char is a closing bracket", file extension (only when it is a short alphanumeric token), media type.
- Error code and error class name. Never the message.
- Resource identifiers that diagnosis needs and that are not content: repository owner and name, issue key, pull request number, Redmine issue number, HTTP status. These stay in worker logs on purpose, because telling a 404 from a 403 for a given resource is how an integration failure gets diagnosed.
- A rejection reason and the length of the rejected value (path validators: `attackType`, `reason`, `pathLength`), not the value.

## Errors

- Node: log `describeError(error)` from `mcp-servers/shared/src/logger.ts`, which returns `code=<CODE> name=<Name>` and never the message. The agent still receives the full message in the tool result; only the log is reduced.
- Angular: log `err.name`, not `String(err)`, when the error came from parsing or from user-supplied data. `GlobalErrorHandler` forwards the error name and the stack frames, never the message.
- Rust: an error text that embeds a path or a user value is logged as a fixed sentence plus size or id, not `{e}`.

## Sentinel tests

A sentinel test pushes a known value through the real logging path and asserts that the value is in no argument the logger received and in no line written. The value is `SENTINEL-997-<channel>`; the test fails on the prefix `SENTINEL-997`, so a new channel needs no new assertion. Test behaviour (what was written), not how the code is built.

- Node, `mcp-servers/`: spy on every `console` method (`log`, `info`, `warn`, `error`, `debug`) and collect the arguments with `util.inspect(args, { depth: 8 })`, so error stacks and own properties are included. Existing tests: `mcp-servers/hub/src/no-user-content-in-logs.test.ts` (the tool call line, worker errors, sandbox `console.*`, the denylist error), `mcp-servers/shared/src/no-user-content-in-logs.test.ts` (JSON-RPC handler, transport, retry), and the per-worker tests in `mcp-servers/redmine/src/client.test.ts`, `mcp-servers/os/src/security.test.ts`, `mcp-servers/sharepoint/src/security.test.ts`, the github and gitlab `tools/validation.test.ts`, `mcp-servers/github/src/no-user-content-in-logs.test.ts` (the request log), and the `error code logged for an isError result` cases in `mcp-servers/hub/src/http-bridge.test.ts` (class and status tokens inside the message stay out of the code).
- Angular, `desktop/src/`: provide `makeMockLogger()` from `testing/mock-logger.ts` as `LoggerService`, drive the code, and assert `JSON.stringify` of all four `mock.calls` arrays does not contain `SENTINEL-997`. Existing tests: `services/chat-session-store.spec.ts` (tool input that fails to parse), `services/file-attachment.service.spec.ts` (pasted attachments), `error-handler.spec.ts` (uncaught errors).
- Rust: assert on what the code hands to the log. For a parser that returns the line it wants written, assert on the returned text (`chat.rs`, `stream_parser_session_log_entries_carry_no_user_content`, over `StreamParser::parse_line` and `LogEntry::message`). For a pure collator, assert on the returned entries (`http_debug_collator.rs`, the `*_logs_no_content` tests). A test that installs a global `log` logger conflicts with the other logger-capturing tests in the same binary, so prefer the returned text.

A new log statement that could carry a value from the user gets a sentinel case in the nearest of these files, or a new file named `no-user-content-in-logs.test.ts` in the worker that owns it.

## DEBUG= is not allowed in the compose template

`DEBUG=` makes Node libraries print their internals. `DEBUG=pw:mcp:*` made the Playwright worker log every tool argument and result in multi-line blocks. No service of the rendered compose may carry a `DEBUG` environment entry, in the list form (`DEBUG=...`), the map form (`DEBUG: ...`) or bare (`DEBUG`). The guard is `compose/mod.rs`, `test_rendered_compose_has_no_debug_env_outside_the_exceptions`, which renders the template with every worker enabled and reads the result; `DEBUG_ENV_EXCEPTIONS` is the explicit exceptions list and is empty. An exception needs a named service and a reason that the service's debug output holds no user content.

## Claude Code HTTP debug output

`ANTHROPIC_LOG=debug` blocks pass through `http_debug_collator.rs` before the session log. The collator keeps method, URL without query and fragment, status, model, token limit, counts and timing. A braced block it does not recognise is reduced to its byte size; a line without braces that matches no known shape passes through. Extend the collator when a new block shape appears; never log the raw block.

## Export window

The diagnostics export keeps only the lines inside a chosen time window (2 h, 24 h, 7 d, 30 d). The window rules are the pure leaf module `crates/speedwave-runtime/src/export_window.rs` (no IO, no file access); `desktop/src-tauri/src/diagnostics.rs` is the adapter that reads files and calls it. The timestamp shapes a source carries are declared in the `DIAGNOSTIC_SOURCES` row of that source, and the module knows only those shapes. Local logs stay complete because they serve diagnosis; this rule and the window together decide what leaves the machine.
