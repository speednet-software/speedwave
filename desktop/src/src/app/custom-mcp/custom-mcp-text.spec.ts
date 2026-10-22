import { describe, it, expect } from 'vitest';
import {
  FILE_READ_CONFIRMATION,
  FILE_WRITE_CONFIRMATION,
  capText,
  confirmationsFor,
  hostAppNotRunning,
  otherRefusalsText,
  parseDomainTarget,
  reasonText,
  serverNameError,
  sourceLabel,
  splitDomain,
  statePillClass,
  statusDot,
  workspaceModeAllowed,
} from './custom-mcp-text';

describe('custom MCP text helpers', () => {
  it('caps untrusted text by characters and marks the cut', () => {
    expect(capText('abc', 5)).toBe('abc');
    expect(capText('abcdef', 5)).toBe('abcd…');
    expect(capText(null)).toBe('');
    expect(capText('')).toBe('');
    expect(Array.from(capText('😀'.repeat(10), 4))).toHaveLength(4);
  });

  it('accepts only server names the backend accepts in shape', () => {
    expect(serverNameError('figma')).toBeNull();
    expect(serverNameError('figma-desk2')).toBeNull();
    expect(serverNameError('')).not.toBeNull();
    expect(serverNameError('Figma')).not.toBeNull();
    expect(serverNameError('1figma')).not.toBeNull();
    expect(serverNameError('figma-')).not.toBeNull();
    expect(serverNameError('fig--ma')).not.toBeNull();
    expect(serverNameError('a'.repeat(32))).not.toBeNull();
    expect(serverNameError('figma-up')).toContain('-up');
    expect(serverNameError('figma-egress')).toContain('-egress');
    expect(serverNameError('fígma')).not.toBeNull();
  });

  it('ranks project access against the organization limit', () => {
    expect(workspaceModeAllowed('read_write', null)).toBe(true);
    expect(workspaceModeAllowed('read_only', 'read_only')).toBe(true);
    expect(workspaceModeAllowed('read_write', 'read_only')).toBe(false);
    expect(workspaceModeAllowed('none', 'none')).toBe(true);
    expect(workspaceModeAllowed('read_only', 'none')).toBe(false);
  });

  it('asks for the read confirmation for read access and both for write access', () => {
    expect(confirmationsFor('none')).toEqual([]);
    expect(confirmationsFor('read_only')).toEqual([FILE_READ_CONFIRMATION]);
    expect(confirmationsFor('read_write')).toEqual([
      FILE_READ_CONFIRMATION,
      FILE_WRITE_CONFIRMATION,
    ]);
  });

  it('parses a typed domain target with a 443 default', () => {
    expect(parseDomainTarget('api.figma.com')).toEqual({ host: 'api.figma.com', port: 443 });
    expect(parseDomainTarget(' API.Figma.com:8443 ')).toEqual({
      host: 'api.figma.com',
      port: 8443,
    });
    expect(parseDomainTarget('localhost')).toBeNull();
    expect(parseDomainTarget('a b.com')).toBeNull();
    expect(parseDomainTarget('api.figma.com:0')).toBeNull();
    expect(parseDomainTarget('api.figma.com:70000')).toBeNull();
    expect(parseDomainTarget('https://api.figma.com')).toBeNull();
    expect(parseDomainTarget('')).toBeNull();
    expect(splitDomain('api.figma.com:443')).toEqual({ host: 'api.figma.com', port: 443 });
  });

  it('draws a full dot only for a running server, a half one for a running host server', () => {
    const npm = { kind: 'npm', package: 'p', version: '1.0.0', integrity: '' } as const;
    const host = { kind: 'host', port: 3845, path: '/mcp' } as const;
    expect(statusDot({ state: 'approved', enabled: true, source: npm }).glyph).toBe('●');
    expect(statusDot({ state: 'approved', enabled: true, source: host }).glyph).toBe('◐');
    expect(statusDot({ state: 'approved', enabled: false, source: npm }).glyph).toBe('○');
    expect(statusDot({ state: 'pending', enabled: true, source: npm }).glyph).toBe('○');
  });

  it('describes sources, states, reasons and a host app that is down', () => {
    expect(
      sourceLabel({ kind: 'npm', package: 'figma-developer-mcp', version: '0.6.1', integrity: '' })
    ).toBe('npm figma-developer-mcp@0.6.1');
    expect(sourceLabel({ kind: 'host', port: 3845, path: '/mcp' })).toBe('host :3845 /mcp');
    expect(statePillClass('approved')).toBe('green');
    expect(statePillClass('changed')).toBe('amber');
    expect(statePillClass('excluded')).toBe('');
    expect(reasonText('host_servers_disabled')).toContain('organization');
    expect(reasonText('something_new')).toBe('something_new');
    expect(reasonText(null)).toBe('');
    expect(hostAppNotRunning('desk')).toBe(
      'desk is not running. Start it and its MCP server, then retry.'
    );
  });

  it('sums up refusals that name no host, in the order given', () => {
    expect(
      otherRefusalsText([
        { reason: 'private_address', count: 2 },
        { reason: 'ip_literal', count: 1 },
        { reason: 'sni_mismatch', count: 4 },
      ])
    ).toBe('private address ×2, IP literal ×1, server name mismatch ×4');
    expect(otherRefusalsText([])).toBe('');
    expect(otherRefusalsText([{ reason: 'from_a_newer_egress' as never, count: 1 }])).toBe(
      'from_a_newer_egress ×1'
    );
  });
});
