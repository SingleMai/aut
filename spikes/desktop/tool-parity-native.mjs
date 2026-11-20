// Opt-in acceptance of the packaged UI against an existing, idle local daemon.
// Read-only task/session requests; does not send a task, answer, or configuration update.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const previous = JSON.parse(await readFile("/tmp/aut-session-native-state.json", "utf8"));
const before = JSON.parse(await readFile("/tmp/aut-tool-parity-preserve.json", "utf8"));
const dataDirectory = resolve(homedir(), ".aut");
const token = (await readFile(resolve(dataDirectory, "daemon-token"), "utf8")).trim();
const request = async (path) => {
  const response = await fetch(`http://127.0.0.1:4317${path}`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Acceptance GET failed: ${response.status}`);
  return response.json();
};
const tasks = await request("/v1/tasks");
if (tasks.tasks.some((task) => task.status === "running" || task.pendingRequestIds.length || task.queue.length))
  throw new Error("Existing work is active; leave its UI untouched.");
const oldArgs = execFileSync("ps", ["-p", String(previous.appPid), "-o", "command="], { encoding: "utf8" }).trim();
if (!oldArgs.startsWith(previous.app)) throw new Error("Previous owned UI process identity changed.");

const run = resolve(".artifacts/omb-tool-parity/native");
await mkdir(run, { recursive: true });
const oldPages = await (await fetch(`http://127.0.0.1:${previous.debugPort}/json/list`)).json();
const oldPage = oldPages.find((page) => page.type === "page");
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  return {
    socket,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => reject(new Error(`Native acceptance timeout: ${method}`)), 15_000);
        const listener = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          clearTimeout(timer); socket.removeEventListener("message", listener);
          if (message.error) reject(new Error(`Native acceptance CDP failed: ${method}`));
          else resolve(message.result);
        };
        socket.addEventListener("message", listener);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}
