import { describe, it, expect, vi } from 'vitest';
import {
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

      // Verify page count
      expect(pages.length).toBeLessThanOrEqual(3);

      // Verify actual item count (the important check!)
      const allItems = pages.flatMap((p) => p.items);
      expect(allItems.length).toBeLessThanOrEqual(25);
      expect(allItems.length).toBeGreaterThanOrEqual(20); // Should get close to maxItems

      // Verify items are sequential (offset calculation works)
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
      expect(allItems.length).toBe(20); // Exactly 20 items (2 pages of 10)
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
      expect(pages[0].items).toHaveLength(10); // First page: full 10
      expect(pages[1].items).toHaveLength(5); // Second page: only 5 (15 - 10 = 5)

      // Verify fetcher was called with correct limits
      expect(mockFetcher).toHaveBeenNthCalledWith(1, 0, 10);
      expect(mockFetcher).toHaveBeenNthCalledWith(2, 10, 5); // limit reduced to 5!
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

    it('extracts items from different response shapes', async () => {
      const responseShapes = [
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

      // Should stop after first page since item is found
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

      expect(count).toBe(10); // 0,2,4,6,8,10,12,14,16,18
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

      // Should only fetch first page
      expect(mockFetcher).toHaveBeenCalledTimes(1);
    });
  });
});
