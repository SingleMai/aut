import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { buildRenderer, desktopRoot, readBrandSvg, rendererLicenses } from "./renderer-build.mjs";

const filename = resolve(desktopRoot, "../../.artifacts/desktop-preview/aut-components.html");
const [bundle, brand, license, notice] = await Promise.all([
  buildRenderer("src/preview/component-preview.tsx", "src/preview/preview.css", {
    minify: true,
    write: false,
    legalComments: "inline",
    format: "iife",
    outdir: "preview",
    loader: { ".woff2": "dataurl" },
  }),
  readBrandSvg(),
  readFile(resolve(desktopRoot, "../../LICENSE"), "utf8"),
  readFile(resolve(desktopRoot, "../../NOTICE"), "utf8"),
]);
const licenses = [license, notice, await rendererLicenses(bundle.metafile)].join("\n\n");
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith(".css")).text;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>aut · 桌面组件预览</title>
<style>${css}</style></head><body><div class="brand-library" aria-hidden="true">${brand}</div>
<div id="app"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script>
<script type="text/plain" id="third-party-licenses">${licenses.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
await mkdir(dirname(filename), { recursive: true });
await writeFile(filename, html);
console.log(filename);
if (!process.argv.includes("--build-only")) {
  const server = createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/aut-components.html") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
  });
  server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}/`));
}
