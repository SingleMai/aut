// Opt-in: real Codex + Jev, isolated file input, report snapshots and quoted revision.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import { AcceptedResponse, FileResponse, FileContentResponse, MessageResponse, TaskSessionResponse } from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const directory = fixtureDirectory();
const cli = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ stage: "starting", directory, cli }));
const result = await Effect.runPromise(withDaemon(directory, (api) => Effect.gen(function* () {
  const bot = yield* configure(api, directory);
  const input = yield* api.request("/v1/files", FileResponse, "POST", { name: "sales.csv", base64: Buffer.from("item,revenue\nAlpha,10\nBeta,20\nGamma,12\n").toString("base64") });
  const submitted = yield* api.request("/v1/messages", MessageResponse, "POST", {
    text: `请交给${bot.name}做文件验收。读取附件 sales.csv 并计算 revenue 合计。在当前工作目录写一份 report.md，正文必须含 TOTAL=42，再写 summary.csv，包含合计。最终回复以 FILES_V1 开头，用 Markdown 链接交付这两个文件。不提问，不访问外部服务。`, fileIds: [input.file.id],
  });
  const firstRows = yield* api.wait(api.messages, (rows) => rows.some((row) => row.kind === "reply" && row.at >= submitted.message.at && !!row.files?.length), "240 seconds");
  const first = firstRows.find((row) => row.kind === "reply" && row.at >= submitted.message.at && !!row.files?.length);
  yield* assert(first?.files?.length === 2 && first.taskId, "Two file snapshots were not delivered");
  const original = first?.files?.find((file) => file.name === "report.md");
  yield* assert(original, "The original Markdown report is missing");
  const before = yield* api.request(`/v1/files/${original?.id}`, FileContentResponse);
  yield* assert(Buffer.from(before.base64, "base64").toString().includes("TOTAL=42"), "The actual CSV calculation is incorrect");
  console.log(JSON.stringify({ stage: "first-delivery", taskId: first?.taskId, files: first?.files?.map((file) => file.name) }));
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "quote-reply", quotedMessageId: first?.id,
    text: "基于这条回复的 report.md 成果继续修改：读取所附旧版本，在工作目录覆盖 report.md，新版本写 TOTAL=43，并注明这是用户要求的修订值。不要修改附件快照。最终回复以 FILES_V2 开头，只用 Markdown 链接交付 report.md。", });
  const secondRows = yield* api.wait(api.messages, (rows) => rows.some((row) => row.kind === "reply" && row.id !== first?.id && row.taskId === first?.taskId && !!row.files?.length), "240 seconds");
  const second = secondRows.find((row) => row.kind === "reply" && row.id !== first?.id && row.taskId === first?.taskId && !!row.files?.length);
  const revised = second?.files?.find((file) => file.name === "report.md");
  yield* assert(revised && revised.id !== original?.id, "The revised report reused the original file identity");
  const after = yield* api.request(`/v1/files/${original?.id}`, FileContentResponse);
  const revision = yield* api.request(`/v1/files/${revised?.id}`, FileContentResponse);
  yield* assert(after.base64 === before.base64, "The historical report changed after revision");
  yield* assert(Buffer.from(revision.base64, "base64").toString().includes("TOTAL=43"), "The revised report content is incorrect");
  const history = yield* api.request(`/v1/tasks/${first?.taskId}/session`, TaskSessionResponse);
  const logs = yield* api.logs;
  yield* assert(logs.some((log) => log.tree === "inbound" && log.output && "op" in log.output && log.output.op === "send" && log.execution.ok), "The quote did not continue the existing task");
  return { at: new Date().toISOString(), cli, directory, input: input.file, first, second, originalContent: Buffer.from(after.base64, "base64").toString(), revisedContent: Buffer.from(revision.base64, "base64").toString(), nativeTurns: history.history.turns, decisionLogs: logs };
})).pipe(Effect.timeout("10 minutes")));
const output = process.env.AUT_E2E_RESULT ?? join("spikes/e2e/results", "message-files-live.json");
await Effect.runPromise(writeEvidence(output, result));
console.log(JSON.stringify({ stage: "complete", output, versions: [result.first?.id, result.second?.id] }));
