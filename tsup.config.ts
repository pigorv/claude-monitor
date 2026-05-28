import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  target: "node20",
  // Don't clean: tsup's clean would wipe `dist/frontend/` (built by Vite) and break
  // the dev loop where `dev:server` serves the prebuilt SPA. Watch-mode rebuilds
  // simply overwrite tsup's own outputs (`dist/index.js`, `.map`, `.d.ts`).
  // `npm run build` itself runs `tsup && vite build`, so a fresh build is still fine.
  clean: false,
  dts: true,
  sourcemap: true,
  external: ["better-sqlite3"],
  define: {
    "process.env.APP_VERSION": JSON.stringify(pkg.version),
  },
});
