import type { AutConfig, BotConfig } from "@aut/protocol";
import { Button, Select } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import type { UiError } from "./api.js";
import { CharacterEditor } from "./characters/character-editor.js";
import { readBotForm } from "./configuration-forms.js";
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
  onSave,
}: {
  bot?: BotConfig | undefined;
  bots: readonly BotConfig[];
  config: AutConfig;
  focusCharacter: boolean;
  flash: Flash;
  close: () => void;
  settings: () => void;
  onSave: (value: BotConfig) => Effect.Effect<unknown, UiError>;
}) {
  const [name, setName] = useState(bot?.name ?? "");
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
        submit={(form) => readBotForm(form, bot, { bots, config }).pipe(Effect.flatMap(onSave))}
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
                  defaultValue={bot?.id ?? ""}
                  required
                  disabled={!!bot}
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
                <TextAreaField
                  name="mcp"
                  label={t.mcp}
                  defaultValue={JSON.stringify(bot?.mcpServers ?? [], null, 2)}
                />
              </details>
              {bot?.system && <p className="muted">{t.primaryAssistant}</p>}
            </div>
            <div className="form-actions">
              <Button type="button" color="gray" variant="surface" onClick={close}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={busy}>
                {t.save}
              </Button>
            </div>
          </>
        )}
      </ConfigurationForm>
    </Dialog>
  );
}
