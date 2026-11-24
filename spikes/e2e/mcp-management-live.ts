// Opt-in: real Codex + Jev + public read-only MCP, with isolated aut configuration.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  McpGrantsResponse, McpServersResponse, MessageResponse, TaskSessionResponse, TriggerRunsResponse, TriggersResponse,
} from "../../packages/protocol/dist/index.js";
import { assert, configurePrimary, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const directory = fixtureDirectory();
const cli = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ stage: "starting", directory, cli }));
const result = await Effect.runPromise(withDaemon(directory, (api) => Effect.gen(function* () {
  const primary = yield* configurePrimary(api);
  const setup = yield* api.request("/v1/messages", MessageResponse, "POST", {
    text: `主助手 aut，请直接为我接入一个 MCP 服务，使用内置 mcp_info 和 mcp_server 工具管理，不使用 shell 或 HTTP 绕过管理工具。服务名 acceptance-search，transport=http，url=https://api.you.com/mcp?profile=free。创建后测试并启用，只给主助手 Bot ${primary.id} 授权 you-search 这一个工具。不要创建其他 Bot，不要提问，不要现在执行搜索。完成后简短报告。`,
  });
  const setupMessages = yield* api.wait(api.messages, (messages) => messages.some((message) => message.kind === "reply" && message.at >= setup.message.at), "240 seconds");
  const server = (yield* api.request("/v1/mcp/servers", McpServersResponse)).servers.find((value) => value.name === "acceptance-search");
  yield* assert(server?.enabled && server.health.status === "ready", "The primary assistant did not enable the tested MCP server");
  if (!server) return yield* Effect.dieMessage("Missing server");
  const grants = yield* api.request(`/v1/bots/${encodeURIComponent(primary.id)}/mcp-grants`, McpGrantsResponse);
  yield* assert(grants.grants.some((grant) => grant.serverId === server.id && grant.enabled && grant.allowedTools.length === 1 && grant.allowedTools[0] === "you-search"), "The exact tool grant was not persisted");
  console.log(JSON.stringify({ stage: "configured", serverId: server.id, tools: server.tools.map((tool) => tool.name) }));
  const at = Date.now() + 60_000;
  yield* api.request("/v1/messages", MessageResponse, "POST", {
    text: `主助手 aut，请使用 create_trigger 为你自己（Bot ${primary.id}）创建一个一次性计划，id=mcp-live-once，name=MCP 搜索验收，schedule={"kind":"once","at":${at}}，enabled=true，payload={}。计划的 prompt 必须是："调用已授权的 you-search MCP 工具，query 为 site:modelcontextprotocol.io introduction MCP，count=1，extraction=none。根据真实结果，用中文一句话解释 MCP 并附来源链接；答案以 MCP_LIVE_OK 开头。不能使用 shell、浏览器或其他搜索工具替代该 MCP 调用。"。请直接创建，不要提前执行，不要提问。`,
  });
  yield* api.wait(api.request("/v1/triggers", TriggersResponse), (value) => value.triggers.some((trigger) => trigger.id === "mcp-live-once"), "180 seconds");
  const runs = yield* api.wait(api.request("/v1/triggers/mcp-live-once/runs", TriggerRunsResponse), (value) => value.runs.some((run) => run.status === "ran"), "300 seconds");
  const run = runs.runs.find((entry) => entry.status === "ran");
  yield* assert(run?.taskId, "The trigger did not complete a task");
  const messages = yield* api.wait(api.messages, (rows) => rows.some((message) => message.kind === "reply" && message.taskId === run?.taskId), "120 seconds");
  const reply = messages.find((message) => message.kind === "reply" && message.taskId === run?.taskId);
  yield* assert(reply?.text.includes("MCP_LIVE_OK") && reply.text.includes("http"), "The scheduled MCP task did not deliver a sourced result");
  const session = yield* api.request(`/v1/tasks/${encodeURIComponent(run?.taskId ?? "")}/session`, TaskSessionResponse);
  const toolCalls = session.history.turns.flatMap((turn) => turn.items).filter((item) => item.kind === "tool");
  const call = toolCalls.find((item) => item.status === "completed" && item.tool?.name === "acceptance-search.you-search");
  yield* assert(call?.tool, "No completed MCP search call was recorded for the scheduled task");
  const searchOutput = JSON.parse(call?.tool?.output ?? "null");
  yield* assert(!searchOutput?.isError && searchOutput?.structuredContent?.results?.web?.length > 0, "The MCP search call did not return a real result");
  const management = [];
  for (const task of (yield* api.tasks).filter((task) => task.id !== run?.taskId)) {
    const history = yield* api.request(`/v1/tasks/${encodeURIComponent(task.id)}/session`, TaskSessionResponse);
    management.push({taskId: task.id, tools: history.history.turns.flatMap((turn) => turn.items).filter((item) => item.kind === "tool")});
  }
  const actions = management.flatMap((row) => row.tools).filter((item) => item.status === "completed" && item.tool?.name === "aut.mcp_server").map((item) => JSON.parse(item.tool?.input ?? "{}").action);
  yield* assert(["create", "test", "enable", "grant"].every((action) => actions.includes(action)), "The primary assistant did not use the MCP management tools");
  const logs = yield* api.logs;
  const triggerLog = logs.find((log) => log.tree === "trigger" && log.execution.ok);
  yield* assert(triggerLog, "The trigger decision log was not persisted");
  return { at: new Date().toISOString(), cli, model: primary.modelSelection.model, directory,
    server: { id: server.id, name: server.name, health: server.health, tools: server.tools.map(({ name, inputSchema }) => ({ name, inputSchema })) },
    grants: grants.grants, setupReplies: setupMessages.filter((message) => message.kind === "reply" && message.at >= setup.message.at).map(({ text }) => text),
    run, reply, toolCalls, management, fullReport: session.history.turns.flatMap((turn) => turn.items).filter((item) => item.kind === "assistant" && item.phase === "final").map((item) => item.text), triggerDecisionLogId: triggerLog?.id,
  };
})).pipe(Effect.timeout("12 minutes")));
const output = process.env.AUT_E2E_RESULT ?? join("spikes/e2e/results", "mcp-management-live.json");
await Effect.runPromise(writeEvidence(output, result));
console.log(JSON.stringify({ stage: "complete", output, reply: result.reply?.text }));
