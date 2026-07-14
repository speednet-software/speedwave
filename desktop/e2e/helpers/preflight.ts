/** Pre-suite checks on the external LLM services the specs depend on. */

/** `max_tokens` Claude Code asks for. OpenRouter reserves credit for the whole
 *  budget up front, so a balance that covers real usage can still 402 on this. */
const CLAUDE_CODE_MAX_TOKENS = 16_384;

const FETCH_TIMEOUT_MS = 20_000;

/** Set when the local LLM server is unreachable; specs that need it self-skip. */
export const LOCAL_LLM_UNREACHABLE_ENV = 'E2E_LOCAL_LLM_UNREACHABLE';

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

/** Probes OpenRouter with the token budget Claude Code actually sends. The
 *  balance endpoint is not a substitute: OpenRouter reserves credit for the full
 *  `max_tokens` up front, so a funded-looking account still 402s here — and a 402
 *  leaves the proxy with no usage line, which the cost specs see only as an
 *  unpriced dashboard timing out. Fatal: nearly every chat spec needs this. */
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

/** True when the local OpenAI-compatible server answers FROM THIS HOST — model
 *  discovery runs on the e2e machine, not on the one that authored .env. */
async function localLlmReachable(): Promise<boolean> {
  const baseUrl = process.env.LOCAL_LLM_BASE_URL;
  const apiKey = process.env.LOCAL_LLM_API_KEY;
  if (!baseUrl || !apiKey) return false;
  try {
    await fetchJson(`${baseUrl.replace(/\/$/, '')}/models`, apiKey);
    return true;
  } catch {
    return false;
  }
}

/** Fatal preconditions (empty when the suite may run) plus the local-LLM verdict.
 *  An unreachable local LLM is NOT fatal — it marks the two local-provider specs
 *  skippable so the other 16 keep reporting, and prints why. */
export async function runPreflight(): Promise<PreflightFailure[]> {
  const [openrouter, localOk] = await Promise.all([checkOpenrouter(), localLlmReachable()]);

  if (!localOk) {
    process.env[LOCAL_LLM_UNREACHABLE_ENV] = '1';
    const target = process.env.LOCAL_LLM_BASE_URL || '(LOCAL_LLM_BASE_URL unset)';
    console.warn(
      `\n⚠  E2E preflight: local LLM at ${target} is unreachable from this machine.\n` +
        '   Specs 11 (local-provider-resume) and 12 (provider-errors) will SKIP — the local\n' +
        '   provider is not covered by this run. Give this host a route to the server to\n' +
        '   restore that coverage.\n'
    );
  }

  return openrouter ? [openrouter] : [];
}

/** True when preflight found no route to the local LLM from this host. */
export function localLlmUnreachable(): boolean {
  return process.env[LOCAL_LLM_UNREACHABLE_ENV] === '1';
}
