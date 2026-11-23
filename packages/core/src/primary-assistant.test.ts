import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotConfig, BotId, BotsConfig } from "@aut/protocol";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "./config-store.js";
import { CoreLive } from "./index.js";
import { PrimaryAssistant, PrimaryAssistantLive, primaryBotConfig } from "./primary-assistant.js";

const seed = {
  modelSelection: { instanceId: "configured", model: "chosen-model", effort: "high" },
  cwd: "/existing/project",
};
const instance = {
  id: "configured",
  kind: "codex",
  name: "Existing",
  command: "codex",
  args: ["app-server"],
  env: { USER_SETTING: "keep" },
};
const withRegistry = async <A>(
  bots: BotsConfig,
  run: (directory: string) => Effect.Effect<A, unknown, PrimaryAssistant | ConfigStore>,
  configured = true,
) => {
  const directory = mkdtempSync(join(tmpdir(), "aut-primary-assistant-"));
  const layer = PrimaryAssistantLive.pipe(
    Layer.provideMerge(CoreLive({ dataDirectory: directory })),
  );
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ConfigStore;
          yield* config.writeConfig({ harnessInstances: configured ? [instance] : [] });
          yield* config.writeBots(bots);
          return yield* run(directory);
        }).pipe(Effect.provide(layer)),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("configured primary assistant", () => {
  it("creates a primary assistant template using the configured model and workdir", () => {
    const bot = primaryBotConfig(BotId.make("custom-primary"), seed);
    expect(Schema.decodeUnknownSync(BotConfig)(bot)).toEqual(bot);
    expect(bot.system).toBe("primary");
    expect(bot.name).toBe("aut");
    expect(bot.modelSelection).toEqual(seed.modelSelection);
    expect(bot.cwd).toBe(seed.cwd);
    expect(bot.description).toMatch(/^[\x20-\x7E]+$/);
    expect(bot.soul).toMatch(/^[\x20-\x7E]+$/);
    expect(bot.modelSelection).not.toBe(seed.modelSelection);
  });
  it("accepts specialists and a single primary marker", () => {
    const primary = primaryBotConfig(BotId.make("aut"), seed);
    const { system: _, ...specialist } = { ...primary, id: BotId.make("notes") };
    const valid = Schema.is(BotsConfig);
    expect(valid([specialist, primary])).toBe(true);
    expect(valid([primary, { ...specialist, system: "primary" }])).toBe(false);
    for (const system of ["general", "slow-brain"])
      expect(valid([{ ...specialist, system }])).toBe(false);
  });
  it("uses the role flag and preserves every existing setting and JSON byte", async () => {
    const existing: BotConfig = {
      ...primaryBotConfig(BotId.make("user-chosen-id"), seed),
      name: "Edited name",
      soul: "User-owned instructions",
    };
    await withRegistry([existing], (directory) =>
      Effect.gen(function* () {
        const configBefore = readFileSync(join(directory, "config.json"), "utf8");
        const botsBefore = readFileSync(join(directory, "bots.json"), "utf8");
        expect(yield* (yield* PrimaryAssistant).get).toEqual(existing);
        expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(configBefore);
        expect(readFileSync(join(directory, "bots.json"), "utf8")).toBe(botsBefore);
      }),
    );
  });
  it("rejects an absent role instead of treating a same-ID user bot as a system bot", async () => {
    const { system: _, ...ordinary } = primaryBotConfig(BotId.make("aut"), seed);
    const result = await withRegistry([ordinary], () =>
      Effect.either(Effect.flatMap(PrimaryAssistant, (bots) => bots.get)),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({ code: "Configuration" });
  });
  it("rejects a role whose harness instance no longer exists", async () => {
    const bot = primaryBotConfig(BotId.make("custom-id"), seed);
    const result = await withRegistry(
      [bot],
      () => Effect.either(Effect.flatMap(PrimaryAssistant, (bots) => bots.get)),
      false,
    );
    expect(result._tag).toBe("Left");
  });
  it("rechecks current configuration on each read", async () => {
    const bot = primaryBotConfig(BotId.make("aut"), seed);
    await withRegistry([bot], () =>
      Effect.gen(function* () {
        const registry = yield* PrimaryAssistant;
        expect(yield* registry.get).toEqual(bot);
        yield* (yield* ConfigStore).writeConfig({ harnessInstances: [] });
        expect((yield* Effect.either(registry.get))._tag).toBe("Left");
      }),
    );
  });
});
