import type { McpServer } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { parseMcpPaste, prepareMcpImport, saveMcpImportSecrets } from "./mcp-import.js";
import type { PastedMcpServer } from "./openmausbot/lib/mcp-paste.js";
import { InputField, TextAreaField } from "./ui/form-fields.js";
import { type Flash, useAction } from "./ui/use-action.js";

function ImportPreview({
  draft,
  data,
  flash,
}: {
  draft: PastedMcpServer;
  data: DesktopData;
  flash: Flash;
}) {
  const action = useAction(flash);
  const [key] = useState(() => crypto.randomUUID());
  const [saved, setSaved] = useState<McpServer>();
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const secrets = draft.transport === "stdio" ? draft.env : draft.headers;
  return (
    <form
      className="detail-card editor-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        action.run(
          Effect.gen(function* () {
            let server = saved;
            if (!server) {
              const prepared = yield* prepareMcpImport(draft, form);
              const input = yield* saveMcpImportSecrets(prepared, key);
              yield* Effect.sync(() => setMessage(t.mcpImportSaving));
              const result = yield* data.createMcpServer(input).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    setUncertain(true);
                    setMessage(t.mcpImportUncertain);
                  }),
                ),
              );
              server = result.server;
              yield* Effect.sync(() => setSaved(result.server));
            }
            yield* Effect.sync(() => setMessage(t.mcpImportTesting));
            const result = yield* data
              .testMcpServer(server.id)
              .pipe(Effect.tapError(() => Effect.sync(() => setMessage(t.mcpImportFailed))));
            yield* Effect.sync(() => {
              setSaved(result.server);
              setMessage(`${t.mcpImportReady} ${result.server.tools.length}`);
            });
          }),
        );
      }}
    >
      <fieldset
        disabled={action.busy || Boolean(saved) || uncertain}
        className="form-body mcp-import-fields"
      >
        <InputField name="name" label={t.name} defaultValue={draft.name} required />
        {draft.transport === "stdio" ? (
          <>
            <InputField
              name="command"
              label={t.mcpServerCommand}
              defaultValue={draft.command}
              required
              wide
            />
            <InputField
              name="args"
              label={t.mcpServerArgs}
              defaultValue={JSON.stringify(draft.args)}
              wide
            />
          </>
        ) : (
          <InputField name="url" label={t.mcpServerUrl} defaultValue={draft.url} required wide />
        )}
        {secrets.map((secret, i) => (
          <InputField
            key={secret.name}
            type="password"
            autoComplete="off"
            name={`secret-${i}`}
            label={secret.gap ? `${secret.name} · ${secret.gap.names.join(", ")}` : secret.name}
            defaultValue={secret.value}
            placeholder={secret.gap ? t.mcpImportFillSecret : ""}
            required
            wide
          />
        ))}
      </fieldset>
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      <div className="form-actions">
        <Button type="submit" disabled={action.busy || uncertain}>
          {saved ? t.mcpServerTest : t.mcpImportSaveTest}
        </Button>
      </div>
    </form>
  );
}

export function McpImportForm({
  servers,
  data,
  flash,
  onClose,
  onManual,
}: {
  servers: readonly McpServer[];
  data: DesktopData;
  flash: Flash;
  onClose: () => void;
  onManual: () => void;
}) {
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<readonly PastedMcpServer[]>([]);
  const action = useAction(flash);
  return (
    <section className="mcp-import">
      {!drafts.length ? (
        <form
          className="detail-card editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            action.run(
              parseMcpPaste(
                text,
                servers.map((server) => server.name),
              ).pipe(
                Effect.tap((values) =>
                  Effect.sync(() => {
                    setDrafts(values);
                    setText("");
                  }),
                ),
              ),
            );
          }}
        >
          <TextAreaField
            name="paste"
            label={t.mcpImportPaste}
            placeholder={t.mcpImportPlaceholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            required
            wide
          />
          <div className="form-actions">
            <Button type="button" variant="ghost" onClick={onManual}>
              {t.mcpImportManual}
            </Button>
            <Button type="button" variant="surface" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={action.busy}>
              {t.mcpImportPreview}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">{t.mcpImportHint}</p>
          {drafts.map((draft) => (
            <ImportPreview key={draft.name} draft={draft} data={data} flash={flash} />
          ))}
          <Button type="button" variant="surface" onClick={onClose}>
            {t.mcpImportClose}
          </Button>
        </>
      )}
    </section>
  );
}
