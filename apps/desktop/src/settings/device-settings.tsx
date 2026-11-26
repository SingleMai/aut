import type { DesktopConnectionStatus } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { useState } from "react";
import { connectionAction } from "../api.js";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";
import { type Flash, useAction } from "../ui/use-action.js";
import { PairComputerDialog } from "./pair-computer-dialog.js";
import { RemoteAccessSettings } from "./remote-access-settings.js";

export function DeviceSettings({
  status,
  flash,
}: {
  status: DesktopConnectionStatus;
  flash: Flash;
}) {
  const [adding, setAdding] = useState(false);
  const { busy, run } = useAction(flash);
  return (
    <section className="device-settings" aria-label={t.settingsDevices}>
      <div className="settings-group-heading">
        <h2>{t.settingsDevices}</h2>
      </div>
      <div className="settings-list">
        <div className="settings-item current-device">
          <span className="settings-item-icon">
            <Icon name={status.mode === "local" ? "laptop" : "computer"} />
          </span>
          <div className="settings-item-copy">
            <h3>{status.mode === "local" ? t.thisComputer : status.name}</h3>
            <p>{t.currentComputer}</p>
          </div>
          <span className="connection-badge" data-phase={status.phase}>
            {t.executionStatus[status.phase]}
          </span>
        </div>
        {(status.message || status.canLogin) && (
          <div className="device-feedback">
            {status.message && (
              <p className="connection-error" role="status">
                {status.message}
              </p>
            )}
            {status.canLogin && (
              <Button
                size="1"
                disabled={busy}
                onClick={() => run(connectionAction({ action: "login" }))}
              >
                {t.remoteHostLogin}
              </Button>
            )}
          </div>
        )}
        <button
          type="button"
          className="settings-item settings-item-link"
          onClick={() => setAdding(true)}
        >
          <span className="settings-item-icon">
            <Icon name="plus" />
          </span>
          <span className="settings-item-copy">{t.addComputer}</span>
          <Icon name="chevron" />
        </button>
        {status.mode === "local" ? (
          <RemoteAccessSettings flash={flash} />
        ) : (
          <button
            type="button"
            className="settings-item settings-item-link"
            disabled={busy}
            onClick={() => run(connectionAction({ action: "local" }))}
          >
            <span className="settings-item-icon">
              <Icon name="laptop" />
            </span>
            <span className="settings-item-copy">{t.executionLocal}</span>
            <Icon name="chevron" />
          </button>
        )}
      </div>
      <p className="settings-caption">
        {status.mode === "local" ? t.settingsDeviceHint : t.remoteContinueHint}
      </p>
      {adding && <PairComputerDialog onClose={() => setAdding(false)} />}
    </section>
  );
}
