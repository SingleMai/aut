import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterError, BotId, JsonValue, type StartSessionInput, TaskId } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Either, Queue, Schema, Stream, Take } from "effect";
import { describe, expect } from "vitest";
import { makeClaudeAdapter } from "./session.js";
import type {
  ClaudeProcessOptions,
  ClaudeTransportFactory,
  ClaudeTransportNotice,
} from "./transport.js";

const fakeCli = fileURLToPath(
  new URL("../../../../spikes/claude/fake-claude-cli.ts", import.meta.url),
);
const input: StartSessionInput = {
  taskId: TaskId.make("claude-adapter-test"),
  bot: {
    id: BotId.make("claude-test-bot"),
    name: "Claude test",
    description: "Protocol fixture",
    soul: "",
    modelSelection: { instanceId: "claude-fixture", model: "claude-test" },
    cwd: "/tmp",
  },
  model: "claude-test",
  cwd: "/tmp",
  instructions: "You are a test worker.",
  mcpServers: [],
};

const fixtureAdapter = (mode = "stream") =>
  makeClaudeAdapter({
    command: fakeCli,
    args: [],
    env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_REPLY_FILE: "/tmp/aut-claude-fixture-reply.txt" },
  });

describe("Claude adapter", () => {
  writeFileSync("/tmp/aut-claude-fixture-reply.txt", "fixture reply\n");

  it.scopedLive("disables native memory on start, resume and fork despite instance overrides", () =>
    Effect.gen(function* () {
      const probe = yield* Schema.decodeUnknown(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            name: Schema.optional(Schema.String),
            scenario: Schema.optional(Schema.String),
            env: Schema.optional(Schema.Struct({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: Schema.String })),
            assertions: Schema.optional(
              Schema.Struct({
                projectLoaded: Schema.Boolean,
                memoryAbsent: Schema.Boolean,
                passed: Schema.Boolean,
              }),
            ),
          }),
        ),
      )(
        readFileSync(
          new URL(
            "../../../../spikes/claude/fixtures/native-memory-2.1.330.jsonl",
            import.meta.url,
          ),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
      );
      const recordedOverride = probe.find(
        (row) => row.type === "scenario" && row.name === "env-forced-off",
      )?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
      expect(recordedOverride).toBe("1");
      expect(
        probe.find((row) => row.type === "result" && row.scenario === "env-forced-off")?.assertions,
      ).toEqual({ projectLoaded: true, memoryAbsent: true, passed: true });

      const launches: ClaudeProcessOptions[] = [];
      const factory: ClaudeTransportFactory = {
        open: (options) =>
          Effect.gen(function* () {
            launches.push(options);
            const notices = yield* Queue.unbounded<ClaudeTransportNotice>();
            return { notices, send: () => Effect.void, stop: Effect.void };
          }),
      };
      const adapter = makeClaudeAdapter(
        {
          args: [
            "--settings",
            JSON.stringify({
              autoMemoryEnabled: true,
              env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", AUT_SETTINGS_ENV: "kept" },
              hooks: { Stop: [] },
            }),
          ],
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", AUT_TEST_ENV: "preserved" },
        },
        factory,
      );
      const first = yield* adapter.startSession(input);
      yield* adapter.resumeSession(first.cursor, input);
      yield* first.fork();

      expect(launches).toHaveLength(3);
      expect(launches[0]?.args).toContain("--session-id");
      expect(launches[1]?.args).toContain("--resume");
      expect(launches[2]?.args).toContain("--fork-session");
      for (const launch of launches) {
        expect(launch.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe(recordedOverride);
        expect(launch.env?.AUT_TEST_ENV).toBe("preserved");
        expect(launch.cwd).toBe(input.cwd);
        expect(launch.args[launch.args.indexOf("--model") + 1]).toBe(input.model);
        expect(launch.args.filter((arg) => arg === "--settings")).toHaveLength(1);
        const path = launch.args[launch.args.indexOf("--settings") + 1] as string;
        const settings = yield* Schema.decodeUnknown(Schema.parseJson(JsonValue))(
          readFileSync(path, "utf8"),
        );
        expect(settings).toEqual({
          autoMemoryEnabled: false,
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", AUT_SETTINGS_ENV: "kept" },
          hooks: { Stop: [] },
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    }),
  );

  it.scopedLive("preserves the last settings file and resolves its path from the session cwd", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "aut-claude-settings-test-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const source = JSON.stringify({
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", AUT_SETTINGS_PROVIDER: "unchanged" },
        permissions: { allow: ["Read"] },
      });
      writeFileSync(join(directory, "instance.json"), source);
      let launch: ClaudeProcessOptions | undefined;
      const factory: ClaudeTransportFactory = {
        open: (options) =>
          Effect.gen(function* () {
            launch = options;
            const notices = yield* Queue.unbounded<ClaudeTransportNotice>();
            return { notices, send: () => Effect.void, stop: Effect.void };
          }),
      };
      const adapter = makeClaudeAdapter(
        { args: ["--settings", '{"discarded":true}', "--settings=instance.json"] },
        factory,
      );
      yield* adapter.startSession({ ...input, cwd: directory });
      expect(launch).toBeDefined();
      const args = launch?.args ?? [];
      expect(args.some((arg) => arg.startsWith("--settings="))).toBe(false);
      const settings = yield* Schema.decodeUnknown(Schema.parseJson(JsonValue))(
        readFileSync(args[args.indexOf("--settings") + 1] as string, "utf8"),
      );
      expect(settings).toEqual({
        autoMemoryEnabled: false,
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", AUT_SETTINGS_PROVIDER: "unchanged" },
        permissions: { allow: ["Read"] },
      });
      expect(readFileSync(join(directory, "instance.json"), "utf8")).toBe(source);
    }),
  );

  it.scopedLive(
    "rejects invalid settings without exposing contents and cleans up failed starts",
    () =>
      Effect.gen(function* () {
        const directory = mkdtempSync(join(tmpdir(), "aut-claude-invalid-settings-test-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
        );
        const invalidJson = '{"private":"AUT_SETTINGS_SECRET","broken":';
        writeFileSync(join(directory, "invalid.json"), invalidJson);
        let launch: ClaudeProcessOptions | undefined;
        const factory: ClaudeTransportFactory = {
          open: (options) => {
            launch = options;
            return Effect.fail(
              new AdapterError({ code: "TransportError", message: "Fixture failure" }),
            );
          },
        };
        for (const [args, message] of [
          [[`--settings=${invalidJson}`], "Invalid Claude settings JSON object"],
          [["--settings", "invalid.json"], "Invalid Claude settings JSON object"],
          [["--settings=missing.json"], "Unable to read Claude settings"],
        ] as const) {
          const invalid = yield* makeClaudeAdapter({ args }, factory)
            .startSession({ ...input, cwd: directory })
            .pipe(Effect.either);
          expect(Either.isLeft(invalid)).toBe(true);
          if (Either.isLeft(invalid)) expect(invalid.left.message).toBe(message);
        }
        expect(launch).toBeUndefined();

        const failed = yield* makeClaudeAdapter({}, factory)
          .startSession(input)
          .pipe(Effect.either);
        expect(Either.isLeft(failed)).toBe(true);
        expect(launch).toBeDefined();
        const args = launch?.args ?? [];
        const config = args[args.indexOf("--mcp-config") + 1] as string;
        expect(existsSync(dirname(config))).toBe(false);
      }),
  );

  it.scopedLive("maps stream-json turns to aut events and transcript entries", () =>
    Effect.gen(function* () {
      const session = yield* fixtureAdapter().startSession(input);
      const events = yield* Stream.toQueue(session.events);
      yield* Effect.yieldNow();
      yield* session.startTurn({ text: "Say hello", messageIds: [] });
      const received: string[] = [];
      let completed = false;
      while (!completed) {
        const chunk = yield* Take.done(yield* Queue.take(events));
        for (const event of chunk) {
          received.push(event.kind);
          completed = completed || event.kind === "turn.completed";
        }
      }
      expect(received).toContain("turn.started");
      expect(received).toContain("cursor.updated");
      expect(received).toContain("message.delta");
      expect(received).toContain("turn.completed");
      expect((yield* session.transcript()).some((entry) => entry.role === "user")).toBe(true);
      expect((yield* session.transcript()).some((entry) => entry.role === "assistant")).toBe(true);
    }),
  );

  it.scopedLive("keeps the cursor kind stable across a resume", () =>
    Effect.gen(function* () {
      const adapter = fixtureAdapter("happy");
      const first = yield* adapter.startSession(input);
      expect(first.cursor.kind).toBe("claude");
      const firstEvents = yield* Stream.toQueue(first.events);
      yield* Effect.yieldNow();
      yield* first.startTurn({ text: "first", messageIds: [] });
      while (
        ![...(yield* Take.done(yield* Queue.take(firstEvents)))].some(
          (event) => event.kind === "turn.completed",
        )
      ) {}
      const resumed = yield* adapter.resumeSession(first.cursor, input);
      expect(resumed.cursor.kind).toBe("claude");
      yield* resumed.interrupt();
    }),
  );
});

