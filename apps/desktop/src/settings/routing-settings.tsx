import type { AutConfig } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { desktopApi } from "../api.js";
import { readClassifierForm } from "../configuration-forms.js";
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
  const [editing, setEditing] = useState(false);
  return (
    <ConfigurationForm
      className={`settings-form${editing ? " is-editing" : ""}`}
      flash={flash}
      submit={(form) =>
        Effect.gen(function* () {
          const classifier = yield* readClassifierForm(form);
          const { classifier: _previous, ...current } = yield* desktopApi.getConfig();
          yield* data.saveConfig(classifier ? { ...current, classifier } : current);
          setEditing(false);
          flash(t.saved);
        })
      }
    >
      {(busy) => (
        <>
          <details
            className="settings-advanced"
            onToggle={(event) => {
              if (event.currentTarget.open) setEditing(true);
            }}
          >
            <summary>
              <span>{t.advanced}</span>
              <span>{t.settingsAdvancedHint}</span>
              <Icon name="chevron" />
            </summary>
            <div className="advanced-services">
              <h3>{t.routingService}</h3>
              <p className="muted">{t.routingServiceHint}</p>
              <ClassifierSettings slot="primary" value={config.classifier?.primary} flash={flash} />
              <details className="optional-service">
                <summary>{t.fallback}</summary>
                <ClassifierSettings
                  slot="fallback"
                  value={config.classifier?.fallback}
                  flash={flash}
                />
              </details>
            </div>
          </details>
          <p className="settings-caption service-privacy">{t.settingsHint}</p>
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
