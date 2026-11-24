import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { FILE_MAX_BYTES, MessageId } from "@aut/protocol";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, expect, it } from "vitest";
import { CoreLive } from "./index.js";
import { MessageFiles, reportFileTargets } from "./message-files.js";
import { Store } from "./store.js";

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "aut-files-"));
  directories.push(directory);
  const cwd = join(directory, "work");
  mkdirSync(cwd);
  const dataDirectory = join(directory, "data");
  const run = <A, E>(effect: Effect.Effect<A, E, MessageFiles | Store>) =>
    Effect.runPromise(effect.pipe(Effect.provide(CoreLive({ dataDirectory }))));
  return { directory, cwd, dataDirectory, run };
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("collects only expired unused drafts, preserves references and reports across restart, and renews active drafts", async () => {
  const { run, cwd, dataDirectory } = fixture();
  const uploads = await run(
    Effect.flatMap(MessageFiles, (files) =>
      Effect.forEach(
        ["unused", "referenced", "active", "corruptLease", "corruptMetadata"],
        (name) => files.upload({ name, base64: "YQ==" }),
      ),
    ),
  );
  const [unused, referenced, active, corruptLease, corruptMetadata] = uploads;
  if (!unused || !referenced || !active || !corruptLease || !corruptMetadata)
    throw new Error("Missing uploads");
  for (const file of uploads)
    writeFileSync(join(dirname(file.path), "draft.json"), JSON.stringify({ expiresAt: 0 }));
  writeFileSync(join(dirname(corruptLease.path), "draft.json"), "invalid lease");
  const invalidMetadataPath = join(dirname(corruptMetadata.path), "metadata.json");
  chmodSync(invalidMetadataPath, 0o600);
  writeFileSync(invalidMetadataPath, "invalid metadata");
  await run(
    Effect.flatMap(Store, (store) =>
      store.transaction((tx) =>
        tx.insert("main_thread_messages", {
          id: MessageId.make("saved"),
          author: "user",
          at: 1,
          kind: "text",
          text: "Keep",
          files: [referenced],
        }),
      ),
    ),
  );
  writeFileSync(join(cwd, "output.txt"), "output");
  const report = await run(
    Effect.flatMap(MessageFiles, (files) =>
      files.captureReport("[output](output.txt)", cwd, "report"),
    ),
  );
  await run(Effect.flatMap(MessageFiles, (files) => files.renew([active.id])));
  const abandoned = join(dataDirectory, "files", ".upload-00000000-0000-0000-0000-000000000000");
  mkdirSync(abandoned);
  utimesSync(abandoned, 0, 0);
  expect(await run(Effect.flatMap(MessageFiles, (files) => files.collect))).toEqual({ removed: 2 });
  expect(existsSync(unused.path)).toBe(false);
  expect(existsSync(referenced.path)).toBe(true);
  expect(existsSync(active.path)).toBe(true);
  expect(existsSync(corruptLease.path)).toBe(true);
  expect(existsSync(corruptMetadata.path)).toBe(true);
  const output = report.files?.[0];
  if (!output) throw new Error("Missing report");
  expect(await run(Effect.flatMap(MessageFiles, (files) => files.discard(output.id)))).toBe(false);
  expect(await run(Effect.flatMap(MessageFiles, (files) => files.discard(referenced.id)))).toBe(
    false,
  );
  expect(await run(Effect.flatMap(MessageFiles, (files) => files.discard(active.id)))).toBe(true);
  expect(await run(Effect.flatMap(MessageFiles, (files) => files.discard(active.id)))).toBe(false);
});

it("serializes removal with message attachment commits so a sent file cannot disappear", async () => {
  const { run } = fixture();
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* MessageFiles;
        const store = yield* Store;
        const file = yield* files.upload({ name: "race.txt", base64: "YQ==" });
        const entered = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const send = yield* files
          .withFiles([file.id], (attachments) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(commit);
              yield* store.transaction((tx) =>
                tx.insert("main_thread_messages", {
                  id: MessageId.make("race"),
                  author: "user",
                  at: 1,
                  kind: "text",
                  text: "Keep",
                  files: attachments,
                }),
              );
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const removal = yield* files.discard(file.id).pipe(Effect.forkScoped);
        yield* Effect.yieldNow();
        expect((yield* Fiber.poll(removal))._tag).toBe("None");
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(send);
        expect(yield* Fiber.join(removal)).toBe(false);
        expect((yield* files.read(file.id)).base64).toBe("YQ==");
      }),
    ),
  );
});

