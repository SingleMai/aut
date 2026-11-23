import type { BotConfig, JsonValue, McpGrant, McpServer } from "@aut/protocol";
import { McpServerInput, type McpServerInput as McpServerInputType } from "@aut/protocol";
import { Badge, Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import { UiError, validate } from "./api.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { InputField, TextAreaField } from "./ui/form-fields.js";
import { type Flash, useAction } from "./ui/use-action.js";

const parseJson = (value: string, fallback: JsonValue) =>
  Effect.try({
    try: () => (value.trim() ? (JSON.parse(value) as JsonValue) : fallback),
    catch: () => new UiError({ message: "JSON 格式有误，请检查输入。" }),
  });

const serverInput = (form: HTMLFormElement, transport: McpServerInputType["transport"]) => {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? "").trim();
  if (transport === "stdio")
    return Effect.all({
      args: parseJson(text("args"), []),
      env: parseJson(text("env"), {}),
    }).pipe(
      Effect.flatMap(({ args, env }) =>
        validate(McpServerInput, {
          name: text("name"),
          transport,
          command: text("command"),
          args,
          ...(text("cwd") ? { cwd: text("cwd") } : {}),
          env,
        }),
      ),
    );
  return parseJson(text("headers"), {}).pipe(
    Effect.flatMap((headers) =>
      validate(McpServerInput, {
        name: text("name"),
        transport,
        url: text("url"),
        headers,
      }),
    ),
  );
};

function ServerForm({
  server,
  flash,
  busy,
  onSave,
  onCancel,
}: {
  server?: McpServer;
  flash: Flash;
  busy: boolean;
  onSave: (input: McpServerInput) => void;
  onCancel: () => void;
}) {
  const [transport, setTransport] = useState<McpServerInputType["transport"]>(
    server?.transport ?? "stdio",
  );
  return (
    <form
      className="detail-card editor-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        serverInput(form, transport).pipe(
          Effect.tap((value) => Effect.sync(() => onSave(value))),
          Effect.catchTag("UiError", (error) => Effect.sync(() => flash(error.message))),
          Effect.runFork,
        );
      }}
    >
      <div className="form-body">
        <InputField name="name" label={t.name} defaultValue={server?.name ?? ""} required />
        <label className="field-label" htmlFor="mcp-transport">
          {t.mcpTransport}
        </label>
        <select
          id="mcp-transport"
          name="transport"
          value={transport}
          onChange={(event) => setTransport(event.target.value as McpServerInputType["transport"])}
        >
          <option value="stdio">{t.mcpStdio}</option>
          <option value="http">{t.mcpHttp}</option>
          <option value="sse">{t.mcpSse}</option>
        </select>
        {transport === "stdio" ? (
          <>
            <InputField
              name="command"
              label={t.mcpServerCommand}
              defaultValue={server?.transport === "stdio" ? server.command : ""}
              required
            />
            <InputField
              name="args"
              label={t.mcpServerArgs}
              defaultValue={JSON.stringify(server?.transport === "stdio" ? server.args : [])}
              wide
            />
            <InputField
              name="cwd"
              label={t.cwd}
              defaultValue={server?.transport === "stdio" ? (server.cwd ?? "") : ""}
            />
            <TextAreaField
              name="env"
              label={t.mcpServerEnv}
              defaultValue={JSON.stringify(
                server?.transport === "stdio" ? (server.env ?? {}) : {},
                null,
                2,
              )}
              wide
            />
          </>
        ) : (
          <>
            <InputField
              name="url"
              label={t.mcpServerUrl}
              defaultValue={server?.transport === "stdio" ? "" : (server?.url ?? "")}
              required
              wide
            />
            <TextAreaField
              name="headers"
              label={t.mcpServerHeaders}
              defaultValue={JSON.stringify(
                server?.transport === "stdio" ? {} : (server?.headers ?? {}),
                null,
                2,
              )}
              wide
            />
          </>
        )}
      </div>
      <div className="form-actions">
        <Button type="button" color="gray" variant="surface" onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={busy}>
          {t.mcpServerSave}
        </Button>
      </div>
    </form>
  );
}

function GrantRows({
  server,
  bots,
  grants,
  data,
  flash,
}: {
  server: McpServer;
  bots: readonly BotConfig[];
  grants: ReadonlyMap<string, McpGrant>;
  data: DesktopData;
  flash: Flash;
}) {
  const update = useAction(flash);
  if (!bots.length) return <p className="muted">{t.mcpServerNoBots}</p>;
  return (
    <div className="mcp-grants">
      {bots.map((bot) => {
        const grant = grants.get(bot.id);
        const allowed = new Set(grant?.allowedTools ?? []);
        return (
          <section key={bot.id} className="mcp-grant-row">
            <label>
              <input
                type="checkbox"
                checked={grant?.enabled ?? false}
                onChange={(event) =>
                  update.run(
                    data
                      .setMcpGrant(bot.id, server.id, {
                        enabled: event.target.checked,
                        allowedTools: [...allowed],
                      })
                      .pipe(
                        Effect.tap(() => Effect.sync(() => flash(t.saved))),
                        Effect.zipRight(data.refresh(["mcp"])),
                      ),
                  )
                }
              />
              {bot.name}
            </label>
            {server.tools.map((tool) => (
              <label key={`${bot.id}:${tool.name}`} className="mcp-tool-check">
                <input
                  type="checkbox"
                  disabled={!grant?.enabled}
                  checked={allowed.has(tool.name)}
                  onChange={(event) => {
                    const next = new Set(allowed);
                    if (event.target.checked) next.add(tool.name);
                    else next.delete(tool.name);
                    update.run(
                      data
                        .setMcpGrant(bot.id, server.id, {
                          enabled: grant?.enabled ?? false,
                          allowedTools: [...next],
                        })
                        .pipe(Effect.tap(() => Effect.sync(() => flash(t.saved)))),
                    );
                  }}
                />
                {tool.name}
              </label>
            ))}
          </section>
        );
      })}
    </div>
  );
}

