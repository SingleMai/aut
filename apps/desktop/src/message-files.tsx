// Attachment chip structure and preview keyboard behavior adapted from OpenMausBot
// src/components/AttachmentPreview.tsx, commit 4250c53a3acb0218870a4041101cb08b116160ce.
// Apache-2.0; see NOTICE. aut retrieves immutable file IDs through its existing IPC.
import type { FileContentResponse, MessageFile } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect, Fiber } from "effect";
import { Download, Eye, FileText, FolderOpen, Image } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { desktopApi, UiError } from "./api.js";
import { t } from "./i18n.js";
import { isImageFile } from "./openmausbot/lib/file-clipboard.js";
import { Dialog } from "./ui/dialog.js";
import { type Flash, useAction } from "./ui/use-action.js";

export const fileSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
const imageFile = (file: MessageFile) => isImageFile({ type: file.mime });
const textFile = (file: MessageFile) =>
  file.mime.startsWith("text/") || file.mime === "application/json";
export const actOnFile = (file: MessageFile, action: "save" | "reveal" | "preview") =>
  Effect.gen(function* () {
    const native = window.aut.fileAction;
    if (native) {
      const result = yield* Effect.tryPromise({
        try: () => native({ id: file.id, action }),
        catch: () => new UiError({ message: t.fileActionFailed }),
      });
      if (!result.ok)
        return yield* Effect.fail(new UiError({ message: result.error ?? t.fileActionFailed }));
      return result.cancelled ? "cancelled" : "done";
    }
    if (action !== "save") return yield* Effect.fail(new UiError({ message: t.fileDesktopOnly }));
    const result = yield* desktopApi.getFile(file.id);
    yield* Effect.sync(() => {
      const link = document.createElement("a");
      link.href = `data:application/octet-stream;base64,${result.base64}`;
      link.download = result.file.name;
      document.body.append(link);
      link.click();
      link.remove();
    });
    return "done";
  });

function FilePreview({
  file,
  onClose,
  flash,
}: {
  file: MessageFile;
  onClose: () => void;
  flash: Flash;
}) {
  const [content, setContent] = useState<FileContentResponse>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const action = useAction(flash);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries a failed read of the same snapshot.
  useEffect(() => {
    let active = true;
    setContent(undefined);
    setError(undefined);
    const fiber = Effect.runFork(
      desktopApi.getFile(file.id).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (active) setContent(value);
          }),
        ),
        Effect.catchAll((value) =>
          Effect.sync(() => {
            if (active) setError(value.message);
          }),
        ),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [file.id, revision]);
  let body: ReactNode;
  if (content && imageFile(file))
    body = (
      <img
        className="file-preview-image"
        src={`data:${file.mime};base64,${content.base64}`}
        alt={file.name}
      />
    );
  else if (content && textFile(file)) {
    const bytes = Uint8Array.from(atob(content.base64), (character) => character.charCodeAt(0));
    body = (
      <>
        <pre className="file-preview-text">
          {new TextDecoder().decode(bytes.subarray(0, 256 * 1024))}
        </pre>
        {bytes.length > 256 * 1024 && <p className="muted">{t.filePreviewTruncated}</p>}
      </>
    );
  } else if (content) body = <p className="muted">{t.filePreviewExternal}</p>;
  return (
    <Dialog title={file.name} onClose={onClose}>
      <div className="file-preview">
        {error ? (
          <p role="alert">
            {error}{" "}
            <Button variant="soft" onClick={() => setRevision((value) => value + 1)}>
              {t.retry}
            </Button>
          </p>
        ) : !content ? (
          <p role="status">{t.loading}</p>
        ) : (
          body
        )}
        <div className="file-card-actions">
          <Button disabled={action.busy} onClick={() => action.run(actOnFile(file, "save"))}>
            <Download size={16} />
            {t.fileSave}
          </Button>
          {window.aut.fileAction && (
            <Button
              variant="soft"
              disabled={action.busy}
              onClick={() => action.run(actOnFile(file, "preview"))}
            >
              <Eye size={16} />
              {t.fileQuickLook}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function FileCard({ file, flash }: { file: MessageFile; flash: Flash }) {
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState(false);
  const action = useAction(flash);
  const Icon = imageFile(file) ? Image : FileText;
  return (
    <div className="file-card" data-file-id={file.id}>
      <button
        type="button"
        className="file-card-name"
        onClick={() => setPreview(true)}
        aria-label={`${t.filePreview} ${file.name}`}
        title={file.name}
      >
        <Icon size={20} />
        <span>
          <strong>{file.name}</strong>
          <small>{fileSize(file.size)}</small>
        </span>
        <Eye size={15} />
      </button>
      <div className="file-card-actions">
        <button
          type="button"
          disabled={action.busy}
          title={t.fileSave}
          aria-label={`${t.fileSave} ${file.name}`}
          onClick={() =>
            action.run(
              actOnFile(file, "save").pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (result === "done") setSaved(true);
                  }),
                ),
              ),
            )
          }
        >
          <Download size={15} />
          <span>{saved ? t.fileSaved : t.fileSave}</span>
        </button>
        {window.aut.fileAction && (
          <button
            type="button"
            disabled={action.busy}
            title={t.fileReveal}
            aria-label={`${t.fileReveal} ${file.name}`}
            onClick={() => action.run(actOnFile(file, "reveal"))}
          >
            <FolderOpen size={15} />
          </button>
        )}
      </div>
      {preview && <FilePreview {...{ file, flash }} onClose={() => setPreview(false)} />}
    </div>
  );
}
export function MessageFilesView({
  files,
  flash,
}: {
  files: readonly MessageFile[];
  flash: Flash;
}) {
  return (
    <div className="message-files">
      {files.map((file) => (
        <FileCard key={file.id} {...{ file, flash }} />
      ))}
    </div>
  );
}
