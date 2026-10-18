<script lang="ts">
  import type { Snapshot } from "./$types";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import FileText from "@lucide/svelte/icons/file-text";
  import StickyNote from "@lucide/svelte/icons/sticky-note";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { DataTable, ListDetail, Toolbar } from "$lib/components/page";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Table from "$lib/components/ui/table";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import FileEditor from "$lib/components/projects/FileEditor.svelte";
  import NoteEditor from "$lib/components/projects/NoteEditor.svelte";
  import { KIND_OPTIONS, documentRows, parseKind, type DocRow, type KindFilter } from "$lib/components/projects/documents-model";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { deleteFile, deleteNote, fetchFiles, fetchNotes, projectKeys } from "$lib/api/projects";
  import { relativeTime, formatBytes } from "$lib/utils/format";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  // svelte-ignore state_referenced_locally
  let kind = $state<KindFilter>(parseKind(page.url.searchParams.get("kind")));
  let search = $state("");
  $effect(() => {
    const url = new URL(page.url);
    if (kind === "all") url.searchParams.delete("kind");
    else url.searchParams.set("kind", kind);
    if (url.search !== page.url.search) void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  });

  const notesQuery = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.notes(slug), queryFn: () => fetchNotes(slug), enabled: slug.length > 0 && kind !== "files" })),
  );
  const filesQuery = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.files(slug), queryFn: () => fetchFiles(slug), enabled: slug.length > 0 && kind !== "notes" })),
  );

  const notes = $derived($notesQuery.data?.notes ?? []);
  const files = $derived($filesQuery.data?.files ?? []);
  const rows = $derived(documentRows(notes, files, kind, search));
  const loading = $derived(($notesQuery.isLoading && kind !== "files") || ($filesQuery.isLoading && kind !== "notes"));
  const failure = $derived.by(() => {
    const err = ($notesQuery.isError && kind !== "files" ? $notesQuery.error : null) ?? ($filesQuery.isError && kind !== "notes" ? $filesQuery.error : null);
    return err ? (err instanceof ApiError ? err.message : "Could not load documents") : null;
  });

  // What the editor sheet is showing: an existing row, or a new note/file.
  type Editing = { mode: "row"; row: DocRow } | { mode: "new"; kind: "note" | "file" };
  let editing = $state<Editing | null>(null);
  let editorOpen = $state(false);
  const open = (next: Editing) => { editing = next; editorOpen = true; };
  const close = () => { editorOpen = false; };
  const editorKind = $derived(editing?.mode === "row" ? editing.row.kind : editing?.kind);
  const editorTitle = $derived(`${editing?.mode === "new" ? "New" : "Edit"} ${editorKind === "file" ? "file" : "note"}`);

  let editorDirty = $state(false);
  let toDelete = $state<DocRow | null>(null);
  let confirmOpen = $state(false);
  const deleteMutation = createMutation({
    mutationFn: (row: DocRow) => (row.kind === "note" ? deleteNote(slug, row.id) : deleteFile(slug, row.id)),
    onSuccess: (_d, row) => { toast.success(row.kind === "note" ? "Note deleted" : "File deleted"); confirmOpen = false; toDelete = null; },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not delete document"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.notes(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.files(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });
  export const snapshot: Snapshot<{ search: typeof search, kind: typeof kind }> = {
    capture: () => ({ search, kind }),
    restore: (value) => { search = value.search; kind = value.kind; },
  };
</script>

<div class="space-y-3">
  <Toolbar bind:search searchPlaceholder="Search documents" count={`${rows.length} ${rows.length === 1 ? "document" : "documents"}`}>
    {#snippet filters()}
      <SegmentedControl label="Document kind" value={kind} options={KIND_OPTIONS} onChange={(next) => (kind = next)} />
    {/snippet}
    {#snippet actions()}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-body font-medium text-primary-foreground hover:bg-primary/90">
          <Plus class="h-4 w-4" /> New
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-40">
          <DropdownMenu.Item onclick={() => open({ mode: "new", kind: "note" })}><StickyNote class="h-4 w-4" /> New note</DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => open({ mode: "new", kind: "file" })}><FileText class="h-4 w-4" /> New file</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </Toolbar>

  <ListDetail dirty={editorDirty} bind:open={editorOpen} title={editorTitle} description={editorKind === "file" ? "Saved by stored name: an existing name is overwritten." : "Header and body are both required."}>
    {#snippet list()}
      <DataTable
        items={rows}
        {loading}
        onClearFilters={() => search = ""}
        error={failure}
        key={(row) => row.key}
        filtered={search.trim() !== ""}
        emptyIcon={FileText}
        emptyTitle={kind === "notes" ? "No notes yet" : kind === "files" ? "No files yet" : "No documents yet"}
        emptyDescription="Notes and files agents and administrators keep for this project."
        caption="Project documents"
      >
        {#snippet head()}
          <Table.Head>Name</Table.Head>
          <Table.Head class="hidden sm:table-cell">Kind</Table.Head>
          <Table.Head class="hidden md:table-cell">Summary</Table.Head>
          <Table.Head class="hidden lg:table-cell">Size</Table.Head>
          <Table.Head>Updated</Table.Head>
          <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
        {/snippet}
        {#snippet row(item: DocRow)}
          <Table.Row>
            <Table.Cell class="max-w-xs">
              <button type="button" class="flex max-w-full items-center gap-2 text-left hover:underline" onclick={() => open({ mode: "row", row: item })}>
                {#if item.kind === "note"}<StickyNote class="h-4 w-4 shrink-0 text-muted-foreground" />{:else}<FileText class="h-4 w-4 shrink-0 text-muted-foreground" />{/if}
                <span class="truncate {item.kind === 'file' ? 'font-mono text-body-sm' : 'font-medium'}">{item.name}</span>
              </button>
            </Table.Cell>
            <Table.Cell class="hidden sm:table-cell"><Badge variant="outline">{item.kind === "note" ? "Note" : "File"}</Badge></Table.Cell>
            <Table.Cell class="hidden max-w-sm truncate text-muted-foreground md:table-cell">{item.summary || "—"}</Table.Cell>
            <Table.Cell class="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{item.kind === "file" ? formatBytes(item.file.size_bytes) : "—"}</Table.Cell>
            <Table.Cell class="whitespace-nowrap text-muted-foreground">{item.updatedAt ? relativeTime(item.updatedAt) : "—"}</Table.Cell>
            <Table.Cell class="text-right">
              <RowActions
                label={`Actions for ${item.name}`}
                actions={[{ label: item.kind === "note" ? "Delete note" : "Delete file", icon: Trash2, destructive: true, onClick: () => { toDelete = item; confirmOpen = true; } }]}
              />
            </Table.Cell>
          </Table.Row>
        {/snippet}
      </DataTable>
    {/snippet}
    {#snippet detail()}
      {#key editing?.mode === "row" ? editing.row.key : `new:${editing?.mode === "new" ? editing.kind : ""}`}
        {#if editing}
          {#if editorKind === "file"}
            <FileEditor bind:dirty={editorDirty} {slug} file={editing.mode === "row" && editing.row.kind === "file" ? editing.row.file : null} onDone={close} />
          {:else}
            <NoteEditor bind:dirty={editorDirty} {slug} note={editing.mode === "row" && editing.row.kind === "note" ? editing.row.note : null} onDone={close} />
          {/if}
        {/if}
      {/key}
    {/snippet}
  </ListDetail>
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title={toDelete?.kind === "file" ? "Delete file?" : "Delete note?"}
  description={`This permanently removes ${toDelete?.name ?? "this document"} from the project.`}
  confirmLabel="Delete"
  destructive
  busy={$deleteMutation.isPending}
  onClose={() => { if (!$deleteMutation.isPending) toDelete = null; }}
  onConfirm={() => { if (toDelete) $deleteMutation.mutate(toDelete); }}
/>
