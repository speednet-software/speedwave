/**
 * Graph URL builders for SharePoint Lists: lists + items (columns: {@link ./columns-client.ts}).
 * `siteId` is always from `GraphRequester.getSiteId()`; no tool accepts `site_id` (ADR-060).
 */
import type { GraphRequester } from './site-client.js';

/** Lists / items URL builder + request helpers. */
export class ListsClient {
  /**
   * Build a Graph URL+request helper for the lists / items domain.
   * @param graph - shared Graph requester owning the siteId + auth state
   */
  constructor(private readonly graph: GraphRequester) {}

  // -- low-level URL builders ------------------------------------------------

  /** `/sites/{site-id}/lists`. */
  listsPath(): string {
    return `/sites/${this.graph.getSiteId()}/lists`;
  }

  /**
   * `/sites/{site-id}/lists/{list-id}`.
   * @param listId - Graph id of the list
   */
  listPath(listId: string): string {
    return `${this.listsPath()}/${listId}`;
  }

  /**
   * `/sites/{site-id}/lists/{list-id}/items`.
   * @param listId - Graph id of the list
   */
  itemsPath(listId: string): string {
    return `${this.listPath(listId)}/items`;
  }

  /**
   * `/sites/{site-id}/lists/{list-id}/items/{item-id}`.
   * @param listId - Graph id of the list
   * @param itemId - Graph id of the item
   */
  itemPath(listId: string, itemId: string): string {
    return `${this.itemsPath(listId)}/${itemId}`;
  }

  // -- request helpers -------------------------------------------------------

  /** GET /sites/{site-id}/lists — all lists on the configured site. */
  listLists<T = unknown>(): Promise<T | undefined> {
    return this.graph.graphRequest<T>('GET', this.listsPath());
  }

  /**
   * GET /sites/{site-id}/lists/{list-id}?$expand=columns — one list with schema.
   * @param listId - Graph id of the list
   */
  getList<T = unknown>(listId: string): Promise<T | undefined> {
    return this.graph.graphRequest<T>('GET', `${this.listPath(listId)}?$expand=columns`);
  }

  /**
   * POST /sites/{site-id}/lists — create a new list.
   * @param body - Graph list payload (displayName, list.template, optional columns)
   */
  createList<T = unknown>(body: Record<string, unknown>): Promise<T | undefined> {
    return this.graph.graphRequest<T>('POST', this.listsPath(), body);
  }

  /**
   * PATCH /sites/{site-id}/lists/{list-id} — rename / change description.
   * @param listId - Graph id of the list
   * @param body - partial list update payload
   */
  updateList(listId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.graph.graphRequest('PATCH', this.listPath(listId), body);
  }

  /**
   * DELETE /sites/{site-id}/lists/{list-id} — remove the list. Destructive.
   * @param listId - Graph id of the list
   */
  deleteList(listId: string): Promise<unknown> {
    return this.graph.graphRequest('DELETE', this.listPath(listId));
  }

  // -- items -----------------------------------------------------------------

  /**
   * GET .../items?$expand=fields[&...query]; `$expand=fields` is always set.
   * @param listId - Graph id of the list
   * @param extraQuery - additional OData query-string segments, appended with `&`
   */
  listItems<T = unknown>(listId: string, extraQuery: string[] = []): Promise<T | undefined> {
    const qs = ['$expand=fields', ...extraQuery].join('&');
    return this.graph.graphRequest<T>('GET', `${this.itemsPath(listId)}?${qs}`);
  }

  /**
   * GET /sites/{site-id}/lists/{list-id}/items/{item-id}?$expand=fields.
   * @param listId - Graph id of the list
   * @param itemId - Graph id of the item
   */
  getItem<T = unknown>(listId: string, itemId: string): Promise<T | undefined> {
    return this.graph.graphRequest<T>('GET', `${this.itemPath(listId, itemId)}?$expand=fields`);
  }

  /**
   * POST .../items — create a new item; `body` is typically `{ fields: { ... } }`.
   * @param listId - Graph id of the list
   * @param body - Graph item payload (typically `{ fields: { ... } }`)
   */
  createItem<T = unknown>(listId: string, body: Record<string, unknown>): Promise<T | undefined> {
    return this.graph.graphRequest<T>('POST', this.itemsPath(listId), body);
  }

  /**
   * PATCH on `.../items/{item-id}/fields` — Graph's per-field update endpoint.
   * @param listId - Graph id of the list
   * @param itemId - Graph id of the item
   * @param fields - field name → value mapping (only listed fields are touched)
   */
  updateItem(listId: string, itemId: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.graph.graphRequest('PATCH', `${this.itemPath(listId, itemId)}/fields`, fields);
  }

  /**
   * DELETE /sites/{site-id}/lists/{list-id}/items/{item-id} — remove the item.
   * @param listId - Graph id of the list
   * @param itemId - Graph id of the item
   */
  deleteItem(listId: string, itemId: string): Promise<unknown> {
    return this.graph.graphRequest('DELETE', this.itemPath(listId, itemId));
  }
}
