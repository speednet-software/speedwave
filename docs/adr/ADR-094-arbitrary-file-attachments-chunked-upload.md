# ADR-094: Arbitrary file attachments streamed to disk through chunked raw-body IPC

> **Status:** Accepted (2026-10-16). Amends ADR-065.
> **Context:** ADR-065 made pasted and dropped images reach Claude as files under `<project>/.speedwave/pastes/` referenced by an `@/workspace/...` text token. The composer accepted only JPEG, PNG, GIF and WebP, and every byte went through the renderer's resampler and one `save_pasted_image` invoke whose payload was a JSON array of numbers (`Array.from(bytes)` in `desktop/src/src/app/services/image-preprocessor.service.ts`), under a 3 MB post-resample cap and a 10 MB host cap (`desktop/src-tauri/src/paste_cmd.rs`). SPEED-801 asks for any file type, without the whole file in memory and without a size cap that has no reason once the bytes only need to land on disk.

## Decision

1. **Every file type is accepted by paste and drop.** `isSupportedImageType` (`image-preprocessor.service.ts`) routes the four raster types through the unchanged ADR-065 image pipeline; everything else, SVG and TIFF included, goes through the file pipeline below.
2. **Non-image files are streamed, never buffered.** `FileAttachmentService.stage` (`desktop/src/src/app/services/file-attachment.service.ts`) opens an upload with `begin_paste_upload`, reads the `File` in `UPLOAD_CHUNK_BYTES` (8 MiB) slices through `Blob.slice().arrayBuffer()`[^1][^2] and sends each slice as the raw body of an `append_paste_upload` invoke, addressed by an `x-upload-id` request header, then calls `finish_paste_upload`. Tauri's `invoke` sends an `ArrayBuffer` or `Uint8Array` argument as an `application/octet-stream` body and forwards request headers to the command[^3]; the command reads them through `tauri::ipc::Request` (`body()` as `InvokeBody::Raw`, `headers()`)[^4]. The renderer holds one slice at a time; the Rust side holds one request body at a time and appends it to `<name>.part` under the pastes directory (`paste_cmd.rs::append_chunk`). wry delivers custom-protocol request bodies on macOS (`HTTPBody`, or `HTTPBodyStream` when WebKit streams it) and on Windows (`Content()` as an `IStream`)[^5][^6]; the lockfile carries wry 0.57.0, the bodies were checked in the 0.55.1 source.
3. **`append_paste_upload` is a sync command with `#[tauri::command(async)]`.** A sync command runs on the main thread unless marked `async`, which moves it to a thread pool; an `async fn` with a borrowed argument such as `Request<'_>` must return a `Result`[^7]. The sync-plus-attribute shape keeps the disk write off the main thread and keeps the argument borrow trivial. `begin`, `finish` and `abort` are `async fn` wrappers over `spawn_blocking`, like `save_pasted_image`.
4. **Bounds that remain.** There is no total size cap. The size the renderer declares at `begin` is the upper bound of the appends (one byte over discards the upload and its part file); one append body is capped at 16 MiB (`MAX_UPLOAD_CHUNK_BYTES`), which bounds what one request holds in memory; `finish` refuses an upload short of its declared size. A failed write, `ENOSPC` included, is returned as the error text and shown in the composer. The image path keeps its 3 MB and 10 MB caps, because those bytes still reach the model inline through Claude Code's `Read` tool, where Anthropic's per-image limits apply (ADR-065).
5. **On-disk name.** Images keep `paste-<ts>-<seq>.<ext>`. Files get `paste-<ts>-<seq>-<stem>.<ext>` (`paste_cmd.rs::generate_upload_filename`): path components are dropped (`../x` becomes `x`), the stem keeps Unicode alphanumerics plus `_` and `.`, maps every other run of characters to one `-`, and is cut at 64 characters; the extension keeps up to 16 lowercase ASCII alphanumerics, else it is folded into the stem. No whitespace survives, so the `@path` token stays one word. The chat shows the original name.
6. **Cancellation.** Each `ComposerAttachments` record owns an `AbortController`; `remove`, `clear` and `dispose` abort it, the upload loop stops at the next slice and calls `abort_paste_upload`, which deletes the part file. The part file is created with `create_new`, owner-only permissions (`fs_perms::set_owner_only`) and renamed into place only after `sync_all`.
7. **Display.** The state tree gains `MessageBlock::File { filename, size_bytes }` (`crates/speedwave-runtime/src/stream/state_tree.rs`), mirrored in `models/state-tree.ts` and rendered as a pill (`user-message-file`); the composer strip renders a name-and-size pill (`composer-attachment-file`) instead of a thumbnail. Dropped directories are reported by name (`FileDropDirective.foldersDropped`, read through `webkitGetAsEntry`[^8]) instead of producing an empty file named after the folder.
8. **The wire is unchanged.** A file reaches Claude as the same `@/workspace/.speedwave/pastes/<name>` text token ADR-065 uses for images; `chat.rs`, `send_message` and the one-slot queue are untouched.

