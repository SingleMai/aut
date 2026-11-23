// Opt-in packaged Electron smoke test; synthetic local data only, no model calls.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer, Schedule } from "effect";
import { CoreLive, primaryBotConfig } from "../../packages/core/dist/index.js";
import { Administration, AdministrationLive } from "../../packages/daemon/dist/index.js";
import { BotId, TaskId } from "../../packages/protocol/dist/index.js";

const app = resolve(process.env.AUT_PACKAGE_OUT || "apps/desktop/dist/package", `aut-darwin-${process.arch}/aut.app`);
const executable = join(app, "Contents/MacOS/aut");
const directory = mkdtempSync(join(tmpdir(), "aut-packaged-smoke-"));
const evidenceDirectory = process.env.AUT_E2E_ARTIFACT_DIR ?? "spikes/e2e/results";
const profile = mkdtempSync(join(tmpdir(), "aut-packaged-profile-"));
const model = JSON.parse(readFileSync("spikes/e2e/results/progress-0.169.0.json", "utf8")).model;
writeFileSync(join(directory, "config.json"), JSON.stringify({ harnessInstances: [{ id: "local", name: "Existing CLI", kind: "codex", command: "codex", args: [] }] }), { mode: 0o600 });
writeFileSync(join(directory, "bots.json"), JSON.stringify([primaryBotConfig(BotId.make("aut"), { cwd: directory, modelSelection: { instanceId: "local", model, effort: "low" } })]), { mode: 0o600 });
const receiptBotId = BotId.make("packaged-observations");
await Effect.runPromise(Effect.flatMap(Administration, (admin) => admin.createBot({
  id: receiptBotId, name: "观测助手", description: "Synthetic receipt check", soul: "",
  cwd: directory, modelSelection: { instanceId: "local", model },
}, TaskId.make("packaged-creator"))).pipe(Effect.provide(AdministrationLive.pipe(Layer.provide(CoreLive({ dataDirectory: directory }))))));
const freePort = Effect.async<number, Error>((resume) => {
  const server = createServer();
  server.once("error", (error) => resume(Effect.fail(error)));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    server.close(() => resume(port ? Effect.succeed(port) : Effect.fail(new Error("Missing smoke port"))));
  });
  return Effect.sync(() => server.close());
});
const assert = (condition: unknown, message: string) => condition ? Effect.void : Effect.fail(new Error(message));
const until = <A, E>(read: Effect.Effect<A, E>, matches: (value: A) => boolean) => Effect.gen(function* () {
  let latest = yield* read;
  if (matches(latest)) return latest;
  yield* read.pipe(Effect.tap((value) => Effect.sync(() => { latest = value; })), Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: matches }));
  return latest;
}).pipe(Effect.timeout("60 seconds"));
const jsonFetch = (url: string, token?: string, body?: unknown) => Effect.tryPromise({
  try: async () => {
    const response = await fetch(url, { ...(token ? { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } } : {}), ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Smoke HTTP status ${response.status}`);
    return await response.json() as any;
  }, catch: () => new Error("Smoke HTTP request failed"),
});
let ownedDaemon: number | undefined;
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const port = yield* freePort;
  const debugPort = yield* freePort;
  let output = "";
  let appExited = false;
  const child = yield* Effect.acquireRelease(Effect.sync(() => {
    const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], { env: { ...process.env, AUT_DATA_DIR: directory, AUT_PORT: String(port), AUT_DESKTOP_PROFILE: profile }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("exit", () => { appExited = true; });
    return child;
  }), (child) => Effect.sync(() => { if (!appExited) child.kill("SIGTERM"); if (ownedDaemon && running(ownedDaemon)) process.kill(ownedDaemon, "SIGTERM"); }));
  yield* until(Effect.sync(() => output.includes("aut desktop interface ready")), Boolean);
  const token = readFileSync(join(directory, "daemon-token"), "utf8").trim();
  const health = yield* jsonFetch(`http://127.0.0.1:${port}/v1/health`, token);
  yield* assert(health.status === "ok", "Packaged daemon health failed");
  const processes = execFileSync("ps", ["-axo", "pid,ppid,args"], { encoding: "utf8" }).split("\n");
  const own = processes.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).find((row) => row && Number(row[2]) === child.pid && row[3]?.includes("/Resources/daemon/main.mjs"));
  yield* assert(own, "Cannot identify the daemon spawned by this packaged app");
  ownedDaemon = Number(own![1]);
  const pages = yield* jsonFetch(`http://127.0.0.1:${debugPort}/json/list`);
  const page = pages.find((value: any) => value.type === "page" && value.url.startsWith("file://"));
  yield* assert(page?.webSocketDebuggerUrl, "The packaged renderer did not open a page");
  const socket = yield* Effect.acquireRelease(Effect.async<WebSocket, Error>((resume) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener("open", () => resume(Effect.succeed(socket)), { once: true });
    socket.addEventListener("error", () => resume(Effect.fail(new Error("Smoke CDP failed"))), { once: true });
  }), (socket) => Effect.sync(() => socket.close()));
  let next = 0;
  const cdp = (method: string, params: unknown = {}) => Effect.async<any, Error>((resume) => {
    const id = ++next;
    const listener = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data));
      if (value.id !== id) return;
      socket.removeEventListener("message", listener);
      resume(value.error ? Effect.fail(new Error("Smoke CDP command failed")) : Effect.succeed(value.result));
    };
    socket.addEventListener("message", listener); socket.send(JSON.stringify({ id, method, params }));
    return Effect.sync(() => socket.removeEventListener("message", listener));
  }).pipe(Effect.timeout("10 seconds"));
  const evaluate = (expression: string) => cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).pipe(Effect.flatMap((result) => result.exceptionDetails ? Effect.fail(new Error("Smoke renderer evaluation failed")) : Effect.succeed(result.result.value)));
  const initial = yield* evaluate("({title:document.title,connected:document.body.innerText.includes('已连接本地服务'),bridge:typeof window.aut?.request==='function'})");
  yield* assert(initial.connected && initial.bridge, "The actual packaged renderer did not connect");
  const appearance = yield* evaluate(`(async () => {
    const families = ["Geist Variable", "Geist Mono Variable"];
    const faces = await Promise.all(families.map((name) => document.fonts.load('14px "' + name + '"', "aut")));
    return {
      styles: [...document.styleSheets].map((sheet) => new URL(sheet.href).pathname.split("/").pop()),
      fonts: faces.map((family) => family.some((face) => face.status === "loaded")),
    };
  })()`);
  yield* assert(appearance.styles.join() === "style.css" && appearance.fonts.every(Boolean),
    "Packaged desktop theme or local font assets are missing");
  // These controls portal outside the app root and inject a few library-owned styles.
  yield* evaluate(`window.styleViolations = [];
    document.addEventListener("securitypolicyviolation", event => window.styleViolations.push(event.effectiveDirective)); true`);
  const pressKey = (key: "Enter" | "Escape" | "ArrowDown") => {
    const event = { key, code: key, windowsVirtualKeyCode: { Enter: 13, Escape: 27, ArrowDown: 40 }[key] };
    return cdp("Input.dispatchKeyEvent", { type: "keyDown", ...event, ...(key === "Enter" && { text: "\r" }) }).pipe(
      Effect.zipRight(cdp("Input.dispatchKeyEvent", { type: "keyUp", ...event })),
    );
  };
  yield* until(evaluate("[...document.querySelectorAll('button')].some(b => b.textContent === '撤销创建')"), Boolean);
  yield* evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === '撤销创建').click(); true");
  yield* until(evaluate("document.body.innerText.includes('已撤销创建')"), Boolean);
  const creationRows = yield* jsonFetch(`http://127.0.0.1:${port}/v1/messages`, token);
  const creationReceipt = creationRows.messages.find((message: any) => message.botCreation?.botId === receiptBotId);
  const bots = yield* jsonFetch(`http://127.0.0.1:${port}/v1/bots`, token);
  yield* assert(creationReceipt?.botCreation.status === "undone" && !bots.bots.some((bot: any) => bot.id === receiptBotId), "Packaged undo did not persist the receipt and remove its bot");
  yield* evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Bot').click(); true");
  const primaryCard = yield* until(evaluate("[...document.querySelectorAll('.bot-card')].map(card => ({ name: card.querySelector('h2')?.textContent, role: card.querySelector('.bot-role')?.textContent }))"), (cards) => cards.length === 1 && cards[0].role === '主助手');
  yield* assert(bots.bots.length === 1 && bots.bots[0].system === 'primary' && primaryCard[0].name === 'aut', "The packaged Bot page must expose a single primary assistant");
  yield* evaluate("document.querySelector('.bot-avatar').focus(); true");
  yield* pressKey("Enter");
  yield* until(evaluate("document.activeElement.matches('.character-choices [role=radio][aria-checked=true]')"), Boolean);
  yield* pressKey("Escape");
  yield* until(evaluate("!document.querySelector('[role=dialog]') && document.activeElement.matches('.bot-avatar')"), Boolean);
  yield* evaluate(`const edit = [...document.querySelectorAll('.bot-card button')].find(b => b.textContent === '编辑');
    edit.focus(); edit.click(); true`);
  yield* until(evaluate("!!document.querySelector('[role=dialog] [role=combobox]')"), Boolean);
  yield* evaluate("document.querySelector('[role=dialog] [role=combobox]').focus(); true");
  yield* pressKey("ArrowDown");
  yield* until(evaluate("!!document.querySelector('[role=listbox] [role=option]')"), Boolean);
  for (const appearance of ["dark", "light"]) {
    yield* cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: appearance }] });
    yield* until(evaluate(`(() => {
      const surfaces = [document.documentElement, document.querySelector("input[name=name]"), document.querySelector("[role=dialog]"), document.querySelector("[role=listbox]")];
      return document.documentElement.dataset.appearance === "${appearance}" && surfaces.every(node => node && getComputedStyle(node).colorScheme === "${appearance}");
    })()`), Boolean);
  }
  yield* cdp("Emulation.setEmulatedMedia", { features: [] });
  yield* pressKey("Enter");
  yield* until(evaluate("!document.querySelector('[role=listbox]') && document.activeElement.matches('[role=combobox]')"), Boolean);
  yield* pressKey("Escape");
  yield* until(evaluate("!document.querySelector('[role=dialog]') && document.activeElement.textContent === '编辑'"), Boolean);
  yield* evaluate("document.activeElement.click(); true");
  yield* until(evaluate("!!document.querySelector('[role=dialog] form')"), Boolean);
  const soulDraft = "  Indented instruction\n\nPreserve this line.\n";
  yield* evaluate(`const botForm = document.querySelector('[role=dialog] form');
    botForm.elements.soul.value = ${JSON.stringify(soulDraft)};
    botForm.elements.effort.value = '';
    botForm.elements.mcp.value = '[';
    botForm.requestSubmit(); true`);
  yield* until(evaluate(`(() => {
    const mcp = botForm.elements.mcp;
    const error = document.getElementById(mcp.getAttribute('aria-describedby'));
    return mcp.closest('details').open && document.activeElement === mcp && mcp.getAttribute('aria-invalid') === 'true' && error?.textContent.includes('JSON');
  })()`), Boolean);
  yield* assert(yield* evaluate(`botForm.isConnected && botForm.elements.soul.value === ${JSON.stringify(soulDraft)}`),
    "An invalid MCP draft discarded the Bot editor");
  yield* evaluate("botForm.elements.mcp.value = '[]'; botForm.elements.mcp.closest('details').open = false; botForm.requestSubmit(); true");
  yield* until(evaluate("!document.querySelector('[role=dialog]')"), Boolean);
  const savedBots = yield* jsonFetch(`http://127.0.0.1:${port}/v1/bots`, token);
  const savedPrimary = savedBots.bots.find((bot: any) => bot.id === bots.bots[0].id);
  yield* assert(savedPrimary?.system === "primary" && savedPrimary.soul === soulDraft &&
    savedPrimary.modelSelection.instanceId === "local" && savedPrimary.modelSelection.effort === undefined,
    "Saving the Bot editor changed identity, whitespace, the selected instance or empty effort");
  yield* evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='设置').click(); true");
  const settings = yield* evaluate("({password:!!document.querySelector('input[type=password]'),save:[...document.querySelectorAll('button')].some(button=>button.textContent==='保存密钥')})");
  yield* assert(settings.password && settings.save, "The packaged settings do not include local secret controls");
  yield* evaluate("document.querySelector('input[aria-label=\"主分类服务密钥\"]').focus(); true");
  yield* cdp("Input.insertText", { text: "packaged-synthetic-key" });
  yield* evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='保存密钥').click(); true");
  yield* until(evaluate("document.querySelector('input[aria-label=\"主分类服务密钥\"]').value===''"), Boolean);
  const keyStatus = yield* evaluate("window.aut.request({method:'GET',path:'/v1/secrets/status?ref=secret:primary'})");
  yield* assert(keyStatus.ok && keyStatus.data.configured, "The packaged credential IPC path failed");
  yield* evaluate(`const settingsForm = document.querySelector('.settings-form');
    settingsForm.querySelector('[name$=".name"]').value = 'Edited CLI';
    settingsForm.querySelector('[name$=".env"]').value = JSON.stringify({ AUT_SMOKE: '1' });
    settingsForm.requestSubmit(); true`);
  const savedConfig = yield* until(jsonFetch(`http://127.0.0.1:${port}/v1/config`, token),
    (config) => config.harnessInstances[0]?.name === "Edited CLI");
  const [savedInstance] = savedConfig.harnessInstances;
  yield* assert(savedInstance.id === "local" && savedInstance.command === "codex" &&
    savedInstance.env?.AUT_SMOKE === "1" && savedConfig.classifier === undefined,
    "Saving settings did not round-trip the harness fields or the optional classifier");
  const screenshot = yield* cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidenceDirectory, "desktop-packaged.png"), Buffer.from(screenshot.data, "base64"));
  yield* jsonFetch(`http://127.0.0.1:${port}/v1/messages`, token, { id: "packaged-no-classifier", text: "合成测试：确认完整 chief 已启动。" });
  const thread = yield* until(jsonFetch(`http://127.0.0.1:${port}/v1/messages`, token), (response) => response.messages.some((message: any) => message.kind === "clarify-card"));
  yield* evaluate("document.querySelector('button[data-view=conversation]').click(); true");
  yield* until(evaluate("!!document.querySelector('.message-more')"), Boolean);
  yield* evaluate(`document.querySelector('.message:has(.message-more) [data-chat-bubble]')
    .dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:innerWidth-2, clientY:innerHeight-2})); true`);
  yield* until(evaluate(`(() => {
    const menu = document.querySelector('[role=menu]');
    if (!menu?.querySelector('[role=menuitem]')) return false;
    const rect = menu.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  })()`), Boolean);
  yield* pressKey("Escape");
  yield* until(evaluate("!document.querySelector('[role=menu]') && document.activeElement.matches('.message-more')"), Boolean);
  const styleViolations = yield* evaluate("window.styleViolations");
  yield* assert(styleViolations.length === 0, "Packaged overlays violated the desktop CSP");
  const mcp = join(app, "Contents/Resources/daemon/stdio.js");
  yield* assert(existsSync(mcp), "The packaged MCP stdio resource is missing");
  yield* evaluate("window.close(); true").pipe(Effect.catchAll(() => Effect.void));
  yield* until(Effect.sync(() => appExited), Boolean);
  const afterClose = yield* jsonFetch(`http://127.0.0.1:${port}/v1/health`, token);
  yield* assert(afterClose.status === "ok" && running(ownedDaemon), "Closing the desktop also stopped the daemon");
  const result = { at: new Date().toISOString(), architecture: process.arch, appPath: app, isolatedDataAndProfile: true, modelSource: "Reused model from successful live acceptance; no discovery or model task was launched", renderer: initial, appearance, overlays: { viewportCollision: true, restoredFocus: true, styleViolations }, primaryCard, secretControls: settings, secretSavedThroughPackagedIpc: true, chiefFallbackCard: thread.messages.find((message: any) => message.kind === "clarify-card").text, bundledMcpStdio: true, windowClosed: true, daemonHealthyAfterWindowClose: true, daemonPid: ownedDaemon, uiPid: child.pid };
  return { ...result, creationUndo: creationReceipt.botCreation, botEditSaved: true, settingsSaved: true };
})).pipe(Effect.timeout("2 minutes")));
if (ownedDaemon) await Effect.runPromise(until(Effect.sync(() => !running(ownedDaemon!)), Boolean));
writeFileSync(join(evidenceDirectory, "desktop-packaged.json"), `${JSON.stringify({ ...result, ownedDaemonStoppedAfterSmoke: true }, null, 2)}\n`);
console.log(JSON.stringify({ ...result, ownedDaemonStoppedAfterSmoke: true }));
