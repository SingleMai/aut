// Message disclosure and structured replies adapted from OpenMausBot ChatView.tsx and ReplyBlocks.tsx,
// commit 738ec88472a3b888ff7b7793755d89da613ed301. Apache-2.0; see NOTICE.
import { useMemo, useState } from "react";
import { ConversationMarkdown } from "./openmausbot/components/ConversationMarkdown.js";
import { useAdvancedMode } from "./openmausbot/context.js";
import { t } from "./openmausbot/lib/i18n.js";
import { splitReplyBlocks } from "./openmausbot/lib/reply-blocks.js";
export const isLongUserMessage = (text: string) => text.length > 600 || text.split("\n").length > 8;
export function ConversationBody({
  text,
  user,
  document = false,
}: {
  text: string;
  user: boolean;
  document?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const advanced = useAdvancedMode();
  const blocks = useMemo(() => {
    if (user || document || advanced) return null;
    const parts = splitReplyBlocks(text);
    return parts.some((part) => part.kind === "table") ? parts : null;
  }, [text, user, document, advanced]);
  if (blocks)
    return (
      <div className="rich-body" data-reply-bubble="">
        {blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: upstream uses source block position so streaming text updates preserve focus.
          <div key={index} data-reply-table={block.kind === "table" ? "" : undefined}>
            <ConversationMarkdown text={block.text} />
          </div>
        ))}
      </div>
    );
  if (!user)
    return (
      <div className="rich-body">
        <ConversationMarkdown text={text} />
      </div>
    );
  const long = isLongUserMessage(text);
  return (
    <>
      <div className={`chat-text${long && !expanded ? " chat-user-clipped" : ""}`}>{text}</div>
      {long && (
        <button
          type="button"
          className="chat-user-disclosure"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? "chat.showLess" : "chat.showFull")}
        </button>
      )}
    </>
  );
}
