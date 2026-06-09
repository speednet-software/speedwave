/**
 * Hardened token-response body reading shared by the OAuth providers:
 * content-type allow-list + streaming size cap before JSON parsing.
 */

/** Max token-response body we read before treating it as malformed. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Reads at most `MAX_BODY_BYTES` of the response (streaming, never buffering a
 * larger body), then parses JSON. A hostile token endpoint cannot OOM the
 * worker — the read aborts once the cap is crossed.
 * @param response - the token endpoint response
 */
export async function readJsonCapped(
  response: Response
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; message: string }> {
  const ctype = response.headers.get('content-type') ?? '';
  // application/json or a +json suffix type (e.g. application/problem+json) —
  // a bare /json/ substring match would pass crafted types like text/jsonx.
  if (!/^application\/(?:[^;]+\+)?json\b/i.test(ctype)) {
    return { ok: false, message: `unexpected content-type '${ctype}'` };
  }
  // Reject early when the endpoint declares an oversized body.
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, message: `response exceeds ${MAX_BODY_BYTES} bytes` };
  }

  const text = await readTextCapped(response, MAX_BODY_BYTES);
  if (text === null) {
    return { ok: false, message: `response exceeds ${MAX_BODY_BYTES} bytes` };
  }
  try {
    return { ok: true, json: JSON.parse(text) as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Streams the response body, returning its text or `null` once `maxBytes` is
 * crossed (aborting the read). Context7 has an undici-specific counterpart; the
 * body types differ (WHATWG stream vs undici), so they stay separate.
 * @param response - the response whose body to read
 * @param maxBytes - upper bound on total bytes
 */
async function readTextCapped(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No stream (e.g. a test stub) — fall back to a buffered read with the cap.
    const buf = await response.arrayBuffer();
    return buf.byteLength > maxBytes ? null : Buffer.from(buf).toString('utf8');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
