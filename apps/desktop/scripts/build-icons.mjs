import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const master = fileURLToPath(import.meta.resolve("@aut/characters/aut.svg"));
const stage = await mkdtemp(join(tmpdir(), "aut-icons-"));
const iconset = join(stage, "aut.iconset");
const plate = `M512 100
  C688 100 780 100 835 139 C855 153 871 169 885 189 C924 244 924 336 924 512
  C924 688 924 780 885 835 C871 855 855 871 835 885 C780 924 688 924 512 924
  C336 924 244 924 189 885 C169 871 153 855 139 835 C100 780 100 688 100 512
  C100 336 100 244 139 189 C153 169 169 153 189 139 C244 100 336 100 512 100Z`;

function iconSvg(compact) {
  const id = compact ? "aut-wink-small" : "aut-wink";
  // Quartz drops nested SVG use references. Embed the selected master path directly.
  const mark = execFileSync("xmllint", ["--xpath", `//*[@id='${id}']`, master], {
    encoding: "utf8",
  });
  const transform = compact ? "translate(237 136) scale(6.45)" : "translate(260 170) scale(5.84)";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs>
      <path id="tile" d="${plate}"/>
      <linearGradient id="porcelain" x2=".2" y2="1">
        <stop stop-color="#fffcf5"/><stop offset=".6" stop-color="#f6f1e7"/><stop offset="1" stop-color="#e9e2d5"/>
      </linearGradient>
    </defs>
    <use xlink:href="#tile" transform="translate(0 8)" fill="#25231f" opacity=".16"/>
    <use xlink:href="#tile" fill="url(#porcelain)" stroke="#d5cec1" stroke-width="4"/>
    <g transform="${transform}" fill="#25231f">${mark}</g>
  </svg>`;
}

try {
  await mkdir(iconset);
  for (const variant of ["regular", "compact"]) {
    const svg = join(stage, `${variant}.svg`);
    await writeFile(svg, iconSvg(variant === "compact"));
    execFileSync("sips", ["-s", "format", "png", svg, "--out", join(stage, `${variant}.png`)]);
  }
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(points * scale);
      const file = `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`;
      const source = join(stage, points <= 32 ? "compact.png" : "regular.png");
      execFileSync("sips", ["-z", pixels, pixels, source, "--out", join(iconset, file)]);
    }
  }
  const icns = join(stage, "aut.icns");
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
  await copyFile(icns, join(assets, "aut.icns"));
  await copyFile(join(iconset, "icon_512x512@2x.png"), join(assets, "aut-icon.png"));
} finally {
  await rm(stage, { recursive: true, force: true });
}
