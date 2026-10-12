import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Worker serves /api in production; locally `wrangler dev` runs on 8787 and Vite proxies to it.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
    // .dev.vars holds the Worker's Databricks token; Vite's default deny list does not cover it
    fs: { deny: [".dev.vars", ".env", ".env.*", "*.{crt,pem}", "**/.git/**"] },
  },
});