## Why

- Native drag-drop stays off (`dragDropEnabled: false` in `desktop/src-tauri/tauri.conf.json`, SPEED-636), so a drop reaches the app only as HTML5 `File` objects without host paths; copying through IPC is the only route, and slicing is what keeps a multi-gigabyte file out of memory on both sides.
- Raw-body IPC is the transport Tauri's own `plugin:fs|write_file` uses, so the body path is exercised on every platform Speedwave ships on; a JSON array of numbers would multiply the bytes crossing the bridge by about four.
- A per-request cap plus a declared-size bound is enough: the renderer is first-party code behind the webview CSP, the file lands under the project's own pastes directory with a generated name and owner-only permissions, and a real disk-full is reported, not prevented.

## Rejected alternatives

- **Re-enabling Tauri native drag-drop for host paths.** Would let Rust copy or link the file with zero bytes through IPC, but it swallows the drop before the webview sees it, so the composer's HTML5 drop handling and its visual feedback stop working (SPEED-636), and paste still has no path.
- **One invoke with the whole file as a raw body.** Avoids the chunk loop but puts the full file in the renderer (`arrayBuffer()`) and in one Rust request; it reintroduces the memory ceiling the ticket removes.
- **A custom URI scheme with `fetch(..., { body: file })`.** The webview would stream the blob, but wry hands the handler the body as one buffer, so the Rust side still holds the whole file, and it adds a second IPC channel next to `invoke`.
- **A global size cap (for example 2 GiB).** No bound follows from the design; a cap would only turn a working copy into a refusal. Disk space is the real limit and it reports itself.
- **Keeping the original filename verbatim.** Spaces break the `@path` token and path separators would be a traversal; the sanitized stem keeps the name readable for the model without either.

[^1]: MDN, `Blob.slice()`: returns a new `Blob` containing a subset of the data the method was called on: <https://developer.mozilla.org/en-US/docs/Web/API/Blob/slice>.

[^2]: MDN, `Blob.arrayBuffer()`: returns a promise that resolves with the blob's contents as an `ArrayBuffer`: <https://developer.mozilla.org/en-US/docs/Web/API/Blob/arrayBuffer>.

[^3]: Tauri v2 JavaScript API, `core`: `InvokeArgs` is `Record<string, unknown> | number[] | ArrayBuffer | Uint8Array`, and `invoke` takes `options.headers`, "readable on the Rust side through `tauri::ipc::Request::headers`": <https://v2.tauri.app/reference/javascript/api/namespacecore/>.

[^4]: `tauri::ipc::Request` on docs.rs: "The IPC request. Includes the `body` and `headers` parameters of a Tauri command invocation. This allows commands to accept raw bytes - on all platforms except Android.", with `body(&self) -> &InvokeBody` and `headers(&self) -> &HeaderMap`: <https://docs.rs/tauri/latest/tauri/ipc/struct.Request.html>.

[^5]: wry 0.55.1, `src/wkwebview/class/url_scheme_handler.rs`: the scheme handler reads `request.HTTPBody()` and falls back to `request.HTTPBodyStream()`: <https://docs.rs/crate/wry/0.55.1/source/src/wkwebview/class/url_scheme_handler.rs>.

[^6]: wry 0.55.1, `src/webview2/mod.rs`: the web resource handler reads `webview_request.Content()` as an `IStream`: <https://docs.rs/crate/wry/0.55.1/source/src/webview2/mod.rs>.

[^7]: Tauri v2 guide, Calling Rust from the Frontend: "Commands without the async keyword are executed on the main thread unless defined with `#[tauri::command(async)]`", and for borrowed arguments in async commands, "Wrap the return type in a `Result`": <https://v2.tauri.app/develop/calling-rust/>.

[^8]: MDN, `DataTransferItem.webkitGetAsEntry()`: returns a `FileSystemEntry` whose `isDirectory` tells a dropped directory from a file: <https://developer.mozilla.org/en-US/docs/Web/API/DataTransferItem/webkitGetAsEntry>.