const old = await connect(oldPage.webSocketDebuggerUrl);
const draft = await old.call("Runtime.evaluate", { expression: "[...document.querySelectorAll('textarea')].some(input => input.value.length > 0)", returnByValue: true });
old.socket.close();
if (draft.result.value) throw new Error("The existing window has a draft; leave it untouched.");
process.kill(previous.appPid, "SIGTERM");
for (let attempt = 0; attempt < 100; attempt++) {
  try { process.kill(previous.appPid, 0); }
  catch { break; }
  if (attempt === 99) throw new Error("Previous UI did not close; do not launch another window.");
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const log = await open(resolve(run, "app.log"), "a");
const child = spawn(previous.app, [`--remote-debugging-port=${previous.debugPort}`], {
  env: { ...process.env, AUT_DESKTOP_PROFILE: resolve(run, "profile") },
  detached: true, stdio: ["ignore", log.fd, log.fd],
});
child.unref(); await log.close();
const until = async (read, predicate) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (predicate(value)) return value; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Native acceptance condition did not arrive.");
};
const pages = await until(async () => (await fetch(`http://127.0.0.1:${previous.debugPort}/json/list`)).json(), (pages) => pages.some((page) => page.type === "page"));
const connection = await connect(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
const evaluate = async (expression) => {
  const result = await connection.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error("Native renderer assertion evaluation failed.");
  return result.result.value;
};
await until(() => evaluate("!!document.querySelector('.sidebar-task')"), Boolean);
await evaluate("document.querySelector('.sidebar-task').click(); true");
await until(() => evaluate("!!document.querySelector('[data-session-mode]') && !!document.querySelector('.task-session-final')"), Boolean);
await evaluate("document.fonts.ready.then(() => true)");
await evaluate("[...document.querySelectorAll('.tool-run-toggle')].find(button => button.getAttribute('aria-expanded') === 'false')?.click(); true");
await until(() => evaluate("!!document.querySelector('[data-testid=tool-activity]')"), Boolean);
await evaluate("document.querySelector('[data-testid=tool-activity] summary').click(); document.querySelector('[data-testid=tool-activity]').scrollIntoView({block:'center'}); true");
const actual = await until(() => evaluate(`(() => {
  const tool=document.querySelector('[data-testid=tool-activity]');
  const style=getComputedStyle(tool); const body=document.querySelector('.task-session-items');
  return {title:document.title,connected:document.body.innerText.includes('已连接本地服务'),
    toolCount:document.querySelectorAll('[data-testid=tool-activity]').length,open:tool.open,
    width:tool.getBoundingClientRect().width,font:style.fontFamily,fontSize:style.fontSize,
    radius:style.borderRadius,background:style.backgroundColor,
    inputLength:tool.querySelectorAll('pre')[0]?.textContent.length,
    outputLength:tool.querySelectorAll('pre')[1]?.textContent.length,
    bodyWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth,
    finalCount:document.querySelectorAll('.task-session-final').length,
    stylesheet:document.styleSheets.length === 1 && document.styleSheets[0].href?.endsWith('/style.css'),
    fontReady:document.fonts.check('13px "Geist Variable"'),
    composerCount:document.querySelectorAll('textarea').length};
})()`), (value) => value.open && value.stylesheet && value.outputLength > 0);
if (actual.width !== 608 || actual.fontSize !== "13px" || actual.bodyScrollWidth > actual.bodyWidth || actual.composerCount !== 0)
  throw new Error("Native tool layout differs from the aut desktop specification.");
await evaluate("document.querySelector('[data-session-mode]').click(); true");
const advanced = await until(() => evaluate("({pressed:document.querySelector('[data-session-mode]').getAttribute('aria-pressed'),summary:document.querySelector('[data-testid=tool-activity] summary').innerText})"), (value) => value.pressed === "true");
await evaluate("document.querySelector('[data-session-tools]').click(); true");
await until(() => evaluate("document.querySelectorAll('[data-testid=tool-activity]').length===0 && document.querySelectorAll('.task-session-final').length===1"), Boolean);
await evaluate("document.querySelector('[data-session-tools]').click(); document.querySelector('[data-session-mode]').click(); true");
await until(() => evaluate("!!document.querySelector('.tool-run-toggle[aria-expanded=false]')"), Boolean);
await evaluate("document.querySelector('.tool-run-toggle[aria-expanded=false]').click(); true");
await until(() => evaluate("!!document.querySelector('[data-testid=tool-activity]')"), Boolean);
await evaluate("document.querySelector('[data-testid=tool-activity] summary').click(); document.querySelector('[data-testid=tool-activity]').scrollIntoView({block:'center'}); true");
const image = await connection.call("Page.captureScreenshot", { format: "png" });
const screenshot = resolve("spikes/e2e/results/tool-parity-native.png");
await writeFile(screenshot, Buffer.from(image.data, "base64"));
connection.socket.close();
const after = await request("/v1/tasks");
let configPreserved = true;
for (const [name, hash] of Object.entries(before.hashes)) {
  let actualHash=null; try {actualHash=createHash("sha256").update(await readFile(resolve(dataDirectory,name))).digest("hex");} catch {}
  configPreserved &&= actualHash === hash;
}
const tasksPreserved = JSON.stringify(before.tasks) === JSON.stringify(after);
if (!configPreserved || !tasksPreserved) throw new Error("Existing configuration/task changed during acceptance.");
const asar = resolve(previous.app, "../../Resources/app.asar");
const result = { at: new Date().toISOString(), appPid: child.pid, debugPort: previous.debugPort,
  taskIds: tasks.tasks.map(task=>task.id), actual, advanced, hiddenToolsKeepFinal: true,
  tasksPreserved, configPreserved, screenshot, appAsarSha256: createHash("sha256").update(await readFile(asar)).digest("hex") };
await writeFile("spikes/e2e/results/tool-parity-native.json", `${JSON.stringify(result, null, 2)}\n`);
await writeFile("/tmp/aut-tool-parity-native-state.json", JSON.stringify({...previous, appPid:child.pid,run}), {mode:0o600});
await writeFile("/tmp/aut-session-native-state.json", JSON.stringify({...previous, appPid:child.pid,run}), {mode:0o600});
console.log(JSON.stringify(result));
