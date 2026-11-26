import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? resolve(root, "dist/native"));
const architecture = process.argv[3] ?? process.arch;
if (!["arm64", "x64"].includes(architecture) || process.platform !== "darwin")
  throw new Error("Build the macOS companion on macOS for arm64 or x64.");
await mkdir(output, { recursive: true });
const env = {
  ...process.env,
  GOOS: "darwin",
  GOARCH: architecture === "x64" ? "amd64" : "arm64",
  CGO_ENABLED: "0",
};
execFileSync(
  "go",
  ["build", "-trimpath", "-ldflags=-s -w", "-o", resolve(output, "aut-transport"), "."],
  { cwd: resolve(root, "native"), env, stdio: "inherit" },
);
execFileSync("codesign", ["--force", "--sign", "-", resolve(output, "aut-transport")], {
  stdio: "inherit",
});
const modules = execFileSync(
  "go",
  [
    "list",
    "-deps",
    "-f",
    "{{if .Module}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}",
    ".",
  ],
  { cwd: resolve(root, "native"), env, encoding: "utf8" },
);
const entries = [];
for (const row of [...new Set(modules.trim().split("\n"))].filter(Boolean)) {
  const [name, version, directory] = row.split("\t");
  if (name === "aut.local/transport") continue;
  const files = (await readdir(directory, { withFileTypes: true })).filter(
    (file) =>
      file.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT|AUTHORS)/i.test(file.name),
  );
  if (!files.some((file) => /^(LICENSE|LICENCE|COPYING)/i.test(file.name)))
    throw new Error(`Missing license: ${name}`);
  const target = resolve(output, "licenses", `${name}@${version}`.replace(/[^a-zA-Z0-9._-]/g, "_"));
  await mkdir(target, { recursive: true });
  for (const file of files)
    await copyFile(resolve(directory, file.name), resolve(target, file.name));
  entries.push({ name, version });
}
const goroot = execFileSync("go", ["env", "GOROOT"], {
  cwd: resolve(root, "native"),
  env,
  encoding: "utf8",
}).trim();
await copyFile(resolve(goroot, "LICENSE"), resolve(output, "licenses/Go.LICENSE"));
await writeFile(resolve(output, "dependencies.json"), `${JSON.stringify(entries, null, 2)}\n`);
console.log("Remote transport companion is ready.");
