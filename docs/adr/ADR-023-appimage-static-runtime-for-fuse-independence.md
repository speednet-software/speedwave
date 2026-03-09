# ADR-023: AppImage Static Runtime for FUSE Independence

> **Status:** Accepted

---

## Context

Speedwave ships on Linux as an AppImage — a single-file, distribution-agnostic format that supports auto-update via the Tauri updater (ADR-003). AppImage Type 2 (the format Tauri generates) requires `libfuse2` on the host system to mount its internal SquashFS filesystem at runtime.[^1]

Ubuntu 24.04 LTS removed `libfuse2` from the default installation, shipping only `libfuse3` instead.[^2] Since `libfuse2` and `libfuse3` are not ABI-compatible, AppImage Type 2 binaries fail to launch on a fresh Ubuntu 24.04 install with:

```
dlopen(): error loading libfuse.so.2
```

This breaks Speedwave's "zero dependencies beyond Speedwave" promise (ADR-000). Users on Ubuntu 24.04+ would need to manually run `sudo apt install libfuse2t64` before launching Speedwave — an unacceptable prerequisite.

The problem affects all AppImage Type 2 applications, not just Speedwave. The AppImage community has developed a solution: a static type2-runtime that statically links `libfuse3`, eliminating the host `libfuse2` dependency entirely.[^3]

## Decision

After Tauri builds the AppImage, **repack it with a static type2-runtime** from the `AppImage/type2-runtime` project.[^3]

### How It Works

An AppImage Type 2 file consists of two parts concatenated together:

1. **Runtime** (~160 KB default, ~300 KB static) — an ELF binary that mounts the SquashFS payload using FUSE
2. **SquashFS payload** — the actual application files

The default runtime dynamically links `libfuse2` (`libfuse.so.2`). The static type2-runtime statically links `libfuse3` (compiled with musl libc), so it carries its own FUSE implementation and does not search for any `.so` on the host system.[^4]

Repacking replaces only the runtime header — the SquashFS payload (Speedwave application) is unchanged:

```bash
# Extract SquashFS offset from the original AppImage
OFFSET=$(grep -abom1 'hsqs' Speedwave.AppImage | cut -d: -f1)

# Replace runtime: static runtime + original SquashFS payload
cat runtime-x86_64 > Speedwave-repacked.AppImage
tail -c +$((OFFSET + 1)) Speedwave.AppImage >> Speedwave-repacked.AppImage
chmod +x Speedwave-repacked.AppImage
```

This is **not** `APPIMAGE_EXTRACT_AND_RUN`. The static runtime performs a normal efficient FUSE mount — it simply carries `libfuse` statically linked within the runtime binary itself, rather than loading it from the system. There is no extraction to `/tmp`, no performance penalty, and no change to the user experience.

### Overhead

The static runtime is approximately 300 KB — roughly 140 KB larger than the default runtime.[^4] This is negligible compared to the ~300 MB total AppImage size (which includes nerdctl-full per ADR-003).

### Precedents

Other projects have adopted the same approach:

- **PCSX2** — repacks AppImages with the static type2-runtime in CI[^5]
- **Krita** — ships AppImages with a custom static runtime[^6]

### What Does Not Change

- AppImage format (still Type 2, still SquashFS)
- Tauri updater compatibility (`latest.json`, signatures, delta updates)
- Code signing (the repacked AppImage is re-signed after repacking)
- `resolve_cli_source()` paths in `speedwave-runtime`
- User experience (download, chmod +x, run — same as before)

## License Analysis

The static type2-runtime is a **separate binary program** (~300 KB) that serves as the AppImage header. Speedwave's application code is the SquashFS payload — a distinct, independent work. The runtime and the payload do not link together; they are concatenated as separate binaries in the AppImage file.

| Library       | Version | License          | Notes                                                    |
| ------------- | ------- | ---------------- | -------------------------------------------------------- |
| type2-runtime | —       | MIT[^3]          | The runtime binary itself                                |
| libfuse3      | 3.15.0  | LGPL-2.1[^7]     | Statically linked into the runtime (see LGPL note below) |
| squashfuse    | 0.5.2   | BSD-2-Clause[^8] | SquashFS mounting library                                |
| zstd          | —       | BSD-3-Clause[^9] | Compression                                              |
| zlib          | —       | zlib[^10]        | Compression                                              |
| musl libc     | —       | MIT[^11]         | C standard library (static linking)                      |
| mimalloc      | —       | MIT[^12]         | Memory allocator                                         |

### LGPL-2.1 Compliance for libfuse3

`libfuse3` is licensed under LGPL-2.1, which requires that users can relink or replace the LGPL-covered library.[^7] This obligation is satisfied because:

1. The type2-runtime is a **separate program** from Speedwave. Speedwave (the SquashFS payload) does not link libfuse in any form.
2. The type2-runtime repository provides **full source code** including build scripts and CI configuration for building the runtime with any version of libfuse.[^3]
3. Users can rebuild the runtime binary from source and replace the AppImage header (first ~300 KB) without modifying Speedwave itself.
4. The full LGPL-2.1 license text is included in `THIRD-PARTY-LICENSES/appimage-runtime-LGPL-2.1.txt`.

## Consequences

### Positive

