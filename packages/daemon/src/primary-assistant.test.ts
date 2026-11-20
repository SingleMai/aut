import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, CoreError, CoreLive, type Store } from "@aut/core";
import { type BotConfig, BotId, type HarnessInstanceConfig } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schedule, type Scope, TestClock } from "effect";
import { afterEach, expect } from "vitest";
import { Administration, AdministrationLive } from "./admin.js";
import {
  PrimaryAssistantBootstrap,
  PrimaryAssistantBootstrapLive,
  PrimaryAssistantDefaultsProbe,
} from "./primary-assistant.js";

const directories: string[] = [];
const directory = () => {
  const value = mkdtempSync(join(tmpdir(), "aut-system-bots-"));
  directories.push(value);
  return value;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const instance: HarnessInstanceConfig = {
  id: "existing",
  name: "Existing provider",
  kind: "codex",
  command: "existing-codex",
  args: ["--profile", "original"],
  env: { EXISTING_SETTING: "preserved" },
};
const user: BotConfig = {
  id: BotId.make("user-bot"),
  name: "User bot",
  description: "Existing description",
  soul: "Existing instructions",
  modelSelection: { instanceId: instance.id, model: "existing-model", effort: "high" },
  cwd: "/existing/workspace",
  mcpServers: [],
};
const run = <A, E>(effect: Effect.Effect<A, E, ConfigStore | Store | Scope.Scope>, path: string) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(CoreLive({ dataDirectory: path })))));
const probe = (
  read: PrimaryAssistantDefaultsProbe["Type"]["read"] = () =>
    Effect.succeed({
      model: "discovered-model",
      effort: "xhigh",
      provider: "existing-provider",
      source: "configured",
    }),
) =>
  Layer.succeed(PrimaryAssistantDefaultsProbe, {
    supports: (value) => value.kind === "codex",
    read,
  });
const bootstrap = (path: string, backend = probe()) =>
  PrimaryAssistantBootstrapLive({ dataDirectory: path }).pipe(Layer.provide(backend));

it("reuses the configured primary assistant and specialist without probing", async () => {
  const path = directory();
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const bots = [
        user,
        {
          ...user,
          system: "primary" as const,
          id: BotId.make("custom-primary"),
          soul: "User-edited instructions",
          name: "User-edited name",
        },
      ];
      const settings = {
        harnessInstances: [instance],
        classifier: {
          primary: {
            backend: "jev",
            model: "jev-1.14.0",
            endpoint: "https://example.invalid/jev",
            apiKeyRef: "env:EXISTING_JEV_KEY",
          },
        },
      };
      yield* config.writeConfig(settings);
      yield* config.writeBots(bots);
      yield* Effect.gen(function* () {
        expect(yield* (yield* PrimaryAssistantBootstrap).status).toEqual({
          status: "ready",
        });
        expect(yield* (yield* PrimaryAssistantBootstrap).ensure).toEqual({
          status: "ready",
        });
      }).pipe(
        Effect.provide(
          bootstrap(
            path,
            probe(() => Effect.die("Must not probe a configured primary assistant")),
          ),
        ),
      );
      expect(yield* config.readConfig).toEqual(settings);
      expect(yield* config.readBots).toEqual(bots);
      const listed = yield* Effect.flatMap(Administration, (admin) => admin.bots).pipe(
        Effect.provide(AdministrationLive),
      );
      expect(listed).toEqual(bots);
    }),
    path,
  );
});

it("adds one primary assistant, handles ID collisions and copies the existing model/effort/workdir", async () => {
  const path = directory();
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const existing = { ...user, id: BotId.make("aut") };
      yield* config.writeConfig({ harnessInstances: [instance] });
      yield* config.writeBots([existing]);
      yield* Effect.gen(function* () {
        expect((yield* (yield* PrimaryAssistantBootstrap).status).status).toBe("ready");
        expect((yield* (yield* PrimaryAssistantBootstrap).ensure).status).toBe("ready");
      }).pipe(
        Effect.provide(
          bootstrap(
            path,
            probe(() => Effect.die("Must reuse existing selection")),
          ),
        ),
      );
      const bots = yield* config.readBots;
      expect(bots.map((bot) => bot.id)).toEqual(["aut", "aut-2"]);
      expect(bots[0]).toEqual(existing);
      expect(bots.slice(1).map((bot) => bot.modelSelection)).toEqual([user.modelSelection]);
      expect(bots.slice(1).map((bot) => bot.cwd)).toEqual([user.cwd]);
      expect(yield* config.readConfig).toEqual({ harnessInstances: [instance] });
    }),
    path,
  );
});

