# ADR-068: Resource budget SSOT — container memory/CPU + adaptive VM sizing

> **Status:** Accepted
> **Context:** A production install on a 48 GB host OOM-killed the Claude container (`exec failed with exit code 137` = SIGKILL[^1]). Root cause: the `claude` container's adaptive memory limit resolved to 20 GiB (`VM − overhead`), and on a Lima VM that does not return memory to the host, the live footprint of Claude plus the co-resident workers (office 1g, playwright 2g + 2g shm, …) exceeded the VM's physical 24 GiB. The deeper problem an audit surfaced: memory/CPU numbers were scattered across three disconnected homes (`resources.rs` owned only the Claude limit; `compose.template.yml` carried ~37 hardcoded literals; plugin defaults were buried in `plugin.rs`), with nothing checking the total against the VM and no drift test linking template to code.

## Decision

One Rust module owns every memory/CPU/tmpfs/shm number Speedwave itself ships. The compose renderer substitutes placeholders from this SSOT instead of reading YAML literals; a test asserts the template carries only placeholders that resolve to the SSOT values.

1. **Claude container = fixed 6 GiB**, not adaptive. Claude Code's official hardware requirement is 4 GB+ RAM[^2] and the process itself is light (heavy compute is server-side), so a fixed 6 GiB ceiling is generous and — unlike the old `VM − overhead` formula — immune to drift when workers are added. SSOT: `resources.rs::CLAUDE_MEMORY_GIB`.

2. **Container limits are ceilings, not reservations.** A hard limit (`mem_limit` / compose `memory:`) is the maximum a container may use, not memory reserved up front[^3]. The sum of all container limits may therefore exceed the VM (overcommit) without harm, as long as live usage does not — the normal, accepted Docker/OCI posture[^3]. We do **not** sum limits and assert `Σ ≤ VM`; that would be the wrong metric. We only assert the _always-on_ containers (Claude + hub — the two that start on every project) fit the smallest supported VM.

3. **Per-worker limits live on the service descriptor.** `consts::McpServiceDescriptor` gains a `resources: ContainerResources` field, populated for each of the nine toggleable workers. Resources live next to the rest of a service's definition (auth, network, toggle), so adding a worker is one descriptor entry. The always-on containers (Claude, hub) have no descriptor and so live as constants in `resources.rs`. This is two files by design — grouped by _service ownership_, not by _resource kind_; the alternative (all numbers in one file, descriptors referencing them by key) merely moves the seam and adds a drift vector.

4. **VM sizing is adaptive and macOS-only.** `desired_vm_memory_gib = (host/2).clamp(8,32)` and `desired_vm_cpus = (host_cores/2).clamp(4,8)` — at or above the 16 GiB minimum supported host (`MIN_SUPPORTED_HOST_GIB`) this never exceeds half the host; the 8 GiB memory floor is the VM for that minimum host and is what makes the always-on set (Claude 6 GiB cap + hub) fit. A typical 16 GB / 8-core Mac gets an 8 GiB VM with 4 vCPUs[^4]. This is Lima-only: VZ pins vCPUs statically[^5] so Speedwave (owning the whole `lima.yaml`) must size them. On Windows, WSL2 schedules CPUs dynamically and defaults the VM to half host RAM[^6]; `.wslconfig` is a global, user-owned file shared with Docker Desktop and every distro[^7], so Speedwave deliberately leaves WSL2 CPU/RAM unmanaged. The asymmetry is correct per-platform behaviour, not an oversight.

5. **MCP hub = 1 full CPU** (was 0.5). The hub is on the path of every MCP request and does real CPU work (sandboxed code-exec, PII regex, result aggregation), so 1 core — a start-low value to raise only if measurement shows throttling, per the "start low, measure, adjust" sizing guidance[^8].

## Why fixed-6 over adaptive for Claude

The adaptive formula made sense in March 2026 with four light workers (~1.5 GiB total), where a 4 GiB overhead reserve held. It silently broke when office (1 GiB) and playwright (2 GiB + 2 GiB shm) landed in v0.11.0 — the overhead constant lived in a different file from the worker limits, so the person adding playwright had no reason to touch it. A fixed ceiling cannot drift this way: adding a tenth worker never changes Claude's number.

## Where it lives in code

- `ContainerResources` type, `CLAUDE_RESOURCES`, `HUB_RESOURCES`, `CLAUDE_MEMORY_GIB`, `always_on_memory_mib`, `desired_vm_memory_gib`, `desired_vm_cpus`, `host_logical_cpus`, OOM detection — `crates/speedwave-runtime/src/resources.rs`
- Per-worker `resources` field on every `TOGGLEABLE_MCP_SERVICES` entry, plugin `PLUGIN_DEFAULT_{MEM,CPU,TMPFS}` + `PLUGIN_{MEM_LIMIT_MAX_MIB,CPU_LIMIT_MAX}` caps — `crates/speedwave-runtime/src/consts.rs`
- Placeholder substitution (`apply_container_resources`) + the `resources_render_from_ssot` guard — `crates/speedwave-runtime/src/compose.rs`
- Lima `cpus`/`memory` injection (`desired_lima_vm_cpus` / `desired_lima_vm_memory`) — `desktop/src-tauri/src/setup_wizard.rs` (`#[cfg(macos)]`)
- Plugin default fallback at render — `crates/speedwave-runtime/src/plugin.rs`

## Outside the SSOT (by design, not gaps)

