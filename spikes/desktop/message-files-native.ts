// Opt-in native Electron file lifecycle acceptance; isolated data/profile, no model calls.
// The Save dialog response is controlled through the test-only Node inspector. Production
// renderer/preload/IPC, file writes, Finder and Quick Look execute unchanged in the packaged app.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Schedule } from "effect";
import { CoreLive, MessageFiles, Store, primaryBotConfig } from "../../packages/core/dist/index.js";
import { BotId, MessageId } from "../../packages/protocol/dist/index.js";

const root = resolve(process.env.AUT_PACKAGE_OUT ?? ".artifacts/file-lifecycle-package");
const executable = join(root, `aut-darwin-${process.arch}/aut.app/Contents/MacOS/aut`);
const directory = mkdtempSync(join(tmpdir(), "aut-native-files-"));
const profile = mkdtempSync(join(tmpdir(), "aut-native-files-profile-"));
const evidence = process.env.AUT_E2E_RESULT ?? "spikes/e2e/results/message-files-native.json";
const screenshotPath = resolve("docs/assets/desktop/message-files-native.png");
writeFileSync(join(directory, "config.json"), JSON.stringify({ harnessInstances: [{ id: "local", name: "Fixture", kind: "codex", command: "codex", args: [] }] }), { mode: 0o600 });
writeFileSync(join(directory, "bots.json"), JSON.stringify([primaryBotConfig(BotId.make("aut"), { cwd: directory, modelSelection: { instanceId: "local", model: "fixture-only" } })]), { mode: 0o600 });
const fixtures = await Effect.runPromise(Effect.gen(function* () {
  const files = yield* MessageFiles;
  const store = yield* Store;
  const saved = yield* files.upload({ name: "native-report.txt", base64: Buffer.from("AUT_NATIVE_FILE_PREVIEW\nTOTAL=42\n历史附件保持原样。\n").toString("base64") });
  const expired = yield* files.upload({ name: "abandoned.txt", base64: "YQ==" });
  yield* store.transaction(tx => tx.insert("main_thread_messages", { id: MessageId.make("native-file-message"), at: Date.now(), author: "user", kind: "text", text: "请核对这份文件的预览与保存。", files: [saved] }));
  return { saved, expired };
}).pipe(Effect.provide(CoreLive({ dataDirectory: directory }))));
writeFileSync(join(dirname(fixtures.expired.path), "draft.json"), JSON.stringify({ expiresAt: 0 }));

const freePort = () => Effect.async<number, Error>(resume => {
  const server = createServer(); server.once("error", error => resume(Effect.fail(error)));
  server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = address && typeof address !== "string" ? address.port : 0; server.close(() => resume(port ? Effect.succeed(port) : Effect.fail(new Error("Missing port")))); });
  return Effect.sync(() => server.close());
});
const assert = (condition: unknown, text: string) => condition ? Effect.void : Effect.fail(new Error(text));
const until = <A, E>(read: Effect.Effect<A, E>, matches: (value: A) => boolean) => Effect.suspend(() => {
  let latest: A;
  return read.pipe(Effect.tap(value => Effect.sync(() => { latest = value; })), Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: matches }), Effect.map(() => latest), Effect.timeout("45 seconds"));
});
const json = (url: string) => Effect.tryPromise(() => fetch(url).then(response => response.json()));
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const inspector = (url: string) => Effect.gen(function* () {
  const socket = yield* Effect.acquireRelease(Effect.async<WebSocket, Error>(resume => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resume(Effect.succeed(socket)), { once: true });
    socket.addEventListener("error", () => resume(Effect.fail(new Error("Inspector connection failed"))), { once: true });
  }), socket => Effect.sync(() => socket.close()));
  let next = 0;
  return (expression: string) => Effect.async<any, Error>(resume => {
    const id = ++next;
    const handler = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data));
      if (value.id !== id) return;
      socket.removeEventListener("message", handler);
      const result = value.result;
      resume(value.error || result.exceptionDetails ? Effect.fail(new Error(`Inspector evaluation failed: ${JSON.stringify(value.error ?? result.exceptionDetails)}`)) : Effect.succeed(result.result.value));
    };
    socket.addEventListener("message", handler);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    return Effect.sync(() => socket.removeEventListener("message", handler));
  }).pipe(Effect.timeout("30 seconds"));
});

