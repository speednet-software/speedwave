/**
 * Rig-side access to the bundled container engine (nerdctl) for dirty-state
 * self-heal specs — bundled limactl shell on macOS, `wsl.exe` on Windows.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';

/** Same sentinel content `engine-contract.bats` plants. */
export const DEAD_ID = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** nerdctl name-store dir; hash pinned by `consts::tests::nerdctl_addr_hash_matches_default_socket_digest`. */
export function nameStoreDir(): string {
  return '/var/lib/nerdctl/1935db59/names/default';
}

/** Resolves SPEEDWAVE_DATA_DIR the way the runtime does, default `~/.speedwave`. */
function dataDir(): string {
  return process.env.SPEEDWAVE_DATA_DIR || join(homedir(), '.speedwave');
}

/** Mirrors `consts::compose_prefix()`/`derive_instance_name_from`: data-dir basename, leading dots stripped. */
export function composePrefix(): string {
  const basename =
    dataDir()
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || '';
  return basename.replace(/^\.+/, '');
}

/** Lima VM instance name: same derivation as `composePrefix()` (`consts::lima_vm_name`). */
export function instanceName(): string {
  return composePrefix();
}

/** Mirrors `consts::derive_wsl_distro_name_from`: `.speedwave`→`Speedwave`, else `Speedwave-<suffix>`. */
export function wslDistroName(): string {
  const basename = composePrefix();
  if (basename === 'speedwave') return 'Speedwave';
  const suffix = basename.startsWith('speedwave-') ? basename.slice('speedwave-'.length) : basename;
  return `Speedwave-${suffix}`;
}

/**
 * Runs argv as root inside the engine namespace and returns trimmed UTF-8 stdout.
 * darwin: bundled limactl `shell <instance> -- sudo <argv>`; win32: `wsl.exe -d <distro> -u root --`.
 */
export function engineExec(argv: string[]): string {
  if (process.platform === 'darwin') {
    const limactl = join(
      homedir(),
      'Applications/Speedwave.app/Contents/Resources/lima/bin/limactl'
    );
    const env = { ...process.env, LIMA_HOME: join(dataDir(), 'lima') };
    return execFileSync(limactl, ['shell', instanceName(), '--', 'sudo', ...argv], {
      env,
      encoding: 'utf8',
    }).trim();
  }
  if (process.platform === 'win32') {
    const env = { ...process.env, WSL_UTF8: '1' };
    return execFileSync('wsl.exe', ['-d', wslDistroName(), '-u', 'root', '--', ...argv], {
      env,
      encoding: 'utf8',
    }).trim();
  }
  throw new Error(`engineExec: unsupported platform '${process.platform}'`);
}

const CONTAINER_LOG_TAIL = '500';

function engineArgv(argv: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (process.platform === 'darwin') {
    const limactl = join(
      homedir(),
      'Applications/Speedwave.app/Contents/Resources/lima/bin/limactl'
    );
    return {
      file: limactl,
      args: ['shell', instanceName(), '--', 'sudo', ...argv],
      env: { ...process.env, LIMA_HOME: join(dataDir(), 'lima') },
    };
  }
  if (process.platform === 'win32') {
    return {
      file: 'wsl.exe',
      args: ['-d', wslDistroName(), '-u', 'root', '--', ...argv],
      env: { ...process.env, WSL_UTF8: '1' },
    };
  }
  throw new Error(`engineArgv: unsupported platform '${process.platform}'`);
}

/**
 * Writes the recent log of every e2e project container (stdout and stderr, timestamped) and the
 * container list into `dir`, one `FAIL-<stamp>-<container>.log` per container, and returns the
 * files written. Containers are found by the `_e2e-` project infix of their compose name. The
 * argv stays free of shell metacharacters and whitespace: the Windows transport re-parses it.
 */
