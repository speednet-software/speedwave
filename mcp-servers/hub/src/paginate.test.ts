import { describe, it, expect, vi } from 'vitest';
import {
  ITEM_KEYS,
  paginate,
  collectPages,
  findInPages,
  countInPages,
  filterPages,
  mapPages,
  takeFromPages,
} from './paginate.js';

describe('paginate', () => {
  describe('paginate generator', () => {
    it('paginates through items correctly', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 50 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 50 });
      });

      const pages: unknown[] = [];
      for await (const page of paginate(mockFetcher, { limit: 10 })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(5);
      expect(mockFetcher).toHaveBeenCalledTimes(5);
    });

    it('respects maxItems config', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      const pages: Array<{ items: Array<{ id: number }> }> = [];
      for await (const page of paginate<{ id: number }>(mockFetcher, { limit: 10, maxItems: 25 })) {
        pages.push(page);
      }

      expect(pages.length).toBeLessThanOrEqual(3);

      const allItems = pages.flatMap((p) => p.items);
      expect(allItems.length).toBeLessThanOrEqual(25);
      expect(allItems.length).toBeGreaterThanOrEqual(20);

      allItems.forEach((item, index) => {
        expect(item.id).toBe(index);
      });
    });

    it('respects maxItems with exact boundary', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      const pages: Array<{ items: Array<{ id: number }> }> = [];
      for await (const page of paginate<{ id: number }>(mockFetcher, { limit: 10, maxItems: 20 })) {
        pages.push(page);
      }

      const allItems = pages.flatMap((p) => p.items);
      expect(allItems.length).toBe(20);
    });

    it('last page has reduced limit when approaching maxItems', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      const pages: Array<{ items: Array<{ id: number }> }> = [];
      for await (const page of paginate<{ id: number }>(mockFetcher, { limit: 10, maxItems: 15 })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0].items).toHaveLength(10);
      expect(pages[1].items).toHaveLength(5);

      expect(mockFetcher).toHaveBeenNthCalledWith(1, 0, 10);
      expect(mockFetcher).toHaveBeenNthCalledWith(2, 10, 5);
    });

    it('respects maxPages config', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      const pages: unknown[] = [];
      for await (const page of paginate(mockFetcher, { limit: 10, maxPages: 3 })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(3);
    });

    it('stops when stopWhen returns true', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      const pages: unknown[] = [];
      for await (const page of paginate(mockFetcher, {
        limit: 10,
        stopWhen: (_, pageNumber) => pageNumber >= 2,
      })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
    });

    it('stops when fetcher returns empty array', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({ items: [] });

      const pages: unknown[] = [];
      for await (const page of paginate(mockFetcher)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });

    it('extracts items when fetcher returns a plain array (no wrapper object)', async () => {
      const mockFetcher = vi
        .fn()
        .mockResolvedValueOnce([{ id: 1 }, { id: 2 }] as unknown as {
          items: Array<{ id: number }>;
        })
        .mockResolvedValue({ items: [] } as { items: Array<{ id: number }> });

      const pages: Array<{ items: Array<{ id: number }> }> = [];
      for await (const page of paginate(mockFetcher)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0].items).toHaveLength(2);
      expect(pages[0].items[0]).toEqual({ id: 1 });
      expect(pages[0].items[1]).toEqual({ id: 2 });
    });

    it('returns empty page when response has no known keys and is not an array', async () => {
      const mockFetcher = vi
        .fn()
        .mockResolvedValueOnce({ count: 5, status: 'ok' } as unknown as { items: unknown[] })
        .mockResolvedValue({ items: [] } as { items: unknown[] });

      const pages: unknown[] = [];
      for await (const page of paginate(mockFetcher)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });

    it('throws a teaching error when a page carries arrays only under unrecognised keys', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({ mrs: [{ iid: 1 }], count: 1 });

      await expect(collectPages(paginate(mockFetcher))).rejects.toThrow(
        `arrays under unrecognised keys (mrs); recognised keys: ${ITEM_KEYS.join(', ')}`
      );
      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });

    it('reads an unpaginated { versions, total_count } list as one page', async () => {
      const versions = [{ id: 87 }, { id: 88 }];
      const mockFetcher = vi.fn().mockResolvedValue({ versions, total_count: 2 });

      const all = await collectPages(paginate<{ id: number }>(mockFetcher));

      expect(all).toEqual(versions);
      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });

    it('pages through every id when the fetcher returns { ids, total_count }', async () => {
      const allIds = Array.from({ length: 23 }, (_, i) => i + 1);
      const mockFetcher = vi
        .fn()
        .mockImplementation((offset: number, limit: number) =>
          Promise.resolve({ ids: allIds.slice(offset, offset + limit), total_count: allIds.length })
        );

      const pages: Array<{ items: number[]; offset: number }> = [];
      for await (const page of paginate<number>(mockFetcher, { limit: 10 })) {
        pages.push(page);
      }

      expect(pages.map((p) => p.items.length)).toEqual([10, 10, 3]);
      expect(pages.map((p) => p.offset)).toEqual([0, 10, 20]);
      expect(pages.flatMap((p) => p.items)).toEqual(allIds);
      expect(mockFetcher.mock.calls).toEqual([
        [0, 10],
        [10, 10],
        [20, 10],
      ]);
    });

    it('terminates on an empty ids page', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({ ids: [], total_count: 0 });

      const pages: unknown[] = [];
      for await (const page of paginate(mockFetcher)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });

    it('drives hasMore from total_count across ids pages', async () => {
      const mockFetcher = vi
        .fn()
        .mockImplementation((offset: number, limit: number) =>
          Promise.resolve({ ids: [7, 8, 9].slice(offset, offset + limit), total_count: 3 })
        );

      const pages: Array<{ hasMore: boolean; totalCount?: number }> = [];
      for await (const page of paginate<number>(mockFetcher, { limit: 2 })) {
        pages.push(page);
      }

      expect(pages.map((p) => p.hasMore)).toEqual([true, false]);
      expect(pages.map((p) => p.totalCount)).toEqual([3, 3]);
      expect(mockFetcher).toHaveBeenCalledTimes(2);
    });

    it('stops after a full ids page that reaches total_count without another fetch', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({ ids: [7, 8, 9], total_count: 3 });

      const pages: Array<{ hasMore: boolean }> = [];
      for await (const page of paginate<number>(mockFetcher, { limit: 3 })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0].hasMore).toBe(false);
      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });

    it('prefers ids over a sibling detail array in an ids-only response', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ids: [1, 2],
        projects: [
          { id: 1, name: 'a' },
          { id: 2, name: 'b' },
        ],
        total_count: 2,
      });

      const items = await collectPages(paginate(mockFetcher));

      expect(items).toEqual([1, 2]);
    });

    it('extracts items from different response shapes', async () => {
      const responseShapes = [
        { ids: [1], total_count: 1 },
        { issues: [{ id: 1 }], total_count: 1 },
        { projects: [{ id: 2 }], total_count: 1 },
        { messages: [{ id: 3 }], total_count: 1 },
        { results: [{ id: 4 }], total_count: 1 },
      ];

      for (const response of responseShapes) {
        const mockFetcher = vi
          .fn()
          .mockResolvedValueOnce(response)
          .mockResolvedValue({ items: [] });

        const pages: unknown[] = [];
        for await (const page of paginate(mockFetcher)) {
          pages.push(page);
        }

        expect(pages[0]).toBeDefined();
      }
    });

    it('provides correct hasMore indicator', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset) => {
        if (offset === 0) {
          return Promise.resolve({ items: [{ id: 1 }], total_count: 2 });
        }
        return Promise.resolve({ items: [{ id: 2 }], total_count: 2 });
      });

      const pages: Array<{ hasMore: boolean }> = [];
      for await (const page of paginate(mockFetcher, { limit: 1 })) {
        pages.push(page as { hasMore: boolean });
      }

      expect(pages[0].hasMore).toBe(true);
      expect(pages[1].hasMore).toBe(false);
    });
  });

  describe('collectPages', () => {
    it('collects all items from pages', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 25 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 25 });
      });

      const items = await collectPages(paginate(mockFetcher, { limit: 10 }));

      expect(items).toHaveLength(25);
    });

    it('returns empty array for no items', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({ items: [] });
      const items = await collectPages(paginate(mockFetcher));

      expect(items).toHaveLength(0);
    });
  });

  describe('findInPages', () => {
    it('finds first matching item', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      const found = await findInPages(
        paginate<{ id: number; name: string }>(mockFetcher, { limit: 10 }),
        (item) => item.id === 25
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(25);
    });

    it('returns undefined when not found', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 30 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 30 });
      });

      const found = await findInPages(
        paginate<{ id: number }>(mockFetcher, { limit: 10 }),
        (item) => item.id === 999
      );

      expect(found).toBeUndefined();
    });

    it('stops early when item is found', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      await findInPages(
        paginate<{ id: number }>(mockFetcher, { limit: 10 }),
        (item) => item.id === 5
      );

      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('countInPages', () => {
    it('counts all items without predicate', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 25 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 25 });
      });

      const count = await countInPages(paginate(mockFetcher, { limit: 10 }));

      expect(count).toBe(25);
    });

    it('counts matching items with predicate', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 20 }, (_, i) => ({ id: i, even: i % 2 === 0 }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 20 });
      });

      const count = await countInPages(
        paginate<{ id: number; even: boolean }>(mockFetcher, { limit: 10 }),
        (item) => item.even
      );

      expect(count).toBe(10);
    });
  });

  describe('filterPages', () => {
    it('filters items across pages', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 20 }, (_, i) => ({
          id: i,
          status: i % 3 === 0 ? 'active' : 'inactive',
        }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 20 });
      });

      const filtered = await filterPages(
        paginate<{ id: number; status: string }>(mockFetcher, { limit: 10 }),
        (item) => item.status === 'active'
      );

      expect(filtered.every((item) => item.status === 'active')).toBe(true);
    });
  });

  describe('mapPages', () => {
    it('maps items across pages', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 15 }, (_, i) => ({ id: i, name: `item-${i}` }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 15 });
      });

      const mapped = await mapPages(
        paginate<{ id: number; name: string }>(mockFetcher, { limit: 10 }),
        (item) => item.name
      );

      expect(mapped).toHaveLength(15);
      expect(mapped[0]).toBe('item-0');
    });
  });

  describe('takeFromPages', () => {
    it('takes first N items', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      const taken = await takeFromPages(paginate(mockFetcher, { limit: 10 }), 15);

      expect(taken).toHaveLength(15);
    });

    it('returns all items if less than N', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 5 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items, total_count: 5 });
      });

      const taken = await takeFromPages(paginate(mockFetcher, { limit: 10 }), 100);

      expect(taken).toHaveLength(5);
    });

    it('stops fetching once N items collected', async () => {
      const mockFetcher = vi.fn().mockImplementation((offset, limit) => {
        const allItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
        const items = allItems.slice(offset, offset + limit);
        return Promise.resolve({ items });
      });

      await takeFromPages(paginate(mockFetcher, { limit: 10 }), 5);

      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });
  });
});
