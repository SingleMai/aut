import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutConfig, BotConfig, MessageId } from "@aut/protocol";
import { Effect, Either, Exit, Layer, Queue, Schema, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChangesLive } from "./changes.js";
import { ConfigStore, ConfigStoreLive } from "./config-store.js";
import { EventBus, EventBusLive } from "./event-bus.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "aut-config-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const run = <A, E>(effect: Effect.Effect<A, E, ConfigStore>, dataDirectory: string) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(ConfigStoreLive({ dataDirectory }).pipe(Layer.provide(ChangesLive))),
      ),
    ),
  );

const config = Schema.decodeUnknownSync(AutConfig)({
  harnessInstances: [
    {
      id: "local",
      name: "Existing provider",
      kind: "codex",
      command: "/custom/bin/codex",
      args: ["app-server"],
      env: { CUSTOM_PROVIDER: "keep" },
    },
  ],
  classifier: {
    primary: {
      backend: "jev",
      model: "jev-1.13.0",
      endpoint: "https://api.example.com",
      apiKeyRef: "env:JEV_KEY",
    },
  },
});
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "bot-1",
  name: "Research",
  description: "Research tasks",
  soul: "Keep exact instructions\n第二行",
  modelSelection: { instanceId: "local", model: "model-pinned", effort: "high" },
  cwd: "/existing/project",
  mcpServers: [],
});

describe("atomic configuration files", () => {
  it("provides empty first-run configuration without creating account settings", async () => {
    const path = directory();
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConfigStore;
        return [yield* store.readConfig, yield* store.readBots];
      }),
      path,
    );
    expect(result).toEqual([{ harnessInstances: [] }, []]);
    expect(readdirSync(path)).toEqual([]);
  });

  it("round-trips providers, bot workdirs and instructions with private file permissions", async () => {
    const path = directory();
    await run(
      Effect.gen(function* () {
        const store = yield* ConfigStore;
        yield* store.writeConfig(config);
        yield* store.writeBots([bot]);
      }),
      path,
    );
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConfigStore;
        return { config: yield* store.readConfig, bots: yield* store.readBots };
      }),
      path,
    );
    expect(result).toEqual({ config, bots: [bot] });
    expect(statSync(join(path, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "bots.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(path).sort()).toEqual(["bots.json", "config.json"]);
  });

  it("serializes read-modify-write updates without losing configured fields", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConfigStore;
        yield* store.writeConfig(config);
        yield* Effect.all(
          Array.from({ length: 30 }, (_, index) =>
            store.updateConfig((value) => ({
              ...value,
              harnessInstances: [
                ...value.harnessInstances,
                {
                  id: `instance-${index}`,
                  name: "Additional",
                  kind: "codex",
                  command: "codex",
                  args: [],
                },
              ],
            })),
          ),
          { concurrency: "unbounded" },
        );
        return yield* store.readConfig;
      }),
      directory(),
    );
    expect(result.harnessInstances).toHaveLength(31);
    expect(result.harnessInstances[0]).toEqual(config.harnessInstances[0]);
    expect(result.classifier).toEqual(config.classifier);
  });

  it("preserves the original bytes after invalid writes or invalid existing configuration", async () => {
    const path = directory();
    await run(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeConfig(config);
      }),
      path,
    );
    const before = readFileSync(join(path, "config.json"), "utf8");
    const invalid = await run(
      Effect.gen(function* () {
        const store = yield* ConfigStore;
        return yield* Effect.either(
          store.writeConfig({
            ...config,
            harnessInstances: [...config.harnessInstances, ...config.harnessInstances],
          }),
        );
      }),
      path,
    );
    expect(Either.isLeft(invalid) && invalid.left.code).toBe("Configuration");
    expect(readFileSync(join(path, "config.json"), "utf8")).toBe(before);
    const unsupported = '{"harnessInstances":[],"futureSetting":"must survive"}\n';
    writeFileSync(join(path, "config.json"), unsupported);
    const blocked = await run(
      Effect.gen(function* () {
        return yield* Effect.either((yield* ConfigStore).updateConfig((value) => value));
      }),
      path,
    );
    expect(Either.isLeft(blocked) && blocked.left.code).toBe("Configuration");
    expect(readFileSync(join(path, "config.json"), "utf8")).toBe(unsupported);
    expect(readdirSync(path)).toEqual(["config.json"]);
  });

  it("does not silently reset malformed JSON", async () => {
    const path = directory();
    writeFileSync(join(path, "bots.json"), "{bad");
    const result = await run(
      Effect.gen(function* () {
        return yield* Effect.either((yield* ConfigStore).readBots);
      }),
      path,
    );
    expect(Either.isLeft(result) && result.left.code).toBe("Configuration");
    expect(readFileSync(join(path, "bots.json"), "utf8")).toBe("{bad");
  });
});

describe("scoped PubSub event bus", () => {
  it("publishes validated events to subscribers and closes subscriptions with their scope", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* EventBus;
          const subscriptionScope = yield* Scope.make();
          const subscription = yield* Scope.extend(bus.subscribe, subscriptionScope);
          const event = {
            source: "user",
            kind: "message",
            messageId: MessageId.make("m1"),
          } as const;
          yield* bus.publish(event);
          const received = yield* Queue.take(subscription);
          yield* Scope.close(subscriptionScope, Exit.succeed(undefined));
          const shutdown = yield* Queue.isShutdown(subscription);
          return { received, shutdown, expected: event };
        }).pipe(Effect.provide(EventBusLive)),
      ),
    );
    expect(result.received).toEqual(result.expected);
    expect(result.shutdown).toBe(true);
  });

  it("rejects malformed events and shuts down queues when the bus layer closes", async () => {
    const queue = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* EventBus;
          const queue = yield* bus.subscribe;
          const malformed = yield* Effect.either(
            bus.publish({ source: "user", kind: "message", messageId: "" as MessageId }),
          );
          expect(Either.isLeft(malformed) && malformed.left.code).toBe("Validation");
          return queue;
        }).pipe(Effect.provide(EventBusLive)),
      ),
    );
    expect(await Effect.runPromise(Queue.isShutdown(queue))).toBe(true);
  });
});
