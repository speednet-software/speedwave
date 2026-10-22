import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { SLACK_FEATURES_FILE, SLACK_FEATURE_IDS, isFeatureEnabled } from './features.js';

describe('features', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.TOKENS_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'slack-features-'));
    process.env.TOKENS_DIR = dir;
  });

  afterEach(async () => {
    if (previous === undefined) {
      delete process.env.TOKENS_DIR;
    } else {
      process.env.TOKENS_DIR = previous;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('allows a feature when the features file is absent', async () => {
    expect(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload)).toBe(true);
  });

  it('allows a feature listed as enabled', async () => {
    await writeFile(path.join(dir, SLACK_FEATURES_FILE), '{"enabled":["file_upload"]}');
    expect(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload)).toBe(true);
  });

  it('refuses a feature the file does not list', async () => {
    await writeFile(path.join(dir, SLACK_FEATURES_FILE), '{"enabled":[]}');
    expect(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload)).toBe(false);
  });

  it.each([
    ['not JSON', '{nope'],
    ['JSON null', 'null'],
    ['no enabled key', '{}'],
    ['enabled not an array', '{"enabled":"file_upload"}'],
  ])('refuses a feature when the file is %s', async (_name, body) => {
    await writeFile(path.join(dir, SLACK_FEATURES_FILE), body);
    expect(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload)).toBe(false);
  });

  it('refuses a feature when the file cannot be read for another reason than absence', async () => {
    await mkdir(path.join(dir, SLACK_FEATURES_FILE));
    expect(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload)).toBe(false);
  });
});