- **Per-plugin actual mem/cpu** come from the signed `plugin.json` in the sibling `speedwave-plugins` repo; this repo owns only the default + cap envelope (`PLUGIN_DEFAULT_*` / `PLUGIN_*_MAX`), never the value.
- **Host processes** (mcp-os, host_exec, oauth, ide-bridge) have no mem/cpu limits — they are light host-side Node processes (ADR-010), bounded by the host OS, not by Speedwave.
- **WSL2 VM CPU/RAM** — user-owned `.wslconfig`, intentionally unmanaged (decision 4).
- **Lima/VZ does not return ballooned memory to macOS** until VM restart[^9] — the reason the VM ceiling must be sized conservatively rather than relying on reclaim. (WSL2 reclaims via `autoMemoryReclaim`, default `dropCache`[^6], but its `gradual` mode is rejected: it blocks the container daemon under systemd[^10], which is exactly our setup.)

## SSOT alignment

`compose.template.yml` resource placeholders (`${CLAUDE_MEMORY}`, `${CLAUDE_CPUS}`, `${CLAUDE_TMPFS}`, `${MCP_<SVC>_{MEM,CPUS,TMPFS,SHM}}`) ↔ the `resources.rs`/descriptor SSOT. Enforced by `compose::tests::resources_render_from_ssot`, which renders the template and asserts each container's parsed values equal the SSOT entry with no resource placeholder left over. Adding a worker or changing a limit = edit the descriptor only; the template needs no edit and the renderer picks it up.

## Rejected alternatives

- **Sum-of-limits ≤ VM budget test** — wrong metric (limits are ceilings, not reservations[^3]); would assert a property the overcommit design rejects.
- **All numbers in one `resource_budget.rs`, descriptors reference by key** — moves the two-file seam from "resources vs always-on" to "service definition vs its resources" and adds a `config_key → resources` table that can drift from `TOGGLEABLE_MCP_SERVICES`.
- **Adaptive Claude memory (keep the old formula, fix the overhead)** — still drifts whenever a worker is added; a fixed ceiling is structurally immune.
- **Adaptive WSL2 vCPU/RAM via `.wslconfig`** — would throttle the user's entire WSL (global file shared with Docker Desktop[^7]); WSL2 already schedules well dynamically[^6].

## Not every exit 137 is OOM

While diagnosing the OOM above, a second, unrelated exit-137 cause surfaced and cost hours because the two are indistinguishable from the exit code alone. 137 = 128 + SIGKILL(9)[^1], and SIGKILL has two sources here:

1. **Container OOM kill** — the VM's OOM killer reaps Claude. Confirmable only via `nerdctl inspect`'s `OOMKilled=true`.
2. **Host-side `kill -9`** — a racing supervisor kills a worker. The trigger was two supervisors (the Desktop watchdog and the CLI, both running on the same `~/.speedwave`) each managing the per-project `oauth` worker (ADR-060). On spawn, `kill_stale_node` reads `lock.json` and kills the recorded PID; with two supervisors each saw the other's live worker as "stale" and killed it, cycling ~20s. When Claude called `oauth.refresh` (via SharePoint, the only refresh consumer) mid-restart, the MCP call's teardown propagated SIGKILL up the `limactl → nerdctl exec → Claude` chain as 137.

`is_oom_exit` is signature-only (137 / signal 9) and does **not** consult `OOMKilled`, so it cannot tell these apart — its message must not assert OOM as certain. The fix removes cause #2 at the source: the **CLI no longer spawns host workers** — the Desktop app owns them (it is a hard CLI prerequisite), so a single supervisor's watchdog respawns only its own dead worker and never races. Defense-in-depth: `kill_stale_node` killing a _live_ node at spawn time now logs `WARN` (a single greppable line), since with one owner that should never happen.

## References

- ADR-002 — Lima as VM manager on macOS (where the VM lives; this ADR sizes it)
- ADR-010 — mcp-os as a host process (host processes are outside container limits)
- ADR-032 — nested-virtualization resilience (the build worker pool's CPU use is a separate concern from VM/container sizing)

[^1]: Exit code 137 = 128 + SIGKILL(9), the shell convention a process killed by SIGKILL reports; the OOM killer sends SIGKILL. <https://tldp.org/LDP/abs/html/exitcodes.html>

[^2]: Claude Code system requirements: "Hardware: 4 GB+ RAM, x64 or ARM64 processor." <https://code.claude.com/docs/en/setup>

[^3]: Docker resource constraints - hard vs soft limits; `--memory` is a hard ceiling the container "can use no more than," not a reservation. <https://docs.docker.com/engine/containers/resource_constraints/>

[^4]: Apple's M3/M4 MacBook Air base config is 16 GB RAM with an 8–10-core CPU. <https://www.apple.com/macbook-air/specs/>

[^5]: Lima VZ (Apple Virtualization.framework) driver and its static CPU/memory configuration. <https://lima-vm.io/docs/config/vmtype/>

[^6]: WSL2 `.wslconfig`: `memory` defaults to 50% of host RAM; `autoMemoryReclaim` (experimental) defaults to `dropCache`. <https://learn.microsoft.com/en-us/windows/wsl/wsl-config>

[^7]: WSL2 resource management (memory/processors in `.wslconfig`) is global and shared with Docker Desktop's WSL2 backend. <https://docs.docker.com/desktop/wsl/>

[^8]: Docker memory/CPU sizing guidance: "Begin with lower limits and increase based on monitoring data." <https://docs.docker.com/engine/containers/resource_constraints/>

[^9]: Lima on VZ does not release ballooned guest memory back to macOS until the VM is restarted. <https://github.com/lima-vm/lima/discussions/2720>

[^10]: WSL `autoMemoryReclaim=gradual` can hang/block when systemd is enabled in the distro. <https://github.com/microsoft/WSL/issues/10675>
