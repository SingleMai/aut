// Extracted from OpenMausBot src/components/{SidebarSimpleTop.tsx,elevated.ts} at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// Framed desktop search controls. The caller names the searchable resource.
import { IconButton, TextField } from "@radix-ui/themes";
import { Search, X } from "lucide-react";
import type { Ref } from "react";
import { t } from "../lib/i18n.js";
import { imeComposing } from "../lib/send-key.js";

export function SidebarSearchToggle({
  open,
  onToggle,
  label,
  ref,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <IconButton
      ref={ref}
      type="button"
      data-sidebar-search-toggle
      onClick={onToggle}
      aria-label={label}
      aria-expanded={open}
      title={label}
      color="gray"
      variant="ghost"
      radius="full"
      size="1"
    >
      <Search size={17} strokeWidth={1.5} aria-hidden="true" />
    </IconButton>
  );
}

export function SidebarSearchPill({
  query,
  onQuery,
  onClose,
  label,
}: {
  label: string;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
}) {
  return (
    <TextField.Root
      data-sidebar-search-pill
      className="sidebar-search"
      size="2"
      radius="full"
      autoFocus
      type="search"
      value={query}
      onChange={(event) => onQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== "Escape" || imeComposing(event.nativeEvent))
          return;
        event.preventDefault();
        onClose();
      }}
      placeholder={label}
      aria-label={label}
    >
      <TextField.Slot>
        <Search size={15} aria-hidden="true" />
      </TextField.Slot>
      <TextField.Slot side="right">
        <IconButton
          type="button"
          onClick={onClose}
          aria-label={t("sidebar.searchClose")}
          title={t("sidebar.searchClose")}
          color="gray"
          variant="ghost"
          radius="full"
          size="1"
        >
          <X size={14} aria-hidden="true" />
        </IconButton>
      </TextField.Slot>
    </TextField.Root>
  );
}
