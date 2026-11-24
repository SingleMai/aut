import {
  AcceptedResponse,
  type AutConfig,
  type BotConfig,
  BotResponse,
  BotsResponse,
  ConfigResponse,
  type CreateTriggerInput,
  DeletedResponse,
  FileContentResponse,
  FileReleaseResponse,
  FileResponse,
  type FileUploadInput,
  JsonValue,
  McpAuthStartResponse,
  type McpGrantInput,
  McpGrantResponse,
  McpGrantsResponse,
  type McpServerInput,
  McpServerResponse,
  McpServersResponse,
  McpTestResponse,
  MessagePageResponse,
  MessageResponse,
  ReportResponse,
  RequestResponse,
  type RouteTestInput,
  RouteTestResponse,
  type SecretSaveInput,
  SecretSaveResponse,
  SecretStatusResponse,
  type SendMessageInput,
  TaskListResponse,
  TaskResponse,
  TaskSessionResponse,
  TriggerResponse,
  TriggerRunsResponse,
  TriggersResponse,
  UiAction,
  type UpdateTriggerInput,
} from "@aut/protocol";
import { Data, Effect, Schema } from "effect";
import type { ApiRequest } from "./bridge.js";
export class UiError extends Data.TaggedError("UiError")<{ readonly message: string }> {}
const request = <A, I>(
  method: ApiRequest["method"],
  path: string,
  schema: Schema.Schema<A, I>,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const value =
      body === undefined
        ? undefined
        : yield* Schema.decodeUnknown(JsonValue)(body).pipe(
            Effect.mapError(() => new UiError({ message: "输入格式无效。" })),
          );
    const result = yield* Effect.tryPromise({
      try: () =>
        window.aut.request({ method, path, ...(value === undefined ? {} : { body: value }) }),
      catch: () => new UiError({ message: "无法连接本地服务。" }),
    });
    if (!result.ok) return yield* Effect.fail(new UiError({ message: result.error.message }));
    return yield* Schema.decodeUnknown(schema)(result.data).pipe(
      Effect.mapError(() => new UiError({ message: "服务返回的数据格式不兼容。" })),
    );
  });
export const validate = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(() => new UiError({ message: "请检查必填字段与输入格式。" })),
  );

export const messagePageSize = 50;
const beforeQuery = (before?: string) =>
  before === undefined ? "" : `&before=${encodeURIComponent(before)}`;

