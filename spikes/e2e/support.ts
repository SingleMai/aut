// Opt-in live acceptance helpers. Mutations go through the same local API as the desktop.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Schedule } from "effect";
import { DaemonLive, HttpServer } from "../../packages/daemon/dist/index.js";
import { Store } from "../../packages/core/dist/index.js";
import { JEV_ENDPOINT, JEV_MODEL } from "../../packages/classifier/dist/index.js";
import { BotConfig, BotId, BotsResponse, ConfigResponse, MessagePageResponse, TaskListResponse } from "../../packages/protocol/dist/index.js";

export const assert = (condition: unknown, message: string) => condition ? Effect.void : Effect.fail(new Error(message));
export const fixtureDirectory = () => mkdtempSync(join(tmpdir(), "aut-e2e-"));
export const writeEvidence = (path: string, result: unknown) => Effect.try(() => writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }));

export const client = (dataDirectory: string) => Effect.gen(function* () {
  const server = yield* HttpServer;
  const token = yield* Effect.try(() => readFileSync(join(dataDirectory, "daemon-token"), "utf8").trim());
  const request = <A, I>(path: string, schema: Schema.Schema<A, I>, method = "GET", body?: unknown) => Effect.tryPromise({
    try: async () => {
      const response = await fetch(`http://${server.host}:${server.port}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Local API ${method} ${path} failed (${response.status})`);
      return response.json() as Promise<unknown>;
    },
    catch: (cause) => new Error(`Local API ${method} ${path} failed (${cause instanceof Error ? cause.name : "unknown"})`),
  }).pipe(Effect.flatMap(Schema.decodeUnknown(schema)));
  const messages = request("/v1/messages?limit=50", MessagePageResponse).pipe(Effect.map((response) => response.messages));
  const tasks = request("/v1/tasks?limit=50", TaskListResponse).pipe(Effect.map((response) => response.tasks));
  const wait = <A, E, R>(read: Effect.Effect<A, E, R>, matches: (value: A) => boolean, timeout = "120 seconds") => Effect.gen(function* () {
    let latest = yield* read;
    if (matches(latest)) return latest;
    yield* read.pipe(
      Effect.tap((value) => Effect.sync(() => { latest = value; })),
      Effect.repeat({ schedule: Schedule.spaced("250 millis"), until: matches }),
    );
    return latest;
  }).pipe(Effect.timeout(timeout as "120 seconds"));
  const store = yield* Store;
  return { request, messages, tasks, wait, logs: store.transaction((tx) => tx.list("decision_logs", { limit: 1000 })), events: store.transaction((tx) => tx.list("events", { limit: 10000 })) };
});
export type LiveClient = Effect.Effect.Success<ReturnType<typeof client>>;

export const configurePrimary = (api: LiveClient) => Effect.gen(function* () {
  const config = yield* api.request("/v1/config", ConfigResponse);
  yield* api.request("/v1/config", ConfigResponse, "PUT", { ...config, classifier: { primary: { backend: "jev", model: JEV_MODEL, endpoint: JEV_ENDPOINT, apiKeyRef: "env:TYPESAFE_API_KEY" } } });
  const bots = (yield* api.request("/v1/bots", BotsResponse)).bots;
  const primary = bots.find((bot) => bot.system === "primary");
  if (!primary) return yield* Effect.fail(new Error("Bootstrap did not create the primary assistant"));
  return primary;
});

export const createEcho = (api: LiveClient, dataDirectory: string, primary: BotConfig) => Effect.gen(function* () {
  const bot: BotConfig = { id: BotId.make("echo-fixture"), name: "回声助手", description: "Handle synthetic integration verification and echo test requests, including echoing short test results.", soul: "You are a synthetic integration-test worker. Follow the user's exact fixture instructions. Never touch external accounts or send messages to people. Native user questions are allowed only when explicitly requested by the fixture. Keep final reports short unless the fixture explicitly requests a long report.", modelSelection: { ...primary.modelSelection, effort: "low" }, cwd: dataDirectory, mcpServers: [] };
  yield* api.request("/v1/bots", Schema.Struct({ bot: BotConfig }), "POST", bot);
  return bot;
});

export const configure = (api: LiveClient, dataDirectory: string) =>
  configurePrimary(api).pipe(Effect.flatMap((primary) => createEcho(api, dataDirectory, primary)));

export const withDaemon = <A, E>(dataDirectory: string, work: (api: LiveClient) => Effect.Effect<A, E>) => Effect.scoped(
  client(dataDirectory).pipe(Effect.flatMap(work), Effect.provide(DaemonLive({ dataDirectory, port: 0 }))),
);
