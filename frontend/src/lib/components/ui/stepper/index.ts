import Root from "./stepper.svelte";

export interface StepperStep {
  id: string;
  label: string;
  /** Renders a check mark instead of the step number. */
  done: boolean;
  /** Clickable. Unreachable steps render disabled. */
  reachable: boolean;
}

export { Root, Root as Stepper };
