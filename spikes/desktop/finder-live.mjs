// Opt-in packaged macOS acceptance. LaunchServices starts a new isolated desktop/profile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { JEV_ENDPOINT, JEV_MODEL } from "../../packages/classifier/dist/index.js";

if (!process.env.TYPESAFE_API_KEY || !process.env.AUT_PACKAGE_OUT)
  throw new Error("Select a packaged build and supply the opt-in classifier key");
const app = resolve(process.env.AUT_PACKAGE_OUT, `aut-darwin-${process.arch}/aut.app`);
const root = mkdtempSync(join(tmpdir(), "aut-launchservices-"));
const directory = join(root, "data");
const profile = join(root, "profile");
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const port = await freePort(),
  debug = await freePort();
const url = `http://127.0.0.1:${port}`;
async function wait(read, stage, seconds = 90) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await pause(160);
  }
  throw new Error(`Timed out at ${stage}`);
}
const launch = () =>
  execFileSync("/usr/bin/open", [
    "-n",
    "-g",
    "-a",
    app,
    "--env",
    `AUT_DATA_DIR=${directory}`,
    "--env",
    `AUT_DESKTOP_PROFILE=${profile}`,
    "--env",
    `AUT_PORT=${port}`,
    "--env",
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    "--args",
    `--remote-debugging-port=${debug}`,
  ]);
