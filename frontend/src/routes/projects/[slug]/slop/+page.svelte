<script lang="ts">
  /**
   * Read-only view of the project's slop jobs: agents create, update, run and
   * close them through MCP (`slop_job_*`); operators inspect files, runs and
   * findings here. A job is deleted 24 h after its last activity.
   */
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import ScanSearch from "@lucide/svelte/icons/scan-search";
  import { DataTable, StateBlock } from "$lib/components/page";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { Badge, type BadgeVariant } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import EventRow from "$lib/components/logs/EventRow.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { fetchSlopJob, fetchSlopJobs, projectKeys, type SlopJobSummary, type SlopRunSummary } from "$lib/api/projects";

  const slug = $derived(page.params.slug ?? "");
  let open = $state<string | null>(null);
  $effect(() => { void slug; open = null; });

  const jobsQuery = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.slop(slug), queryFn: () => fetchSlopJobs(slug), enabled: slug.length > 0 })),
  );
  const detailQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.slopJob(slug, open ?? ""),
      queryFn: () => fetchSlopJob(slug, open!),
      enabled: slug.length > 0 && open !== null,
    })),
  );

  const jobs = $derived($jobsQuery.data?.jobs ?? []);
  const statusVariant = (status: SlopRunSummary["status"]): BadgeVariant =>
    status === "completed" ? "success" : status === "failed" ? "danger" : status === "incomplete" ? "warning" : "info";
  const priorityVariant = (priority: string): BadgeVariant => (priority === "P0" ? "danger" : priority === "P1" ? "warning" : "outline");
  const countsLabel = (run: SlopRunSummary | null) =>
    run?.counts ? `${run.counts.P0 ?? 0} P0 · ${run.counts.P1 ?? 0} P1 · ${run.counts.P2 ?? 0} P2` : "—";
  const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);
</script>

<DataTable
  items={jobs}
  loading={$jobsQuery.isLoading}
  error={$jobsQuery.isError ? ($jobsQuery.error instanceof ApiError ? $jobsQuery.error : "Could not load slop jobs") : null}
  onRetry={() => void $jobsQuery.refetch()}
  key={(job) => job.job_id}
  emptyIcon={ScanSearch}
  emptyTitle="No slop jobs in this project"
  emptyDescription="Agents create UI/UX review jobs with the slop_job_* MCP tools. A job is deleted when it is closed or 24 hours after its last activity, so finished reviews disappear from this list."
  caption="Slop jobs, newest activity first"
