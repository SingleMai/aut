// Test-only source oracle. It never imports enterprise/ or an upstream backend.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upstream = resolve(process.env.OMB_REFERENCE_REPO ?? "/tmp/aut-research/openmausbot/repo");
const expectedCommit = "738ec88472a3b888ff7b7793755d89da613ed301";
const actualCommit = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (actualCommit !== expectedCommit) throw new Error(`Reference commit mismatch: ${actualCommit}`);
const sourceRoot = resolve(upstream, "src");
const copiedRoot = resolve(root, "apps/desktop/src/openmausbot");
const require = createRequire(resolve(root, "apps/desktop/package.json"));
const { build } = require("esbuild");
const output = resolve(root, ".tmp/tool-parity-oracle");
await mkdir(output, { recursive: true });
const alias = new Map([
  ["@/lib/i18n", resolve(copiedRoot, "lib/i18n.ts")],
  ["@/lib/interface-mode", resolve(copiedRoot, "context.tsx")],
  ["@/locales", resolve(copiedRoot, "locales.ts")],
  ["@/state/api", resolve(copiedRoot, "api.ts")],
]);
const extensionPath = async (path) => {
  for (const candidate of [path, `${path}.tsx`, `${path}.ts`, resolve(path, "index.ts")]) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return path;
};
await build({
  entryPoints: [resolve(root, "spikes/desktop/tool-parity-oracle.tsx")],
  outfile: resolve(output, "oracle.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  jsx: "automatic",
  sourcemap: true,
  nodePaths: [resolve(root, "apps/desktop/node_modules"), resolve(root, "node_modules")],
  plugins: [
    {
      name: "upstream-reference-only",
      setup(builder) {
        // The oracle compares behavior; upstream utility classes have no stylesheet in this fixture.
        builder.onResolve({ filter: /^@\/lib\/cn$/ }, () => ({ path: "cn", namespace: "oracle-style" }));
        builder.onLoad({ filter: /.*/, namespace: "oracle-style" }, () => ({
          contents: 'export const cn = (...names) => names.filter(Boolean).join(" ");',
        }));
        builder.onResolve({ filter: /^oracle-upstream\// }, async ({ path }) => ({
          path: await extensionPath(
            resolve(
              sourceRoot,
              path.endsWith("activity-runs") ? "lib" : "components",
              path.slice("oracle-upstream/".length),
            ),
          ),
        }));
        builder.onResolve({ filter: /^@\// }, async ({ path }) => ({
          path: alias.get(path) ?? (await extensionPath(resolve(sourceRoot, path.slice(2)))),
        }));
        builder.onResolve({ filter: /^\.\.?\// }, ({ path, importer }) => {
          if (!importer.startsWith(sourceRoot)) return;
          const candidate = resolve(dirname(importer), path).replace(/\.[tj]sx?$/, "");
          if (candidate === resolve(sourceRoot, "lib/i18n"))
            return { path: alias.get("@/lib/i18n") };
        });
      },
    },
  ],
  metafile: true,
}).then(async (result) => {
  const sourceInputs = Object.keys(result.metafile.inputs).filter((path) =>
    path.includes("openmausbot/repo"),
  );
  if (sourceInputs.some((path) => path.includes("enterprise/")))
    throw new Error("Enterprise source is forbidden");
  await writeFile(
    resolve(output, "source-inputs.json"),
    JSON.stringify(
      { expectedCommit, actualCommit, sourceInputs, shims: Object.fromEntries(alias) },
      null,
      2,
    ),
  );
});
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tool source parity oracle</title><link rel="stylesheet" href="/style.css"><style>html{font-size:16px}body{margin:0;background:#f9f8f5;color:#242321;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:20px 24px;border-bottom:1px solid #ddd}h1{font-size:20px;margin:0}header p{font-size:12px;color:#666}h2{font-size:13px;margin:0 0 16px}.oracle-controls{display:flex;align-items:center;gap:16px;font-size:13px}.oracle-controls button{padding:6px 12px;border:1px solid #ccc;border-radius:8px;background:white}.oracle-controls input{width:auto;margin-right:6px}main{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:24px}section{min-width:0}.oracle-transcript{display:flex;flex-direction:column;gap:12px;padding:20px;border:1px solid #e5e3df;border-radius:16px;min-width:0;background:white}.oracle-text{font-size:14px;line-height:1.65;margin:0;overflow-wrap:anywhere}@media(max-width:800px){main{gap:12px;padding:12px}.oracle-transcript{padding:12px}}</style></head><body><div id="root"></div><script type="module" src="/oracle.js"></script></body></html>`;
await writeFile(resolve(output, "index.html"), html);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/style.css") {
      response.setHeader("content-type", "text/css");
      response.end(await readFile(resolve(root, "apps/desktop/dist/style.css")));
      return;
    }
    if (/^\/[a-zA-Z0-9_/-]+\.woff2$/.test(pathname)) {
      response.setHeader("content-type", "font/woff2");
      response.end(await readFile(resolve(root, "apps/desktop/dist", pathname.slice(1))));
      return;
    }
    const path =
      pathname === "/" ? resolve(output, "index.html") : resolve(output, pathname.slice(1));
    if (!path.startsWith(`${output}/`)) throw new Error("Invalid path");
    response.setHeader(
      "content-type",
      extname(path) === ".js"
        ? "text/javascript"
        : extname(path) === ".html"
          ? "text/html"
          : "application/json",
    );
    response.end(await readFile(path));
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
server.listen(Number(process.env.OMB_PARITY_PORT ?? 4318), "127.0.0.1", () =>
  process.stdout.write(
    `${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, output, referenceCommit: actualCommit })}\n`,
  ),
);
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
