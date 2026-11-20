import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { HttpServer } from "./http.js";
import { DaemonApiLive } from "./index.js";
import { SecretReader, SecretReaderLive } from "./secret-reader.js";
import { SecretStore, SecretStoreLive } from "./secret-store.js";

const directories: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "aut-secret-test-"));
  directories.push(path);
  return path;
};
const run = <A, E>(path: string, work: Effect.Effect<A, E, SecretStore | SecretReader>) =>
  Effect.runPromise(
    work.pipe(
      Effect.provide(
        SecretReaderLive.pipe(Layer.provideMerge(SecretStoreLive({ dataDirectory: path }))),
      ),
    ),
  );

it("atomically saves and replaces keys in a private file while retaining concurrent independent entries", async () => {
  const path = directory();
  chmodSync(path, 0o755);
  await run(
    path,
    Effect.gen(function* () {
      const store = yield* SecretStore;
      expect(yield* store.status("secret:primary")).toEqual({
        apiKeyRef: "secret:primary",
        configured: false,
      });
      yield* Effect.all(
        [
          store.save("primary", Redacted.make("first-fixture")),
          store.save("fallback", Redacted.make("fallback-fixture")),
        ],
        { concurrency: "unbounded" },
      );
      const inode = statSync(join(path, "secrets.json")).ino;
      expect(yield* store.save("primary", Redacted.make("replacement-fixture"))).toEqual({
        apiKeyRef: "secret:primary",
        configured: true,
      });
      expect(statSync(join(path, "secrets.json")).ino).not.toBe(inode);
      expect(Redacted.value(yield* store.resolve("secret:primary"))).toBe("replacement-fixture");
      expect(Redacted.value(yield* store.resolve("secret:fallback"))).toBe("fallback-fixture");
      expect(String(yield* store.resolve("secret:primary"))).not.toContain("replacement-fixture");
    }),
  );
  expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(join(path, "secrets.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(path)).toEqual(["secrets.json"]);
});

it.each([
  '{"schemaVersion":1,"entries":[{"name":"primary","key":"private-fixture"}],"unknown":"secret"}',
  '{"schemaVersion":1,"entries":[{"name":"primary","key":"private-fixture"},{"name":"primary","key":"other"}]}',
  '{"schemaVersion":2,"entries":[]}',
  '{"broken":"private-fixture"',
])("preserves invalid store bytes and sanitizes decode errors", async (bytes) => {
  const path = directory();
  writeFileSync(join(path, "secrets.json"), bytes);
  const failure = await run(
    path,
    Effect.either(
      Effect.gen(function* () {
        yield* (yield* SecretStore).save("primary", Redacted.make("replacement-fixture"));
      }),
    ),
  );
  expect(failure._tag).toBe("Left");
  expect(JSON.stringify(failure)).not.toContain("private-fixture");
  expect(JSON.stringify(failure)).not.toContain("replacement-fixture");
  expect(readFileSync(join(path, "secrets.json"), "utf8")).toBe(bytes);
});

it("rejects symlink directories, symlink files and non-regular files without modifying targets", async () => {
  const path = directory();
  const target = join(path, "target");
  mkdirSync(target, { mode: 0o755 });
  const targetFile = join(target, "secrets.json");
  const bytes = '{"schemaVersion":1,"entries":[]}';
  writeFileSync(targetFile, bytes, { mode: 0o644 });
  const linked = join(path, "linked");
  symlinkSync(target, linked);
  const save = Effect.gen(function* () {
    yield* (yield* SecretStore).save("primary", Redacted.make("private-fixture"));
  });
  expect((await run(linked, Effect.either(save)))._tag).toBe("Left");
  expect(statSync(target).mode & 0o777).toBe(0o755);
  const linkedFileDirectory = join(path, "file-link");
  mkdirSync(linkedFileDirectory);
  symlinkSync(targetFile, join(linkedFileDirectory, "secrets.json"));
  expect((await run(linkedFileDirectory, Effect.either(save)))._tag).toBe("Left");
  expect(readFileSync(targetFile, "utf8")).toBe(bytes);
  expect(statSync(targetFile).mode & 0o777).toBe(0o644);
  const nonregular = join(path, "nonregular");
  mkdirSync(join(nonregular, "secrets.json"), { recursive: true });
  expect((await run(nonregular, Effect.either(save)))._tag).toBe("Left");
});

it("rejects a save that would make its own store unreadable and preserves the previous file", async () => {
  const path = directory();
  const contents = JSON.stringify({
    schemaVersion: 1,
    entries: Array.from({ length: 63 }, (_, index) => ({
      name: `key${index}`,
      key: "z".repeat(16384),
    })),
  });
  writeFileSync(join(path, "secrets.json"), contents);
  await run(
    path,
    Effect.gen(function* () {
      const store = yield* SecretStore;
      expect(
        (yield* Effect.either(store.save("overflow", Redacted.make("z".repeat(16384)))))._tag,
      ).toBe("Left");
      expect(yield* store.status("secret:key0")).toEqual({
        apiKeyRef: "secret:key0",
        configured: true,
      });
    }),
  );
  expect(readFileSync(join(path, "secrets.json"), "utf8")).toBe(contents);
});

it("resolves explicit environment references without changing them or the public configuration", async () => {
  const path = directory();
  const name = "AUT_SECRET_TEST_ONLY";
  const before = process.env[name];
  process.env[name] = "environment-fixture";
  try {
    await run(
      path,
      Effect.gen(function* () {
        const reader = yield* SecretReader;
        expect(Redacted.value(yield* reader.resolve(`env:${name}`))).toBe("environment-fixture");
        expect(Redacted.value(yield* reader.resolve(name))).toBe("environment-fixture");
        yield* (yield* SecretStore).save("primary", Redacted.make("file-fixture"));
        expect(Redacted.value(yield* reader.resolve("secret:primary"))).toBe("file-fixture");
        expect(process.env[name]).toBe("environment-fixture");
        expect((yield* Effect.either(reader.resolve("env:missing-name")))._tag).toBe("Left");
      }),
    );
    expect(readdirSync(path)).toEqual(["secrets.json"]);
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

it("exposes authenticated save and status without a key readback route or secret error details", async () => {
  const path = directory();
  const scope = await Effect.runPromise(Scope.make());
  closes.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const context = await Effect.runPromise(
    Layer.buildWithScope(DaemonApiLive({ dataDirectory: path, port: 0 }), scope),
  );
  const server = Context.get(context, HttpServer);
  const token = readFileSync(join(path, "daemon-token"), "utf8");
  const base = `http://${server.host}:${server.port}`;
  const request = (route: string, method = "GET", body?: unknown) =>
    fetch(base + route, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const secret = "private-http-fixture";
  expect((await fetch(`${base}/v1/secrets/status?ref=secret:primary`)).status).toBe(401);
  const saved = await request("/v1/secrets", "POST", { name: "primary", key: secret });
  expect(await saved.json()).toEqual({ apiKeyRef: "secret:primary", configured: true });
  expect(await (await request("/v1/secrets/status?ref=secret:primary")).json()).toEqual({
    apiKeyRef: "secret:primary",
    configured: true,
  });
  expect(await (await request("/v1/secrets/status?ref=secret:missing")).json()).toEqual({
    apiKeyRef: "secret:missing",
    configured: false,
  });
  expect((await request("/v1/secrets")).status).toBe(404);
  expect((await request("/v1/secrets/primary")).status).toBe(404);
  const invalid = await request("/v1/secrets", "POST", { name: "../escape", key: secret });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain(secret);
  expect((await request("/v1/secrets/status?ref=secret:primary&ref=secret:missing")).status).toBe(
    400,
  );
  expect(await (await request("/v1/config")).text()).not.toContain(secret);
  expect(await (await request("/v1/messages")).text()).not.toContain(secret);
});
