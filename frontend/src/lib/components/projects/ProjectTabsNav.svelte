<script lang="ts">
  /** The one tab level on a project page: Board, Documents, Reports, Activity. */
  import { base } from "$app/paths";
  import TabNav from "$lib/components/layout/TabNav.svelte";

  type Props = {
    slug: string;
    /** Open board cards, notes plus files, and open reports; a tab shows its count only when it is above zero. */
    counts?: { board?: number; documents?: number; reports?: number };
  };
  let { slug, counts }: Props = $props();

  const root = $derived(`${base}/projects/${encodeURIComponent(slug)}`);
  const badge = (n: number | undefined) => (n && n > 0 ? n : undefined);
  const items = $derived([
    { label: "Board", href: `${root}/board`, badge: badge(counts?.board) },
    { label: "Documents", href: `${root}/documents`, badge: badge(counts?.documents) },
    { label: "Reports", href: `${root}/reports`, badge: badge(counts?.reports) },
    { label: "Activity", href: `${root}/activity` },
  ]);
</script>

<TabNav {items} aria-label="Project sections" />
