<script lang="ts">
  import SpeechInputSettings from "../SpeechInputSettings.svelte";
  import { Section } from "$lib/components/page";
  import WrapperRolloutSection from "../WrapperRolloutSection.svelte";
  import CommunicatorApiSection from "../CommunicatorApiSection.svelte";
  import RtkSettings from "../RtkSettings.svelte";
</script>

<WrapperRolloutSection />

<Section id="rollout-protocol" title="Host agent protocol" description="Which communicator API level hosts speak. Read only here.">
  <CommunicatorApiSection headingLevel={3} />
</Section>

<RtkSettings />

<SpeechInputSettings />
