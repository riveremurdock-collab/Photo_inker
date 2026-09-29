import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// The Kawa site hosts the fonts and favicon this app uses (at /fonts and
// /images). In dev, serve them from the site's public folder when it exists
// next to this project, so running locally looks the same as on the site.
const SITE_PUBLIC = path.resolve(__dirname, "../kawa_website/public");

function siteAssets(): Plugin {
  return {
    name: "kawa-site-assets",
    apply: "serve",
    configureServer(server) {
      if (!fs.existsSync(SITE_PUBLIC)) return;
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
        if (!url.startsWith("/fonts/") && !url.startsWith("/images/")) return next();
        const file = path.join(SITE_PUBLIC, url);
        if (!file.startsWith(SITE_PUBLIC) || !fs.existsSync(file)) return next();
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// Relative base so the built files work from any folder on a static host.
// No server or backend: everything runs in the browser.
export default defineConfig({
  base: "./",
  plugins: [siteAssets()],
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
  },
});
