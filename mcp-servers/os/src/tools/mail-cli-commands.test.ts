import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ALLOWED_COMMANDS } from './index.js';
import { handleSearchEmails } from './mail-reading.js';
import { markEmailsNotSpamTool, renameMailboxTool } from './mail-organizing.js';

const MAIL_CLI_SOURCE = new URL(
  '../../../../native/macos/mail/Sources/MailCLI.swift',
  import.meta.url
);

/**
 * The text of a mail-cli Swift source file.
 * @param file - File name inside native/macos/mail/Sources.
 */
function mailSource(file: string): string {
  return readFileSync(
    new URL(`../../../../native/macos/mail/Sources/${file}`, import.meta.url),
    'utf8'
  );
}

/**
 * The text between `start` and the first `end` after it.
 * @param source - Text to cut from.
 * @param start - Marker the cut starts after.
 * @param end - Marker the cut ends before.
 */
function between(source: string, start: string, end: string): string {
  const after = source.split(start)[1] ?? '';
  return after.split(end)[0] ?? '';
}

/**
 * The command names mail-cli's `mailCommands` registers, read from its Swift source.
 * @param source - Text of MailCLI.swift.
 */
function mailCliCommands(source: string): string[] {
  const body = source.split('func mailCommands(')[1]?.split('\n    ]\n')[0] ?? '';
  return [...body.matchAll(/^\s+"(\w+)":/gm)].map((match) => match[1]);
}

describe('mail-cli commands', () => {
  it('the os allowlist names exactly the commands mail-cli registers', () => {
    const commands = mailCliCommands(readFileSync(MAIL_CLI_SOURCE, 'utf8'));

    expect(commands.length).toBeGreaterThan(0);
    expect([...ALLOWED_COMMANDS.mail].sort()).toEqual([...commands].sort());
  });

  it('reads the registered names, nested handlers included, and nothing after the command table', () => {
    const source = [
      'func mailCommands(executor: X) -> Y {',
      '    return [',
      '        "list_emails": scripted(listEmails),',
      '        "check_mail": scripted { params, scripts in',
      '            try f(params["account"] as? String)',
      '        },',
      '    ]',
      '}',
      'let other = ["not_a_command": 1]',
    ].join('\n');

    expect(mailCliCommands(source)).toEqual(['list_emails', 'check_mail']);
  });
});

describe('mail tools mirror mail-cli', () => {
  it('searchEmails asks for the filters MessageFilter narrows by and noSearchFilter names', async () => {
    const result = await handleSearchEmails({ mailbox: 'INBOX' });
    const asked =
      /Give at least one of ([^.]+)\./.exec(result.error?.message ?? '')?.[1].split(', ') ?? [];
    const narrows = (
      between(mailSource('AppleMailClient.swift'), 'var narrows: Bool {', '}').match(
        /\b[a-z][A-Za-z]*\b/g
      ) ?? []
    )
      .filter((name) => name !== 'nil')
      .map((name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    const named = between(mailSource('MailCLI.swift'), 'at least one of ', ';')
      .replace(/"\s*\+\s*"/g, '')
      .split(/, | or /);

    expect(asked.length).toBeGreaterThan(0);
    expect([...narrows].sort()).toEqual([...asked].sort());
    expect([...named].sort()).toEqual([...asked].sort());
  });

  it('markEmailsNotSpam declares the per-mail key mail-cli reports', () => {
    const action = between(mailSource('MailOrganizing.swift'), 'func markEmailsNotSpam(', '\n}');
    const reports = /reports: "(\w+)"/.exec(action)?.[1];
    const properties = markEmailsNotSpamTool.outputSchema?.properties as Record<
      string,
      { items: { properties: Record<string, unknown> } }
    >;

    expect(reports).toBeDefined();
    expect(Object.keys(properties.emails.items.properties)).toContain(reports);
  });

  it('renameMailbox names every special mailbox mail-cli refuses', () => {
    const properties = [
      ...between(mailSource('MailOrganizing.swift'), 'specialMailboxProperties = [', ']').matchAll(
        /"([^"]+)"/g
      ),
    ].map((match) => match[1]);
    const names = properties.map((property) => {
      const name = property.replace(/ mailbox$/, '');
      return name[0].toUpperCase() + name.slice(1);
    });

    expect(names).toHaveLength(6);
    for (const name of [...names, 'archive mailbox']) {
      expect(renameMailboxTool.description).toContain(name);
    }
  });
});
