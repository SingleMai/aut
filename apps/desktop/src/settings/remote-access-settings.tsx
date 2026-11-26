import type { RemoteHostStatus } from "@aut/protocol";
import { Button, Switch } from "@radix-ui/themes";
import { Effect, Fiber, Schedule } from "effect";
import { useEffect, useState } from "react";
import { connectionAction, desktopApi } from "../api.js";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";
import { Dialog } from "../ui/dialog.js";
import { InputField } from "../ui/form-fields.js";
import { type Flash, useAction } from "../ui/use-action.js";

export function RemoteAccessSettings({ flash }: { flash: Flash }) {
  const { busy, run } = useAction(flash);
  const [host, setHost] = useState<RemoteHostStatus>();
  const [hostError, setHostError] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState<string>();
  const [confirm, setConfirm] = useState<"rotate" | "disable">();
  useEffect(() => {
    const fiber = Effect.runFork(
      desktopApi.getRemoteHost().pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            setHost(value);
            setHostError("");
          }),
        ),
        Effect.catchAll((error) => Effect.sync(() => setHostError(error.message))),
        Effect.repeat(Schedule.spaced("2 seconds")),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, []);
  const configure = (enabled: boolean, rotate = false) =>
    run(
      desktopApi
        .configureRemoteHost({ enabled, name: name?.trim() || host?.name || "我的 Mac", rotate })
        .pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              setHost(value);
              setName(undefined);
              setEditingName(false);
              setConfirm(undefined);
              if (rotate) flash(t.remoteHostRotated);
            }),
          ),
        ),
    );
  return (
    <>
      <div className="settings-item sharing-toggle">
        <span className="settings-item-icon">
          <Icon name="link" />
        </span>
        <div className="settings-item-copy">
          <h3>{t.sharingAllow}</h3>
          <p>{t.sharingCompactHint}</p>
        </div>
        <Switch
          size="2"
          aria-label={t.sharingAllow}
          checked={host?.enabled ?? false}
          disabled={busy || !host || !!hostError}
          onCheckedChange={(enabled) => (enabled ? configure(true) : setConfirm("disable"))}
        />
      </div>
      {hostError && (
        <p className="device-feedback connection-error" role="status">
          {hostError}
        </p>
      )}
      {host?.enabled && (
        <div className="sharing-details">
          <div className="sharing-status-row">
            <div className="settings-item-copy">
              <span
                className="connection-badge"
                data-phase={host.state === "ready" ? "connected" : "connecting"}
              >
                {host.state === "ready" ? t.sharingConnected : t.remoteHostState[host.state]}
              </span>
              <p>
                {host.state === "ready"
                  ? t.sharingCompactReady
                  : host.state === "login"
                    ? t.sharingLoginHint
                    : t.remoteHostPending}
              </p>
            </div>
            {host.state === "login" && (
              <Button
                size="1"
                disabled={busy}
                onClick={() => run(connectionAction({ action: "login" }))}
              >
                {t.remoteHostLogin}
              </Button>
            )}
            {host.state === "ready" && (
              <Button
                size="1"
                variant="surface"
                color="gray"
                disabled={busy}
                onClick={() =>
                  run(
                    connectionAction({ action: "copy" }).pipe(
                      Effect.tap(() => Effect.sync(() => flash(t.remoteHostCopied))),
                    ),
                  )
                }
              >
                <Icon name="clipboard" />
                {t.remoteHostCopy}
              </Button>
            )}
          </div>
          {host.message && (
            <p className="connection-error" role="status">
              {host.message}
            </p>
          )}
          <details className="sharing-options">
            <summary>
              {t.sharingManage}
              <Icon name="chevron" />
            </summary>
            {!editingName ? (
              <div className="settings-item">
                <div className="settings-item-copy">
                  <h3>{t.sharingRename}</h3>
                  <p>{host.name}</p>
                </div>
                <Button variant="ghost" size="1" color="gray" onClick={() => setEditingName(true)}>
                  {t.edit}
                </Button>
              </div>
            ) : (
              <form
                className="settings-item computer-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  configure(true);
                }}
              >
                <InputField
                  label={t.sharingRename}
                  value={name ?? host.name}
                  maxLength={80}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  type="submit"
                  size="1"
                  variant="surface"
                  disabled={busy || !name?.trim() || name.trim() === host.name}
                >
                  {t.save}
                </Button>
                <Button
                  size="1"
                  variant="ghost"
                  color="gray"
                  onClick={() => {
                    setEditingName(false);
                    setName(undefined);
                  }}
                >
                  {t.cancel}
                </Button>
              </form>
            )}
            <div className="settings-item">
              <div className="settings-item-copy">
                <h3>{t.remoteHostRotate}</h3>
                <p>{t.sharingRotateCompact}</p>
              </div>
              <Button
                size="1"
                variant="surface"
                color="gray"
                disabled={busy}
                onClick={() => setConfirm("rotate")}
              >
                {t.remoteHostRotate}
              </Button>
            </div>
            <p className="settings-caption">{t.pairingPrivate}</p>
          </details>
        </div>
      )}
      {confirm && (
        <Dialog
          title={confirm === "rotate" ? t.remoteHostRotate : t.remoteHostDisable}
          maxWidth="460px"
          onClose={() => setConfirm(undefined)}
        >
          <div className="pairing-body">
            <p>{confirm === "rotate" ? t.sharingRotateHint : t.sharingDisableHint}</p>
          </div>
          <div className="form-actions">
            <Button variant="surface" onClick={() => setConfirm(undefined)}>
              {t.cancel}
            </Button>
            <Button
              color="red"
              disabled={busy}
              onClick={() => configure(confirm === "rotate", confirm === "rotate")}
            >
              {t.sharingConfirm}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
