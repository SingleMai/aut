// Adapted from the local-server rows in OpenMausBot src/components/McpServersPanel.tsx at
// 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc. Apache-2.0; see NOTICE.
// aut uses existing daemon actions, Radix controls and explicit per-Bot tool grants.
import type { BotConfig, McpGrant, McpServer } from "@aut/protocol";
import { Badge, Button, IconButton, Switch, TextField } from "@radix-ui/themes";
import { Effect } from "effect";
import {
  CheckCircle2,
  FlaskConical,
  Globe,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Search,
  ServerCog,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { UiError } from "../../api.js";
import type { DesktopData } from "../../desktop-data.js";
import { t } from "../../i18n.js";
import { McpGrantFields } from "../../mcp-grant-fields.js";
import { Dialog } from "../../ui/dialog.js";
import { type Flash, useAction } from "../../ui/use-action.js";

export function McpServerCard({
  server,
  bots,
  grants,
  grantsReady,
  disabled = false,
  data,
  flash,
  onEdit,
  onGrant,
}: {
  server: McpServer;
  bots: readonly BotConfig[];
  grants: ReadonlyMap<string, McpGrant>;
  grantsReady: boolean;
  disabled?: boolean;
  data: DesktopData;
  flash: Flash;
  onEdit: () => void;
  onGrant: (grant: McpGrant) => void;
}) {
  const action = useAction(flash);
  const busy = disabled || action.busy;
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const run = <A,>(name: string, effect: Effect.Effect<A, UiError>) =>
    action.run(
      effect.pipe(
        Effect.tapError((failure) => Effect.sync(() => setError(failure.message))),
        Effect.ensuring(Effect.sync(() => setPending(""))),
        (operation) =>
          Effect.sync(() => {
            setPending(name);
            setError("");
          }).pipe(Effect.zipRight(operation)),
      ),
    );
  const ready = server.health.status === "ready";
  const needsAuth = server.auth.status === "required" || server.auth.status === "error";
  const healthText = needsAuth
    ? t.mcpServerAuth
    : ready
      ? `${t.mcpServerReady} · ${server.tools.length} ${t.mcpToolCount}`
      : server.health.status === "error"
        ? t.mcpServerError
        : t.mcpServerUnknown;
  const assigned = [...grants.values()].filter((grant) => grant.enabled).length;
  const query = search.trim().toLowerCase();
  const tools = server.tools.filter((tool) =>
    `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(query),
  );
  const address =
    server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url;
  const credentialNames = Object.keys(
    server.transport === "stdio" ? (server.env ?? {}) : (server.headers ?? {}),
  );
  return (
    <article className="mcp-server-card" data-mcp-server={server.id} aria-label={server.name}>
      <div className="mcp-server-row">
        <div className={`mcp-server-icon${server.enabled ? " is-enabled" : ""}`}>
          {server.transport === "stdio" ? <ServerCog size={20} /> : <Globe size={20} />}
        </div>
        <div className="mcp-server-info">
          <div className="mcp-server-name">
            <h3>{server.name}</h3>
            <Badge color={server.enabled ? "green" : "gray"} size="1">
              {server.enabled ? t.mcpEnabled : t.mcpDisabled}
            </Badge>
            {server.auth.status === "authenticated" && (
              <Badge color="green" size="1">
                {t.mcpSignedIn}
              </Badge>
            )}
          </div>
          <p className="mcp-server-address" title={address}>
            {address}
          </p>
          <p className={`mcp-server-status${needsAuth ? " needs-auth" : ""}`}>
            <span
              className={`mcp-status-dot ${ready ? "ready" : needsAuth ? "auth" : server.health.status}`}
            />
            {healthText}
            <span>
              · {server.transport === "stdio" ? t.mcpStdio : server.transport.toUpperCase()}
            </span>
          </p>
        </div>
        <div className="mcp-row-actions">
          {server.transport !== "stdio" &&
            (needsAuth || server.oauth || server.auth.status === "authenticated") && (
              <Button
                type="button"
                size="1"
                variant={needsAuth ? "solid" : "ghost"}
                color={needsAuth ? "teal" : "gray"}
                disabled={busy}
                onClick={() =>
                  server.auth.status === "authenticated"
                    ? run("logout", data.logoutMcpAuth(server.id))
                    : run(
                        "login",
                        data.startMcpAuth(server.id).pipe(
                          Effect.tap(({ authorizationUrl: url }) =>
                            Effect.sync(() => {
                              setAuthorizationUrl(url);
                              window.open(url, "_blank", "noopener,noreferrer");
                            }),
                          ),
                        ),
                      )
                }
              >
                {pending === "login" || pending === "logout" ? (
                  <Loader2 size={14} className="mcp-spin" />
                ) : server.auth.status === "authenticated" ? (
                  <LogOut size={14} />
                ) : (
                  <LogIn size={14} />
                )}
                {server.auth.status === "authenticated" ? t.mcpServerLogout : t.mcpServerLogin}
              </Button>
            )}
          <Button
            type="button"
            size="1"
            color="gray"
            variant="ghost"
            disabled={busy}
            onClick={() => run("test", data.testMcpServer(server.id))}
          >
            {pending === "test" ? (
              <Loader2 size={14} className="mcp-spin" />
            ) : (
              <FlaskConical size={14} />
            )}
            {pending === "test" ? t.mcpTesting : t.mcpServerTest}
          </Button>
          <IconButton
            type="button"
            size="1"
            color="gray"
            variant="ghost"
            aria-label={`${t.edit} ${server.name}`}
            title={t.edit}
            disabled={busy}
            onClick={onEdit}
          >
            <Pencil size={14} />
          </IconButton>
          <IconButton
            type="button"
            size="1"
            color="gray"
            variant="ghost"
            aria-label={`${t.mcpServerDelete} ${server.name}`}
            title={t.mcpServerDelete}
            disabled={busy}
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={14} />
          </IconButton>
          <Switch
            size="1"
            checked={server.enabled}
            aria-label={`${server.enabled ? t.mcpServerDisable : t.mcpServerEnable} ${server.name}`}
            disabled={busy || (!server.enabled && (!ready || needsAuth))}
            title={!ready ? t.mcpTestBeforeEnable : undefined}
            onCheckedChange={(enabled) =>
              run("toggle", data.setMcpServerEnabled(server.id, enabled))
            }
          />
        </div>
      </div>
      {credentialNames.length > 0 && (
        <p className="mcp-credential-summary">
          {t.mcpSavedCredentials} {credentialNames.join("、")}
        </p>
      )}
      {(error || server.health.message || needsAuth) && (
        <div
          className={`mcp-feedback ${needsAuth ? "mcp-feedback-warning" : "mcp-feedback-error"}`}
          role="alert"
        >
          {error || (needsAuth ? t.mcpAuthHint : server.health.message)}
        </div>
      )}
      {authorizationUrl && server.auth.status !== "authenticated" && (
        <div className="mcp-feedback mcp-feedback-pending" role="status">
          {t.mcpWaitingLogin}
          <Button
            type="button"
            size="1"
            variant="ghost"
            onClick={() => window.open(authorizationUrl, "_blank", "noopener,noreferrer")}
          >
            {t.mcpOpenLogin}
          </Button>
        </div>
      )}
      {pending === "test" && (
        <div className="mcp-feedback mcp-feedback-pending" role="status">
          <Loader2 size={14} className="mcp-spin" />
          {t.mcpImportTesting}
        </div>
      )}
      {ready && !server.enabled && (
        <div className="mcp-ready-hint">
          <CheckCircle2 size={14} />
          {t.mcpReadyHint}
        </div>
      )}
      <div className="mcp-server-details">
        <details>
          <summary>
            {t.mcpServerTools}
            <span>{server.tools.length}</span>
          </summary>
          {!server.tools.length ? (
            <p className="muted">{t.botMcpNoTools}</p>
          ) : (
            <div className="mcp-tools-panel">
              <TextField.Root
                aria-label={t.mcpSearchTools}
                placeholder={t.mcpSearchTools}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              >
                <TextField.Slot>
                  <Search size={14} />
                </TextField.Slot>
              </TextField.Root>
              <div className="mcp-tool-list">
                {tools.map((tool) => (
                  <div className="mcp-tool-description" key={tool.name}>
                    <code>{tool.name}</code>
                    <p>{tool.description || tool.title || t.mcpNoDescription}</p>
                  </div>
                ))}
                {!tools.length && <p className="muted">{t.mcpNoMatches}</p>}
              </div>
            </div>
          )}
        </details>
        <details>
          <summary>
            {t.mcpServerBots}
            <span>
              {assigned} / {bots.length}
            </span>
          </summary>
          {!grantsReady && (
            <p className="muted" role="status">
              {t.botMcpLoading}
            </p>
          )}
          {!bots.length ? (
            <p className="muted">{t.mcpServerNoBots}</p>
          ) : (
            <div className="mcp-grants">
              {bots.map((bot) => (
                <McpGrantFields
                  key={bot.id}
                  label={bot.name}
                  tools={server.tools}
                  grant={grants.get(bot.id)}
                  disabled={busy || !grantsReady}
                  onChange={(value) =>
                    run(
                      "grant",
                      data
                        .setMcpGrant(bot.id, server.id, value)
                        .pipe(Effect.tap(({ grant }) => Effect.sync(() => onGrant(grant)))),
                    )
                  }
                />
              ))}
            </div>
          )}
        </details>
      </div>
      {deleting && (
        <Dialog
          title={`${t.mcpDeleteTitle} ${server.name}`}
          onClose={() => {
            if (!action.busy) setDeleting(false);
          }}
          maxWidth="420px"
        >
          <div className="mcp-delete-content">
            <p>{t.mcpDeleteHint}</p>
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}
            <div className="mcp-inline-actions">
              <Button
                type="button"
                variant="surface"
                color="gray"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                {t.cancel}
              </Button>
              <Button
                type="button"
                color="red"
                disabled={busy}
                onClick={() =>
                  run(
                    "delete",
                    data
                      .deleteMcpServer(server.id)
                      .pipe(Effect.tap(() => Effect.sync(() => setDeleting(false)))),
                  )
                }
              >
                {t.mcpServerDelete}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </article>
  );
}
