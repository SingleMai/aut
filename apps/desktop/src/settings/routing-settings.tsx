import type { AutConfig, ClassifierBackendConfig } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { desktopApi } from "../api.js";
import { classifierLabel, readClassifierForm } from "../configuration-forms.js";
import type { DesktopData } from "../desktop-data.js";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";
import { ConfigurationForm } from "../ui/configuration-form.js";
import type { Flash } from "../ui/use-action.js";
import { ClassifierSettings } from "./classifier-settings.js";

export function RoutingSettings({
  config,
  data,
  flash,
}: {
  config: AutConfig;
  data: DesktopData;
  flash: Flash;
}) {
  return (
    <details className="fast-brain-settings settings-list">
      <summary className="fast-brain-heading">
        <strong>{t.fastBrain}</strong>
        <span>{classifierLabel(config.classifier?.primary)}</span>
        <Icon name="chevron" />
      </summary>
      <ConfigurationForm
        key={JSON.stringify(config.classifier)}
        className="fast-brain-form"
        flash={flash}
        submit={(form) =>
          Effect.gen(function* () {
            const classifier = yield* readClassifierForm(form);
            const current = yield* desktopApi.getConfig();
            yield* data.saveConfig({ ...current, classifier });
            flash(t.saved);
          })
        }
      >
        {(busy) => (
          <>
            <div className="fast-brain-body">
              <p className="fast-brain-note">{t.fastBrainHint}</p>
              <ClassifierSettings slot="primary" value={config.classifier?.primary} flash={flash} />
              <BackupSettings value={config.classifier?.fallback} flash={flash} />
            </div>
            <div className="form-actions fast-brain-actions">
              <p className="muted">{t.applySettingsHint}</p>
              <Button type="submit" disabled={busy}>
                {t.saveSettings}
              </Button>
            </div>
          </>
        )}
      </ConfigurationForm>
    </details>
  );
}

function BackupSettings({
  value,
  flash,
}: {
  value: ClassifierBackendConfig | undefined;
  flash: Flash;
}) {
  const [included, setIncluded] = useState(!!value);
  if (!included)
    return (
      <div className="fast-brain-backup">
        <button className="fast-brain-backup-add" type="button" onClick={() => setIncluded(true)}>
          <Icon name="plus" />
          {t.addFastBrainBackup}
        </button>
      </div>
    );
  return (
    <div className="fast-brain-backup">
      <div className="fast-brain-backup-header">
        <strong>{t.fastBrainBackup}</strong>
        <Button
          size="1"
          variant="ghost"
          color="gray"
          type="button"
          onClick={() => setIncluded(false)}
        >
          {t.removeFastBrainBackup}
        </Button>
      </div>
      <p className="fast-brain-note">{t.fastBrainBackupHint}</p>
      <ClassifierSettings slot="fallback" value={value} flash={flash} />
    </div>
  );
}