it("uses only discovered native defaults when creating a fresh aut configuration", async () => {
  const path = directory();
  let calls = 0;
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      yield* Effect.gen(function* () {
        expect((yield* (yield* PrimaryAssistantBootstrap).status).status).toBe("ready");
        yield* (yield* PrimaryAssistantBootstrap).ensure;
      }).pipe(
        Effect.provide(
          bootstrap(
            path,
            probe(({ cwd, instance, timeoutMs }) => {
              calls += 1;
              expect(timeoutMs).toBe(30_000);
              expect(cwd).toBe(join(path, "workspace"));
              expect(instance).toMatchObject({ command: "codex", args: [] });
              expect(instance.env).toBeUndefined();
              return Effect.succeed({
                model: "reported-native-default",
                effort: "xhigh",
                provider: null,
                source: "reported-default",
              });
            }),
          ),
        ),
      );
      expect(calls).toBe(1);
      expect(existsSync(join(path, "workspace"))).toBe(true);
      const settings = yield* config.readConfig;
      expect(settings.harnessInstances).toHaveLength(1);
      expect(settings.harnessInstances[0]?.args).toEqual([]);
      const bots = yield* config.readBots;
      expect(bots).toHaveLength(1);
      expect(bots[0]).toMatchObject({ id: "aut", system: "primary", name: "aut" });
      for (const bot of bots)
        expect(bot.modelSelection).toEqual({
          instanceId: "aut-codex",
          model: "reported-native-default",
          effort: "xhigh",
        });
    }),
    path,
  );
});

it("probes an existing instance without changing its provider arguments or environment", async () => {
  const path = directory();
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      yield* config.writeConfig({ harnessInstances: [instance] });
      yield* Effect.gen(function* () {
        expect((yield* (yield* PrimaryAssistantBootstrap).status).status).toBe("ready");
      }).pipe(
        Effect.provide(
          bootstrap(
            path,
            probe((input) => {
              expect(input.instance).toEqual(instance);
              expect(input.cwd).toBe(process.cwd());
              return Effect.succeed({
                model: "custom-configured-model",
                provider: "unchanged-provider",
                source: "configured",
              });
            }),
          ),
        ),
      );
      expect(yield* config.readConfig).toEqual({ harnessInstances: [instance] });
      expect(
        (yield* config.readBots).every(
          (bot) => bot.modelSelection.model === "custom-configured-model",
        ),
      ).toBe(true);
    }),
    path,
  );
});

it("keeps settings APIs usable after failed discovery and ensures roles after a later user save", async () => {
  const path = directory();
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const services = AdministrationLive.pipe(
        Layer.provideMerge(
          bootstrap(
            path,
            probe(() =>
              Effect.fail(
                new CoreError({ code: "Configuration", message: "Synthetic missing CLI" }),
              ),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const status = yield* PrimaryAssistantBootstrap;
        const admin = yield* Administration;
        expect((yield* status.status).status).toBe("needsConfiguration");
        expect(yield* config.readBots).toEqual([]);
        expect(yield* config.readConfig).toEqual({ harnessInstances: [] });
        yield* admin.setConfig({ harnessInstances: [instance] });
        expect((yield* status.status).status).toBe("needsConfiguration");
        yield* admin.createBot(user);
        yield* status.status.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 millis"),
            until: (value) => value.status === "ready",
          }),
          Effect.timeout("1 second"),
        );
        expect((yield* status.status).status).toBe("ready");
        const bots = yield* admin.bots;
        expect(bots.find((bot) => bot.id === user.id)).toEqual(user);
        expect(bots.filter((bot) => bot.system)).toHaveLength(1);
        const primary = bots.find((bot) => bot.system === "primary");
        if (!primary) return yield* Effect.die("Missing fixture primary assistant");
        expect((yield* admin.deleteBot(primary.id).pipe(Effect.flip)).code).toBe("Conflict");
        const { system: _, ...withoutIdentity } = primary;
        expect((yield* admin.updateBot(primary.id, withoutIdentity).pipe(Effect.flip)).code).toBe(
          "Conflict",
        );
        expect((yield* admin.setConfig({ harnessInstances: [] }).pipe(Effect.flip)).code).toBe(
          "Conflict",
        );
      }).pipe(Effect.provide(services));
    }),
    path,
  );
});

