import {
  AcceptedResponse,
  type AutConfig,
  type BotConfig,
  BotConnectionResponse,
  BotMemoryResponse,
  type BotModelDiscoveryInput,
  BotModelOptionsResponse,
  BotModelsResponse,
  BotResponse,
  BotsResponse,
  ConfigResponse,
  type CreateTriggerInput,
  DeletedResponse,
  FileContentResponse,
  FileReleaseResponse,
  FileResponse,
  type FileUploadInput,
  type HarnessInstanceConfig,
  JsonValue,
  McpAuthStartResponse,
  type McpGrantInput,
  McpGrantResponse,
  McpGrantsResponse,
  type McpServerInput,
  McpServerResponse,
  McpServersResponse,
  McpTestResponse,
  MemoryFileResponse,
  MemoryGraphResponse,
  type MemoryWriteInput,
  MessagePageResponse,
  MessageResponse,
  type RemoteHostInput,
  RemoteHostStatus,
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
import type { ApiRequest, ConnectionAction } from "./bridge.js";
import { t } from "./i18n.js";
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
export const connectionAction = (input: ConnectionAction) =>
  Effect.gen(function* () {
    const invoke = window.aut.connection;
    if (!invoke) return yield* Effect.fail(new UiError({ message: "请使用完整的桌面应用。" }));
    const result = yield* Effect.tryPromise({
      try: () => invoke(input),
      catch: () => new UiError({ message: "无法更新执行位置。" }),
    });
    if (!result.ok) return yield* Effect.fail(new UiError({ message: result.error }));
    return result;
  });

const remoteHostUnavailable = () => new UiError({ message: t.remoteHostUnavailable });

export const validate = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(() => new UiError({ message: "请检查必填字段与输入格式。" })),
  );

export const messagePageSize = 50;
const beforeQuery = (before?: string) =>
  before === undefined ? "" : `&before=${encodeURIComponent(before)}`;
const memoryBase = (botId: string) => `/v1/bots/${encodeURIComponent(botId)}/memory`;
const memorySnapshotQuery = (snapshot?: string) =>
  snapshot === undefined ? "" : `snapshot=${encodeURIComponent(snapshot)}`;

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
  listBotModelOptions: () => request("GET", "/v1/bot-models/options", BotModelOptionsResponse),
  discoverBotModels: (input: BotModelDiscoveryInput) =>
    request("POST", "/v1/bot-models/discover", BotModelsResponse, input),
  ensureBotConnection: (input: HarnessInstanceConfig) =>
    request("POST", "/v1/bot-models/connection", BotConnectionResponse, input),
  saveBot: (bot: BotConfig, existingId?: string) =>
    existingId === undefined
      ? request("POST", "/v1/bots", BotResponse, bot)
      : request("PUT", `/v1/bots/${encodeURIComponent(existingId)}`, BotResponse, bot),
  deleteBot: (id: string) =>
    request("DELETE", `/v1/bots/${encodeURIComponent(id)}`, DeletedResponse),
  listBotMemory: (botId: string, snapshot?: string) =>
    request(
      "GET",
      `${memoryBase(botId)}${snapshot === undefined ? "" : `?${memorySnapshotQuery(snapshot)}`}`,
      BotMemoryResponse,
    ),
  getBotMemoryGraph: (botId: string, snapshot?: string) =>
    request(
      "GET",
      `${memoryBase(botId)}/graph${snapshot === undefined ? "" : `?${memorySnapshotQuery(snapshot)}`}`,
      MemoryGraphResponse,
    ),
  readBotMemory: (botId: string, path: string, snapshot?: string) =>
    request(
      "GET",
      `${memoryBase(botId)}/file?path=${encodeURIComponent(path)}${snapshot === undefined ? "" : `&${memorySnapshotQuery(snapshot)}`}`,
      MemoryFileResponse,
    ),
  writeBotMemory: (botId: string, input: MemoryWriteInput) =>
    request("PUT", `${memoryBase(botId)}/file`, MemoryFileResponse, input),
  deleteBotMemory: (botId: string, path: string) =>
    request(
      "DELETE",
      `${memoryBase(botId)}/file?path=${encodeURIComponent(path)}`,
      AcceptedResponse,
    ),
  clearBotMemory: (botId: string) =>
    request("POST", `${memoryBase(botId)}/clear`, AcceptedResponse),
  testRoute: (input: RouteTestInput) => request("POST", "/v1/route-test", RouteTestResponse, input),
  getRemoteHost: () =>
    request("GET", "/v1/remote/host", RemoteHostStatus).pipe(
      Effect.mapError(remoteHostUnavailable),
    ),
  configureRemoteHost: (input: typeof RemoteHostInput.Type) =>
    request("PUT", "/v1/remote/host", RemoteHostStatus, input).pipe(
      Effect.mapError(remoteHostUnavailable),
    ),
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
