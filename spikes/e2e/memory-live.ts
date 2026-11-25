// Opt-in acceptance with the configured native Codex provider and real Jev.
// Only this fresh fixture directory is mutated; existing provider configuration is reused.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { memoryDreamTriggerId } from "../../packages/core/dist/index.js";
import {
  BotConfig,
  BotId,
  BotMemoryResponse,
  MemoryFileResponse,
  MemoryGraphResponse,
  ReportResponse,
  TaskResponse,
  TaskSessionResponse,
  TriggerResponse,
  TriggerRunsResponse,
  type Trigger,
} from "../../packages/protocol/dist/index.js";
import {
  assert,
  configurePrimary,
  fixtureDirectory,
  type LiveClient,
  withDaemon,
  writeEvidence,
} from "./support.ts";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required for this opt-in live acceptance probe");

const dataDirectory = fixtureDirectory();
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const nonce = randomUUID().slice(0, 8);
const markerA = `MEMORY_A_${nonce}`;
const markerB = `MEMORY_B_${nonce}`;
const durableFact = `RELEASE_ALIAS_${nonce}`;
const reviewers = ["青禾", "知夏", "望舒", "听澜"] as const;
const reviewer = reviewers[Number.parseInt(nonce.slice(0, 2), 16) % reviewers.length]!;
const releaseFact = "灯塔项目发布前必须完成预演，发布流程依赖预演验收。";
const rehearsalFact = `预演在沙盒环境进行，验收人是${reviewer}，必须核对登录与导出。`;
const progress = (stage: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ stage, ...detail }));
const historyTools = (session: TaskSessionResponse) =>
  session.history.turns.flatMap((turn) =>
    turn.items.flatMap((item) => (item.tool ? [item.tool] : [])),
  );
progress("starting", { dataDirectory, cliVersion });

const completeTrigger = (api: LiveClient, trigger: Trigger) =>
  Effect.gen(function* () {
    const runs = api
      .request(`/v1/triggers/${encodeURIComponent(trigger.id)}/runs`, TriggerRunsResponse)
      .pipe(Effect.map((response) => response.runs));
    const started = yield* api.wait(
      runs,
      (values) =>
        values.some(
          (run) => run.status === "running" || run.status === "ran" || run.status === "failed",
        ),
      "180 seconds",
    );
    const occurrence = started.find(
      (run) => run.status === "running" || run.status === "ran" || run.status === "failed",
    );
    yield* assert(occurrence && occurrence.status !== "failed", "Trigger dispatch failed");
    const taskId = occurrence!.taskId ?? `trigger:${occurrence!.id}`;
    progress("trigger-started", { triggerId: trigger.id, runId: occurrence!.id, taskId });
    const task = api.request(`/v1/tasks/${encodeURIComponent(taskId)}`, TaskResponse);
    const settled = yield* api.wait(
      task,
      ({ task }) => ["idle", "failed", "interrupted", "waiting_user"].includes(task.status),
      "480 seconds",
    );
    yield* assert(settled.task.status === "idle", `Native task settled as ${settled.task.status}`);
    const delivered = yield* api.wait(
      api.messages,
      (values) =>
        values.some(
          (message) =>
            message.kind === "reply" && message.taskId === taskId && message.fullReportRef,
        ),
      "180 seconds",
    );
    const reply = delivered.find(
      (message) => message.kind === "reply" && message.taskId === taskId && message.fullReportRef,
    )!;
    const report = yield* api.request(
      `/v1/reports/${encodeURIComponent(reply.fullReportRef!)}`,
      ReportResponse,
    );
    const finished = yield* api.wait(runs, (values) =>
      values.some((run) => run.id === occurrence!.id && run.status === "ran"),
    );
    const run = finished.find((entry) => entry.id === occurrence!.id)!;
    yield* assert(
      run.taskId === taskId && run.finishedAt !== undefined,
      "Completed occurrence lacks its retained task link",
    );
    const session = yield* api.request(
      `/v1/tasks/${encodeURIComponent(taskId)}/session?limit=20`,
      TaskSessionResponse,
    );
    yield* assert(
      session.availability === "available" && session.history.turns.length > 0,
      "Native session history was not retained",
    );
    progress("trigger-completed", { triggerId: trigger.id, taskId, report: report.text });
    return { run, task: settled.task, report: report.text, reply: reply.text, session };
  });

