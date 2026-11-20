import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("ships the renderer with one stylesheet and resolves both local font families", async () => {
  const output = await mkdtemp(join(tmpdir(), "aut-desktop-css-"));
  try {
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./build.mjs", import.meta.url)),
      output,
    ]);
    const html = await readFile(join(output, "index.html"), "utf8");
    expect(html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g)).toEqual([
      '<link rel="stylesheet" href="style.css">',
    ]);
    expect((await readdir(output)).filter((file) => file.endsWith(".css"))).toEqual(["style.css"]);
    const css = await readFile(join(output, "style.css"), "utf8");
    const fonts = [...css.matchAll(/url\(["']?\.\/fonts\/([^"')]+\.woff2)["']?\)/g)].map(
      (match) => match[1],
    );
    expect(fonts).toContain("geist-latin-wght-normal.woff2");
    expect(fonts).toContain("geist-mono-latin-wght-normal.woff2");
    expect(fonts.sort()).toEqual((await readdir(join(output, "fonts"))).sort());
    expect(css).toMatch(/\.tool-activity\[open\]\s*\{\s*width:\s*min\(608px, 100%\)/);
    expect(css).toContain("-webkit-line-clamp: 4");
    expect(css).not.toContain("@import");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
