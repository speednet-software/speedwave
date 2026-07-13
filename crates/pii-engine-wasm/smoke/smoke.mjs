// Node smoke test for the pii-engine-wasm artifact built by ../build-wasm.sh.
// Verifies construction, tokenize/detokenize roundtrip, determinism, and fail-closed
// rejection of a tampered token. Exits non-zero on any failure.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = process.argv[2] ?? path.join(here, '..', '..', '..', 'mcp-servers', 'policies', 'wasm-pkg');
const require = createRequire(import.meta.url);
const { PiiEngine } = require(path.join(pkgDir, 'speedwave_pii_engine_wasm.js'));

const POLICY_JSON = JSON.stringify({
  version: 2,
  source: { policies: ['strict'], forced: [] },
  categories: {
    EMAIL: { tokenize: true, log: false },
    PHONE_PL: { tokenize: true, log: false },
    PESEL: { tokenize: true, log: false },
    NIP: { tokenize: true, log: false },
    IBAN: { tokenize: true, log: false },
    CARD: { tokenize: true, log: false },
    API_KEY: { tokenize: true, log: false },
    SENSITIVE_FIELD: { tokenize: true, log: false },
  },
  customPatterns: [],
  sensitiveKeys: ['password', 'token', 'secret'],
});
const KEY_HEX = 'ab'.repeat(32);

function run() {
  // 1. Construction with a real v2 policy and a 64-hex key.
  const engine = new PiiEngine(POLICY_JSON, KEY_HEX);

  // 2. tokenize an object holding an email and a valid PESEL.
  const original = { note: 'reach me at a@b.com', pesel: '44051401359' };
  const tokenizeOut = JSON.parse(engine.tokenize(JSON.stringify(original)));
  assert.ok(!tokenizeOut.value.note.includes('a@b.com'), 'email must be tokenized out of note');
  assert.ok(!tokenizeOut.value.pesel.includes('44051401359'), 'PESEL must be tokenized');
  const categories = tokenizeOut.detections.map((d) => d.category).sort();
  assert.deepEqual(categories, ['EMAIL', 'PESEL']);
  for (const d of tokenizeOut.detections) {
    assert.equal(d.action, 'tokenized');
    assert.equal(d.count, 1);
  }

  // 3. detokenize the tokenized value back to the original, character for character.
  const detokenized = JSON.parse(engine.detokenize(JSON.stringify(tokenizeOut.value)));
  assert.deepEqual(detokenized, original);

  // 4. Determinism: tokenizing the same value twice yields the same token.
  const again = JSON.parse(engine.tokenize(JSON.stringify(original)));
  assert.equal(again.value.note, tokenizeOut.value.note);
  assert.equal(again.value.pesel, tokenizeOut.value.pesel);

  // 5. Fail-closed: a corrupted token must be rejected, not silently passed through.
  const tampered = { ...tokenizeOut.value };
  tampered.pesel = tampered.pesel.replace('TOKEN_', 'TOKEN_X');
  assert.throws(() => engine.detokenize(JSON.stringify(tampered)), /./, 'tampered token must throw');

  console.log('pii-engine-wasm smoke test passed: construction, tokenize, detokenize, determinism, fail-closed all verified');
}

try {
  run();
} catch (err) {
  console.error('pii-engine-wasm smoke test FAILED:', err);
  process.exit(1);
}
