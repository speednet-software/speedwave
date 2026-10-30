import { spawnSync } from 'node:child_process';

import { engineArgvForProbe } from './engine';

const PROXY_CONTAINER = 'speedwave_e2e-test_proxy';
const CURL_IMAGE = 'docker.io/curlimages/curl:8.11.1';

export function logLocalLlmRoute(): void {
  const base = process.env.LOCAL_LLM_BASE_URL;
  if (!base) return;
  const url = new URL(base);
  const host = url.hostname;
  const target = `${url.origin}/v1/models`;
  const steps: [string, string[]][] = [
    ['vm: getent hosts', ['getent', 'hosts', host]],
    ['vm: ip -4 route', ['ip', '-4', 'route']],
    ['vm: curl', ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}_%{time_connect}s', '--max-time', '20', target]],
    ['vm: nerdctl ps', ['nerdctl', 'ps', '--format', '{{.Names}}']],
    ['proxy netns: curl', ['nerdctl', 'run', '--rm', '--network', `container:${PROXY_CONTAINER}`, CURL_IMAGE, '-sS', '-o', '/dev/null', '-w', '%{http_code}_%{time_connect}s', '--max-time', '20', target]],
    ['default bridge: curl', ['nerdctl', 'run', '--rm', CURL_IMAGE, '-sS', '-o', '/dev/null', '-w', '%{http_code}_%{time_connect}s', '--max-time', '20', target]],
  ];
  for (const [label, argv] of steps) {
    const { file, args, env } = engineArgvForProbe(argv);
    const started = Date.now();
    const run = spawnSync(file, args, { env, encoding: 'utf8', timeout: 180_000 });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n   ');
    console.warn(`\n[SPEED-863 route] ${label} (exit ${run.status}, ${Date.now() - started} ms)\n   ${out}\n`);
  }
}
