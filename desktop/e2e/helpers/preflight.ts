/** Pre-suite checks on the external LLM services the specs depend on. */

/** `max_tokens` Claude Code asks for. OpenRouter reserves credit for the whole
 *  budget up front, so a balance that covers real usage can still 402 on this. */
const CLAUDE_CODE_MAX_TOKENS = 16_384;

const FETCH_TIMEOUT_MS = 20_000;

const LOCAL_MODEL_PROBE_MAX_TOKENS = 16;
const LOCAL_MODEL_PROBE_TIMEOUT_MS = 120_000;
const LOCAL_MODEL_PROBE_ATTEMPTS = 6;
const LOCAL_MODEL_PROBE_BUSY_RETRY_MS = 10_000;

/** Set when the local LLM server is unreachable; specs that need it self-skip. */
export const LOCAL_LLM_UNREACHABLE_ENV = 'E2E_LOCAL_LLM_UNREACHABLE';

const LOCAL_LLM_MODEL_UNUSABLE_ENV = 'E2E_LOCAL_LLM_MODEL_UNUSABLE';

/** One failed environment precondition, reported before any spec runs. */
export interface PreflightFailure {
  readonly service: string;
  readonly reason: string;
}

async function fetchJson(url: string, apiKey: string): Promise<unknown> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Probes with the real token budget: the balance endpoint is no substitute,
 *  since a funded-looking account still 402s on the up-front reservation. */
async function checkOpenrouter(): Promise<PreflightFailure | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) {
    return {
      service: 'OpenRouter',
      reason: 'OPENROUTER_API_KEY / OPENROUTER_MODEL are not set (`set -a && source .env`)',
    };
  }
  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: CLAUDE_CODE_MAX_TOKENS,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { service: 'OpenRouter', reason: `probe request failed: ${(e as Error).message}` };
  }
  if (res.ok) return null;

  const body = await res.text().catch(() => '');
  const detail = body.slice(0, 300).trim();
  if (res.status === 402) {
    return {
      service: 'OpenRouter',
      reason:
        `402 on a ${CLAUDE_CODE_MAX_TOKENS}-token request — OpenRouter reserves credit for the ` +
        'whole budget up front, so the balance shown in the dashboard can look fine while every ' +
        `Claude Code turn is rejected. Add credits at https://openrouter.ai/settings/credits. ${detail}`,
    };
  }
  return { service: 'OpenRouter', reason: `probe returned HTTP ${res.status}. ${detail}` };
}

/** True when the server answers FROM THIS HOST on the catalog path production
 *  uses (`discovery.rs` → `{base}/v1/models`); bare `/models` 404s on LM Studio. */
async function localLlmReachable(): Promise<boolean> {
  const baseUrl = process.env.LOCAL_LLM_BASE_URL;
  const apiKey = process.env.LOCAL_LLM_API_KEY;
  if (!baseUrl || !apiKey) return false;
  try {
    await fetchJson(`${baseUrl.replace(/\/$/, '')}/v1/models`, apiKey);
    return true;
  } catch {
    return false;
  }
}

async function localModelProblem(): Promise<string | null> {
  const baseUrl = process.env.LOCAL_LLM_BASE_URL;
  const apiKey = process.env.LOCAL_LLM_API_KEY;
  const model = process.env.LOCAL_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    return 'LOCAL_LLM_BASE_URL / LOCAL_LLM_API_KEY / LOCAL_LLM_MODEL are not set';
  }
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: LOCAL_MODEL_PROBE_MAX_TOKENS,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(LOCAL_MODEL_PROBE_TIMEOUT_MS),
      });
    } catch (e) {
      return `probe request failed: ${(e as Error).message}`;
    }
    const body = await res.text().catch(() => '');
    if (res.ok && hasStopReason(body)) return null;
    if (res.status !== 429 || attempt === LOCAL_MODEL_PROBE_ATTEMPTS) {
      return `HTTP ${res.status}: ${body.slice(0, 300).trim()}`;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCAL_MODEL_PROBE_BUSY_RETRY_MS));
  }
}

function hasStopReason(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { stop_reason?: unknown }).stop_reason === 'string'
    );
  } catch {
    return false;
  }
}

/** Fatal preconditions, empty when the suite may run. An unreachable local LLM is not
 *  fatal — it marks spec 11 and the live-server tests of spec 12 skippable so the rest keep reporting. */
export async function runPreflight(): Promise<PreflightFailure[]> {
  const [openrouter, localOk, modelProblem] = await Promise.all([
    checkOpenrouter(),
    localLlmReachable(),
    localModelProblem(),
  ]);
  const target = process.env.LOCAL_LLM_BASE_URL || '(LOCAL_LLM_BASE_URL unset)';

  if (!localOk) {
    process.env[LOCAL_LLM_UNREACHABLE_ENV] = '1';
    console.warn(
      `\n⚠  E2E preflight: local LLM at ${target} is unreachable from this machine.\n` +
        '   Spec 11 (local-provider-resume) and the live-server tests of spec 12\n' +
        '   (provider-errors) will SKIP — spec 12 still runs its offline-server test.\n' +
        '   Give this host a route to the server to restore that coverage.\n'
    );
  } else if (modelProblem) {
    process.env[LOCAL_LLM_MODEL_UNUSABLE_ENV] = '1';
    console.warn(
      `\n⚠  E2E preflight: model ${process.env.LOCAL_LLM_MODEL} on ${target} does not answer (${modelProblem}).\n` +
        '   Spec 11 (local-provider-resume) and the local-provider test of spec 20 will SKIP;\n' +
        '   spec 12 still runs against the server. Set LOCAL_LLM_MODEL to a model it serves.\n'
    );
  }

  return openrouter ? [openrouter] : [];
}

/** True when preflight found no route to the local LLM from this host. */
export function localLlmUnreachable(): boolean {
  return process.env[LOCAL_LLM_UNREACHABLE_ENV] === '1';
}

export function localModelUnavailable(): boolean {
  return localLlmUnreachable() || process.env[LOCAL_LLM_MODEL_UNUSABLE_ENV] === '1';
}
