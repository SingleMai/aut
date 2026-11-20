import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = await mkdtemp(resolve(tmpdir(), "aut-package-"));
try {
  await mkdir(resolve(staging, "app/dist"), { recursive: true });
  for (const file of ["main.cjs", "preload.cjs", "ui.js", "index.html", "style.css"])
    await copyFile(resolve(root, "dist", file), resolve(staging, "app/dist", file));
  await cp(resolve(root, "dist/fonts"), resolve(staging, "app/dist/fonts"), { recursive: true });
  await writeFile(
    resolve(staging, "app/package.json"),
    JSON.stringify({ name: "aut", version: "0.0.0", main: "dist/main.cjs" }),
  );
  await mkdir(resolve(staging, "daemon"));
  await build({
    entryPoints: [resolve(root, "../../packages/daemon/dist/main.js")],
    outfile: resolve(staging, "daemon/main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire as autCreateRequire } from "node:module"; const require = autCreateRequire(import.meta.url);',
    },
    target: "node24",
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
  await writeFile(resolve(staging, "daemon/package.json"), JSON.stringify({ type: "module" }));
  await build({
    entryPoints: [resolve(root, "../../packages/mcp-bridge/dist/stdio.js")],
    outfile: resolve(staging, "daemon/stdio.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire as autCreateRequire } from "node:module"; const require = autCreateRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  const results = await packager({
    dir: resolve(staging, "app"),
    out: process.env.AUT_PACKAGE_OUT || resolve(root, "dist/package"),
    overwrite: true,
    name: "aut",
    appBundleId: "dev.aut.desktop",
    icon: resolve(root, "assets/aut.icns"),
    platform: "darwin",
    arch: process.arch,
    asar: true,
    extraResource: [resolve(staging, "daemon")],
    electronVersion: "45.3.3",
  });
  for (const output of results) {
    const resources = resolve(output, "aut.app/Contents/Resources");
    await copyFile(
      resolve(root, "dist/renderer-LICENSES.txt"),
      resolve(resources, "renderer-LICENSES.txt"),
    );
    for (const file of ["LICENSE", "NOTICE"])
      await copyFile(resolve(root, "../..", file), resolve(resources, file));
  }
  console.log(results.join("\n"));
} finally {
  await rm(staging, { recursive: true, force: true });
}