export function McpPage({
  servers,
  bots,
  data,
  flash,
}: {
  servers: readonly McpServer[];
  bots: readonly BotConfig[];
  data: DesktopData;
  flash: Flash;
}) {
  const [editing, setEditing] = useState<McpServer | "new">();
  const [grants, setGrants] = useState<ReadonlyMap<string, ReadonlyMap<string, McpGrant>>>(
    new Map(),
  );
  const save = useAction(flash);
  const remove = useAction(flash);
  useEffect(() => {
    Effect.runPromise(
      Effect.all(
        bots.map((bot) =>
          data.listMcpGrants(bot.id).pipe(Effect.map((value) => [bot.id, value.grants] as const)),
        ),
        { concurrency: "unbounded" },
      ),
    )
      .then((rows) =>
        setGrants(
          new Map(
            rows.map(([botId, values]) => [
              botId,
              new Map(values.map((grant) => [grant.serverId, grant] as const)),
            ]),
          ),
        ),
      )
      .catch(() => undefined);
  }, [bots, data]);
  return (
    <>
      <div className="section-heading">
        <p className="muted">{t.mcpServerHint}</p>
        <Button type="button" onClick={() => setEditing("new")}>
          {t.addMcpServer}
        </Button>
      </div>
      {editing && (
        <ServerForm
          key={editing === "new" ? "new" : editing.id}
          {...(editing === "new" ? {} : { server: editing })}
          flash={flash}
          busy={save.busy}
          onCancel={() => setEditing(undefined)}
          onSave={(input) =>
            save.run(
              (editing === "new"
                ? data.createMcpServer(input)
                : data.updateMcpServer(editing.id, input)
              ).pipe(
                Effect.tap(() => Effect.sync(() => setEditing(undefined))),
                Effect.tap(() => Effect.sync(() => flash(t.saved))),
              ),
            )
          }
        />
      )}
      <div className="bots-grid">
        {!servers.length && <p className="empty-panel">{t.mcpServerNoTools}</p>}
        {servers.map((server) => {
          const serverGrants = new Map<string, McpGrant>();
          for (const bot of bots) {
            const grant = grants.get(bot.id)?.get(server.id);
            if (grant) serverGrants.set(bot.id, grant);
          }
          const status = server.health.status;
          const label =
            server.auth.status === "required"
              ? t.mcpServerAuth
              : status === "ready"
                ? t.mcpServerReady
                : status === "error"
                  ? t.mcpServerError
                  : t.mcpServerUnknown;
          return (
            <article key={server.id} className="bot-card mcp-card">
              <div className="section-heading">
                <h2>{server.name}</h2>
                <Badge color={status === "ready" ? "green" : status === "error" ? "red" : "gray"}>
                  {label}
                </Badge>
              </div>
              <p className="muted">
                {server.transport.toUpperCase()} · {server.tools.length} tools
              </p>
              {server.health.message && <p className="field-error">{server.health.message}</p>}
              <details>
                <summary>{t.mcpServerTools}</summary>
                <ul>
                  {server.tools.map((tool) => (
                    <li key={tool.name}>{tool.name}</li>
                  ))}
                </ul>
              </details>
              <details>
                <summary>{t.mcpServerBots}</summary>
                <GrantRows
                  server={server}
                  bots={bots}
                  grants={serverGrants}
                  data={data}
                  flash={flash}
                />
              </details>
              <div className="toolbar bot-card-actions">
                {server.transport !== "stdio" && (
                  <Button
                    type="button"
                    color={server.auth.status === "authenticated" ? "amber" : "gray"}
                    variant="surface"
                    onClick={() => {
                      if (server.auth.status === "authenticated") {
                        save.run(
                          data
                            .logoutMcpAuth(server.id)
                            .pipe(Effect.tap(() => Effect.sync(() => flash(t.saved)))),
                        );
                        return;
                      }
                      save.run(
                        data.startMcpAuth(server.id).pipe(
                          Effect.tap(({ authorizationUrl }) =>
                            Effect.sync(() => {
                              window.open(authorizationUrl, "_blank", "noopener,noreferrer");
                            }),
                          ),
                        ),
                      );
                    }}
                    disabled={save.busy}
                  >
                    {server.auth.status === "authenticated" ? t.mcpServerLogout : t.mcpServerLogin}
                  </Button>
                )}
                <Button
                  type="button"
                  color="gray"
                  variant="surface"
                  onClick={() => save.run(data.testMcpServer(server.id))}
                  disabled={save.busy}
                >
                  {t.mcpServerTest}
                </Button>
                <Button
                  type="button"
                  color={server.enabled ? "amber" : "green"}
                  variant="soft"
                  onClick={() => save.run(data.setMcpServerEnabled(server.id, !server.enabled))}
                  disabled={save.busy}
                >
                  {server.enabled ? t.mcpServerDisable : t.mcpServerEnable}
                </Button>
                <Button
                  type="button"
                  color="gray"
                  variant="ghost"
                  onClick={() => setEditing(server)}
                >
                  {t.edit}
                </Button>
                <Button
                  type="button"
                  color="red"
                  variant="ghost"
                  onClick={() => remove.run(data.deleteMcpServer(server.id))}
                  disabled={remove.busy}
                >
                  {t.mcpServerDelete}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
