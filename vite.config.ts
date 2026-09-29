import { defineConfig } from "vite";

// Relative base so the built files work from any folder on a static host.
// No server or backend: everything runs in the browser.
export default defineConfig({
  base: "./",
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
  },
});
