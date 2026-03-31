import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

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
      assetsDir: 'assets',
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
    ].filter(Boolean),
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
