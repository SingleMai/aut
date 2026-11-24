// Layout adapted from OpenMausBot src/components/McpServersPanel.tsx at
// 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc. Apache-2.0; see NOTICE.
// aut retains its existing daemon registry and exact per-Bot grants.
import type { BotConfig, McpGrant, McpServer } from "@aut/protocol";
import { Button, IconButton } from "@radix-ui/themes";
import { Effect, Fiber } from "effect";
import { Plus, RefreshCw, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { McpServerCard } from "./openmausbot/components/McpServerCard.js";
import { McpServerEditor } from "./openmausbot/components/McpServerEditor.js";
import { type Flash, useAction } from "./ui/use-action.js";

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
  const [grants, setGrants] = useState<ReadonlyMap<string, readonly McpGrant[]>>(new Map());
  const [grantsStatus, setGrantsStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [revision, setRevision] = useState(0);
  const refresh = useAction(flash);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries failed authorization reads.
  useEffect(() => {
    let active = true;
    setGrantsStatus("loading");
    const fiber = Effect.runFork(
      Effect.forEach(
        bots,
        (bot) =>
          data.listMcpGrants(bot.id).pipe(Effect.map(({ grants }) => [bot.id, grants] as const)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.tap((rows) =>
          Effect.sync(() => {
            if (active) {
              setGrants(new Map(rows));
              setGrantsStatus("ready");
            }
          }),
        ),
        Effect.catchAll(() =>
          Effect.sync(() => {
            if (active) setGrantsStatus("failed");
          }),
        ),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [bots, data, servers, revision]);
  return (
    <div className="mcp-page">
      <div className="mcp-page-heading">
        <div>
          <h2>{t.mcpPageTitle}</h2>
          <p>{t.mcpServerHint}</p>
        </div>
        <div className="mcp-inline-actions">
          <IconButton
            type="button"
            variant="ghost"
            color="gray"
            aria-label={t.mcpRefresh}
            disabled={refresh.busy || Boolean(editing)}
            onClick={() =>
              refresh.run(
                data
                  .refresh(["mcp"])
                  .pipe(Effect.tap(() => Effect.sync(() => setRevision((value) => value + 1)))),
              )
            }
          >
            <RefreshCw size={16} />
          </IconButton>
          <Button
            type="button"
            variant="soft"
            color="gray"
            disabled={Boolean(editing)}
            onClick={() => setEditing("new")}
          >
            <Plus size={15} />
            {t.addMcpServer}
          </Button>
        </div>
      </div>
      {editing && (
        <McpServerEditor
          key={editing === "new" ? "new" : editing.id}
          {...(editing === "new" ? {} : { server: editing })}
          servers={servers}
          data={data}
          flash={flash}
          onClose={() => setEditing(undefined)}
        />
      )}
      {grantsStatus === "failed" && (
        <div className="mcp-feedback mcp-feedback-error" role="alert">
          {t.mcpGrantsLoadError}
          <Button
            type="button"
            size="1"
            variant="ghost"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t.control.retry}
          </Button>
        </div>
      )}
      {!servers.length && !editing && (
        <div className="mcp-empty">
          <div className="mcp-server-icon">
            <ServerCog size={24} />
          </div>
          <h3>{t.mcpEmptyTitle}</h3>
          <p>{t.mcpEmptyHint}</p>
          <Button type="button" variant="surface" color="gray" onClick={() => setEditing("new")}>
            <Plus size={15} />
            {t.mcpConnectFirst}
          </Button>
        </div>
      )}
      <div className="mcp-server-list">
        {servers.map((server) => {
          const serverGrants = new Map<string, McpGrant>();
          for (const [botId, values] of grants) {
            const grant = values.find((value) => value.serverId === server.id);
            if (grant) serverGrants.set(botId, grant);
          }
          return (
            <McpServerCard
              key={server.id}
              server={server}
              bots={bots}
              grants={serverGrants}
              grantsReady={grantsStatus === "ready"}
              disabled={Boolean(editing)}
              data={data}
              flash={flash}
              onEdit={() => setEditing(server)}
              onGrant={(grant) =>
                setGrants((current) =>
                  new Map(current).set(grant.botId, [
                    ...(current.get(grant.botId) ?? []).filter(
                      (item) => item.serverId !== grant.serverId,
                    ),
                    grant,
                  ]),
                )
              }
            />
          );
        })}
      </div>
    </div>
  );
}