for (const speed of [undefined, "default", "fast"]) {
  it.scopedLive(
    `applies ${speed ?? "inherited"} Claude speed to temporary settings on start, resume and fork`,
    () =>
      Effect.gen(function* () {
        const settings: unknown[] = [];
        const factory: ClaudeTransportFactory = {
          open: (options) =>
            Effect.gen(function* () {
              settings.push(
                JSON.parse(
                  readFileSync(
                    options.args[options.args.indexOf("--settings") + 1] as string,
                    "utf8",
                  ),
                ),
              );
              expect(options.args[options.args.indexOf("--effort") + 1]).toBe("high");
              const notices = yield* Queue.unbounded<ClaudeTransportNotice>();
              return { notices, send: () => Effect.void, stop: Effect.void };
            }),
        };
        const adapter = makeClaudeAdapter(
          { args: ["--settings", '{"fastMode":true,"model":"kept"}'] },
          factory,
        );
        const selected = { ...input, effort: "high", ...(speed ? { speed } : {}) };
        const session = yield* adapter.startSession(selected);
        yield* adapter.resumeSession(session.cursor, selected);
        yield* session.fork();
        expect(settings).toHaveLength(3);
        for (const value of settings)
          expect(value).toMatchObject({
            model: "kept",
            fastMode: speed !== "default",
            autoMemoryEnabled: false,
          });
      }),
  );
}