export const desktopApi = {
  uploadFile: (input: FileUploadInput) => request("POST", "/v1/files", FileResponse, input),
  keepFiles: (ids: readonly string[]) =>
    request("POST", "/v1/files/keepalive", AcceptedResponse, { ids: [...ids] }),
  discardFile: (id: string) =>
    request("DELETE", `/v1/files/${encodeURIComponent(id)}`, FileReleaseResponse),
  getFile: (id: string) =>
    request("GET", `/v1/files/${encodeURIComponent(id)}`, FileContentResponse),
  listMessages: (before?: string) =>
    request(
      "GET",
      `/v1/messages?limit=${messagePageSize}${beforeQuery(before)}`,
      MessagePageResponse,
    ),
  sendMessage: (input: typeof SendMessageInput.Encoded) =>
    request("POST", "/v1/messages", MessageResponse, input),
  undoBotCreation: (id: string) =>
    request("POST", `/v1/messages/${encodeURIComponent(id)}/undo-bot-creation`, MessageResponse),
  sendAction: (input: typeof UiAction.Encoded) =>
    validate(UiAction, input).pipe(
      Effect.flatMap((action) => request("POST", "/v1/actions", AcceptedResponse, action)),
    ),
  listTasks: () => request("GET", "/v1/tasks?limit=50", TaskListResponse),
  getTask: (id: string) => request("GET", `/v1/tasks/${encodeURIComponent(id)}`, TaskResponse),
  getTaskSession: (id: string, before?: string) =>
    request(
      "GET",
      `/v1/tasks/${encodeURIComponent(id)}/session?limit=10${beforeQuery(before)}`,
      TaskSessionResponse,
    ),
  getRequest: (id: string) =>
    request("GET", `/v1/requests/${encodeURIComponent(id)}`, RequestResponse),
  getReport: (ref: string) =>
    request("GET", `/v1/reports/${encodeURIComponent(ref)}`, ReportResponse),
  listBots: () => request("GET", "/v1/bots", BotsResponse),
  saveBot: (bot: BotConfig, existingId?: string) =>
    existingId === undefined
      ? request("POST", "/v1/bots", BotResponse, bot)
      : request("PUT", `/v1/bots/${encodeURIComponent(existingId)}`, BotResponse, bot),
  deleteBot: (id: string) =>
    request("DELETE", `/v1/bots/${encodeURIComponent(id)}`, DeletedResponse),
  testRoute: (input: RouteTestInput) => request("POST", "/v1/route-test", RouteTestResponse, input),
  getConfig: () => request("GET", "/v1/config", ConfigResponse),
  saveConfig: (config: AutConfig) => request("PUT", "/v1/config", ConfigResponse, config),
  listMcpServers: () => request("GET", "/v1/mcp/servers", McpServersResponse),
  createMcpServer: (input: typeof McpServerInput.Encoded) =>
    request("POST", "/v1/mcp/servers", McpServerResponse, input),
  updateMcpServer: (id: string, input: typeof McpServerInput.Encoded) =>
    request("PUT", `/v1/mcp/servers/${encodeURIComponent(id)}`, McpServerResponse, input),
  deleteMcpServer: (id: string) =>
    request("DELETE", `/v1/mcp/servers/${encodeURIComponent(id)}`, DeletedResponse),
  testMcpServer: (id: string) =>
    request("POST", `/v1/mcp/servers/${encodeURIComponent(id)}/test`, McpTestResponse),
  setMcpServerEnabled: (id: string, enabled: boolean) =>
    request(
      "POST",
      `/v1/mcp/servers/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
      McpServerResponse,
    ),
  startMcpAuth: (id: string) =>
    request("POST", `/v1/mcp/servers/${encodeURIComponent(id)}/auth/start`, McpAuthStartResponse),
  logoutMcpAuth: (id: string) =>
    request("POST", `/v1/mcp/servers/${encodeURIComponent(id)}/auth/logout`, McpServerResponse),
  listMcpGrants: (botId: string) =>
    request("GET", `/v1/bots/${encodeURIComponent(botId)}/mcp-grants`, McpGrantsResponse),
  setMcpGrant: (botId: string, serverId: string, input: typeof McpGrantInput.Encoded) =>
    request(
      "PUT",
      `/v1/bots/${encodeURIComponent(botId)}/mcp-grants/${encodeURIComponent(serverId)}`,
      McpGrantResponse,
      input,
    ),
  listTriggers: () => request("GET", "/v1/triggers", TriggersResponse),
  createTrigger: (input: typeof CreateTriggerInput.Encoded) =>
    request("POST", "/v1/triggers", TriggerResponse, input),
  updateTrigger: (id: string, input: typeof UpdateTriggerInput.Encoded) =>
    request("PUT", `/v1/triggers/${encodeURIComponent(id)}`, TriggerResponse, input),
  pauseTrigger: (id: string) =>
    request("POST", `/v1/triggers/${encodeURIComponent(id)}/pause`, TriggerResponse),
  resumeTrigger: (id: string) =>
    request("POST", `/v1/triggers/${encodeURIComponent(id)}/resume`, TriggerResponse),
  listTriggerRuns: (id: string) =>
    request("GET", `/v1/triggers/${encodeURIComponent(id)}/runs`, TriggerRunsResponse),
  saveSecret: (input: SecretSaveInput) => request("POST", "/v1/secrets", SecretSaveResponse, input),
  getSecretStatus: (ref: string) =>
    request("GET", `/v1/secrets/status?ref=${encodeURIComponent(ref)}`, SecretStatusResponse),
};