it.effect(
  "returns a successful configuration save before background discovery and interrupts it on Scope close",
  () =>
    Effect.gen(function* () {
      const path = directory();
      const entered = yield* Deferred.make<void>();
      let calls = 0;
      let released = false;
      const services = AdministrationLive.pipe(
        Layer.provideMerge(
          bootstrap(
            path,
            probe(() => {
              calls += 1;
              if (calls === 1)
                return Effect.fail(
                  new CoreError({
                    code: "Configuration",
                    message: "Synthetic initial discovery failure",
                  }),
                );
              return Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    released = true;
                  }),
                ),
              );
            }),
          ),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const admin = yield* Administration;
          const next = { harnessInstances: [instance] };
          expect(yield* admin.setConfig(next)).toEqual(next);
          yield* Deferred.await(entered);
          expect(yield* admin.config).toEqual(next);
          expect(released).toBe(false);
        }).pipe(Effect.provide(services), Effect.provide(CoreLive({ dataDirectory: path }))),
      );
      expect(calls).toBe(2);
      expect(released).toBe(true);
      expect(existsSync(join(path, "bots.json"))).toBe(false);
    }),
);

it.effect(
  "bounds bootstrap discovery and retains needsConfiguration without placeholder bots",
  () =>
    Effect.gen(function* () {
      const path = directory();
      const entered = yield* Deferred.make<void>();
      let released = false;
      const service = PrimaryAssistantBootstrapLive({
        dataDirectory: path,
        probeTimeoutMs: 50,
      }).pipe(
        Layer.provide(
          probe(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
          ),
        ),
      );
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* PrimaryAssistantBootstrap).status;
        }).pipe(Effect.provide(service), Effect.provide(CoreLive({ dataDirectory: path }))),
      ).pipe(Effect.fork);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("50 millis");
      expect((yield* Fiber.join(fiber)).status).toBe("needsConfiguration");
      expect(released).toBe(true);
      expect(existsSync(join(path, "bots.json"))).toBe(false);
    }),
);

it("serializes bootstrap with a concurrent bot save and preserves both the update and primary assistant", async () => {
  const path = directory();
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      yield* config.writeConfig({ harnessInstances: [instance] });
      yield* config.writeBots([user]);
      const read = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let paused = false;
      const wrapped: ConfigStore["Type"] = {
        ...config,
        readBots: config.readBots.pipe(
          Effect.tap(() => {
            if (paused) return Effect.void;
            paused = true;
            return Deferred.succeed(read, undefined).pipe(Effect.zipRight(Deferred.await(release)));
          }),
        ),
      };
      const updated: BotConfig = {
        ...user,
        soul: "Concurrent user edit",
        modelSelection: { ...user.modelSelection, model: "updated-model" },
      };
      const writer = yield* Effect.gen(function* () {
        yield* (yield* Administration).updateBot(user.id, updated);
      }).pipe(
        Effect.provide(AdministrationLive),
        Effect.provideService(ConfigStore, wrapped),
        Effect.fork,
      );
      yield* Deferred.await(read);
      const initializer = yield* Effect.gen(function* () {
        return yield* (yield* PrimaryAssistantBootstrap).status;
      }).pipe(
        Effect.provide(
          bootstrap(
            path,
            probe(() => Effect.die("Existing bot must be reused")),
          ),
        ),
        Effect.provideService(ConfigStore, wrapped),
        Effect.fork,
      );
      yield* Effect.yieldNow();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      expect((yield* Fiber.join(initializer)).status).toBe("ready");
      const bots = yield* config.readBots;
      expect(bots).toHaveLength(2);
      expect(bots.find((bot) => bot.id === user.id)).toEqual(updated);
      expect(
        bots
          .filter((bot) => bot.system)
          .every((bot) => bot.modelSelection.model === "updated-model"),
      ).toBe(true);
    }),
    path,
  );
});
