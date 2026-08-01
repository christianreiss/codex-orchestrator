import { mount } from "svelte";
// Tokens and markdown typography first, so app-specific rules that follow win
// on equal specificity.
import "$lib/styles/tokens.css";
import "$lib/styles/md-prose.css";
import "./styles.css";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });
