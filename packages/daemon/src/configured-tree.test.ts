import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, CoreLive, Store } from "@aut/core";
import { BotConfig, BotId } from "@aut/protocol";
import { Effect, Layer, Redacted, Schema } from "effect";
import { expect, it } from "vitest";
import { ConfiguredTreeLive } from "./configured-tree.js";
import { RouteTest, RouteTestLive } from "./route-test.js";
import { SecretReader } from "./secret-reader.js";

it("uses a fresh configuration snapshot per tree and keeps credentials outside decision logs", async () => {
  const requests: { path: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    request.resume();
    request.on("end", () => {
      const second = request.url === "/second";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: {
            bot: {
              type: "choice",
              choice: second ? "code" : "general",
              confidence: 0.001,
              probabilities: second ? { code: 0.9, general: 0.1 } : { code: 0.1, general: 0.9 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-configured-tree-"));
  try {
    const secrets = Layer.succeed(SecretReader, {
      resolve: (reference) =>
        Effect.succeed(
          Redacted.make(reference === "secret-a" ? "synthetic-key-a" : "synthetic-key-b"),
        ),
    });
    const core = CoreLive({ dataDirectory });
    const tree = ConfiguredTreeLive.pipe(Layer.provideMerge(Layer.merge(core, secrets)));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ConfigStore;
          const route = yield* RouteTest;
          const bot = Schema.decodeUnknownSync(BotConfig)({
            id: "general",
            name: "General",
            description: "General work",
            soul: "",
            cwd: "/tmp",
            modelSelection: { instanceId: "local", model: "test" },
          });
          yield* config.writeBots([
            bot,
            { ...bot, id: BotId.make("code"), name: "Code", description: "Coding" },
          ]);
          const settings = (path: string, ref: string) => ({
            harnessInstances: [],
            classifier: {
              primary: {
                backend: "jev",
                model: "jev-1.14.0",
                endpoint: `http://127.0.0.1:${address.port}/${path}`,
                apiKeyRef: ref,
              },
            },
          });
          yield* config.writeConfig(settings("first", "secret-a"));
          const first = yield* route.run({ text: "First request" });
          yield* config.writeConfig(settings("second", "secret-b"));
          const second = yield* route.run({ text: "Second request" });
          return {
            first,
            second,
            logs: yield* (yield* Store).transaction((tx) => tx.list("decision_logs")),
          };
        }).pipe(Effect.provide(RouteTestLive.pipe(Layer.provideMerge(tree)))),
      ),
    );
    expect(result.first.selectedBotId).toBe("general");
    expect(result.second.selectedBotId).toBe("code");
    expect(result.second.probabilities.find((entry) => entry.botId === "code")?.probability).toBe(
      0.9,
    );
    expect(requests).toEqual([
      { path: "/first", authorization: "Bearer synthetic-key-a" },
      { path: "/second", authorization: "Bearer synthetic-key-b" },
    ]);
    expect(result.logs.every((entry) => entry.classifierCalls[0]?.backend === "jev")).toBe(true);
    expect(JSON.stringify(result.logs)).not.toContain("synthetic-key");
    expect(JSON.stringify(result.logs)).not.toContain("secret-a");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
