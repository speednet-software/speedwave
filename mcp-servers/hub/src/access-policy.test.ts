import { describe, it, expect } from 'vitest';
import type { AccessRules } from './access-config.js';
import {
  decideAccess,
  readOnlyServices,
  serviceAccessMode,
  readOnlyNotice,
} from './access-policy.js';
import type { ToolMetadata } from './hub-types.js';

const LONG_SERVICE = 'custom-' + 'a'.repeat(57);
const FULL: AccessRules = { default: 'full', services: {} };
const ALL_READ_ONLY: AccessRules = { default: 'read_only', services: {} };
const SLACK_READ_ONLY: AccessRules = { default: 'full', services: { slack: 'read_only' } };

function tool(service: string, name: string, annotations?: ToolMetadata['annotations']) {
  return {
    name,
    description: name,
    keywords: [],
    inputSchema: {},
    example: '',
    service,
    annotations,
  } satisfies ToolMetadata;
}

describe('decideAccess', () => {
  it('allows every tool in full mode, annotated or not', () => {
    expect(decideAccess(FULL, tool('slack', 'sendChannel'))).toEqual({ allowed: true });
    expect(decideAccess(FULL, tool('slack', 'sendChannel', { readOnlyHint: false }))).toEqual({
      allowed: true,
    });
  });

  it('allows a tool annotated readOnlyHint true in read-only mode', () => {
    const t = tool('slack', 'listChannelIds', { readOnlyHint: true });
    expect(decideAccess(ALL_READ_ONLY, t)).toEqual({ allowed: true });
  });

  it('denies a tool annotated as a write in read-only mode', () => {
    const t = tool('slack', 'sendChannel', { readOnlyHint: false, destructiveHint: false });
    expect(decideAccess(ALL_READ_ONLY, t)).toMatchObject({
      allowed: false,
      reason: 'read-only',
    });
  });

  it('denies a destructive tool in read-only mode', () => {
    const t = tool('redmine', 'deleteJournal', { readOnlyHint: false, destructiveHint: true });
    expect(decideAccess(ALL_READ_ONLY, t)).toMatchObject({ allowed: false });
  });

  it('denies a tool without annotations in read-only mode', () => {
    expect(decideAccess(ALL_READ_ONLY, tool('figma', 'getFile'))).toMatchObject({
      allowed: false,
      reason: 'read-only',
    });
  });

  it('denies a tool whose annotations omit readOnlyHint in read-only mode', () => {
    const t = tool('figma', 'getFile', { destructiveHint: false });
    expect(decideAccess(ALL_READ_ONLY, t)).toMatchObject({ allowed: false });
  });

  it('denies every tool of a custom-* service in read-only mode, even annotated read-only', () => {
    const t = tool('custom-notes', 'listNotes', { readOnlyHint: true });
    expect(decideAccess(ALL_READ_ONLY, t)).toMatchObject({
      allowed: false,
      reason: 'read-only',
    });
  });

  it('allows a custom-* service in full mode', () => {
    const t = tool('custom-notes', 'addNote');
    expect(decideAccess(FULL, t)).toEqual({ allowed: true });
  });

  it('applies a per-service mode only to that service', () => {
    const write = { readOnlyHint: false };
    expect(decideAccess(SLACK_READ_ONLY, tool('slack', 'send', write))).toMatchObject({
      allowed: false,
    });
    expect(decideAccess(SLACK_READ_ONLY, tool('redmine', 'create', write))).toEqual({
      allowed: true,
    });
  });

  it('carries service and tool in the denial and a teaching message', () => {
    const decision = decideAccess(
      ALL_READ_ONLY,
      tool('slack', 'sendChannel', { readOnlyHint: false })
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.service).toBe('slack');
    expect(decision.tool).toBe('sendChannel');
    expect(decision.message).toContain('Read-only mode');
    expect(decision.message).toContain('slack.sendChannel');
    expect(decision.message).toContain('Reads');
    expect(decision.message).toContain('Settings, Read-only integrations');
    expect(decision.message).toContain("this integration's Always read-only switch if on");
    expect(decision.message).toContain('organization');
  });

  it('names the Always read-only switch of the integration in a per-service denial', () => {
    const decision = decideAccess(
      SLACK_READ_ONLY,
      tool('slack', 'sendChannel', { readOnlyHint: false })
    );
    if (decision.allowed) throw new Error('expected a denial');
    expect(decision.message).toContain('Always read-only switch of this integration');
    expect(decision.message).not.toContain('Read-only integrations');
    expect(decision.message).not.toContain('organization');
  });

  it.each([
    ['global default', ALL_READ_ONLY],
    [
      'per-service entry',
      { default: 'full', services: { [LONG_SERVICE]: 'read_only' } } as AccessRules,
    ],
  ])('keeps the %s denial under the executor error cap for long names', (_, rules) => {
    const decision = decideAccess(rules, tool(LONG_SERVICE, 'x'.repeat(60)));
    if (decision.allowed) throw new Error('expected a denial');
    expect(decision.message.length).toBeLessThan(450);
  });

  it('names the os category as Desktop shows it', () => {
    const decision = decideAccess(
      { default: 'full', services: { 'os-mail': 'read_only' } },
      { ...tool('os', 'sendEmail', { readOnlyHint: false }), osCategory: 'mail' }
    );
    if (decision.allowed) throw new Error('expected a denial');
    expect(decision.message).toContain('for Mail,');
    expect(decision.message).toContain('Always read-only switch of this integration');
  });

  it('names why a custom-* service is blocked', () => {
    const decision = decideAccess(
      ALL_READ_ONLY,
      tool('custom-notes', 'listNotes', { readOnlyHint: true })
    );
    if (decision.allowed) throw new Error('expected a denial');
    expect(decision.message).toContain('custom');
  });

  it('names a missing annotation as the cause', () => {
    const decision = decideAccess(ALL_READ_ONLY, tool('figma', 'getFile'));
    if (decision.allowed) throw new Error('expected a denial');
    expect(decision.message).toContain('annotation');
  });
});