it("extracts only rendered local files including reference links and images", () => {
  expect(
    reportFileTargets(
      "[a](./a.csv) ![b](b.png) [c][source]\n\n[source]: file:///tmp/c.pdf\n\n`[bad](secret)`\n\n```\n[x](hidden)\n```\n\n[remote](https://example.com) [anchor](#foo) [network](//host/a)\n",
    ),
  ).toEqual(["./a.csv", "b.png", "file:///tmp/c.pdf"]);
});
it("uploads same-named files as separate durable snapshots and rejects tampering", async () => {
  const { run } = fixture();
  const first = await run(
    Effect.flatMap(MessageFiles, (files) =>
      files.upload({ name: "../../收入.csv", base64: Buffer.from("first").toString("base64") }),
    ),
  );
  const second = await run(
    Effect.flatMap(MessageFiles, (files) =>
      files.upload({ name: "收入.csv", base64: Buffer.from("second").toString("base64") }),
    ),
  );
  expect(first.name).toBe("收入.csv");
  expect(first.id).not.toBe(second.id);
  expect(
    Buffer.from(
      (await run(Effect.flatMap(MessageFiles, (files) => files.read(first.id)))).base64,
      "base64",
    ).toString(),
  ).toBe("first");
  chmodSync(first.path, 0o600);
  writeFileSync(first.path, "altered");
  const result = await run(
    Effect.flatMap(MessageFiles, (files) => files.read(first.id)).pipe(Effect.either),
  );
  expect(result._tag).toBe("Left");
  const invalid = await run(
    Effect.flatMap(MessageFiles, (files) => files.get("../secrets.json")).pipe(Effect.either),
  );
  expect(invalid._tag).toBe("Left");
});
it("keeps report versions immutable across edits, source deletion, retry and service restart", async () => {
  const { run, cwd } = fixture();
  const source = join(cwd, "report with spaces.md");
  writeFileSync(source, "version one");
  const report = `[Report](${pathToFileURL(source).href})`;
  const first = await run(
    Effect.flatMap(MessageFiles, (files) => files.captureReport(report, cwd, "event-1")),
  );
  const file1 = first.files?.[0];
  expect(file1).toBeDefined();
  writeFileSync(source, "version two");
  const second = await run(
    Effect.flatMap(MessageFiles, (files) => files.captureReport(report, cwd, "event-2")),
  );
  expect(second.files?.[0]?.id).not.toBe(file1?.id);
  rmSync(source);
  const retry = await run(
    Effect.flatMap(MessageFiles, (files) => files.captureReport(report, cwd, "event-1")),
  );
  expect(retry).toEqual(first);
  expect(readFileSync(file1?.path ?? "", "utf8")).toBe("version one");
  expect(readFileSync(second.files?.[0]?.path ?? "", "utf8")).toBe("version two");
});
it("rejects missing, oversized, hidden, directory and symlink escape targets without losing valid files", async () => {
  const { run, cwd, directory } = fixture();
  writeFileSync(join(directory, "outside.txt"), "secret");
  symlinkSync(join(directory, "outside.txt"), join(cwd, "escape.txt"));
  writeFileSync(join(cwd, ".env"), "secret");
  writeFileSync(join(cwd, "ok.txt"), "safe");
  writeFileSync(join(cwd, "large.txt"), Buffer.alloc(FILE_MAX_BYTES + 1));
  mkdirSync(join(cwd, "folder"));
  const targets = [
    "escape.txt",
    "../outside.txt",
    ".env",
    "missing.txt",
    "large.txt",
    "folder",
    "ok.txt",
  ];
  const result = await run(
    Effect.flatMap(MessageFiles, (files) =>
      files.captureReport(targets.map((path) => `[file](${path})`).join("\n"), cwd, "event"),
    ),
  );
  expect(result.files?.map((file) => file.name)).toEqual(["ok.txt"]);
  expect(result.fileIssues).toHaveLength(6);
});
it("rejects noncanonical upload encoding and keeps zero-byte files", async () => {
  const { run } = fixture();
  for (const base64 of ["a", "a===", "YWJj\n", "Zh=="]) {
    expect(
      (
        await run(
          Effect.flatMap(MessageFiles, (files) => files.upload({ name: "x", base64 })).pipe(
            Effect.either,
          ),
        )
      )._tag,
    ).toBe("Left");
  }
  const empty = await run(
    Effect.flatMap(MessageFiles, (files) => files.upload({ name: "empty.txt", base64: "" })),
  );
  expect(empty.size).toBe(0);
});