export function dumpContainerLogs(dir: string, stamp: string): string[] {
  const ps = engineExec(['nerdctl', 'ps', '-a', '--format', '{{.Names}}:{{.Status}}']);
  const written: string[] = [];
  const psFile = join(dir, `FAIL-${stamp}-containers.txt`);
  writeFileSync(psFile, ps + '\n');
  written.push(psFile);
  const names = ps
    .split('\n')
    .map((line) => line.split(':')[0].trim())
    .filter((name) => name.includes('_e2e-'));
  for (const name of names) {
    const { file, args, env } = engineArgv([
      'nerdctl',
      'logs',
      '--timestamps',
      '--tail',
      CONTAINER_LOG_TAIL,
      name,
    ]);
    const run = spawnSync(file, args, { env, encoding: 'utf8' });
    const body = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const logFile = join(dir, `FAIL-${stamp}-${name}.log`);
    writeFileSync(
      logFile,
      run.status === 0 ? body : `${body}\n[nerdctl logs exited ${run.status}]\n`
    );
    written.push(logFile);
  }
  return written;
}

/**
 * Copies the Claude Code session logs of the data dir into `session-logs` next to the spec
 * tree before a factory reset wipes them, and returns that directory.
 */
export function preserveSessionLogs(): string {
  const source = join(dataDir(), 'logs');
  const dest = join(process.cwd(), 'session-logs');
  rmSync(dest, { recursive: true, force: true });
  if (existsSync(source)) cpSync(source, dest, { recursive: true });
  return dest;
}

const ENGINE_PROBE_TIMEOUT_MS = 60_000;

const SUDO_TIMELINE_SCRIPT = [
  'if [ -e /etc/sudo.conf ]; then cp -p /etc/sudo.conf /tmp/spw-sudo.conf.bak || exit 1; fi',
  "printf 'Debug sudo /tmp/spw-sudo-debug.log all@debug\\n' >/etc/sudo.conf",
  'timeout 45 sudo -n true',
  'if [ -e /tmp/spw-sudo.conf.bak ]; then mv /tmp/spw-sudo.conf.bak /etc/sudo.conf; else rm -f /etc/sudo.conf; fi',
  'wc -l /tmp/spw-sudo-debug.log',
  'head -3 /tmp/spw-sudo-debug.log',
  'awk \'{ split($3, t, ":"); s = t[1] * 3600 + t[2] * 60 + t[3]; if (NR > 1 && s - prev >= 1) { print "---- gap " s - prev " s"; print last; print $0 } prev = s; last = $0 }\' /tmp/spw-sudo-debug.log',
  'rm -f /tmp/spw-sudo-debug.log',
].join('\n');

const ENGINE_STATE_PROBES: { argv: string[]; keep?: { head?: number; tail?: number } }[] = [
  { argv: ['true'] },
  { argv: ['uptime'] },
  { argv: ['cat', '/proc/pressure/cpu', '/proc/pressure/memory', '/proc/pressure/io'] },
  { argv: ['free', '-m'] },
  { argv: ['vmstat', '1', '3'] },
  { argv: ['df', '-h'] },
  { argv: ['top', '-b', '-n', '1', '-o', '%CPU'], keep: { head: 40 } },
  { argv: ['dmesg', '-T'], keep: { tail: 100 } },
];

function keepLines(text: string, keep?: { head?: number; tail?: number; grep?: RegExp }): string {
  if (!keep) return text;
  const lines = text.split('\n');
  if (keep.grep !== undefined) {
    const pattern = keep.grep;
    return lines.filter((line) => pattern.test(line)).join('\n');
  }
  if (keep.head !== undefined) return lines.slice(0, keep.head).join('\n');
  if (keep.tail !== undefined) return lines.slice(-keep.tail).join('\n');
  return text;
}

/**
 * Writes the load, pressure, memory, disk and kernel log of the engine VM (Lima) or distro (WSL)
 * into `dir` as `FAIL-<stamp>-engine-state.txt` and returns the file. Each probe records how
 * long its round trip through the engine transport took, so a slow transport shows apart from
 * a loaded guest. On macOS it also times the Lima SSH transport from the host: through the
 * control master and on a fresh connection, `limactl shell` without `sudo`, `sudo` without
 * `limactl`, the guest's name resolution, a syscall trace of a slow `sudo` with the guest's
 * systemd, journal and D-Bus state, sudo's own debug timeline, plus the master's state and
 * the live ssh and limactl processes. The argv stays free of shell metacharacters and
 * whitespace: the Windows transport re-parses it.
 */
