import type { AutConfig, HarnessInstanceConfig } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { ClassifierSettings } from "./classifier-settings.js";
import { readSettingsForm } from "./configuration-forms.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { ConfigurationForm } from "./ui/configuration-form.js";
import { InputField, TextAreaField } from "./ui/form-fields.js";
import type { Flash } from "./ui/use-action.js";

export function SettingsPage({
  config,
  data,
  flash,
}: {
  config: AutConfig;
  data: DesktopData;
  flash: Flash;
}) {
  const [rows, setRows] = useState<{ key: string; instance?: HarnessInstanceConfig }[]>(() =>
    config.harnessInstances.map((instance) => ({
      key: crypto.randomUUID(),
      instance,
    })),
  );
  return (
    <ConfigurationForm
      flash={flash}
      className="settings-form"
      submit={(form) =>
        Effect.gen(function* () {
          const next = yield* readSettingsForm(form, rows);
          yield* data.saveConfig(next);
          flash(t.saved);
        })
      }
    >
      {(busy) => (
        <>
          <p className="privacy-note">{t.settingsHint}</p>
          <div>
            {rows.map(({ key, instance }) => (
              <section key={key} className="settings-section">
                <div className="section-heading">
                  <h2>{instance?.name || t.harness}</h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="1"
                    color="red"
                    onClick={() => setRows((prev) => prev.filter((row) => row.key !== key))}
                  >
                    {t.delete}
                  </Button>
                </div>
                <div className="form-grid">
                  <InputField
                    required
                    name={`${key}.id`}
                    label={t.id}
                    defaultValue={instance?.id ?? ""}
                  />
                  <InputField
                    required
                    name={`${key}.name`}
                    label={t.name}
                    defaultValue={instance?.name ?? ""}
                  />
                  <InputField
                    required
                    name={`${key}.kind`}
                    label={t.instanceKind}
                    defaultValue={instance?.kind ?? "codex"}
                  />
                  <InputField
                    required
                    name={`${key}.command`}
                    label={t.command}
                    defaultValue={instance?.command ?? "codex"}
                  />
                  <InputField
                    required
                    name={`${key}.args`}
                    label={t.arguments}
                    defaultValue={JSON.stringify(instance?.args ?? [])}
                    wide
                  />
                  <TextAreaField
                    name={`${key}.env`}
                    label={t.environment}
                    defaultValue={JSON.stringify(instance?.env ?? {}, null, 2)}
                    wide
                  />
                </div>
              </section>
            ))}
          </div>
          <Button
            type="button"
            color="gray"
            variant="surface"
            onClick={() => setRows((prev) => [...prev, { key: crypto.randomUUID() }])}
          >
            {t.addInstance}
          </Button>
          <p className="muted">{t.classifierOptional}</p>
          <ClassifierSettings slot="primary" value={config.classifier?.primary} flash={flash} />
          <ClassifierSettings slot="fallback" value={config.classifier?.fallback} flash={flash} />
          <div className="form-actions settings-actions">
            <p className="muted">{t.applySettingsHint}</p>
            <Button type="submit" disabled={busy}>
              {t.saveSettings}
            </Button>
          </div>
        </>
      )}
    </ConfigurationForm>
  );
}
