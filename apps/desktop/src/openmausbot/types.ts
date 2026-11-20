// UI-only projection of OpenMausBot Message/Tool fields (Apache-2.0).
// Source: src/state/store.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. See NOTICE.
// This is a renderer view type, not a daemon protocol or persistent store.
import type { ServerTextParams, ServerToolText } from "./shared/server-text.js";

export interface Tool extends ServerToolText {
  name: string;
  ok?: boolean | undefined;
  label?: string;
  summary?: string;
  problem?: string;
  input?: string;
  output?: string;
  clipped?: boolean;
  whose?: { person: string; app: string };
  itemId?: string;
}

export interface Message {
  id: string;
  at: number;
  role: "user" | "bot" | "system";
  kind: "text" | "activity";
  text?: string;
  textCode?: string;
  textParams?: ServerTextParams;
  turnId?: string;
  turnTerminal?: boolean;
  tool?: Tool;
  from?: { botId: string; name?: string; color?: string };
  comm?: unknown;
  threadRef?: unknown;
  relay?: unknown;
  dataResult?: unknown;
  reaction?: string;
  replyToId?: string;
  attachments?: readonly unknown[] | null;
}