function processes() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean);
  const window = rows.find(
    (row) =>
      row[3].startsWith(`${app}/Contents/MacOS/aut `) &&
      row[3].includes(`--remote-debugging-port=${debug}`),
  );
  return {
    ui: window && Number(window[1]),
    daemon:
      window &&
      Number(
        rows.find(
          (row) => row[2] === window[1] && row[3].endsWith("/Contents/Resources/daemon/main.mjs"),
        )?.[1],
      ),
  };
}
let token, ownedDaemon;
const api = async (path, method = "GET", body) => {
  const response = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `${method} ${path} returned ${response.status}`);
  return response.json();
};
async function connect() {
  const page = await wait(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(
        (p) => p.type === "page" && p.url.startsWith("file:"),
      );
    } catch {
      return false;
    }
  }, "packaged renderer");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    socket.onopen = res;
    socket.onerror = rej;
  });
  let serial = 0;
  const evaluate = async (fn, ...args) => {
    const id = ++serial;
    return new Promise((res, rej) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
        rej(new Error("Renderer command timed out"));
      }, 10000);
      socket.addEventListener(
        "message",
        (event) => {
          const msg = JSON.parse(String(event.data));
          if (msg.id !== id) return;
          clearTimeout(timeout);
          controller.abort();
          if (msg.error || msg.result.exceptionDetails)
            rej(
              new Error(
                msg.result?.exceptionDetails?.exception?.description ?? "Renderer command failed",
              ),
            );
          else res(msg.result.result.value);
        },
        { signal: controller.signal },
      );
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: `(${fn})(${args.map((v) => JSON.stringify(v)).join(",")})`,
            returnByValue: true,
          },
        }),
      );
    });
  };
  await wait(
    () => evaluate(() => Boolean(document.querySelector(".composer textarea"))),
    "React conversation",
  );
  return { evaluate, close: () => socket.close() };
}
const report = {
  at: new Date().toISOString(),
  cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  launch: "/usr/bin/open -n -g",
  initialPath: "/usr/bin:/bin:/usr/sbin:/sbin",
  scope: "empty local data directory and dedicated Electron profile",
};
let ui;
const stage = (name) => console.log(JSON.stringify({ stage: name, root }));
try {
  stage("launch");
  launch();
  ui = await connect();
  ownedDaemon = processes().daemon;
  assert.ok(ownedDaemon);
  token = readFileSync(join(directory, "daemon-token"), "utf8").trim();
  const initial = (await api("/v1/bots")).bots;
  const primary = initial.find((b) => b.system === "primary");
  assert.ok(primary && initial.length === 1);
  report.discoveredSystems = initial.map((b) => b.system);
  report.model = primary.modelSelection.model;
  const config = await api("/v1/config");
  const { apiKeyRef } = await api("/v1/secrets", "POST", {
    name: "finder-probe",
    key: process.env.TYPESAFE_API_KEY,
  });
  await api("/v1/config", "PUT", {
    ...config,
    classifier: {
      primary: { backend: "jev", model: JEV_MODEL, endpoint: JEV_ENDPOINT, apiKeyRef },
    },
  });
  const click = (label) =>
    ui.evaluate((label) => {
      const b = [...document.querySelectorAll("button")].find(
        (b) =>
          (b.getAttribute("aria-label") === label || b.textContent.trim() === label) &&
          b.getClientRects().length,
      );
      if (!b) return false;
      b.click();
      return true;
    }, label);
  assert.ok(await click("Bot"));
  await wait(() => click("新建 Bot"), "Bot editor");
  const fields = {
    id: "finder-questions",
    name: "颜色问答员",
    description: "处理颜色问答测试，询问颜色并记录答案。",
    model: report.model,
    effort: "low",
    cwd: directory,
    soul: "For this synthetic test, when asked to verify a color, call request_user_input exactly once. Ask one question with id fixture_color, header Color, text Which fixture color?, options Blue and Red. Wait for the user's explicit answer. After receiving it, reply in Chinese with the selected color. Do not answer the question yourself.",
  };
  await ui.evaluate((fields) => {
    const form = document.querySelector('[role="dialog"] form');
    for (const [key, value] of Object.entries(fields)) form.elements.namedItem(key).value = value;
    form.requestSubmit();
  }, fields);
  await wait(
    async () => (await api("/v1/bots")).bots.some((b) => b.id === fields.id),
    "manual Bot saved",
  );
  assert.ok(await click("主会话"));
  const submitMeasured = async (text) => {
    await ui.evaluate((text) => {
      const ids = new Set(
        [...document.querySelectorAll("[data-message-id]")].map((row) => row.dataset.messageId),
      );
      const start = performance.now();
      window.autProbeAck = undefined;
      const observer = new MutationObserver(() => {
        const row = [
          ...document.querySelectorAll(".kind-ack,.kind-clarify-card,.kind-notice"),
        ].find((el) => !ids.has(el.dataset.messageId));
        if (row) {
          window.autProbeAck = {
            messageId: row.dataset.messageId,
            rendererMs: Math.round(performance.now() - start),
          };
          observer.disconnect();
        }
      });
      observer.observe(document.querySelector(".message-feed"), { subtree: true, childList: true });
      const el = document.querySelector(".composer textarea");
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.form.requestSubmit();
    }, text);
    const visible = await wait(
      () => ui.evaluate(() => window.autProbeAck),
      "rendered routing acknowledgement",
    );
    const db = new DatabaseSync(join(directory, "aut.db"), { readOnly: true });
    try {
      const record = (table, id) =>
        JSON.parse(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id).data);
      const ack = record("main_thread_messages", visible.messageId);
      const log = record("decision_logs", ack.decisionLogId),
        event = record("events", log.input.eventRef);
      const classifierMs = log.classifierCalls.reduce((n, c) => n + c.latencyMs, 0);
      const persistedMs = ack.at - event.at;
      return {
        decisionId: log.id,
        output: log.output.op,
        rendererMs: visible.rendererMs,
        persistedMs,
        classifierMs,
        beforeTreeMs: log.at - event.at,
        otherDaemonMs: persistedMs - classifierMs,
      };
    } finally {
      db.close();
    }
  };
  report.routingTimings = [await submitMeasured("请颜色问答员开始一个新的颜色问答测试。")];
  const messages = async () => (await api("/v1/messages?limit=50")).messages;
  const card = await wait(
    async () => (await messages()).find((m) => m.kind === "question-card"),
    "native color question",
  );
  const request = (await api(`/v1/requests/${encodeURIComponent(card.card.requestId)}`)).request;
  assert.equal(request.questions.length, 1);
  const [question] = request.questions;
  assert.equal(question.id, "fixture_color");
  assert.equal(question.text, "Which fixture color?");
  assert.deepEqual(
    question.options.map((o) => o.label),
    ["Blue", "Red"],
  );
  await wait(
    () =>
      ui.evaluate(
        (id, option) => {
          const button = document.querySelector(
            `[data-message-id="${CSS.escape(id)}"] [data-ask-choice="${CSS.escape(option)}"]`,
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        },
        card.id,
        question.options[0].id,
      ),
    "answer in native renderer",
  );
  const reply = await wait(
    async () => (await messages()).find((m) => m.kind === "reply" && m.taskId === card.taskId),
    "native reply",
    180,
  );
  assert.match(
    (await api(`/v1/reports/${encodeURIComponent(reply.fullReportRef)}`)).text,
    /Blue|蓝/i,
  );
  assert.equal(
    (await api(`/v1/requests/${encodeURIComponent(card.card.requestId)}`)).answerState,
    "delivered",
  );
  report.manualBotId = fields.id;
  report.questionDelivered = true;
  report.originalReply = reply.text;
  for (const text of [
    "刚才的颜色问答任务现在是什么状态？",
    "颜色问答任务目前还在运行吗？",
    "这个颜色问答任务现在空闲了吗？",
  ]) {
    report.routingTimings.push(await submitMeasured(text));
  }
  const old = (await messages()).find((m) => m.dispatch?.botId === fields.id);
  const openCorrection = async (id) =>
    wait(
      () =>
        ui.evaluate((id) => {
          const b = [
            ...(document
              .querySelector(`[data-message-id="${CSS.escape(id)}"]`)
              ?.querySelectorAll("button") ?? []),
          ].find((b) => b.textContent === "纠正派发");
          if (!b) return false;
          b.click();
          return true;
        }, id),
      "open dispatch correction",
    );
  await openCorrection(old.id);
  await ui.evaluate(() => {
    const select = document.querySelector('[role="dialog"] [role="combobox"]');
    select.focus();
    select.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
  });
  await wait(() => ui.evaluate((id) => {
    const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.endsWith(`(${id})`));
    if (!option) return false;
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    return true;
  }, primary.id), "target bot option");
  assert.ok(await click("改派并新建任务"));
  const next = await wait(
    async () => (await messages()).find((m) => m.dispatch?.botId === primary.id),
    "reroute via React",
  );
  await openCorrection(next.id);
  assert.ok(await click("撤销并取消原任务"));
  await wait(
    async () => (await messages()).find((m) => m.id === next.id && m.dispatch?.status === "undo"),
    "undo via React",
  );
  report.dispatchStatuses = {
    original: (await messages()).find((m) => m.id === old.id).dispatch.status,
    second: "undo",
  };
  stage("reopen");
  await ui.evaluate(() => {
    setTimeout(() => window.close(), 10);
    return true;
  });
  ui.close();
  await wait(() => !processes().ui, "first window exit");
  assert.equal((await api("/v1/health")).status, "ok");
  launch();
  ui = await connect();
  await wait(
    () =>
      ui.evaluate(
        (id) => Boolean(document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)),
        reply.id,
      ),
    "reopened conversation",
  );
  assert.ok(
    await ui.evaluate(
      () =>
        document.body.innerText.includes("已改派") &&
        document.body.innerText.includes("已撤销派发"),
    ),
  );
  report.reopenedWithReplyAndCorrections = true;
  const out = process.env.AUT_E2E_RESULT ?? join(root, "finder.json");
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  stage("complete");
} finally {
  ui?.close();
  const owned = processes();
  for (const pid of [owned.ui, ownedDaemon ?? owned.daemon])
    if (pid)
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
  rmSync(join(directory, "secrets.json"), { force: true });
}
