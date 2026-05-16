import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/admin/api": "http://localhost",
      "/admin/auth": "http://localhost",
      "/admin/ws": "http://localhost",
    },
  },
});
