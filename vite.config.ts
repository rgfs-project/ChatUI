import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  // Pre-bundle the browser dependencies at dev-server start. Otherwise the first
  // page that imports one triggers a re-optimization mid-load (HTTP 504
  // "Outdated Optimize Dep") and that page fails to hydrate.
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router",
      "react-router/dom",
      "@tanstack/react-query",
      "react-markdown",
      "remark-gfm",
      "lucide-react",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-tooltip",
    ],
  },
  build: {
    // Every asset is a first-party hashed file; no data: URIs to widen the CSP.
    assetsInlineLimit: 0,
  },
  environments: {
    ssr: {
      // Pre-bundle the browser dependencies at dev-server start. Otherwise the first
  // page that imports one triggers a re-optimization mid-load (HTTP 504
  // "Outdated Optimize Dep") and that page fails to hydrate.
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router",
      "react-router/dom",
      "@tanstack/react-query",
      "react-markdown",
      "remark-gfm",
      "lucide-react",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-tooltip",
    ],
  },
  build: {
        // The SSR bundle entry is our Express app module, which imports the
        // React Router server build (virtual module) itself.
        rollupOptions: { input: "./server/app.ts" },
      },
    },
  },
});
