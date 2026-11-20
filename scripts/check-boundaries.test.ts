import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBoundaries } from "./check-boundaries.mjs";

const roots: string[] = [];
const workspace = (source: string, dependencies: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "aut-boundaries-"));
  roots.push(root);
  for (const name of ["protocol", "core", "adapters", "daemon"]) {
    const directory = join(root, "packages", name);
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: `@aut/${name}`, dependencies: name === "core" ? dependencies : {} }),
    );
  }
  writeFileSync(join(root, "packages/core/src/index.ts"), source);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace architecture", () => {
  it("accepts protocol and adapter interface dependencies", () => {
    const root = workspace('import "@aut/protocol"; import "@aut/adapters/interface";', {
      "@aut/protocol": "workspace:*",
      "@aut/adapters": "workspace:*",
    });
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("rejects a reverse dependency in the package manifest", () => {
    expect(checkBoundaries(workspace("export {};", { "@aut/daemon": "workspace:*" }))).toContain(
      "@aut/core: forbidden package dependency @aut/daemon",
    );
  });

  it.each([
    'import "@aut/daemon";',
    'export * from "@aut/daemon";',
    'const load = () => import("@aut/daemon");',
    'const daemon = require("@aut/daemon");',
    'type Daemon = import("@aut/daemon");',
  ])("rejects reverse source imports: %s", (source) => {
    expect(
      checkBoundaries(workspace(source)).some((error: string) =>
        error.includes("forbidden import @aut/daemon"),
      ),
    ).toBe(true);
  });

  it("rejects bypasses through relative source paths", () => {
    expect(
      checkBoundaries(workspace('import "../../daemon/src/index.js";')).some((error: string) =>
        error.includes("cross-package path import"),
      ),
    ).toBe(true);
  });

  it("rejects concrete adapter imports from core", () => {
    expect(
      checkBoundaries(
        workspace('import "@aut/adapters/codex";', { "@aut/adapters": "workspace:*" }),
      ).some((error: string) => error.includes("core may only import")),
    ).toBe(true);
  });

  it("allows protocol test tools while keeping runtime and workspace restrictions", () => {
    const root = workspace("export {};");
    const directory = join(root, "packages/protocol/src");
    writeFileSync(
      join(directory, "schema.test.ts"),
      'import "vitest"; import "@effect/vitest"; import "node:assert";',
    );
    expect(checkBoundaries(root)).toEqual([]);
    writeFileSync(join(directory, "index.ts"), 'import "vitest";');
    expect(
      checkBoundaries(root).some((error: string) =>
        error.includes("protocol may only import effect"),
      ),
    ).toBe(true);
    writeFileSync(join(directory, "index.ts"), "export {};");
    writeFileSync(join(directory, "schema.test.ts"), 'import "@aut/core";');
    expect(
      checkBoundaries(root).some((error: string) => error.includes("forbidden import @aut/core")),
    ).toBe(true);
  });
});
