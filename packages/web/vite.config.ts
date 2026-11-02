import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Geliştirmede API ve WS sunucuya proxy'lenir; üretimde `dist/` sunucu
 * tarafından statik servis edilir, aynı origin — token çerezi ve WS için
 * ayrı CORS/auth yolu gerekmez.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      "/api": "http://127.0.0.1:7717",
      "/health": "http://127.0.0.1:7717",
      "/manifest.webmanifest": "http://127.0.0.1:7717",
      "/ws": { target: "ws://127.0.0.1:7717", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
