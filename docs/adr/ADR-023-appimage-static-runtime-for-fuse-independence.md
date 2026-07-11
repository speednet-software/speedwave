# ADR-023: AppImage Static Runtime for FUSE Independence

> **Status:** Superseded by [ADR-025](ADR-025-linux-deb-packaging.md) (Linux moved to `.deb`), then by [ADR-059](ADR-059-drop-linux-support.md) (Linux dropped as a host platform entirely — Speedwave now ships only on macOS/Lima and Windows/WSL2). Historical: nothing in this ADR is in effect today.
> **Context:** When Speedwave still shipped a Linux AppImage, a host `libfuse2` dependency broke first-launch on Ubuntu 24.04+.

## Decision

For the period Speedwave shipped on Linux, the build repacked the Tauri-generated AppImage with the static `type2-runtime` from the `AppImage/type2-runtime` project, replacing only the AppImage runtime header while leaving the SquashFS payload (the application) untouched.

## Why

- AppImage Type 2 (the format Tauri produced) dynamically linked `libfuse.so.2`. Ubuntu 24.04 LTS dropped `libfuse2` from the default install, so a fresh 24.04 system failed to launch the AppImage until the user manually installed `libfuse2t64`[^1].
- The static `type2-runtime` statically links `libfuse3` (built against musl libc)[^2], carrying its own FUSE implementation so the runtime never searches the host for a `.so`. This preserved the "zero dependencies beyond Speedwave" promise from [ADR-000](ADR-000-product-principles.md).
- Repacking swapped only the runtime header (~140 KB larger than the default), negligible against the ~300 MB AppImage. It was a normal FUSE mount — not extract-to-`/tmp` — so no startup or UX penalty.
- The approach was already used by other projects (PCSX2, Krita) (unverified), so it was low-risk.

## License note

The static `type2-runtime` is a separate ~300 KB binary that serves as the AppImage header; Speedwave's code is the concatenated SquashFS payload, and the two do not link together. `libfuse3` is LGPL-2.1[^3]; the obligation to allow relinking/replacement was satisfied because the runtime is a separate program, its full source and build scripts are public, users can rebuild and replace just the header, and the license text shipped in `THIRD-PARTY-LICENSES/`.

## Where it lives in code

Nothing remains. The AppImage build, the repack step, and all Linux packaging were removed when Linux was dropped — see [ADR-059](ADR-059-drop-linux-support.md). The historical bundled-nerdctl rationale that this ADR referenced lives in [ADR-003](ADR-003-bundled-nerdctl-full-on-linux.md), also superseded by ADR-059.

## Rejected alternatives

- **`APPIMAGE_EXTRACT_AND_RUN=1`** — bypasses FUSE by extracting the full ~300 MB payload to `/tmp` on every launch[^4]. Rejected: required a manual env var, was slow, failed on `noexec` `/tmp`, and left stale files on a crash (unverified).
- **`.deb` only, no AppImage** — at the time, `.deb` had no Tauri auto-update path and lost the single-file-everywhere property. (This was later reversed by [ADR-025](ADR-025-linux-deb-packaging.md), then mooted by ADR-059.)
- **`.tar.gz` + manual install** — no desktop integration, no auto-update, worse UX than a self-contained AppImage.
- **Flatpak or Snap** — rejected earlier for sandbox conflicts with rootless container management; the FUSE issue did not change that.
- **Ship `libfuse2.so` alongside the AppImage** — a bundled `.so` is glibc-version-fragile across distros, needs an `LD_LIBRARY_PATH` wrapper, and does not fix the root cause (the default runtime still dlopens `libfuse.so.2`).

[^1]: [Can't Run AppImage on Ubuntu 24.04? Here's How to Fix It](https://itsfoss.com/cant-run-appimage-ubuntu/) - confirms the FUSE-2 runtime dependency and that Ubuntu 24.04 requires manually installing `libfuse2t64` in place of the dropped `libfuse2`.

[^2]: [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime) - "This repository builds a statically linked runtime for type-2 AppImages in a Alpine Linux chroot with musl libc."

[^3]: [libfuse LGPL2.txt](https://raw.githubusercontent.com/libfuse/libfuse/master/LGPL2.txt) - "GNU LESSER GENERAL PUBLIC LICENSE Version 2.1, February 1999."

[^4]: [AppImage troubleshooting: FUSE](https://docs.appimage.org/user-guide/troubleshooting/fuse.html) - documents `APPIMAGE_EXTRACT_AND_RUN=1` as extracting the AppImage contents and running them directly, bypassing FUSE.
