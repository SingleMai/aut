// Opt-in native app check with isolated data. No model calls or account pairing.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { primaryBotConfig } from "../../packages/core/dist/index.js";
import { BotId } from "../../packages/protocol/dist/index.js";
const directory = mkdtempSync(join(tmpdir(), "aut-remote-native-"));
const profile = join(directory, "desktop");
const executable = resolve("apps/desktop/dist/package/aut-darwin-arm64/aut.app/Contents/MacOS/aut");
writeFileSync(
  join(directory, "config.json"),
  JSON.stringify({
    harnessInstances: [
      { id: "fixture", name: "Synthetic fixture", kind: "codex", command: "codex", args: [] },
    ],
  }),
  { mode: 0o600 },
);
writeFileSync(
  join(directory, "bots.json"),
  JSON.stringify([
    primaryBotConfig(BotId.make("aut"), {
      cwd: directory,
      modelSelection: { instanceId: "fixture", model: "isolated-no-model-call" },
    }),
  ]),
  { mode: 0o600 },
);
const pause = (ms) => Effect.runPromise(Effect.sleep(ms));
const until = async (read, predicate, duration = 30000) => {
  const end = Date.now() + duration;
  while (Date.now() < end) {
    try {
      const result = await read();
      if (predicate(result)) return result;
    } catch {}
    await pause(100);
  }
  throw new Error("Native acceptance condition timed out");
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const daemonPort = await freePort(),
  pagePort = await freePort(),
  mainPort = await freePort();
const json = async (url, options = {}) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let child, daemonPid;
const sockets = [];
const launch = (dataDirectory = directory, desktopProfile = profile) => {
  let output = "";
  child = spawn(executable, [`--remote-debugging-port=${pagePort}`, `--inspect=${mainPort}`], {
    env: {
      ...process.env,
      AUT_DATA_DIR: dataDirectory,
      AUT_DESKTOP_PROFILE: desktopProfile,
      AUT_PORT: String(daemonPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    output += b.toString();
  });
  child.stderr.on("data", (b) => {
    output += b.toString();
  });
  return until(
    () => output,
    (v) => v.includes("aut desktop interface ready"),
  );
};
const connect = async (port, type) => {
  const target = await until(
    () => json(`http://127.0.0.1:${port}/json/list`),
    (list) => list.some((v) => v.type === type),
  );
  const socket = new WebSocket(target.find((v) => v.type === type).webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const send = (method, params = {}) =>
    Effect.runPromise(
      Effect.async((resume) => {
        const next = ++id;
        const onmessage = (e) => {
          const data = JSON.parse(String(e.data));
          if (data.id !== next) return;
          socket.removeEventListener("message", onmessage);
          resume(
            data.error ? Effect.fail(new Error("CDP command failed")) : Effect.succeed(data.result),
          );
        };
        socket.addEventListener("message", onmessage);
        socket.send(JSON.stringify({ id: next, method, params }));
        return Effect.sync(() => socket.removeEventListener("message", onmessage));
      }).pipe(Effect.timeout("10 seconds")),
    );
  return {
    send,
    close: () => socket.close(),
    evaluate: async (expression) => {
      const value = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (value.exceptionDetails)
        throw new Error(
          "Native evaluation failed: " +
            (value.exceptionDetails.exception?.description ?? value.exceptionDetails.text),
        );
      return value.result.value;
    },
  };
};
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
try {
  await launch();
  const localPage = await connect(pagePort, "page"),
    localMain = await connect(mainPort, "node");
  await until(() => existsSync(join(directory, "daemon-token")), Boolean);
  const token = readFileSync(join(directory, "daemon-token"), "utf8").trim();
  const api = (path, body) =>
    json(`http://127.0.0.1:${daemonPort}${path}`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { method: "PUT", body: JSON.stringify(body) } : {}),
    });
  const rows = execFileSync("ps", ["-axo", "pid,ppid,args"], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line));
  const daemon = rows.find(
    (row) => row && Number(row[2]) === child.pid && row[3].includes("/Resources/daemon/main.mjs"),
  );
  assert(daemon, "Cannot identify this test's daemon");
  daemonPid = Number(daemon[1]);
  await until(
    () => localPage.evaluate("window.aut.connection({action:'status'})"),
    (r) => r.ok && r.status.mode === "local" && r.status.phase === "connected",
  );
  await localPage.evaluate("document.querySelector('button[data-view=settings]').click();true");
  await until(
    () => localPage.evaluate("!!document.querySelector('[role=switch]:not(:disabled)')"),
    Boolean,
  );
  await localPage.evaluate("document.querySelector('[role=switch]').click();true");
  const host = await until(
    () => api("/v1/remote/host"),
    (r) => r.state === "login" || r.state === "ready",
    45000,
  );
  assert(
    host.state === "login" && host.loginUrl.startsWith("https://login.tailscale.com/"),
    "Fresh host must offer official login without signing in",
  );
  assert(
    !(await localPage.evaluate("window.aut.request({method:'POST',path:'/v1/remote/connection'})"))
      .ok,
    "Renderer exported a host credential",
  );
  const native = await localMain.evaluate(
    `(()=>{const electron=process.mainModule.require('electron');return {encryption:electron.safeStorage.isEncryptionAvailable(),binary:process.mainModule.require('node:fs').existsSync(process.resourcesPath+'/transport/aut-transport')};})()`,
  );
  assert(native.encryption && native.binary, "Missing encryption or bundled transport");
  // Only the confirmation and relaunch trigger are intercepted; IPC, encrypted persistence and quit run normally.
  await localMain.evaluate(
    `(()=>{const electron=process.mainModule.require('electron');electron.dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});electron.app.relaunch=()=>process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(join(directory, "relaunch-requested"))},'yes');return true;})()`,
  );
  const remote = {
    version: 1,
    hostId: "unpaired-synthetic-host",
    nodeId: "unpaired-synthetic-node",
    name: "办公室 Pro",
    token: "a".repeat(64),
  };
  const code = "aut-connect:" + Buffer.from(JSON.stringify(remote)).toString("base64url");
  const inspected = await localPage.evaluate(
    `window.aut.connection(${JSON.stringify({ action: "inspect", text: code })})`,
  );
  assert(
    inspected.ok &&
      inspected.preview.name === remote.name &&
      !JSON.stringify(inspected).includes(remote.token),
    "Pairing preview leaked credentials or lost host identity",
  );
  await localPage.evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='连接另一台电脑').click();true",
  );
  await localPage.evaluate(
    `(()=>{document.querySelector('.pairing-manual input').value=${JSON.stringify(code)};document.querySelector('.pairing-manual form').requestSubmit();return true})()`,
  );
  await until(
    () =>
      localPage.evaluate(
        "document.querySelector('.pairing-recognized')?.innerText.includes('办公室 Pro')",
      ),
    Boolean,
  );
  assert(
    !(await localPage.evaluate(
      `document.body.innerText.includes(${JSON.stringify(remote.token)})`,
    )),
    "Pairing token is visible",
  );
  localPage
    .evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='连接并重启').click();true",
    )
    .catch(() => {});
  const firstPid = child.pid;
  await until(() => existsSync(join(directory, "relaunch-requested")), Boolean);
  localMain.close();
  localPage.close();
  await until(
    () => alive(firstPid),
    (v) => !v,
  );
  assert(existsSync(join(directory, "relaunch-requested")), "Switch did not request a relaunch");
  const stored = readFileSync(join(profile, "execution-target.json"), "utf8");
  assert(
    !stored.includes(remote.token) && JSON.parse(stored).mode === "remote",
    "Pairing information persisted in plaintext",
  );
  assert(
    alive(daemonPid) && (await api("/v1/health")).status === "ok",
    "Desktop switch stopped its host daemon",
  );
  const hostAfterClose = await api("/v1/remote/host");
  assert(hostAfterClose.enabled, "Closing desktop disabled host");
  await launch();
  const remotePage = await connect(pagePort, "page");
  const remoteStatus = await until(
    () => remotePage.evaluate("window.aut.connection({action:'status'})"),
    (r) => r.ok && r.status.mode === "remote" && r.status.phase === "login",
    45000,
  );
  await remotePage.evaluate("document.querySelector('button[data-view=settings]').click();true");
  assert(
    await remotePage.evaluate(
      "document.body.innerText.includes('登录 Tailscale')&&document.body.innerText.includes('切换到本机')&&!document.querySelector('.settings-form')",
    ),
    "Offline remote settings are inaccessible",
  );
  assert(
    !(await remotePage.evaluate("window.aut.connection({action:'copy'})")).ok,
    "Remote client could export host credentials",
  );
  const screenshot = await remotePage.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    "docs/assets/desktop/remote-native-offline.png",
    Buffer.from(screenshot.data, "base64"),
  );
  assert(
    readFileSync(join(directory, "daemon-token"), "utf8").trim() === token,
    "Remote startup modified the local credential",
  );
  await remotePage.evaluate("window.close();true").catch(() => {});
  await until(
    () => alive(child.pid),
    (v) => !v,
  );
  assert((await api("/v1/health")).status === "ok", "Remote desktop exit stopped host");
  await api("/v1/remote/host", { enabled: false, name: "Synthetic host" });
  const unavailableDirectory = join(directory, "unavailable-local");
  mkdirSync(unavailableDirectory);
  writeFileSync(join(unavailableDirectory, "config.json"), "{invalid-fixture");
  await launch(unavailableDirectory, join(directory, "fresh-air-profile"));
  const freshPage = await connect(pagePort, "page");
  await freshPage.evaluate("document.querySelector('button[data-view=settings]').click();true");
  await until(
    () =>
      freshPage.evaluate(
        "[...document.querySelectorAll('button')].some(b=>b.textContent==='连接另一台电脑')",
      ),
    Boolean,
  );
  await freshPage.evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='连接另一台电脑').click();true",
  );
  assert(
    await freshPage.evaluate("!!document.querySelector('[data-pair-paste]')"),
    "Fresh Air cannot open pairing",
  );
  await freshPage.evaluate("window.close();true").catch(() => {});
  await until(
    () => alive(child.pid),
    (v) => !v,
  );
  const evidence = {
    freshAirPairingAvailableWithoutLocalDaemon: true,
    at: new Date().toISOString(),
    architecture: process.arch,
    isolated: true,
    modelCalls: false,
    localAppConnected: true,
    bundledHelper: true,
    officialHostLoginAvailable: true,
    rendererSecretExportBlocked: true,
    osEncryptionAvailable: true,
    pairingSavedEncryptedThroughNativeIpc: true,
    pairingPreviewHidesCredentials: true,
    pairingThroughNewDialog: true,
    relaunchRequested: true,
    hostSurvivesDesktopSwitchAndExit: true,
    remoteProfileReadByRealApp: true,
    remoteStatus: remoteStatus.status.phase,
    remoteOfflineSettings: true,
    remoteExportBlocked: true,
    localTokenPreserved: true,
    realTwoDeviceProductionTest: false,
  };
  writeFileSync(
    "spikes/remote/results/packaged-remote-smoke.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  for (const socket of sockets) socket.close();
  if (child && alive(child.pid)) child.kill("SIGTERM");
  if (daemonPid && alive(daemonPid)) process.kill(daemonPid, "SIGTERM");
}
