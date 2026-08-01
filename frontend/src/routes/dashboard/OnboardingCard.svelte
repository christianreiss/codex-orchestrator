<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { setupStatusQuery } from "$lib/api/setup";
  const setup = setupStatusQuery();
  const pending = $derived($setup.data?.next_actions.filter((action) => !action.complete) ?? []);
</script>

{#if pending.length > 0}
  <Card.Root class="border-primary/30">
    <Card.Header><Card.Title>Finish onboarding</Card.Title><Card.Description>Provider authentication and the first host are still pending.</Card.Description></Card.Header>
    <Card.Content><ul class="space-y-2 text-sm">{#each pending as action}<li>○ {action.label}</li>{/each}</ul></Card.Content>
    <Card.Footer><Button variant="outline" href="/admin/setup">Open setup checklist</Button></Card.Footer>
  </Card.Root>
{/if}
