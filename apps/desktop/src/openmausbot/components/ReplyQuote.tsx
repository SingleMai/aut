// Extracted from OpenMausBot src/components/ReplyQuote.tsx at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// The desktop supplies the author and raw text from its main-thread message.
import { IconButton } from "@radix-ui/themes";
import { Reply, X } from "lucide-react";
import { t } from "../lib/i18n.js";
import { replySnippet } from "../lib/replies.js";

export function ReplyQuote({
  text,
  name,
  onJump,
  onClear,
  compact = false,
}: {
  text: string;
  name: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  const body = (
    <>
      <Reply size={compact ? 14 : 15} strokeWidth={1.5} aria-hidden="true" className="reply-icon" />
      <span className="visually-hidden">{t("chat.reply.replyingTo", { name })}: </span>
      <span aria-hidden="true" className="reply-author">
        {name}
      </span>
      <span dir="auto" className="reply-excerpt">
        {replySnippet(text)}
      </span>
    </>
  );
  return (
    <div data-reply-quote className="reply-quote" data-compact={compact || undefined}>
      {onJump ? (
        <button
          type="button"
          onClick={onJump}
          className="reply-content"
          title={t("chat.reply.jump")}
        >
          {body}
        </button>
      ) : (
        <div className="reply-content">{body}</div>
      )}
      {onClear && (
        <IconButton
          type="button"
          onClick={onClear}
          aria-label={t("chat.reply.cancel")}
          color="gray"
          variant="ghost"
          radius="full"
          size="1"
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
