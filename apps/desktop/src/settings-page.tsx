import type { AutConfig, DesktopConnectionStatus } from "@aut/protocol";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { DeviceSettings } from "./settings/device-settings.js";
import { RoutingSettings } from "./settings/routing-settings.js";
import type { Flash } from "./ui/use-action.js";

export function SettingsPage({
  config,
  data,
  status,
  flash,
}: {
  config: AutConfig | undefined;
  data: DesktopData;
  status: DesktopConnectionStatus;
  flash: Flash;
}) {
  return (
    <div className="settings-overview">
      {window.aut.connection && <DeviceSettings status={status} flash={flash} />}
      <section aria-label={t.fastBrain}>
        {config ? (
          <RoutingSettings config={config} data={data} flash={flash} />
        ) : (
          <p className="settings-empty">{t.settingsUnavailable}</p>
        )}
      </section>
    </div>
  );
}
