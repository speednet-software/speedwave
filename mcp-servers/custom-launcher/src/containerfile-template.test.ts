import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../Containerfile.npm.template', import.meta.url), 'utf8');
const officeDockerfile = readFileSync(new URL('../../office/Dockerfile', import.meta.url), 'utf8');

const fromLines = template.split('\n').filter((line) => line.startsWith('FROM '));

describe('Containerfile.npm.template', () => {
  it('pins every stage to the bookworm-slim digest the office image uses', () => {
    const officeBase = officeDockerfile
      .split('\n')
      .find((line) => line.startsWith('FROM node:24-bookworm-slim@sha256:'));
    expect(officeBase).toBeDefined();
    const officeImage = (officeBase as string).split(' ')[1];
    expect(fromLines).toHaveLength(3);
    for (const line of fromLines) expect(line.split(' ')[1]).toBe(officeImage);
  });

  it('installs the server without install scripts or dev dependencies', () => {
    expect(template).toContain('npm ci --ignore-scripts --omit=dev');
    expect(template).toContain('COPY server/package.json server/package-lock.json ./');
    for (const line of template.split('\n').filter((l) => /\bnpm (ci|install)\b/.test(l))) {
      expect(line).toContain('--ignore-scripts');
    }
  });

  it('runs the launcher as UID 1000 with the baked entry file', () => {
    expect(template).toMatch(/^USER 1000:1000$/m);
    expect(template).toContain('COPY server/entry.json /opt/spw/entry.json');
    expect(template).toContain('SPW_LAUNCHER_ENTRY=/opt/spw/entry.json');
    expect(template).toMatch(/^ENTRYPOINT \["node", "\/opt\/spw\/launcher\/dist\/index\.js"\]$/m);
  });

  it('ships tzdata with a non-interactive apt install', () => {
    const apt = template.split('\n').find((line) => line.includes('apt-get install'));
    expect(apt).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(apt).toContain('tzdata');
  });

  it('carries no comments and no mutable tags', () => {
    expect(template).not.toMatch(/^\s*#/m);
    expect(template).not.toMatch(/:latest\b/);
  });
});
