// Adapted from OpenMausBot src/components/McpServerEditor.tsx at
// 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc. Apache-2.0; see NOTICE.
// Paste-first drafts, missing-value fields and progressive details are retained.
// aut supplies Effect persistence, credential references and per-item save/test receipts.
import type { McpServer } from "@aut/protocol";
import { Button, SegmentedControl, Select, TextArea, TextField } from "@radix-ui/themes";
import { Effect, Either } from "effect";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { DesktopData } from "../../desktop-data.js";
import { t } from "../../i18n.js";
import { parseMcpPaste, prepareMcpDraft, saveMcpImportSecrets } from "../../mcp-import.js";
import { type Flash, useAction } from "../../ui/use-action.js";
import { McpSecretRows } from "./McpSecretRows.js";
import { draftFor, draftFromPaste, emptyDraft, type McpDraft } from "./mcp-draft.js";

type Receipt = {
  server?: McpServer;
  phase: "saving" | "testing" | "ready" | "failed" | "uncertain";
  message: string;
};
const where = (draft: McpDraft) =>
  draft.transport === "stdio" ? [draft.command, ...draft.args.split("\n")].join(" ") : draft.url;
const Field = ({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: Callers supply a named Radix form control as the child.
  <label className={`mcp-field${wide ? " mcp-field-wide" : ""}`}>
    <span>{label}</span>
    {children}
  </label>
);

export function McpServerEditor({
  server,
  servers,
  data,
  flash,
  onClose,
}: {
  server?: McpServer;
  servers: readonly McpServer[];
  data: DesktopData;
  flash: Flash;
  onClose: () => void;
}) {
  const adding = !server;
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<McpDraft[]>(() => (server ? [draftFor(server)] : []));
  const [details, setDetails] = useState(!adding);
  const [error, setError] = useState("");
  const [receipts, setReceipts] = useState<ReadonlyMap<number, Receipt>>(new Map());
  const current = useRef(receipts);
  const [key] = useState(() => crypto.randomUUID());
  const action = useAction(flash);
  const setReceipt = (index: number, value: Receipt) => {
    current.current = new Map(current.current).set(index, value);
    setReceipts(current.current);
  };
  const locked = receipts.size > 0;
  const uncertain = [...receipts.values()].some((value) => value.phase === "uncertain");
  const complete =
    drafts.length > 0 && drafts.every((_, index) => receipts.get(index)?.phase === "ready");
  const setDraft = (index: number, patch: Partial<McpDraft>) => {
    setError("");
    setDrafts((values) =>
      values.map((value, at) => (at === index ? { ...value, ...patch } : value)),
    );
  };
  const paste = (value: string) => {
    setText(value);
    setError("");
    if (!value.trim()) {
      setDrafts(details ? [emptyDraft()] : []);
      return;
    }
    const result = Effect.runSync(
      Effect.either(
        parseMcpPaste(
          value,
          servers.map((item) => item.name),
        ),
      ),
    );
    if (Either.isRight(result)) setDrafts(result.right.map(draftFromPaste));
    else {
      setError(result.left.message);
      setDrafts([]);
    }
  };
  const submit = () =>
    action.run(
      Effect.gen(function* () {
        yield* Effect.sync(() => setError(""));
        // Validate every item before the first write; retries reuse acknowledged server identities.
        const prepared = yield* Effect.forEach(drafts, prepareMcpDraft);
        for (const [index, input] of prepared.entries()) {
          const previous = current.current.get(index);
          if (previous?.phase === "ready" || previous?.phase === "uncertain") continue;
          let saved = previous?.server;
          const result = yield* Effect.gen(function* () {
            if (!saved) {
              yield* Effect.sync(() =>
                setReceipt(index, { phase: "saving", message: t.mcpImportSaving }),
              );
              const config = yield* saveMcpImportSecrets(input, `${key}-${index}`);
              const response = yield* (
                server ? data.updateMcpServer(server.id, config) : data.createMcpServer(config)
              ).pipe(
                Effect.tapError(() =>
                  Effect.sync(() =>
                    setReceipt(index, { phase: "uncertain", message: t.mcpImportUncertain }),
                  ),
                ),
              );
              saved = response.server;
            }
            const persisted = saved;
            yield* Effect.sync(() =>
              setReceipt(index, {
                server: persisted,
                phase: "testing",
                message: t.mcpImportTesting,
              }),
            );
            const response = yield* data.testMcpServer(persisted.id);
            const checked = response.server;
            saved = checked;
            const ready = checked.health.status === "ready";
            yield* Effect.sync(() =>
              setReceipt(index, {
                server: checked,
                phase: ready ? "ready" : "failed",
                message: ready
                  ? `${t.mcpImportReady} ${checked.tools.length}`
                  : checked.auth.status === "required"
                    ? t.mcpImportNeedsAuth
                    : t.mcpImportFailed,
              }),
            );
          }).pipe(Effect.either);
          if (Either.isLeft(result) && current.current.get(index)?.phase !== "uncertain")
            yield* Effect.sync(() =>
              setReceipt(index, {
                ...(saved ? { server: saved } : {}),
                phase: "failed",
                message: result.left.message,
              }),
            );
        }
      }).pipe(Effect.catchAll((failure) => Effect.sync(() => setError(failure.message)))),
    );
  return (
    <section
      data-mcp-editor
      className="mcp-editor"
      aria-label={adding ? t.addMcpServer : t.mcpEditServer}
    >
      <h3>{adding ? t.addMcpServer : `${t.mcpEditServer} · ${server.name}`}</h3>
      {adding && (
        <Field label={t.mcpPastePrompt}>
          <TextArea
            autoFocus
            aria-label={t.mcpImportPaste}
            value={text}
            disabled={action.busy || locked}
            onChange={(event) => paste(event.target.value)}
            spellCheck={false}
            rows={3}
            placeholder="https://mcp.example.com/mcp"
            className="mcp-paste-input"
          />
          <small>{t.mcpImportPlaceholder}</small>
        </Field>
      )}
      {error && (
        <p role="alert" className="mcp-feedback mcp-feedback-error">
          {error}
        </p>
      )}
      {adding && drafts.length > 0 && !error && (
        <div className="mcp-detected" role="status">
          <CheckCircle2 size={15} />
          <span>
            {t.mcpDetected} {drafts.map((draft) => draft.name).join("、")}
          </span>
          {drafts.length === 1 && <code>{where(drafts[0] as McpDraft)}</code>}
        </div>
      )}
      {drafts.map((draft, index) => {
        const receipt = receipts.get(index);
        const missing =
          draft.urlGap || draft.headers.some((row) => row.gap) || draft.env.some((row) => row.gap);
        const savedSecret = draft.oauthSecretRef && !draft.oauthForgetSecret;
        return (
          <div key={draft.id} className="mcp-editor-item">
            {drafts.length > 1 && <h4>{draft.name}</h4>}
            <fieldset
              disabled={action.busy || Boolean(receipt?.server) || receipt?.phase === "uncertain"}
            >
              {!details && missing && (
                <div className="mcp-missing-fields">
                  {draft.urlGap && (
                    <Field label={t.mcpServerUrl}>
                      <TextField.Root
                        value={draft.url}
                        onChange={(event) => setDraft(index, { url: event.target.value })}
                      />
                      <small>{t.mcpUrlMissing}</small>
                    </Field>
                  )}
                  <McpSecretRows
                    kind="header"
                    valuesOf="gaps"
                    rows={draft.headers}
                    onChange={(headers) => setDraft(index, { headers })}
                  />
                  <McpSecretRows
                    kind="env"
                    valuesOf="gaps"
                    rows={draft.env}
                    onChange={(env) => setDraft(index, { env })}
                  />
                </div>
              )}
              {details && (
                <>
                  <SegmentedControl.Root
                    aria-label={t.mcpTransport}
                    value={draft.transport}
                    onValueChange={(value) =>
                      setDraft(index, { transport: value === "stdio" ? "stdio" : "remote" })
                    }
                  >
                    <SegmentedControl.Item value="remote">{t.mcpRemote}</SegmentedControl.Item>
                    <SegmentedControl.Item value="stdio">{t.mcpStdio}</SegmentedControl.Item>
                  </SegmentedControl.Root>
                  <div className="mcp-form-grid">
                    <Field label={t.name}>
                      <TextField.Root
                        aria-label={t.name}
                        value={draft.name}
                        onChange={(event) => setDraft(index, { name: event.target.value })}
                        placeholder="github"
                      />
                    </Field>
                    {draft.transport === "remote" ? (
                      <>
                        <Field label={t.mcpServerUrl}>
                          <TextField.Root
                            aria-label={t.mcpServerUrl}
                            value={draft.url}
                            spellCheck={false}
                            onChange={(event) => setDraft(index, { url: event.target.value })}
                            placeholder="https://mcp.example.com/mcp"
                          />
                        </Field>
                        <Field label={t.mcpTransport}>
                          <Select.Root
                            value={draft.type}
                            onValueChange={(value) =>
                              setDraft(index, { type: value === "sse" ? "sse" : "http" })
                            }
                          >
                            <Select.Trigger aria-label={t.mcpTransport} />
                            <Select.Content>
                              <Select.Item value="http">{t.mcpHttp}</Select.Item>
                              <Select.Item value="sse">{t.mcpSse}</Select.Item>
                            </Select.Content>
                          </Select.Root>
                        </Field>
                        <div className="mcp-field mcp-field-wide">
                          <span>{t.mcpHeaderRows}</span>
                          <McpSecretRows
                            kind="header"
                            rows={draft.headers}
                            onChange={(headers) => setDraft(index, { headers })}
                          />
                          <small>{t.mcpSecretsHint}</small>
                        </div>
                        <details className="mcp-oauth mcp-field-wide">
                          <summary>{t.mcpOAuthTitle}</summary>
                          <p className="muted">{t.mcpOAuthHint}</p>
                          <div className="mcp-form-grid">
                            <Field label={t.mcpClientId}>
                              <TextField.Root
                                aria-label={t.mcpClientId}
                                value={draft.oauthClientId}
                                autoComplete="off"
                                onChange={(event) =>
                                  setDraft(index, { oauthClientId: event.target.value })
                                }
                              />
                            </Field>
                            <Field label={t.mcpClientSecret}>
                              <TextField.Root
                                aria-label={t.mcpClientSecret}
                                type="password"
                                autoComplete="new-password"
                                value={draft.oauthClientSecret}
                                placeholder={savedSecret ? t.mcpSecretSaved : t.mcpOptional}
                                onChange={(event) =>
                                  setDraft(index, { oauthClientSecret: event.target.value })
                                }
                              />
                              {savedSecret && (
                                <Button
                                  type="button"
                                  size="1"
                                  variant="ghost"
                                  onClick={() =>
                                    setDraft(index, {
                                      oauthClientSecret: "",
                                      oauthForgetSecret: true,
                                    })
                                  }
                                >
                                  {t.mcpForgetSecret}
                                </Button>
                              )}
                            </Field>
                          </div>
                        </details>
                      </>
                    ) : (
                      <>
                        <Field label={t.mcpServerCommand}>
                          <TextField.Root
                            aria-label={t.mcpServerCommand}
                            value={draft.command}
                            onChange={(event) => setDraft(index, { command: event.target.value })}
                            placeholder="npx"
                          />
                        </Field>
                        <Field label={t.mcpArgsLines} wide>
                          <TextArea
                            aria-label={t.mcpArgsLines}
                            value={draft.args}
                            onChange={(event) => setDraft(index, { args: event.target.value })}
                            rows={3}
                            placeholder={
                              "-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder"
                            }
                          />
                          <small>{t.mcpArgsHint}</small>
                        </Field>
                        <Field label={t.cwd} wide>
                          <TextField.Root
                            aria-label={t.cwd}
                            value={draft.cwd}
                            onChange={(event) => setDraft(index, { cwd: event.target.value })}
                            placeholder={t.mcpOptional}
                          />
                        </Field>
                        <div className="mcp-field mcp-field-wide">
                          <span>{t.mcpEnvRows}</span>
                          <McpSecretRows
                            kind="env"
                            rows={draft.env}
                            onChange={(env) => setDraft(index, { env })}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </fieldset>
            {receipt && (
              <p
                role="status"
                className={`mcp-feedback mcp-feedback-${receipt.phase === "ready" ? "success" : receipt.phase === "failed" || receipt.phase === "uncertain" ? "error" : "pending"}`}
              >
                {receipt.phase === "saving" || receipt.phase === "testing" ? (
                  <Loader2 size={14} className="mcp-spin" />
                ) : null}
                {receipt.message}
              </p>
            )}
          </div>
        );
      })}
      {adding && (
        <Button
          type="button"
          variant="ghost"
          color="gray"
          size="1"
          className="mcp-details-toggle"
          aria-expanded={details}
          disabled={action.busy || locked}
          onClick={() => {
            setDetails(!details);
            if (!drafts.length) {
              setDrafts([emptyDraft()]);
              setError("");
            }
          }}
        >
          {details ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t.mcpConnectionDetails}
        </Button>
      )}
      <div className="mcp-editor-footer">
        <span>{complete ? t.mcpImportNext : t.mcpNewDisabled}</span>
        <div className="mcp-inline-actions">
          <Button
            type="button"
            color="gray"
            variant="surface"
            disabled={action.busy}
            onClick={onClose}
          >
            {locked ? t.mcpImportClose : t.cancel}
          </Button>
          {!complete && (
            <Button
              type="button"
              disabled={action.busy || !drafts.length || uncertain}
              onClick={submit}
            >
              {action.busy && <Loader2 size={14} className="mcp-spin" />}
              {locked ? t.mcpRetryPending : t.mcpImportSaveTest}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
