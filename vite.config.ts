import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
  },
  esbuild: {
    jsxFactory: "h",
    jsxFragment: "Fragment",
    jsxInject: `import { h, Fragment } from 'preact'`,
  },
  server: {
    proxy: {
      "/api": "http://localhost:4173",
    },
  },
});
