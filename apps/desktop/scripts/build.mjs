import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { buildRenderer, desktopRoot, readBrandSvg, rendererLicenses } from "./renderer-build.mjs";

const output = process.argv[2] ? resolve(process.argv[2]) : resolve(desktopRoot, "dist");
await mkdir(output, { recursive: true });
await Promise.all([
  ...["main", "preload"].map((entry) =>
    build({
      bundle: true,
      sourcemap: true,
      target: "es2023",
      logLevel: "warning",
      entryPoints: [resolve(desktopRoot, `src/${entry}.ts`)],
      outfile: resolve(output, `${entry}.cjs`),
      platform: "node",
      format: "cjs",
      external: ["electron"],
    }),
  ),
  buildRenderer("src/renderer.tsx", "src/style.css", {
    outdir: output,
    sourcemap: true,
    logLevel: "warning",
    assetNames: "fonts/[name]",
    loader: { ".woff2": "file" },
    format: "esm",
  }).then(async ({ metafile }) =>
    writeFile(resolve(output, "renderer-LICENSES.txt"), await rendererLicenses(metafile)),
  ),
  Promise.all([readFile(resolve(desktopRoot, "src/index.html"), "utf8"), readBrandSvg()]).then(
    ([html, brand]) =>
      writeFile(resolve(output, "index.html"), html.replace("<!-- aut-brand -->", brand)),
  ),
]);
console.log("Desktop bundles are ready.");
