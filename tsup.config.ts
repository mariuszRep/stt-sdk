import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", registry: "src/registry/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
});