- **Zero FUSE system dependency.** Speedwave AppImage runs on Ubuntu 22.04, 24.04, Fedora, Arch, openSUSE, and any other Linux distribution without requiring `libfuse2` or `libfuse3` as a system package.
- **Preserves zero-deps promise.** No manual `apt install` step before first launch — consistent with ADR-000.
- **Minimal overhead.** ~140 KB additional size in the runtime header — negligible for a ~300 MB AppImage.
- **Battle-tested approach.** Used by PCSX2, Krita, and other established projects.

### Negative

- **AppImageLauncher incompatibility.** AppImageLauncher (a third-party integration tool) has known issues with custom runtimes.[^13] However, AppImageLauncher has been unmaintained since 2022 and is not widely installed.
- **Continuous release tag.** The `AppImage/type2-runtime` project uses a continuous release tag, meaning the binary at a given URL may change when the runtime is rebuilt.[^3] The SHA256 checksum in our CI must be manually updated when a new runtime build is published.

## Rejected Alternatives

### 1. APPIMAGE_EXTRACT_AND_RUN=1 environment variable

Users can set `APPIMAGE_EXTRACT_AND_RUN=1` to bypass FUSE entirely — the AppImage extracts its full SquashFS contents to `/tmp` on every launch.[^14] Rejected because:

- Users must manually set an environment variable before launching — breaks the zero-config promise.
- Extracts the entire ~300 MB payload to `/tmp` on every launch — slow startup and high disk I/O.
- `/tmp` may have `noexec` mount options on hardened systems, causing extraction to fail.
- The extracted files are not cleaned up if the application crashes.

### 2. .deb package only (no AppImage)

Ship only a `.deb` package, avoiding the FUSE dependency entirely. Rejected because:

- `.deb` does not support auto-update via the Tauri updater — users must manually download each release or configure a custom APT repository.[^15]
- Requires separate packaging per distribution family (`.deb` for Debian/Ubuntu, `.rpm` for Fedora/RHEL).
- Loses the "single file works everywhere" property of AppImage.

### 3. .tar.gz + manual installation

Distribute as a `.tar.gz` archive with a manual install script. Rejected because:

- No desktop integration (`.desktop` file, MIME types, icons) without manual steps.
- No auto-update mechanism.
- Worse UX compared to a self-contained AppImage.

### 4. Flatpak or Snap

Previously rejected in ADR-003 for sandbox conflicts with rootless container management.[^16][^17] The FUSE issue does not change this analysis.

### 5. Ship libfuse2.so alongside the AppImage

Bundle `libfuse2.so` as a separate file next to the AppImage and set `LD_LIBRARY_PATH` at launch. Rejected because:

- `libfuse2` depends on specific glibc versions — a bundled `.so` compiled on Ubuntu 22.04 may not work on Fedora 40 or Arch.
- Requires a wrapper script or launcher to set `LD_LIBRARY_PATH`, adding packaging complexity.
- Does not solve the root cause — the AppImage runtime still dynamically loads `libfuse.so.2`.

---

[^1]: [AppImage Type 2 — FUSE requirement for SquashFS mounting](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)

[^2]: [Ubuntu 24.04 release notes — libfuse2 no longer installed by default](https://discourse.ubuntu.com/t/noble-numbat-release-notes/39890)

[^3]: [AppImage/type2-runtime — static runtime with bundled libfuse](https://github.com/AppImage/type2-runtime)

[^4]: [type2-runtime build — static linking with musl and libfuse3](https://github.com/AppImage/type2-runtime/blob/main/build.sh)

[^5]: [PCSX2 CI — AppImage repacking with static type2-runtime](https://github.com/PCSX2/pcsx2/blob/master/.github/workflows/linux_build_qt.yml)

[^6]: [Krita — custom AppImage runtime](https://invent.kde.org/graphics/krita/-/blob/master/packaging/linux/appimage/build-image.sh)

[^7]: [libfuse — LGPL-2.1 license](https://github.com/libfuse/libfuse/blob/master/LICENSE)

[^8]: [squashfuse — BSD-2-Clause license](https://github.com/vasi/squashfuse/blob/master/LICENSE)

[^9]: [zstd — BSD-3-Clause license](https://github.com/facebook/zstd/blob/dev/LICENSE)

[^10]: [zlib — zlib license](https://github.com/madler/zlib/blob/develop/LICENSE)

[^11]: [musl libc — MIT license](https://git.musl-libc.org/cgit/musl/tree/COPYRIGHT)

[^12]: [mimalloc — MIT license](https://github.com/microsoft/mimalloc/blob/master/LICENSE)

[^13]: [AppImageLauncher — issues with custom runtimes](https://github.com/TheAssassin/AppImageLauncher/issues/596)

[^14]: [AppImage — APPIMAGE_EXTRACT_AND_RUN environment variable](https://docs.appimage.org/user-guide/troubleshooting/fuse.html#setting-up-fuse-2-x-alongside-of-fuse-3-x)

[^15]: [Tauri updater — supported formats (AppImage only on Linux)](https://tauri.app/plugin/updater/)

[^16]: [Flatpak sandbox permissions — namespace restrictions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)

[^17]: [Snap confinement — strict mode restrictions](https://snapcraft.io/docs/snap-confinement)
