import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  SLACK_FEATURES_FILE,
  SLACK_FEATURE_IDS,
  isFeatureEnabled,
  featureNotEnabledResult,
} from './features.js';

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

  it('names the features file Desktop writes', () => {
    expect(SLACK_FEATURES_FILE).toBe('features.json');
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

  it('reads the file on every call', async () => {
    const file = path.join(dir, SLACK_FEATURES_FILE);
    await writeFile(file, '{"enabled":[]}');
    expect(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload)).toBe(false);
    await writeFile(file, '{"enabled":["file_upload"]}');
    expect(await isFeatureEnabled(SLACK_FEATURE_IDS.fileUpload)).toBe(true);
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

  it('builds a teaching failure that names the tool, the feature and the Desktop path', () => {
    const result = featureNotEnabledResult(SLACK_FEATURE_IDS.fileUpload, 'uploadFile');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FEATURE_NOT_ENABLED');
    expect(result.error?.message).toContain('uploadFile');
    expect(result.error?.message).toContain('file sending');
    expect(result.error?.message).toContain('Enable');
    expect(result.error?.message).toContain('Speedwave Desktop, Integrations, Slack');
  });
});
