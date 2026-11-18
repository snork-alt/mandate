import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiUrl = process.env.MANDATE_API_URL ?? `http://127.0.0.1:${process.env.MANDATE_PORT ?? 4000}`;
// Object form: Vite's string shorthand sets changeOrigin, which would rewrite Host to the API's and break the
// server's same-origin (Origin == Host) check for cookie-authenticated requests.
const apiTarget = { target: apiUrl, changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  // The Connect-agent popup points coding agents at the API server, not at this dev server.
  define: { __MANDATE_API_PORT__: JSON.stringify(new URL(apiUrl).port || '80') },
  // Pre-bundle up front so the dev server never serves stale optimized deps after installs.
  optimizeDeps: {
    include: ['react-markdown', 'remark-gfm', 'mermaid', '@mermaid-js/layout-elk', 'yaml', 'diff', 'zod', 'shiki/core', 'shiki/engine/javascript', 'shiki/langs', 'shiki/themes/github-light.mjs', 'shiki/themes/github-dark-dimmed.mjs', 'unified', 'remark-parse', 'mdast-util-to-string'],
  },
  server: {
    port: 5173,
    // Host is kept (changeOrigin: false): the API's DNS-rebinding and Origin checks see the UI's own origin.
    proxy: {
      // Unscoped MCP (project_list) for the project picker.
      '/mcp': apiTarget,
      // Per-project MCP (Streamable HTTP + SSE notifications). Pages under /p/<id>/... stay with Vite.
      '^/p/[^/]+/mcp': apiTarget,
      // Image section files (GET /p/<id>/images/<kind>/<docId>/<sid>).
      '^/p/[^/]+/images/': apiTarget,
      // Connect-agent details (GET /ui/p/<id>/connect).
      '/ui': apiTarget,
      // GitHub sign-in: /auth/status, /auth/github/login, /auth/github/callback, /auth/logout.
      '/auth': apiTarget,
      '/health': apiTarget,
      // The setup wizard saves the address it was opened on (this port, in dev) as the public URL, so everything the
      // server hands out points here: installer and CLI downloads, MCP OAuth (discovery, authorize, token), events.
      '^/(p/[^/]+/)?(un)?install\\.(sh|ps1)': apiTarget,
      '/getmandate.tgz': apiTarget,
      '/.well-known': apiTarget,
      '/oauth': apiTarget,
      '^/p/[^/]+/events': apiTarget,
    },
  },
});
