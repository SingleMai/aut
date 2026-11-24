import type { AutConfig, BotConfig } from "@aut/protocol";
import { Button, Select } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { desktopApi, UiError } from "./api.js";
import { BotMcpGrants, useBotMcpGrants } from "./bot-mcp-grants.js";
import { CharacterEditor } from "./characters/character-editor.js";
import { readBotForm } from "./configuration-forms.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { ConfigurationForm } from "./ui/configuration-form.js";
import { Dialog } from "./ui/dialog.js";
import { InputField, SelectField, TextAreaField } from "./ui/form-fields.js";
import type { Flash } from "./ui/use-action.js";

export function BotEditor({
  bot,
  bots,
  config,
  focusCharacter,
  flash,
  close,
  settings,
  data,
}: {
  bot?: BotConfig | undefined;
  bots: readonly BotConfig[];
  config: AutConfig;
  focusCharacter: boolean;
  flash: Flash;
  close: () => void;
  settings: () => void;
  data: DesktopData;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [persisted, setPersisted] = useState(bot);
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
            const value = yield* readBotForm(form, persisted, { bots, config });
            const saved = yield* desktopApi.saveBot(value, persisted?.id);
            yield* Effect.sync(() => setPersisted(saved.bot));
            yield* grants
              .save(saved.bot.id)
              .pipe(
                Effect.mapError(
                  (error) => new UiError({ message: `${t.botMcpPartial} ${error.message}` }),
                ),
              );
            yield* data.refresh(["bots"]);
            yield* Effect.sync(close);
          })
        }
      >
        {(busy) => (
          <>
            <div className="form-body">
              <InputField
                name="name"
                label={t.name}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
              <CharacterEditor bot={bot} name={name} />
              <TextAreaField
                name="description"
                label={t.description}
                defaultValue={bot?.description ?? ""}
                required
              />
              <TextAreaField name="soul" label={t.soul} defaultValue={bot?.soul ?? ""} rows={4} />
              {!config.harnessInstances.length && (
                <div className="privacy-note">
                  <p className="muted">{t.noConfig}</p>
                  <Button type="button" color="gray" variant="surface" onClick={settings}>
                    前往设置
                  </Button>
                </div>
              )}
              <div className="form-grid">
                <InputField
                  name="id"
                  label={t.id}
                  defaultValue={persisted?.id ?? ""}
                  required
                  disabled={!!persisted}
                />
                <SelectField
                  label={t.instance}
                  name="instance"
                  required
                  defaultValue={bot?.modelSelection.instanceId ?? config.harnessInstances[0]?.id}
                >
                  {config.harnessInstances.map((instance) => (
                    <Select.Item key={instance.id} value={instance.id}>
                      {instance.name}
                    </Select.Item>
                  ))}
                </SelectField>
                <InputField
                  name="model"
                  label={t.model}
                  defaultValue={bot?.modelSelection.model ?? ""}
                  required
                />
                <InputField name="cwd" label={t.cwd} defaultValue={bot?.cwd ?? ""} required />
              </div>
              <details className="advanced-settings">
                <summary>{t.advancedSettings}</summary>
                <InputField
                  name="effort"
                  label={t.effort}
                  defaultValue={bot?.modelSelection.effort ?? ""}
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
