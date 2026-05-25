---
name: notes
description: Use the OS notes integration to query and manage native macOS Notes.app — listing folders and accounts, searching notes by title or body, reading note content, creating new notes, updating existing notes, and deleting notes. Use even when you think you know the answer — Notes state is dynamic; only the live API reflects current content, folder structure, and iCloud-sync updates. Do not use for: non-macOS systems, other note apps (Obsidian, Bear, Logseq, Notion, etc.), or generic note-taking-methodology advice.
user-invocable: false
allowed-tools: mcp__speedwave-hub__search_tools mcp__speedwave-hub__execute_code
---

Notes access goes through MCP Hub. All notes methods are on the injected `os` global — there is no separate `notes` global. Use `search_tools` to discover the live schema, then `execute_code` to call `os.*` methods.

## Workflow

1. `search_tools({ query: "notes", detail_level: "names_only", service: "os" })` — discover available tool names.
2. `search_tools({ query: "<toolName>", detail_level: "full_schema", service: "os" })` — get exact parameter schema before first use.
3. `execute_code` — call via `os.<toolName>(params)` using parameter names from the schema.

Always run steps 1–2 before guessing a tool name or parameter. The live schema is the source of truth.

## Key methods

- `os.listNoteFolders()` — list all folders across all accounts (no params). Returns `id`, `name`, `account_name`, `note_count`.
- `os.listNotes({ folder_id?, limit? })` — list notes, optionally filtered by folder. Default limit: 50.
- `os.getNote({ id })` — fetch a single note by ID with full `body` (HTML) and `plaintext` fields.
- `os.searchNotes({ query, folder_id?, limit? })` — search by title and body text. Default limit: 20.
- `os.createNote({ title, body?, folder_id? })` — create a note; `folder_id` optional (uses default folder if omitted).
- `os.updateNote({ id, title?, body? })` — update title or body; at least one of `title`/`body` required.
- `os.deleteNote({ id })` — permanently delete a note by ID.

## Pitfalls

- **All methods are on `os.*`, not `notes.*`** — there is no separate notes global.
- **Accounts reflect System Settings → Internet Accounts.** Notes.app supports iCloud, On My Mac, and IMAP-based accounts. `listNoteFolders` returns folders from all accounts; `account_name` distinguishes them.
- **Folder names are case-sensitive.** Call `os.listNoteFolders()` first if the user refers to a folder by name; pass the resolved `id` to other calls. Nested folders are supported — the returned `name` is the folder's own name, not its full path.
- **`body` field is HTML; `plaintext` is the stripped text.** `getNote` returns both. Use `plaintext` for text processing; use `body` only if you need to inspect or preserve rich formatting.
- **`searchNotes` matches against `plaintext`, not raw HTML.** Exact-substring matches on HTML-formatted content (bold, tables) may miss text that is visually present. If a search returns no results, try a shorter or simpler query.
- **Write/delete confirmation.** Per `CLAUDE.md`: `createNote`, `updateNote`, and `deleteNote` require explicit user confirmation before execution. `listNoteFolders`, `listNotes`, `getNote`, and `searchNotes` are read-only and need no confirmation.
- **Attachments, drawings, and tables have limited text support.** The API returns text content only; inline images, sketches, and table formatting are not accessible or writable via this integration.
- **macOS TCC permission is pre-validated by Speedwave Settings.** If this integration is enabled, assume access is granted; do not ask the user to check permissions.

## When NOT to use

- Non-macOS host environments.
- Third-party note apps (Obsidian, Bear, Notion, Logseq, Evernote, Apple Notes on iOS only, etc.).
- Plain text files in the project — use the `Read`/`Write` tools on `/workspace` instead.
- Generic note-taking methodology or knowledge-management advice not tied to the user's local Notes.app data.
