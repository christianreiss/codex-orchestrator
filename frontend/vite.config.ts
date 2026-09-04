import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type ProxyOptions } from "vite";
import type { IncomingMessage } from "node:http";

// The backend registers its API directly under /admin/* (no /api prefix —
// e.g. GET /admin/overview, POST /admin/prune-policy), the same base path
// this SvelteKit app's own pages live under (svelte.config.js pins
// paths.base to "/admin"). In production both are served by one Fastify
// process that can resolve the collision internally; in dev they're two
// servers, so path prefix alone can't tell "GET /admin/hosts, the page"
// from "GET /admin/hosts, the JSON the page's own fetch() just asked for".
//
// Vite's own dev-internal request space (/@fs/, /@id/, /.svelte-kit/,
// /node_modules/, HMR pings, …) isn't practically enumerable, so default to
// NOT proxying (let Vite's dev server handle it) and only proxy the one
// signal that's actually reliable: lib/api/client.ts always sets
// `Accept: application/json` on every real backend call, and nothing else
// in dev — page navigations, module/asset fetches, HMR — sends that.
//
// SSE is the one backend call that cannot carry that header: EventSource sends
// `Accept: text/event-stream` and offers no way to change it. It is just as
// reliable a signal — nothing in Vite's dev space asks for an event stream — so
// it is admitted alongside JSON rather than being answered by the dev server.
function bypassNonApi(req: IncomingMessage): string | undefined {
  const accept = req.headers.accept ?? "";
  const isApiCall = accept.includes("application/json") || accept.includes("text/event-stream");
  return isApiCall ? undefined : req.url;
}

const adminProxy: ProxyOptions = {
  target: "http://127.0.0.1:8488",
  bypass: bypassNonApi,
};

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/admin/ws": { target: "ws://127.0.0.1:8488", ws: true },
      "/admin": adminProxy,
    },
  },
});
