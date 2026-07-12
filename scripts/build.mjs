import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
  bundle: true,
  entryPoints: ["src/index.js"],
  format: "cjs",
  outfile: "dist/index.cjs",
  platform: "node",
  target: "node24",
});
