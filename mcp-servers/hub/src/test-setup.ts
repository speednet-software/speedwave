import { afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policyDir = mkdtempSync(join(tmpdir(), 'hub-policy-'));
writeFileSync(join(policyDir, 'access.json'), '{"version":1,"default":"full","services":{}}');
process.env.POLICY_FILE = join(policyDir, 'policy.json');

afterAll(() => rmSync(policyDir, { recursive: true, force: true }));
