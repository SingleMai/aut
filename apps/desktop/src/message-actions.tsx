// Message actions adapted from OpenMausBot src/components/MessageActions.tsx at
// 738ec88472a3b888ff7b7793755d89da613ed301. Apache-2.0. See NOTICE.
import { ContextMenu, DropdownMenu, IconButton } from "@radix-ui/themes";
import { Ellipsis } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "./openmausbot/lib/i18n.js";
import { imeComposing } from "./openmausbot/lib/send-key.js";

export interface MessageMenuItem {
  readonly key: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
}

function preserveNativeContext(event: MouseEvent<HTMLDivElement>) {
  const target = event.target;
  if (
    !event.currentTarget.contains(target as Node) ||
    (target instanceof Element &&
      target.closest(
        "a,button,input,textarea,select,summary,label,[role=button],[contenteditable=true]",
      )) ||
    window.getSelection()?.toString().trim() ||
    (event.nativeEvent as PointerEvent).pointerType === "touch"
  )
    event.stopPropagation();
}

export function MessageActions({
  side,
  menu,
  children,
}: {
  side: "user" | "bot";
  menu: readonly MessageMenuItem[];
  children: ReactNode;
}) {
  const [active, setActive] = useState<"button" | "context" | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusOnClose = useRef<"action" | "trigger" | null>(null);
  const label = t("chat.messageActions");

  useEffect(() => {
    if (!active) return;
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) setActive(null);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [active]);

  const bubble = (
    // biome-ignore lint/a11y/noStaticElementInteractions: preserve native interactions inside the menu trigger.
    <div
      className="message-body"
      data-chat-bubble
      onContextMenu={preserveNativeContext}
      onPointerDown={(event) => {
        // Leave long presses to native text selection.
        if (event.pointerType !== "mouse") event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
  if (!menu.length) return bubble;
  const items = (Item: typeof DropdownMenu.Item | typeof ContextMenu.Item) =>
    menu.map((item) => (
      <Item
        key={item.key}
        onSelect={() => {
          focusOnClose.current = "action";
          trigger.current?.focus({ preventScroll: true });
          item.onSelect();
        }}
      >
        {item.icon}
        {item.label}
      </Item>
    ));
  const content = {
    ref: panel,
    "aria-label": label,
    className: "message-menu",
    loop: true,
    onEscapeKeyDown(event: KeyboardEvent) {
      if (imeComposing(event)) event.preventDefault();
      else focusOnClose.current = "trigger";
    },
    onCloseAutoFocus(event: Event) {
      if (focusOnClose.current) event.preventDefault();
      if (focusOnClose.current === "trigger") trigger.current?.focus({ preventScroll: true });
      focusOnClose.current = null;
    },
  };
  const changeOpen = (kind: "button" | "context", open: boolean) =>
    setActive((current) => (open ? kind : current === kind ? null : current));
  return (
    <>
      <ContextMenu.Root
        modal={false}
        open={active === "context"}
        onOpenChange={(open) => changeOpen("context", open)}
      >
        <ContextMenu.Trigger>
          <div className="message-context-target">{bubble}</div>
        </ContextMenu.Trigger>
        <ContextMenu.Content {...content}>{items(ContextMenu.Item)}</ContextMenu.Content>
      </ContextMenu.Root>
      <div className="message-actions" data-open={active ? "" : undefined}>
        <DropdownMenu.Root
          modal={false}
          open={active === "button"}
          onOpenChange={(open) => changeOpen("button", open)}
        >
          <DropdownMenu.Trigger>
            <IconButton
              type="button"
              ref={trigger}
              aria-label={label}
              title={label}
              color="gray"
              variant="ghost"
              radius="full"
              size="1"
              className="message-more"
            >
              <Ellipsis size={17} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content {...content} align={side === "user" ? "end" : "start"}>
            {items(DropdownMenu.Item)}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </>
  );
}
