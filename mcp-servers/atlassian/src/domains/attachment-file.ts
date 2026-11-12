import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { workspaceRoot } from '@speedwave/mcp-shared';

const JIRA_DOWNLOAD_SUBPATH = path.join('.speedwave', 'jira');

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'file';
}

/**
 * Stream an attachment into `<workspace>/.speedwave/jira/<id>-<name>`, replacing an earlier download.
 * @param id - The attachment ID.
 * @param filename - The attachment file name as Jira reports it.
 * @param content - The attachment bytes.
 */
export async function saveAttachment(
  id: string,
  filename: string,
  content: Readable
): Promise<{ path: string; size: number }> {
  const dir = path.join(workspaceRoot(), JIRA_DOWNLOAD_SUBPATH);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${sanitizeFilename(id)}-${sanitizeFilename(filename)}`);
  const partial = `${target}.part`;
  try {
    await pipeline(content, createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { path: target, size: (await stat(target)).size };
}
