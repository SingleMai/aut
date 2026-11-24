import type { BotId, McpServer, McpServerId } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect, Fiber } from "effect";
import { useEffect, useState } from "react";
import { desktopApi } from "./api.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { type McpGrantDraft, McpGrantFields } from "./mcp-grant-fields.js";

const empty: McpGrantDraft = { enabled: false, allowedTools: [] };
const sameGrant = (left: McpGrantDraft, right: McpGrantDraft) =>
  left.enabled === right.enabled &&
  left.allowedTools.length === right.allowedTools.length &&
  left.allowedTools.every((tool) => right.allowedTools.includes(tool));

export function useBotMcpGrants(botId: BotId | undefined, data: DesktopData) {
  const [servers, setServers] = useState<readonly McpServer[]>([]);
  const [baseline, setBaseline] = useState<ReadonlyMap<McpServerId, McpGrantDraft>>(new Map());
  const [drafts, setDrafts] = useState<ReadonlyMap<McpServerId, McpGrantDraft>>(new Map());
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries a failed authorization read.
  useEffect(() => {
    let active = true;
    setStatus("loading");
    const fiber = Effect.runFork(
      Effect.all({
        servers: desktopApi.listMcpServers(),
        grants: botId ? data.listMcpGrants(botId) : Effect.succeed({ grants: [] }),
      }).pipe(
        Effect.tap(({ servers, grants }) =>
          Effect.sync(() => {
            if (!active) return;
            const current = new Map(grants.grants.map((grant) => [grant.serverId, grant]));
            setServers(servers.servers);
            setBaseline(current);
            setDrafts(current);
            setStatus("ready");
          }),
        ),
        Effect.catchAll(() =>
          Effect.sync(() => {
            if (active) setStatus("failed");
          }),
        ),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [botId, data, revision]);
  return {
    servers,
    drafts,
    status,
    retry: () => setRevision((value) => value + 1),
    change: (id: McpServerId, value: McpGrantDraft) =>
      setDrafts((previous) => new Map(previous).set(id, value)),
    save: (id: BotId) =>
      Effect.forEach(
        [...drafts].filter(
          ([serverId, value]) => !sameGrant(value, baseline.get(serverId) ?? empty),
        ),
        ([serverId, value]) =>
          data.setMcpGrant(id, serverId, value).pipe(
            Effect.tap(({ grant }) =>
              Effect.sync(() => {
                setBaseline((previous) => new Map(previous).set(serverId, grant));
                setDrafts((previous) => new Map(previous).set(serverId, grant));
              }),
            ),
          ),
        { discard: true },
      ),
  };
}

export function BotMcpGrants({
  state,
  busy,
}: {
  state: ReturnType<typeof useBotMcpGrants>;
  busy: boolean;
}) {
  return (
    <section className="bot-mcp-grants" aria-label={t.botMcpTitle}>
      <h3>{t.botMcpTitle}</h3>
      <p className="muted">{t.botMcpHint}</p>
      {state.status === "loading" && (
        <p className="muted" role="status">
          {t.botMcpLoading}
        </p>
      )}
      {state.status === "failed" && (
        <div role="alert">
          <p>{t.mcpGrantsLoadError}</p>
          <Button type="button" variant="surface" disabled={busy} onClick={state.retry}>
            {t.control.retry}
          </Button>
        </div>
      )}
      {state.status === "ready" && !state.servers.length && (
        <p className="muted">{t.botMcpEmpty}</p>
      )}
      {state.status === "ready" &&
        state.servers.map((server) => (
          <div key={server.id} className="bot-mcp-server">
            <McpGrantFields
              label={server.name}
              tools={server.tools}
              grant={state.drafts.get(server.id)}
              disabled={busy}
              onChange={(value) => state.change(server.id, value)}
            />
            {!server.enabled && <p className="muted">{t.botMcpDisabled}</p>}
            {!server.tools.length && <p className="muted">{t.botMcpNoTools}</p>}
          </div>
        ))}
    </section>
  );
}
