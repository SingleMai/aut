import { Schema } from "effect";
import { expect, it } from "vitest";
import { ApiRequest } from "./bridge.js";

it.each([
  ["GET", "/v1/bots/bot-1/memory"],
  ["GET", "/v1/bots/bot-1/memory?snapshot=one"],
  ["GET", "/v1/bots/bot-1/memory/file?path=knowledge%2Fplan.md&snapshot=one"],
  ["GET", "/v1/bots/bot-1/memory/graph"],
  ["GET", "/v1/bots/bot-1/memory/graph?snapshot=one"],
  ["PUT", "/v1/bots/bot-1/memory/file"],
  ["DELETE", "/v1/bots/bot-1/memory/file?path=notes%2Fwork.md"],
  ["POST", "/v1/bots/bot-1/memory/clear"],
  ["GET", "/v1/mcp/servers"],
  ["POST", "/v1/mcp/servers"],
  ["PUT", "/v1/mcp/servers/server-1"],
  ["DELETE", "/v1/mcp/servers/server-1"],
  ["POST", "/v1/mcp/servers/server-1/test"],
  ["POST", "/v1/mcp/servers/server-1/enable"],
  ["POST", "/v1/mcp/servers/server-1/disable"],
  ["POST", "/v1/mcp/servers/server-1/auth/start"],
  ["POST", "/v1/mcp/servers/server-1/auth/logout"],
  ["GET", "/v1/bots/bot-1/mcp-grants"],
  ["PUT", "/v1/bots/bot-1/mcp-grants/server-1"],
  ["GET", "/v1/triggers"],
  ["POST", "/v1/triggers"],
  ["PUT", "/v1/triggers/trigger-1"],
  ["GET", "/v1/triggers/trigger-1/runs"],
  ["POST", "/v1/triggers/trigger-1/pause"],
  ["POST", "/v1/triggers/trigger-1/resume"],
])("allows the desktop %s %s contract", (method, path) => {
  expect(Schema.is(ApiRequest)({ method, path })).toBe(true);
});

it.each([
  ["PUT", "/v1/bots/bot-1/memory/file?snapshot=one"],
  ["DELETE", "/v1/bots/bot-1/memory"],
  ["PUT", "/v1/bots/bot-1/memory/graph"],
  ["DELETE", "/v1/bots/bot-1/memory/graph"],
  ["GET", "/v1/bots/bot-1/memory/secret"],
  ["GET", "https://remote.example/v1/mcp/servers"],
  ["GET", "/v1/mcp/servers?token=x"],
  ["PUT", "/v1/mcp/servers/x/auth/start"],
  ["POST", "/v1/bots/x/mcp-grants"],
  ["DELETE", "/v1/triggers/x"],
  ["GET", "/v1/mcp/credentials"],
])("rejects undeclared desktop %s %s routes", (method, path) => {
  expect(Schema.is(ApiRequest)({ method, path })).toBe(false);
});
