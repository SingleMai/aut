import { IconButton, Dialog as RadixDialog } from "@radix-ui/themes";
import { type ReactNode, useRef } from "react";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";

export function Dialog({
  title,
  maxWidth = "760px",
  children,
  initialFocus,
  onClose,
}: {
  title: string;
  maxWidth?: string;
  children: ReactNode;
  initialFocus?: string;
  onClose: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Content
        ref={content}
        className="modal"
        maxWidth={maxWidth}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const target = initialFocus && content.current?.querySelector<HTMLElement>(initialFocus);
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
        }}
      >
        <div className="modal-header">
          <RadixDialog.Title mb="0">{title}</RadixDialog.Title>
          <RadixDialog.Close>
            <IconButton variant="ghost" color="gray" radius="full" aria-label={t.close}>
              <Icon name="close" />
            </IconButton>
          </RadixDialog.Close>
        </div>
        <div className="modal-content">{children}</div>
      </RadixDialog.Content>
    </RadixDialog.Root>
  );
}