export function dumpEngineState(dir: string, stamp: string): string {
  const sections: string[] = [];
  for (const probe of ENGINE_STATE_PROBES) {
    sections.push(runProbe(probe.argv.join(' '), engineArgv(probe.argv), probe.keep));
  }
  if (process.platform === 'darwin') {
    for (const probe of limaTransportProbes()) {
      sections.push(runProbe(probe.label, probe, probe.keep));
    }
  }
  const stateFile = join(dir, `FAIL-${stamp}-engine-state.txt`);
  writeFileSync(stateFile, sections.join('\n\n') + '\n');
  return stateFile;
}

function runProbe(
  label: string,
  command: { file: string; args: string[]; env: NodeJS.ProcessEnv },
  keep?: { head?: number; tail?: number; grep?: RegExp }
): string {
  const started = Date.now();
  const run = spawnSync(command.file, command.args, {
    env: command.env,
    encoding: 'utf8',
    timeout: ENGINE_PROBE_TIMEOUT_MS,
  });
  const elapsed = Date.now() - started;
  const outcome = run.error ? `error ${run.error.message}` : `exit ${run.status}`;
  const body = keepLines(`${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd(), keep);
  return `== ${label} (${elapsed} ms, ${outcome})\n${body}`;
}

function limaTransportProbes(): {
  label: string;
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  keep?: { grep?: RegExp };
}[] {
  const limaHome = join(dataDir(), 'lima');
  const env = { ...process.env, LIMA_HOME: limaHome };
  const sshConfig = join(limaHome, instanceName(), 'ssh.config');
  const host = `lima-${instanceName()}`;
  const limactl = join(homedir(), 'Applications/Speedwave.app/Contents/Resources/lima/bin/limactl');
  return [
    { label: 'host: limactl list', file: limactl, args: ['list'], env },
    {
      label: 'host: ssh -O check (control master)',
      file: 'ssh',
      args: ['-F', sshConfig, '-O', 'check', host],
      env,
    },
    {
      label: 'host: ssh true through the control master',
      file: 'ssh',
      args: ['-F', sshConfig, host, 'true'],
      env,
    },
    {
      label: 'host: ssh true on a fresh connection',
      file: 'ssh',
      args: ['-F', sshConfig, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', host, 'true'],
      env,
    },
    {
      label: 'host: limactl shell true without sudo',
      file: limactl,
      args: ['shell', instanceName(), '--', 'true'],
      env,
    },
    {
      label: 'host: ssh sudo -n true',
      file: 'ssh',
      args: ['-F', sshConfig, host, 'sudo', '-n', 'true'],
      env,
    },
    {
      label: 'host: ssh guest name resolution',
      file: 'ssh',
      args: [
        '-F',
        sshConfig,
        host,
        'hostname; cat /etc/hosts /etc/resolv.conf; time getent hosts "$(hostname)"; time timeout 20 getent hosts github.com; time timeout 20 getent hosts spw-probe-nonexistent; resolvectl status 2>&1 | head -30',
      ],
      env,
    },
    {
      label: 'host: ssh what sudo waits on',
      file: 'ssh',
      args: [
        '-F',
        sshConfig,
        host,
        [
          'systemctl is-system-running',
          'systemctl --failed --no-legend --no-pager',
          'time logger -t spw-probe sudo-probe',
          'time busctl --system --timeout=20 call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetId',
          'command -v strace >/dev/null || echo strace-missing',
          'timeout 45 sudo -n strace -f -tt -T -o /tmp/spw-sudo.strace sudo -n true',
          "grep -E 'socket\\(|connect\\(|<([1-9][0-9]*|0\\.[1-9])[0-9.]*>' /tmp/spw-sudo.strace | head -60",
          'journalctl -b --since -20min -p warning --no-pager 2>&1 | tail -40',
        ].join('; '),
      ],
      env,
    },
    {
      label: 'host: ssh sudo function timeline',
      file: 'ssh',
      args: [
        '-F',
        sshConfig,
        host,
        `echo ${Buffer.from(SUDO_TIMELINE_SCRIPT).toString('base64')} | base64 -d | sudo -n sh`,
      ],
      env,
    },
    {
      label: 'host: ssh and limactl processes',
      file: 'ps',
      args: ['-axo', 'pid,ppid,etime,stat,command'],
      env,
      keep: { grep: /\b(ssh|limactl)\b/ },
    },
  ];
}

/** Reads the name-store via the engine into filename → 64-hex content. Plain metachar-free
 *  argv is what survives both transports' default-shell re-parse (wsl.rs::run_in_distro). */
export function storeSnapshot(): Map<string, string> {
  const dir = nameStoreDir();
  const listing = engineExec(['ls', dir]);
  const snapshot = new Map<string, string>();
  if (listing === '') return snapshot;
  for (const rawName of listing.split('\n')) {
    const name = rawName.trim();
    if (name === '') continue;
    let content: string;
    try {
      content = engineExec(['cat', `${dir}/${name}`]);
    } catch (err) {
      try {
        engineExec(['test', '-e', `${dir}/${name}`]);
      } catch {
        continue;
      }
      throw err;
    }
    if (!/^[0-9a-f]{64}$/.test(content)) {
      throw new Error(
        `storeSnapshot: entry '${name}' holds malformed content '${content}' — expected a 64-hex container id`
      );
    }
    snapshot.set(name, content);
  }
  return snapshot;
}

function inspectSucceeds(id: string): boolean {
  try {
    engineExec(['nerdctl', 'inspect', id]);
    return true;
  } catch {
    return false;
  }
}

/** Removes the live container and leaves a dead reservation behind it (0600), all in the engine namespace. */
export function plantGhost(containerName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) {
    throw new Error(`plantGhost: unsafe container name '${containerName}'`);
  }
  engineExec(['nerdctl', 'rm', '-f', containerName]);
  const file = `${nameStoreDir()}/${containerName}`;
  const b64 = Buffer.from(`printf '%s' ${DEAD_ID} > ${file} && chmod 600 ${file}`, 'utf8').toString(
    'base64'
  );
  engineExec(['sh', '-c', `echo ${b64} | base64 -d | sh`]);
}

/**
 * Every ghost name must be gone, or its current content must have been
 * re-acquired by a live container (differs from DEAD_ID and inspects clean).
 */
export function assertStoreHealed(ghosts: string[]): void {
  const after = storeSnapshot();
  for (const name of ghosts) {
    const content = after.get(name);
    if (content === undefined) continue;
    if (content === DEAD_ID) {
      throw new Error(`assertStoreHealed: '${name}' still holds the dead reservation ${DEAD_ID}`);
    }
    if (!inspectSucceeds(content)) {
      throw new Error(
        `assertStoreHealed: '${name}' now points at '${content}', but 'nerdctl inspect ${content}' failed`
      );
    }
  }
}

/**
 * A non-ghost entry may disappear ONLY together with its container: present -> current
 * id inspects live; missing -> the `before` id must be gone too (legitimate reap).
 */
export function assertLiveEntriesIntact(before: Map<string, string>, ghosts: string[]): void {
  const after = storeSnapshot();
  const ghostSet = new Set(ghosts);
  for (const [name, beforeId] of before) {
    if (ghostSet.has(name)) continue;
    const currentId = after.get(name);
    if (currentId === undefined) {
      if (inspectSucceeds(beforeId)) {
        throw new Error(
          `assertLiveEntriesIntact: '${name}' disappeared from the name store, but its ` +
            `container '${beforeId}' still inspects live — the heal removed a live reservation`
        );
      }
      continue;
    }
    if (!inspectSucceeds(currentId)) {
      throw new Error(
        `assertLiveEntriesIntact: '${name}' -> '${currentId}' does not inspect; expected id ` +
          `'${beforeId}' to still be live`
      );
    }
  }
}
