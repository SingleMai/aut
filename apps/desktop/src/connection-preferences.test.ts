import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { safeStorage } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionPreferences, ConnectionPreferencesLive } from "./connection-preferences.js";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value.split("").reverse().join(""))),
    decryptString: vi.fn((value: Buffer) => value.toString().split("").reverse().join("")),
  },
}));
const paths: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "aut-target-"));
  paths.push(directory);
  return { directory, layer: ConnectionPreferencesLive(directory) };
};
const profile = {
  version: 1 as const,
  hostId: "host",
  nodeId: "node",
  name: "Pro",
  token: "a".repeat(64),
};
it("persists only OS-encrypted connection data and can switch back to local", async () => {
  const test = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ConnectionPreferences;
      expect(service.remote).toBeUndefined();
      yield* service.save(profile);
    }).pipe(Effect.provide(test.layer)),
  );
  const path = join(test.directory, "execution-target.json");
  expect(readFileSync(path, "utf8")).not.toContain(profile.token);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ConnectionPreferences;
      expect(service.remote).toEqual(profile);
      yield* service.save(undefined);
    }).pipe(Effect.provide(test.layer)),
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, mode: "local" });
});
it("refuses plaintext fallback or corrupt preferences", async () => {
  const test = fixture();
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
  const save = await Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        yield* (yield* ConnectionPreferences).save(profile);
      }).pipe(Effect.provide(test.layer)),
    ),
  );
  expect(save._tag).toBe("Left");
  writeFileSync(
    join(test.directory, "execution-target.json"),
    '{"mode":"remote","token":"plaintext"}',
  );
  expect(
    (await Effect.runPromise(Effect.either(ConnectionPreferences.pipe(Effect.provide(test.layer)))))
      ._tag,
  ).toBe("Left");
});