>
  {#snippet head()}
    <Table.Head class="w-8"><span class="sr-only">Details</span></Table.Head>
    <Table.Head>Job</Table.Head>
    <Table.Head class="text-right">Files (revisions)</Table.Head>
    <Table.Head>Latest run</Table.Head>
    <Table.Head>Findings</Table.Head>
    <Table.Head class="text-right">Expires</Table.Head>
  {/snippet}
  {#snippet row(job: SlopJobSummary)}
    <EventRow expanded={open === job.job_id} onToggle={() => (open = open === job.job_id ? null : job.job_id)} label={job.title} columns={5}>
      {#snippet cells()}
        <Table.Cell>
          <div class="font-medium">{job.title}</div>
          <div class="text-caption text-muted-foreground"><code class="font-mono">{job.job_id.slice(0, 8)}</code> · {job.created_by}</div>
        </Table.Cell>
        <Table.Cell class="text-right tabular-nums">{job.files} ({job.revisions})</Table.Cell>
        <Table.Cell>
          {#if job.latest_run}
            <Badge variant={statusVariant(job.latest_run.status)}>#{job.latest_run.seq} {job.latest_run.mode} · {job.latest_run.status}</Badge>
          {:else}
            <span class="text-muted-foreground">No runs yet</span>
          {/if}
        </Table.Cell>
        <Table.Cell class="whitespace-nowrap tabular-nums text-body-sm">{countsLabel(job.latest_run)}</Table.Cell>
        <Table.Cell class="whitespace-nowrap text-right text-body-sm text-muted-foreground"><Timestamp value={job.expires_at} /></Table.Cell>
      {/snippet}
      {#snippet detail()}
        {#if $detailQuery.isLoading}
          <StateBlock state="loading" rows={3} />
        {:else if $detailQuery.isError}
          <StateBlock state="error" message="Could not load this slop job" cause={$detailQuery.error} onRetry={() => void $detailQuery.refetch()} />
        {:else if $detailQuery.data}
          {@const detail = $detailQuery.data}
          <div class="space-y-4">
            {#if detail.job.description}
              <section>
                <h3 class="text-label font-medium">Description <span class="text-muted-foreground">(rev {detail.job.description_rev})</span></h3>
                <p class="whitespace-pre-wrap text-body-sm">{detail.job.description}</p>
              </section>
            {/if}
            <section>
              <h3 class="text-label font-medium">Files</h3>
              <div class="overflow-x-auto" role="region" aria-label="Job files" tabindex="-1">
                <Table.Root>
                  <Table.Header><Table.Row><Table.Head>Path</Table.Head><Table.Head>Kind</Table.Head><Table.Head class="text-right">Revision</Table.Head><Table.Head class="text-right">Size</Table.Head></Table.Row></Table.Header>
                  <Table.Body>
                    {#each detail.files as file (file.path)}
                      <Table.Row>
                        <Table.Cell><code class="font-mono text-body-sm" class:line-through={file.removed}>{file.path}</code></Table.Cell>
                        <Table.Cell>{file.removed ? "removed" : file.kind}</Table.Cell>
                        <Table.Cell class="text-right tabular-nums">v{file.rev} of {file.revisions}</Table.Cell>
                        <Table.Cell class="text-right tabular-nums">{file.removed ? "—" : bytes(file.size_bytes)}</Table.Cell>
                      </Table.Row>
                    {:else}
                      <Table.Row><Table.Cell colspan={4} class="text-muted-foreground">No files uploaded yet.</Table.Cell></Table.Row>
                    {/each}
                  </Table.Body>
                </Table.Root>
              </div>
            </section>
            <section class="space-y-3">
              <h3 class="text-label font-medium">Runs</h3>
              {#each detail.runs as run (run.run_id)}
                <article class="space-y-2 rounded-md border p-3">
                  <div class="flex flex-wrap items-center gap-2 text-body-sm">
                    <Badge variant={statusVariant(run.status)}>#{run.seq} {run.mode} · {run.status}</Badge>
                    {#if run.verdict?.verdict}<Badge variant="outline">Advisor: {run.verdict.verdict}</Badge>{/if}
                    <span class="text-muted-foreground">slop {run.slop_version ?? "unknown"} · <Timestamp value={run.created_at} /></span>
                  </div>
                  {#if run.verdict?.summary}<p class="text-body-sm">{run.verdict.summary}</p>{/if}
                  {#if run.error}<p class="text-body-sm text-destructive">{run.error}</p>{/if}
                  {#if run.report}
                    {#if run.report.findings.length}
                      <ul class="space-y-1">
                        {#each run.report.findings as finding (finding.id)}
                          <li class="text-body-sm">
                            <Badge variant={priorityVariant(finding.priority)}>{finding.priority}</Badge>
                            <code class="font-mono">{finding.location}</code>
                            <span class="font-medium">{finding.rule}</span>
                            <span class="text-muted-foreground">({finding.kind})</span>
                            — {finding.message} <span class="text-muted-foreground">Remedy: {finding.remedy}</span>
                          </li>
                        {/each}
                      </ul>
                    {:else}
                      <p class="text-body-sm text-muted-foreground">No findings in this run.</p>
                    {/if}
                    {#if run.report.errors.length}
                      <ul class="list-disc pl-5 text-body-sm text-warning-muted-foreground">
                        {#each run.report.errors as problem}<li>{problem}</li>{/each}
                      </ul>
                    {/if}
                  {:else if run.status === "scanning" || run.status === "reviewing" || run.status === "validating"}
                    <p class="text-body-sm text-muted-foreground">Running — results appear here when the run finishes.</p>
                  {/if}
                </article>
              {:else}
                <p class="text-body-sm text-muted-foreground">No runs yet. Agents start runs with slop_job_run.</p>
              {/each}
            </section>
          </div>
        {/if}
      {/snippet}
    </EventRow>
  {/snippet}
</DataTable>
