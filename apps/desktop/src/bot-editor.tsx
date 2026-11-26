import type { AutConfig, BotConfig } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { desktopApi, UiError } from "./api.js";
import { BotMcpGrants, useBotMcpGrants } from "./bot-mcp-grants.js";
import { BotModelField } from "./bot-model-picker/bot-model-field.js";
import { useBotModelOptions } from "./bot-model-picker/catalog.js";
import { CharacterEditor } from "./characters/character-editor.js";
import { readBotForm } from "./configuration-forms.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { ConfigurationForm } from "./ui/configuration-form.js";
import { Dialog } from "./ui/dialog.js";
import { InputField, TextAreaField } from "./ui/form-fields.js";
import type { Flash } from "./ui/use-action.js";

export function BotEditor({
  bot,
  bots,
  config,
  focusCharacter,
  flash,
  close,
  data,
}: {
  bot?: BotConfig | undefined;
  bots: readonly BotConfig[];
  config: AutConfig;
  focusCharacter: boolean;
  flash: Flash;
  close: () => void;
  data: DesktopData;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [persisted, setPersisted] = useState(bot);
  const [cwd, setCwd] = useState(bot?.cwd ?? "");
  const providers = useBotModelOptions(config.harnessInstances);
  const [botId] = useState(() => bot?.id ?? `bot-${crypto.randomUUID().slice(0, 8)}`);
  const grants = useBotMcpGrants(bot?.id, data);
  return (
    <Dialog
      title={bot ? `${t.edit} ${bot.name}` : t.newBot}
      onClose={close}
      initialFocus={
        focusCharacter ? '.character-choices [role="radio"][aria-checked="true"]' : '[name="name"]'
      }
    >
      <ConfigurationForm
        className="editor-form"
        flash={flash}
        submit={(form) =>
          Effect.gen(function* () {
            const value = yield* readBotForm(form, persisted, { bots, options: providers.options });
            const option = providers.options.find(
              ({ instance }) => instance.id === value.modelSelection.instanceId,
            );
            if (!option) return yield* Effect.fail(new UiError({ message: t.validation.instance }));
            const connection = option.configured
              ? option
              : yield* desktopApi.ensureBotConnection({
                  ...option.instance,
                  id: `bot-model-${crypto.randomUUID()}`,
                });
            const saved = yield* desktopApi.saveBot(
              {
                ...value,
                modelSelection: { ...value.modelSelection, instanceId: connection.instance.id },
              },
              persisted?.id,
            );
            yield* Effect.sync(() => setPersisted(saved.bot));
            yield* grants
              .save(saved.bot.id)
              .pipe(
                Effect.mapError(
                  (error) => new UiError({ message: `${t.botMcpPartial} ${error.message}` }),
                ),
              );
            yield* data.refresh(["bots", "config"]);
            yield* Effect.sync(close);
          })
        }
      >
        {(busy) => (
          <>
            <div className="form-body">
              <div className="form-grid">
                <InputField
                  name="name"
                  label={t.name}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
                <InputField
                  name="cwd"
                  label={t.cwd}
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  required
                />
              </div>
              <TextAreaField
                name="description"
                label={t.description}
                defaultValue={bot?.description ?? ""}
                required
              />
              <BotModelField {...{ bot, bots, providers, cwd, busy }} />
              <CharacterEditor bot={bot} name={name} />
              <TextAreaField name="soul" label={t.soul} defaultValue={bot?.soul ?? ""} rows={4} />
              <details className="advanced-settings">
                <summary>{t.advancedSettings}</summary>
                <InputField
                  name="id"
                  label={t.id}
                  defaultValue={botId}
                  required
                  disabled={!!persisted}
                />
              </details>
              <BotMcpGrants state={grants} busy={busy} />
              {bot?.system && <p className="muted">{t.primaryAssistant}</p>}
            </div>
            <div className="form-actions">
              <Button type="button" color="gray" variant="surface" onClick={close}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={busy || grants.status === "loading"}>
                {t.save}
              </Button>
            </div>
          </>
        )}
      </ConfigurationForm>
    </Dialog>
  );
}