let daemonPid: number | undefined;
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const port = yield* freePort();
  const debugPort = yield* freePort();
  const mainPort = yield* freePort();
  let output = "";
  const app = yield* Effect.acquireRelease(Effect.sync(() => {
    const child = spawn(executable, [`--inspect=${mainPort}`, `--remote-debugging-port=${debugPort}`], { env: { ...process.env, AUT_DATA_DIR: directory, AUT_PORT: String(port), AUT_DESKTOP_PROFILE: profile }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", chunk => { output += chunk.toString(); });
    child.stderr?.on("data", chunk => { output += chunk.toString(); });
    return child;
  }), child => Effect.sync(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (daemonPid && running(daemonPid)) process.kill(daemonPid, "SIGTERM");
  }));
  yield* until(Effect.sync(() => output.includes("aut desktop interface ready")), Boolean);
  console.log(JSON.stringify({ stage: "ready", pid: app.pid, directory, port, mainPort, debugPort }));
  const processRows = execFileSync("ps", ["-axo", "pid,ppid,args"], { encoding: "utf8" }).split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line));
  daemonPid = Number(processRows.find(row => row && Number(row[2]) === app.pid && row[3]?.includes("/Resources/daemon/main.mjs"))?.[1]);
  yield* assert(daemonPid, "Missing owned packaged daemon");
  const mainTargets = yield* json(`http://127.0.0.1:${mainPort}/json/list`);
  const main = yield* inspector(mainTargets[0].webSocketDebuggerUrl);
  yield* main("globalThis.nativeElectron = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/dist/main.cjs')('electron'); true");
  const pageTargets = yield* json(`http://127.0.0.1:${debugPort}/json/list`);
  const renderer = yield* inspector(pageTargets.find((target: any) => target.type === "page").webSocketDebuggerUrl);
  yield* until(renderer("!!document.querySelector('.file-card')"), Boolean);
  yield* assert(!existsSync(fixtures.expired.path), "Startup did not collect the expired orphan");
  const safe = fixtures.saved;
  const refusal = yield* renderer(`window.aut.request({method:'DELETE',path:'/v1/files/${safe.id}'})`);
  yield* assert(refusal.ok && refusal.data.released === false, "A sent file was released");
  const native = (action: string) => renderer(`window.aut.fileAction({id:${JSON.stringify(safe.id)},action:${JSON.stringify(action)}})`);
  const savedPath = join(directory, "saved-copy.txt");
  yield* main(`globalThis.realSaveDialog = nativeElectron.dialog.showSaveDialog; nativeElectron.dialog.showSaveDialog = async () => ({canceled:true,filePath:''}); true`);
  const cancelled = yield* native("save");
  yield* assert(cancelled.ok && cancelled.cancelled && !existsSync(savedPath), "Save cancellation wrote a file");
  yield* main(`nativeElectron.dialog.showSaveDialog = async () => ({canceled:false,filePath:${JSON.stringify(savedPath)}}); true`);
  const saved = yield* native("save");
  yield* assert(saved.ok && readFileSync(savedPath).equals(readFileSync(safe.path)), "Saved copy differs from the snapshot");
  yield* main("nativeElectron.dialog.showSaveDialog = realSaveDialog; true");
  const finder = yield* native("reveal");
  yield* assert(finder.ok, "Finder IPC failed");
  const finderFolder = `${realpathSync(dirname(safe.path))}/`;
  const closeOwnedFinder = Effect.try(() => execFileSync("/usr/bin/osascript", ["-e", `tell application "Finder"
repeat with probeWindow in (get every Finder window)
try
if (POSIX path of (target of probeWindow as alias)) is ${JSON.stringify(finderFolder)} then close probeWindow
end try
end repeat
end tell`], { stdio: ["ignore", "pipe", "pipe"] }));
  yield* Effect.addFinalizer(() => closeOwnedFinder.pipe(Effect.ignore));
  yield* until(Effect.try(() => execFileSync("/usr/bin/osascript", ["-e", `tell application "Finder"
set matched to false
repeat with probeWindow in (get every Finder window)
try
if (POSIX path of (target of probeWindow as alias)) is ${JSON.stringify(finderFolder)} then set matched to true
end try
end repeat
return matched
end tell`], { encoding: "utf8" }).trim()), value => value === "true");
  yield* main("nativeElectron.app.focus({steal:true}); nativeElectron.BrowserWindow.getAllWindows()[0].show(); nativeElectron.BrowserWindow.getAllWindows()[0].focus(); true");
  const windows = Effect.try(() => JSON.parse(execFileSync("/usr/bin/swift", ["-e", `import CoreGraphics; import Foundation; let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []; let owned = rows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == ${app.pid} }; print(String(data: try! JSONSerialization.data(withJSONObject:owned),encoding:.utf8)!)`], { encoding: "utf8" })) as any[]);
  const before = new Set((yield* windows).map(row => row.kCGWindowNumber));
  const preview = yield* native("preview");
  yield* assert(preview.ok, "Quick Look IPC failed");
  console.log(JSON.stringify({ stage: "native-preview", pid: app.pid, directory }));
  const visible = yield* until(windows, rows => rows.some(row => !before.has(row.kCGWindowNumber) && row.kCGWindowLayer > 0));
  const panel = visible.find(row => !before.has(row.kCGWindowNumber) && row.kCGWindowLayer > 0);
  yield* main("nativeElectron.BrowserWindow.getAllWindows()[0].closeFilePreview(); true");
  yield* until(windows, rows => !rows.some(row => row.kCGWindowNumber === panel.kCGWindowNumber));
  yield* main("nativeElectron.app.focus({steal:true}); nativeElectron.BrowserWindow.getAllWindows()[0].focus(); true");
  yield* renderer("document.querySelector('button[aria-label=\"预览 native-report.txt\"]').click(); true");
  yield* until(renderer("document.querySelector('.file-preview-text')?.textContent.includes('AUT_NATIVE_FILE_PREVIEW')"), Boolean);
  yield* renderer("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  yield* until(renderer("getComputedStyle(document.querySelector('.modal')).opacity === '1' && document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)"), Boolean);
  yield* renderer("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const screen = yield* main("nativeElectron.BrowserWindow.getAllWindows()[0].webContents.capturePage().then(image => image.toPNG().toString('base64'))");
  mkdirSync(dirname(screenshotPath), { recursive: true });
  writeFileSync(screenshotPath, Buffer.from(screen, "base64"));
  // Close only the Finder window that this probe opened for its isolated snapshot folder.
  yield* closeOwnedFinder;
  return { at: new Date().toISOString(), app: executable, directory, isolatedProfile: profile, savedId: safe.id,
    startupOrphanCollected: true, historicalAttachmentProtected: true, nativeIpcSaveAndCancel: true,
    saveDialog: "Controlled fixture response through test-only main inspector; production copy and IPC unchanged",
    savedCopyMatchesSnapshot: true, finderRequest: finder, finderFolderVerified: true, quickLookRequest: preview,
    quickLookWindow: { id: panel.kCGWindowNumber, ownerPid: panel.kCGWindowOwnerPID, openedAndClosed: true, bounds: panel.kCGWindowBounds },
    previewTextVerified: true, screenshot: screenshotPath,
    captureScope: "Renderer text preview captured from the packaged webContents. Native Quick Look opening/closing verified by owned macOS window identity; no system screen capture permission required." };
})).pipe(Effect.timeout("3 minutes")));
writeFileSync(evidence, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ stage: "complete", evidence, screenshotPath }));
