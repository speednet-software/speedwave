/**
 * Tests for {@link ./columns-client.ts} — column-schema URL builders.
 */
import { describe, it, expect, vi } from 'vitest';
import { ColumnsClient } from './columns-client.js';
import type { GraphRequester } from './site-client.js';

const SITE_ID = 'speednet.sharepoint.com,abc,def';

function fakeRequester(): GraphRequester & {
  graphRequest: ReturnType<typeof vi.fn>;
} {
  return {
    getSiteId: () => SITE_ID,
    graphRequest: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ColumnsClient', () => {
  it('columnsPath = /sites/{site-id}/lists/{list-id}/columns', () => {
    expect(new ColumnsClient(fakeRequester()).columnsPath('L1')).toBe(
      `/sites/${SITE_ID}/lists/L1/columns`
    );
  });

  it('columnPath addresses a single column', () => {
    expect(new ColumnsClient(fakeRequester()).columnPath('L1', 'C1')).toBe(
      `/sites/${SITE_ID}/lists/L1/columns/C1`
    );
  });

  it('addColumn POSTs the supplied schema body', async () => {
    const r = fakeRequester();
    const body = { name: 'Notes', displayName: 'Notes', text: {} };
    await new ColumnsClient(r).addColumn('L1', body);
    expect(r.graphRequest).toHaveBeenCalledWith('POST', `/sites/${SITE_ID}/lists/L1/columns`, body);
  });

  it('removeColumn DELETEs the column', async () => {
    const r = fakeRequester();
    await new ColumnsClient(r).removeColumn('L1', 'C1');
    expect(r.graphRequest).toHaveBeenCalledWith('DELETE', `/sites/${SITE_ID}/lists/L1/columns/C1`);
  });
});
