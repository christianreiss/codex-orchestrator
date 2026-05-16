import type { Snippet } from "svelte";

export type LogTableColumn<T> = {
  id: string;
  header: string;
  /** Optional CSS class applied to both the header and the cells. */
  class?: string;
  /** Optional CSS class applied to the header cell only. */
  headerClass?: string;
  /** Make this column sortable; clicks call `onSort`. */
  sortable?: boolean;
  /** Custom cell snippet. Receives the full row. */
  cell?: Snippet<[T]>;
};
