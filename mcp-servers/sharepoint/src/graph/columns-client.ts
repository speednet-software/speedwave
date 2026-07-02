/**
 * Graph URL builders for the SharePoint list-column schema API.
 *
 * Endpoint set (PR5):
 *   - `POST   /sites/{site-id}/lists/{list-id}/columns`                  (addListColumn)
 *   - `DELETE /sites/{site-id}/lists/{list-id}/columns/{column-id}`      (removeListColumn)
 *
 * Column reads come through {@link ./lists-client.ts}; this module is write-only.
 */
import type { GraphRequester } from './site-client.js';
import { ListsClient } from './lists-client.js';

/** Column-schema URL builder + request helpers. */
export class ColumnsClient {
  private readonly lists: ListsClient;

  /**
   * Build a Graph URL+request helper for the column-schema domain.
   * @param graph - shared Graph requester owning the siteId + auth state
   */
  constructor(private readonly graph: GraphRequester) {
    this.lists = new ListsClient(graph);
  }

  /**
   * `/sites/{site-id}/lists/{list-id}/columns`.
   * @param listId - Graph id of the list
   */
  columnsPath(listId: string): string {
    return `${this.lists.listPath(listId)}/columns`;
  }

  /**
   * `/sites/{site-id}/lists/{list-id}/columns/{column-id}`.
   * @param listId - Graph id of the list
   * @param columnId - Graph id of the column
   */
  columnPath(listId: string, columnId: string): string {
    return `${this.columnsPath(listId)}/${columnId}`;
  }

  /**
   * POST /sites/{site-id}/lists/{list-id}/columns — add a new column.
   * @param listId - Graph id of the list
   * @param body - Graph column-definition payload (one type-specific sub-object)
   */
  addColumn<T = unknown>(listId: string, body: Record<string, unknown>): Promise<T | undefined> {
    return this.graph.graphRequest<T>('POST', this.columnsPath(listId), body);
  }

  /**
   * DELETE /sites/{site-id}/lists/{list-id}/columns/{column-id} — remove a column.
   * @param listId - Graph id of the list
   * @param columnId - Graph id of the column to remove
   */
  removeColumn(listId: string, columnId: string): Promise<unknown> {
    return this.graph.graphRequest('DELETE', this.columnPath(listId, columnId));
  }
}
