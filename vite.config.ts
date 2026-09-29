import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  build: {
    // Every asset is a first-party hashed file; no data: URIs to widen the CSP.
    assetsInlineLimit: 0,
  },
  environments: {
    ssr: {
      build: {
        // The SSR bundle entry is our Express app module, which imports the
        // React Router server build (virtual module) itself.
        rollupOptions: { input: "./server/app.ts" },
      },
    },
  },
});
