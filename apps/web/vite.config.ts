import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import { pwaManifest } from "./src/lib/pwa/manifest";
import { pwaWorkboxOptions } from "./src/lib/pwa/sw-config";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env from monorepo root (single source of truth for all env vars).
  // The third parameter '' loads all env regardless of the `VITE_` prefix.
  const monorepoRoot = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, monorepoRoot, '');

  return {
    base: '/',
    server: {
      host: "localhost",
      port: 8080,
      proxy: {
        '/api': {
          target: env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        }
      },
      hmr: {
        host: 'localhost',
        port: 8080
      },
    },
    build: {
      outDir: 'dist',
      // Not 'assets': that would collide with the /assets (Manage Assets) route,
      // making direct navigation hit the build directory instead of index.html.
      assetsDir: 'static',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
    plugins: [
      react(),
      mode === 'development' &&
      componentTagger(),
      // Installable PWA, app-shell cache only (#155). The service worker is
      // registered by src/lib/pwa/register.ts in production builds only
      // (injectRegister: false), and only takes over when the page says so
      // (registerType: 'prompt'). See docs/specs/frontend/29-pwa.md.
      VitePWA({
        strategies: 'generateSW',
        registerType: 'prompt',
        injectRegister: false,
        filename: 'sw.js',
        manifestFilename: 'manifest.webmanifest',
        manifest: pwaManifest,
        // Icons are already in public/ and covered by globPatterns.
        includeManifestIcons: false,
        workbox: pwaWorkboxOptions,
        devOptions: { enabled: false },
      }),
    ].filter(Boolean),
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
