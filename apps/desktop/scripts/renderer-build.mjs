import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
export const readBrandSvg = () =>
  readFile(new URL(import.meta.resolve("@aut/characters/aut.svg")), "utf8");

export function buildRenderer(ui, style, options) {
  return build({
    entryPoints: { ui: resolve(desktopRoot, ui), style: resolve(desktopRoot, style) },
    platform: "browser",
    target: "es2023",
    bundle: true,
    metafile: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    ...options,
  });
}

// Include license texts for the packages actually linked into the renderer, including Markdown plugins.
export async function rendererLicenses(metafile) {
  const packages = new Set(
    Object.keys(metafile.inputs)
      .map((path) => path.match(/^(.*(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1])
      .filter(Boolean),
  );
  const licenses = [];
  for (const path of [...packages].sort()) {
    const pkg = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"));
    const names = (await readdir(path)).filter((name) =>
      /^(?:license|licence|copying|notice)(?:$|[.-])/i.test(name),
    );
    // The 2.3.8 npm tarball omits its upstream MIT license.
    if (!names.length && pkg.name === "react-remove-scroll-bar" && pkg.version === "2.3.8") {
      const license = await readFile(
        new URL("../licenses/react-remove-scroll-bar.LICENSE", import.meta.url),
        "utf8",
      );
      licenses.push(`${pkg.name} ${pkg.version} — LICENSE\n${license}`);
      continue;
    }
    if (!names.length) throw Error(`Missing bundled license text for ${pkg.name}`);
    for (const name of names)
      licenses.push(
        `${pkg.name} ${pkg.version} — ${name}\n${await readFile(resolve(path, name), "utf8")}`,
      );
  }
  return licenses.join("\n\n");
}