describe('os sub-services', () => {
  const MAIL_READ_ONLY: AccessRules = { default: 'full', services: { 'os-mail': 'read_only' } };
  const write = { readOnlyHint: false };

  function osTool(name: string, osCategory: 'reminders' | 'mail', a?: ToolMetadata['annotations']) {
    return { ...tool('os', name, a), osCategory } satisfies ToolMetadata;
  }

  it('denies a write tool of the read-only sub-service', () => {
    expect(decideAccess(MAIL_READ_ONLY, osTool('sendMail', 'mail', write))).toMatchObject({
      allowed: false,
      reason: 'read-only',
    });
  });

  it('allows a write tool of a sub-service that stays full', () => {
    expect(decideAccess(MAIL_READ_ONLY, osTool('createReminder', 'reminders', write))).toEqual({
      allowed: true,
    });
  });

  it('allows a read tool of the read-only sub-service', () => {
    const read = { readOnlyHint: true };
    expect(decideAccess(MAIL_READ_ONLY, osTool('listEmails', 'mail', read))).toEqual({
      allowed: true,
    });
  });

  it('follows the default when the sub-service has no entry', () => {
    expect(decideAccess(ALL_READ_ONLY, osTool('createReminder', 'reminders', write))).toMatchObject(
      { allowed: false }
    );
  });

  it('lists os with its enabled read-only sub-services', () => {
    expect(readOnlyServices(MAIL_READ_ONLY, ['os', 'slack'], new Set(['reminders']))).toEqual([
      'os (mail)',
    ]);
  });

  it('denies an os write tool without a category when any sub-service is read-only', () => {
    expect(decideAccess(MAIL_READ_ONLY, tool('os', 'unknownWrite', write))).toMatchObject({
      allowed: false,
      reason: 'read-only',
    });
  });

  it('allows an os write tool without a category when no sub-service is read-only', () => {
    expect(decideAccess(FULL, tool('os', 'unknownWrite', write))).toEqual({ allowed: true });
  });

  it('leaves out a disabled read-only sub-service', () => {
    expect(readOnlyServices(MAIL_READ_ONLY, ['os'], new Set(['mail']))).toEqual([]);
  });
});

describe('serviceAccessMode', () => {
  it('uses the service entry over the default', () => {
    expect(serviceAccessMode(SLACK_READ_ONLY, 'slack')).toBe('read_only');
    expect(serviceAccessMode(SLACK_READ_ONLY, 'redmine')).toBe('full');
  });

  it('falls back to the default for an unnamed service', () => {
    expect(serviceAccessMode(ALL_READ_ONLY, 'anything')).toBe('read_only');
  });
});

describe('readOnlyServices', () => {
  it('is empty when nothing is read-only', () => {
    expect(readOnlyServices(FULL, ['slack', 'redmine'])).toEqual([]);
  });

  it('lists every given service under a read-only default', () => {
    expect(readOnlyServices(ALL_READ_ONLY, ['slack', 'redmine'])).toEqual(['slack', 'redmine']);
  });

  it('lists only the named services under a full default', () => {
    expect(readOnlyServices(SLACK_READ_ONLY, ['slack', 'redmine'])).toEqual(['slack']);
  });
});

describe('readOnlyNotice', () => {
  it('is undefined when no service is read-only', () => {
    expect(readOnlyNotice([])).toBeUndefined();
  });

  it('is one sentence naming the blocked services', () => {
    const notice = readOnlyNotice(['slack', 'redmine']);
    expect(notice).toContain('Read-only mode');
    expect(notice).toContain('slack, redmine');
    expect(notice).toContain('blocked');
    expect(notice?.match(/\./g)).toHaveLength(1);
  });
});
