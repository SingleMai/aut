/** Record the isolated tsnet experiment without reading aut or proxy credentials. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Data, Effect, Schema } from "effect";

const execute = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
class ProbeError extends Data.TaggedError("ProbeError")<{ readonly message: string }> {}
const failure = (message: string) => new ProbeError({ message });
const command = (file: string, args: string[]) =>
  Effect.tryPromise({
    try: (signal) =>
      execute(file, args, {
        cwd: directory,
        signal,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 600_000,
        env: {
          ...process.env,
          TS_NO_LOGS_NO_SUPPORT: "true",
          TS_BIND_TO_INTERFACE_BY_ROUTE: "1",
        },
      }),
    catch: () => failure(`Command failed: ${file} ${args.join(" ")}`),
  });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const NetworkSnapshot = Schema.Struct({
  interfaces: Schema.Array(Schema.String),
  dnsDigest: Schema.String,
  proxyDigest: Schema.String,
  routeDigest: Schema.String,
  publicRouteInterface: Schema.String,
});
const Event = Schema.Struct({
  Action: Schema.String,
  Test: Schema.optional(Schema.String),
  Output: Schema.optional(Schema.String),
});
const Evidence = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  at: Schema.String,
  scope: Schema.Literal("same-machine-tsnet-with-local-test-control-and-derp"),
  platform: Schema.String,
  architecture: Schema.String,
  go: Schema.String,
  tailscale: Schema.Literal("v1.106.1"),
  interfaceBinding: Schema.Literal("system-route"),
  tests: Schema.Array(Schema.String),
  before: NetworkSnapshot,
  after: NetworkSnapshot,
  networkConfigurationUnchanged: Schema.Boolean,
  notVerified: Schema.Array(Schema.String),
});
const snapshot = Effect.gen(function* () {
  const [interfaces, dns, proxy, route] = yield* Effect.all(
    [
      command("/sbin/ifconfig", ["-l"]),
      command("/usr/sbin/scutil", ["--dns"]),
      command("/usr/sbin/scutil", ["--proxy"]),
      command("/sbin/route", ["-n", "get", "1.1.1.1"]),
    ],
    { concurrency: "unbounded" },
  );
  const stableRoute = route.stdout
    .split("\n")
    .filter((line) => /^\s*(destination|mask|gateway|interface|flags):/.test(line))
    .join("\n");
  return yield* Schema.decodeUnknown(NetworkSnapshot)({
    interfaces: interfaces.stdout.trim().split(/\s+/).sort(),
    dnsDigest: hash(dns.stdout),
    proxyDigest: hash(proxy.stdout),
    routeDigest: hash(stableRoute),
    publicRouteInterface: route.stdout.match(/interface:\s*(\S+)/)?.[1] ?? "unknown",
  });
});
const program = Effect.gen(function* () {
  if (!output || platform() !== "darwin") {
    return yield* Effect.fail(failure("Usage on macOS: node spikes/remote/run.ts NEW_RESULT_PATH"));
  }
  const before = yield* snapshot;
  const go = yield* command("go", ["version"]);
  const result = yield* command("go", ["test", "-json", "-count=1", "-timeout=120s", "./..."]);
  const events = yield* Effect.forEach(result.stdout.trim().split("\n").filter(Boolean), (line) =>
    Schema.decodeUnknown(Schema.parseJson(Event))(line),
  );
  const tests = events
    .filter((event) => event.Action === "pass" && event.Test?.includes("/"))
    .map((event) => event.Test as string);
  const expected = [
    "NoSystemInterfaceAdded",
    "HTTP",
    "FileRoundTrip",
    "Preview",
    "WebSocket",
    "AuthenticationRequired",
    "HostSurvivesClientDisconnect",
    "ReconnectWithRetainedIdentity",
  ];
  if (
    events.some((event) => event.Action === "fail") ||
    expected.some((name) => !tests.includes(`TestLocalTransport/${name}`))
  ) {
    return yield* Effect.fail(failure("Expected transport checks did not all pass"));
  }
  const after = yield* snapshot;
  const evidence = yield* Schema.decodeUnknown(Evidence)({
    schemaVersion: 2,
    at: new Date().toISOString(),
    scope: "same-machine-tsnet-with-local-test-control-and-derp",
    platform: platform(),
    architecture: arch(),
    go: go.stdout.trim(),
    tailscale: "v1.106.1",
    interfaceBinding: "system-route",
    tests,
    before,
    after,
    networkConfigurationUnchanged: JSON.stringify(before) === JSON.stringify(after),
    notVerified: [
      "Hosted Tailscale login, coordination and internet NAT traversal",
      "Clash TUN compatibility across real networks and proxy nodes",
      "Two-device Wi-Fi roaming, laptop sleep and automatic reconnection",
      "Real aut daemon, harness execution, questions and persisted message delivery",
      "Electron file actions, browser preview integration and packaged helper lifecycle",
    ],
  });
  const encoded = yield* Schema.encode(Schema.parseJson(Evidence))(evidence);
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(resolve(output)), { recursive: true });
      await writeFile(resolve(output), `${JSON.stringify(JSON.parse(encoded), null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    },
    catch: () => failure("Could not save evidence; existing result files are never overwritten"),
  });
  yield* Effect.logInfo(`Passed ${tests.length} local transport checks; evidence: ${output}`);
  if (!evidence.networkConfigurationUnchanged) {
    return yield* Effect.fail(
      failure(
        "Network observations changed; inspect the saved evidence before concluding isolation",
      ),
    );
  }
});
await Effect.runPromise(program);
