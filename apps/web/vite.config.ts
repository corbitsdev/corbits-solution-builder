import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The bundle must be self-contained and offline-safe: no remote fonts, no
    // CDN, nothing the host's CSP would have to be loosened for.
    assetsInlineLimit: 0,
  },
});