const result = await Effect.runPromise(
  withDaemon(dataDirectory, (api) =>
    Effect.gen(function* () {
      const primary = yield* configurePrimary(api);
      const makeBot = (suffix: string) => {
        const bot: BotConfig = {
          id: BotId.make(`memory-live-${suffix}`),
          name: `记忆验收 ${suffix}`,
          description: "Synthetic bot memory acceptance only.",
          soul: "You are an isolated synthetic memory acceptance worker. Follow fixture instructions exactly. Fixture memory facts are intentionally durable for this test. Use native file tools only within your own memory directory. Never access external accounts or modify provider configuration. Keep final reports under 100 Chinese characters. Do not ask questions during this fixture.",
          modelSelection: primary.modelSelection,
          cwd: primary.cwd,
        };
        return api
          .request("/v1/bots", Schema.Struct({ bot: BotConfig }), "POST", bot)
          .pipe(Effect.map(({ bot }) => bot));
      };
      const botA = yield* makeBot("a");
      const botB = yield* makeBot("b");
      const memoryPath = (bot: BotConfig) => `/v1/bots/${encodeURIComponent(bot.id)}/memory`;
      const listing = (bot: BotConfig) => api.request(memoryPath(bot), BotMemoryResponse);
      const read = (bot: BotConfig, path: string) =>
        api.request(`${memoryPath(bot)}/file?path=${encodeURIComponent(path)}`, MemoryFileResponse);
      const write = (bot: BotConfig, content: string) =>
        api.request(`${memoryPath(bot)}/file`, MemoryFileResponse, "PUT", {
          path: "MEMORY.md",
          content,
        });
      yield* write(botA, `# Synthetic fixture memory\n\nMemory namespace token: ${markerA}\n`);
      yield* write(botB, `# Synthetic fixture memory\n\nMemory namespace token: ${markerB}\n`);
      const initialA = yield* listing(botA);
      const initialB = yield* listing(botB);
      yield* assert(
        botA.cwd === botB.cwd && initialA.directory !== initialB.directory,
        "Shared-workdir bots do not have isolated memory directories",
      );
      for (const initial of [initialA, initialB]) {
        yield* assert(
          initial.dream?.enabled && initial.dream.id === memoryDreamTriggerId(initial.botId),
          "Default dream plan was not created",
        );
        yield* assert(
          initial.dream?.schedule.kind === "daily" && initial.dream.schedule.at === "03:00",
          "Default dream schedule is not daily at 03:00",
        );
      }
      progress("configured", {
        model: botA.modelSelection.model,
        sameWorkdir: true,
        botIds: [botA.id, botB.id],
      });

      const scheduleWork = (bot: BotConfig, prompt: string, suffix = "initial") =>
        api.request("/v1/triggers", TriggerResponse, "POST", {
          id: `memory-work-${bot.id}-${suffix}`,
          name: `记忆工作验收 ${bot.id}`,
          botId: bot.id,
          prompt,
          payload: { source: "memory-live" },
          schedule: { kind: "once", at: Date.now() + 3_000 },
          enabled: true,
        });
      const workA = yield* scheduleWork(
        botA,
        [
          "这是隔离环境中的记忆验收。请从本次会话已注入的 Current MEMORY.md contents 获取 Memory namespace token，读取它时禁止调用工具或重新打开 MEMORY.md，以证明自动注入。",
          `随后用原生文件工具，把这条已确认且长期有效的测试事实写进系统指定的本会话 notes 文件：Fixture release-train alias: ${durableFact}。不要修改 MEMORY.md 或 knowledge；事实只写入 notes，之后会由定时整理提升。`,
          `同一份 notes 还要记录两个已经确认的关联主题：发布流程——${releaseFact}；预演验收——${rehearsalFact}。这是未来还会使用的知识，先保留原始事实，之后交给做梦整理成关联知识。`,
          "最后只回复：记忆标记：<已注入的 token>；笔记已保存。不要在回复中包含 release-train alias 的值。",
        ].join("\n"),
      );
      const completedA = yield* completeTrigger(api, workA.trigger);
      yield* assert(
        completedA.report.includes(markerA) && !completedA.report.includes(markerB),
        "Bot A did not report its injected namespace token",
      );
      yield* assert(
        historyTools(completedA.session).length > 0 &&
          historyTools(completedA.session).every((tool) => !tool.input.includes("MEMORY.md")),
        "Bot A reread core memory instead of using the injected entry",
      );
      const afterWorkA = yield* listing(botA);
      const noteFiles = afterWorkA.files.filter((file) => file.path.startsWith("notes/"));
      const notes = yield* Effect.forEach(noteFiles, (file) =>
        read(botA, file.path).pipe(Effect.map(({ file }) => file)),
      );
      yield* assert(
        notes.some(
          (file) =>
            file.content.includes(durableFact) &&
            file.content.includes(reviewer) &&
            file.content.includes("登录") &&
            file.content.includes("导出"),
        ),
        "Native worker did not write the durable note facts",
      );
      yield* assert(
        !(yield* read(botA, "MEMORY.md")).file.content.includes(durableFact),
        "Worker prematurely promoted the note fact",
      );
      yield* assert(
        !(yield* listing(botB)).files.some((file) => file.path.startsWith("notes/")),
        "Bot A wrote into Bot B's notes",
      );

      const workB = yield* scheduleWork(
        botB,
        "这是隔离环境中的记忆验收。仅从已注入的 Current MEMORY.md contents 读取 Memory namespace token，禁止调用任何工具或重新读取文件。只回复：记忆标记：<已注入的 token>。不要记录笔记。",
      );
      const completedB = yield* completeTrigger(api, workB.trigger);
      yield* assert(
        completedB.report.includes(markerB) && !completedB.report.includes(markerA),
        "Bot B did not receive its own isolated injected namespace token",
      );
      yield* assert(
        historyTools(completedB.session).length === 0,
        "Bot B used tools instead of reading its injected memory",
      );

      const dreamId = memoryDreamTriggerId(botA.id);
      const scheduledDream = yield* api.request(
        `/v1/triggers/${encodeURIComponent(dreamId)}`,
        TriggerResponse,
        "PUT",
        {
          schedule: { kind: "once", at: Date.now() + 3_000 },
          enabled: true,
          prompt:
            "执行本 bot 的记忆整理验收。先用 list_tasks 和 read_task_session 检查本 bot 最近普通工作会话的原始记录，再整理 notes。把已确认的 Fixture release-train alias 提升到 knowledge/；保留原有 namespace token。将发布流程与预演验收分别整理为两个知识主题，发布流程使用标准相对 Markdown 链接引用预演验收，文件命名自由。在 MEMORY.md 中为这两个主题保留简短的 Markdown 链接入口，不展开具体验收人和检查项，详细事实只保存在知识文档中。不要创建新的测试值，不要访问其他 bot 的目录。最终用简短中文说明整理结果，不必复述测试标记。",
        },
      );
      const completedDream = yield* completeTrigger(api, scheduledDream.trigger);
      const finalA = yield* listing(botA);
      const finalB = yield* listing(botB);
      const consolidatedEntries = finalA.files.filter(
        (file) => file.path === "MEMORY.md" || file.path.startsWith("knowledge/"),
      );
      const consolidated = yield* Effect.forEach(consolidatedEntries, (file) =>
        read(botA, file.path).pipe(Effect.map(({ file }) => file)),
      );
      yield* assert(
        consolidated.some((file) => file.content.includes(durableFact)),
        "Dream did not promote the durable note fact into core memory or knowledge",
      );
      const core = consolidated.find((file) => file.path === "MEMORY.md")!;
      const graph = yield* api.request(`${memoryPath(botA)}/graph`, MemoryGraphResponse);
      yield* assert(graph.botId === botA.id, "Graph returned another Bot's namespace");
      const relation = graph.edges.find((edge) => {
        const source = consolidated.find((file) => file.path === edge.source);
        const target = consolidated.find((file) => file.path === edge.target);
        return (
          source !== undefined &&
          target !== undefined &&
          source.path !== target.path &&
          source.content.includes("发布") &&
          source.content.includes("预演") &&
          target.content.includes(reviewer) &&
          target.content.includes("登录") &&
          target.content.includes("导出")
        );
      });
      yield* assert(relation, "Dream did not connect the release procedure to rehearsal knowledge");
      yield* assert(graph.brokenLinks.length === 0, "Dream left broken knowledge links");
      yield* assert(
        graph.nodes.some((node) => core.content.includes(node.path)),
        "Core memory did not retain an entry link into the knowledge graph",
      );
      yield* assert(
        !core.content.includes(reviewer) && !core.content.includes("登录"),
        "Core memory expanded the rehearsal facts instead of keeping a short knowledge entry",
      );
      const botBGraph = yield* api.request(`${memoryPath(botB)}/graph`, MemoryGraphResponse);
      yield* assert(
        botBGraph.nodes.length === 0 && botBGraph.edges.length === 0,
        "Bot A's knowledge relations leaked into Bot B's graph",
      );
      yield* assert(
        (yield* read(botA, "MEMORY.md")).file.content.includes(markerA),
        "Dream lost the existing namespace token",
      );
      yield* assert(
        (yield* read(botB, "MEMORY.md")).file.content ===
          `# Synthetic fixture memory\n\nMemory namespace token: ${markerB}\n`,
        "Bot B's memory changed while Bot A consolidated",
      );
      yield* assert(finalB.files.length === 1, "Unrelated Bot B memory gained files");
      yield* assert(
        finalA.snapshots.some((snapshot) => snapshot.reason === "dream"),
        "Dream did not save its review snapshot",
      );
      yield* assert(
        completedDream.task.session.cursor &&
          completedA.task.session.cursor &&
          JSON.stringify(completedDream.task.session.cursor) !==
            JSON.stringify(completedA.task.session.cursor),
        "Dream reused the working session",
      );
      yield* assert(
        completedDream.task.botId === botA.id &&
          completedDream.task.session.instanceId === botA.modelSelection.instanceId,
        "Dream switched Bot or Harness instance",
      );
      const dreamTools = historyTools(completedDream.session);
      const originalSessionRead = dreamTools.some(
        (tool) =>
          tool.name.includes("read_task_session") || tool.input.includes("read_task_session"),
      );
      yield* assert(originalSessionRead, "Dream did not exercise the original-session MCP reader");

      // The follow-up contains no answer facts: successful tool output must supply them.
      const recall = yield* scheduleWork(
        botA,
        "根据当前核心记忆里的知识入口，帮我确认灯塔项目发布前预演在哪里进行、由谁验收、必须核对什么。先阅读发布流程，再沿其中的链接阅读预演验收文档，不要读取历史任务或 notes，不要修改任何文件。直接用一句简短中文回答，不要复述测试标记。",
        "recall",
      );
      const completedRecall = yield* completeTrigger(api, recall.trigger);
      const recallTools = historyTools(completedRecall.session);
      const recalledKnowledge = recallTools.filter(
        (tool) =>
          tool.output.includes(reviewer) &&
          tool.output.includes("登录") &&
          tool.output.includes("导出") &&
          (tool.exitCode === undefined || tool.exitCode === 0) &&
          !tool.name.includes("read_task_session"),
      );
      yield* assert(
        recalledKnowledge.length > 0 &&
          [relation!.source, relation!.target].every((path) =>
            recallTools.some(
              (tool) => tool.input.includes(path) || tool.input.includes(path.split("/").at(-1)!),
            ),
          ),
        "Fresh worker did not read the linked release and rehearsal documents through native tools",
      );
      yield* assert(
        recallTools.every(
          (tool) =>
            !tool.name.includes("read_task_session") &&
            !tool.input.includes("read_task_session") &&
            !tool.input.includes("notes/"),
        ),
        "Fresh worker used raw history or notes instead of the consolidated knowledge",
      );
      yield* assert(
        completedRecall.report.includes(reviewer) &&
          completedRecall.report.includes("沙盒") &&
          completedRecall.report.includes("登录") &&
          completedRecall.report.includes("导出"),
        "Fresh worker did not answer from the consolidated knowledge",
      );
      yield* assert(
        JSON.stringify(completedRecall.task.session.cursor) !==
          JSON.stringify(completedA.task.session.cursor) &&
          JSON.stringify(completedRecall.task.session.cursor) !==
            JSON.stringify(completedDream.task.session.cursor),
        "Recall did not use a fresh working session",
      );
      const afterRecall = yield* Effect.forEach(consolidatedEntries, (file) =>
        read(botA, file.path).pipe(Effect.map(({ file }) => file)),
      );
      yield* assert(
        afterRecall.every((file, index) => file.content === consolidated[index]?.content),
        "Read-only knowledge recall modified existing memory",
      );
      yield* assert(
        JSON.stringify((yield* listing(botA)).files) === JSON.stringify(finalA.files),
        "Read-only knowledge recall changed the memory file listing",
      );
      const logs = yield* api.logs;
      const triggerLogs = logs.filter((log) => log.tree === "trigger" && log.execution.ok);
      yield* assert(triggerLogs.length >= 4, "Trigger decision logging is incomplete");
      const replyGates = logs
        .filter((log) => log.tree === "reply-gate")
        .map((log) => ({
          id: log.id,
          output: log.output,
          calls: log.classifierCalls.map((call) => ({
            backend: call.backend,
            model: call.model,
            response: call.response,
            latencyMs: call.latencyMs,
          })),
        }));
      yield* assert(
        replyGates.length >= 4 &&
          replyGates.every((gate) =>
            gate.calls.some((call) => call.backend === "jev" && call.response !== undefined),
          ),
        "Real Jev readability responses were not recorded",
      );

      const summarize = (completed: typeof completedA) => ({
        run: completed.run,
        task: {
          id: completed.task.id,
          botId: completed.task.botId,
          status: completed.task.status,
          session: completed.task.session,
        },
        report: completed.report,
        reply: completed.reply,
        history: {
          availability: completed.session.availability,
          turns: completed.session.history.turns.length,
          tools: historyTools(completed.session).map((tool) => tool.name),
        },
      });
      return {
        at: new Date().toISOString(),
        cliVersion,
        dataDirectory,
        modelSelection: botA.modelSelection,
        checks: {
          realClassifier: true,
          nativeHarness: true,
          sameWorkdir: true,
          memoryInjected: true,
          nativeNotesWritten: true,
          namespaceIsolation: true,
          defaultDreamOn: true,
          scheduledDreamConsolidated: true,
          separateRetainedDreamSession: true,
          originalSessionRead,
          dreamSnapshot: true,
          knowledgeGraphDerivedFromFiles: true,
          knowledgeRelationVerified: true,
          noBrokenKnowledgeLinks: true,
          conciseCoreKnowledgeEntry: true,
          graphBotIsolation: true,
          freshSessionKnowledgeRecall: true,
          recalledMemoryUnchanged: true,
        },
        defaults: [initialA.dream, initialB.dream],
        workA: summarize(completedA),
        workB: summarize(completedB),
        dream: summarize(completedDream),
        recall: summarize(completedRecall),
        knowledgeGraph: graph,
        verifiedRelation: relation,
        recallEvidence: recalledKnowledge,
        syntheticNotes: notes,
        consolidated,
        snapshots: finalA.snapshots,
        unchangedBotB: finalB.files,
        triggerDecisionLogIds: triggerLogs.map((log) => log.id),
        replyGates,
      };
    }),
  ).pipe(Effect.timeout("25 minutes")),
);

const output =
  process.env.AUT_E2E_RESULT ?? join("spikes/e2e/results", "memory-graph-live-0.171.0.json");
await Effect.runPromise(writeEvidence(output, result));
progress("complete", { output, checks: result.checks });
