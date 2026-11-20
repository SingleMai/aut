// Copied from OpenMausBot, src/components/AttachmentPreview.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: extract the source identity type; attachment preview UI is outside this integration.
export interface MessageAttachmentContext {
  threadId: string;
  messageId: string;
}
