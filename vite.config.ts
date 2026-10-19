import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { cpSync, mkdirSync } from "node:fs";

export default defineConfig({
  base: "./",
  plugins: [react(), {
    name: "offline-pdf-resources",
    closeBundle() {
      // PDF.js 4 embeds JPEG/JBIG2/JPX decoders in the worker. Its standalone
      // image_decoders distribution is unused here and includes source maps.
      for (const name of ["cmaps", "standard_fonts"]) {
        mkdirSync(`dist/pdf/${name}`, { recursive: true });
        cpSync(`node_modules/pdfjs-dist/${name}`, `dist/pdf/${name}`, { recursive: true });
      }
    },
    configureServer(server) {
      server.middlewares.use("/pdf", async (request, response, next) => {
        const { readFile } = await import("node:fs/promises");
        const url = request.url?.split("?")[0] || "";
        if (!/^\/(cmaps|standard_fonts)\/[a-zA-Z0-9_.-]+$/.test(url)) return next();
        try { response.end(await readFile(`node_modules/pdfjs-dist${url}`)); } catch { next(); }
      });
    }
  }],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: { input: { main: "index.html", importer: "import.html" } }
  },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"], setupFiles: ["src/testing/setup.ts"], maxWorkers: 1 }
});
