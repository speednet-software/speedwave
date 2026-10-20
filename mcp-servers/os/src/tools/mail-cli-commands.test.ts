import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ALLOWED_COMMANDS } from './index.js';

const MAIL_CLI_SOURCE = new URL(
  '../../../../native/macos/mail/Sources/MailCLI.swift',
  import.meta.url
);

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
