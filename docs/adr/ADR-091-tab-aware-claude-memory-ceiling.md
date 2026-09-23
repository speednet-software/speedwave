# ADR-091: Tab-aware Claude memory ceiling

> **Status:** Accepted
> **Date:** 2026-09-23
> **Context:** SPEED-388 adds parallel chat tabs (ADR-090); up to `MAX_CHAT_TABS` `claude` processes now run concurrently inside the one `claude` container. ADR-068 decision 1 fixed that container's memory ceiling at 6 GiB, sized for a single Claude Code process. Three concurrent processes under a single-process ceiling risk the exit-137 OOM class ADR-068 was written against, while raising the fixed number for everyone would inflate the always-on footprint on the smallest supported hosts, where only one tab's worth of memory fits anyway. This ADR supersedes ADR-068's decision 1 only; ceilings-not-reservations (decision 2), per-worker descriptors (decision 3), VM sizing (decision 4) and the hub limit (decision 5) stand unchanged.

## Decision

### 1. The Claude ceiling is a formula over tab capacity and VM size, not a constant

`crates/speedwave-runtime/src/resources.rs::claude_memory_gib(vm_gib)` replaces `CLAUDE_MEMORY_GIB`:

```
claude_gib = min(BASE + PER_EXTRA_TAB * (MAX_CHAT_TABS - 1),
                 max(BASE, vm_gib - VM_HEADROOM))
```

with `CLAUDE_BASE_MEMORY_GIB = 6` (the ADR-068 single-process ceiling), `CLAUDE_PER_EXTRA_TAB_GIB = 3` and `CLAUDE_VM_HEADROOM_GIB = 2` (hub hard limit + RAM-backed tmpfs + margin), all in `resources.rs`. The resulting table: an 8 GiB VM (the 16 GiB minimum supported host) stays at today's 6 GiB, a 10 GiB VM gets 8 GiB, and 14 GiB and larger VMs reach the 12 GiB tab-capacity cap. The ceiling never drops below the base, so undersized VMs degrade to exactly the pre-tab behavior instead of starving a single session. `claude_resources(vm_gib)` carries the unchanged CPU (2.0) and tmpfs (512 MiB) values next to the computed memory.

The 3 GiB per-extra-tab and 2 GiB headroom constants are provisional: they are sized from the ADR-068 single-process observations, not from measured multi-tab footprints. Phase 5 of SPEED-388 measures real concurrent-tab usage and adjusts the constants; changing either is a one-const edit in `resources.rs`.

ADR-068 rejected an adaptive Claude ceiling because the old `VM − overhead` formula drifted whenever a worker was added. This formula does not reintroduce that failure mode: its inputs are the VM size and the tab capacity, never the worker set, so adding a worker still cannot change Claude's number. The always-on fit invariant moves with it: the fit test (`resources.rs::always_on_fits_smallest_supported_vm`) evaluates the formula at the 8 GiB VM, where the clamp guarantees Claude + hub still fit.

### 2. The formula's VM input resolves per platform, reusing the existing detection path

`resources.rs::resolved_vm_memory_gib()` is `desired_vm_memory_gib(host_total_memory_gib())`, the exact composition Lima provisioning already used (`provision.rs::desired_lima_vm_memory`); the compose renderer now calls it too (`compose/mod.rs::render_compose_in` threads `claude_resources(resolved_vm_memory_gib())` through the existing `${CLAUDE_MEMORY}` placeholder in `apply_container_resources`).

- **macOS:** `host_total_memory_gib` probes real host RAM (`sysctl hw.memsize`), so the input equals the Lima VM Speedwave itself sizes (ADR-068 decision 4).
- **Windows:** WSL2 memory stays deliberately unmanaged (ADR-068 decision 4; Speedwave never writes `.wslconfig`). The WSL2 VM defaults to half of host RAM[^1], so `desired_vm_memory_gib(detected_host_ram)` would estimate it, but there is no Windows host-RAM probe in the runtime crate: `host_total_memory_gib_impl` returns `None` on Windows and the function falls back to 16 GiB, giving an 8 GiB VM estimate and a 6 GiB Claude ceiling. This conservative default is deliberate: Windows keeps exactly today's behavior until phase 5 measurement justifies both a real probe and larger ceilings, matching the ticket's measure-first stance. A Windows host whose WSL2 VM is actually larger simply keeps a lower ceiling than it could; it is never over-committed.

The resolution is a render-time input, not container state: a RAM upgrade or a `.wslconfig` change is picked up on the next compose render, which recreates the container with the new limit.

### 3. The tab cap is enforced backend-side from one SSOT

`resources.rs::MAX_CHAT_TABS = 3` is the Rust SSOT for tab capacity; the frontend mirror (`desktop/src/src/app/services/chat-session-store.ts::MAX_CHAT_TABS`) is cross-read-tested (`resources.rs::max_chat_tabs_matches_ts_mirror`), following the house `_matches_ts` pattern. The registry rejects creating a new tab entry at the cap (`desktop/src-tauri/src/chat_registry.rs::ChatSessions::prepare`, error `MSG_TAB_LIMIT_REACHED`), while existing tab ids keep working and closing a tab frees the slot. The frontend `canOpenTab` gate (`chat-state.service.ts`) becomes defense-in-depth UI: a bug or a prompt-injected call path can no longer spawn unbounded `claude` processes, because the process count and the memory formula are capped by the same constant.

## Consequences

- Hosts with 32 GiB and more get a 12 GiB Claude ceiling, sized for three concurrent tabs; the 16 GiB minimum supported host keeps 6 GiB, and its user runs multiple tabs inside the single-tab budget (acceptable: limits are ceilings, and the base already carries headroom over Claude Code's 4 GB requirement per ADR-068).
- Windows stays at 6 GiB regardless of host RAM until a measured probe lands (phase 5).
- The rendered ceiling now varies by host, so a compose file is no longer byte-identical across machines for the same config; `compose::tests::resources_render_from_ssot` asserts the placeholder alignment at two VM sizes instead of one fixed value.
- Snapshots rendered by older app versions still carry `memory: 6144m`; the update path always re-renders compose from the current config (`crates/speedwave-runtime/src/update.rs::update_containers`), so rollback compose files self-correct on the next update.

## Rejected alternatives

- **Raise the fixed ceiling to 12 GiB for everyone.** On the 8 GiB VM of the minimum supported host the always-on set would no longer fit; the ADR-068 fit invariant would have to be dropped rather than ported.
- **One container per tab.** Isolates tabs' memory cleanly but multiplies the hardened-container surface (mounts, SecurityCheck profiles, entrypoint state, IDE bridge) per tab, and Claude Code's per-project home (`~/.claude`) is shared state the tabs deliberately see together.
- **Scale by live tab count instead of capacity.** Compose bakes the limit in at container create; resizing on tab open/close means recreating the container under running sessions, exactly the disruption tabs exist to avoid. Capacity-based sizing changes the limit only at render time.
- **A Windows host-RAM probe now (`GlobalMemoryStatusEx` or PowerShell).** Rejected for this phase: it would ship an unmeasured estimate of a VM Speedwave deliberately does not manage, and phase 5's measurements decide whether the ceiling should follow the WSL2 default at all.

## References

- ADR-068: resource budget SSOT (decision 1 superseded here; decisions 2-5 unchanged)
- ADR-090: tab-keyed chat session registry (the parallel-tab mechanism this sizes for)

[^1]: WSL2 `.wslconfig`: the `memory` setting defaults to "50% of total memory on Windows". <https://learn.microsoft.com/en-us/windows/wsl/wsl-config>
