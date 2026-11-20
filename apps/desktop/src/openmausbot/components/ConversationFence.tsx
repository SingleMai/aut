// Adapted from OpenMausBot src/components/CodeBlock.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0; see NOTICE.
// Use token elements instead of generator HTML or inline styles under the desktop CSP.

import { IconButton } from "@radix-ui/themes";
import { common, createLowlight } from "lowlight";
import { Check, Copy, WrapText, X } from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { useAdvancedMode } from "../context.js";
import { useCopyFeedback } from "../lib/copy-feedback.js";
import { t } from "../lib/i18n.js";

const grammar = createLowlight(common);
type Token = ReturnType<typeof grammar.highlight>["children"][number];
function tokens(nodes: readonly Token[]): ReactNode {
  let offset = 0;
  return nodes.map((node) => {
    const key = offset++;
    return node.type === "text" ? (
      <Fragment key={key}>{node.value}</Fragment>
    ) : node.type === "element" ? (
      <span
        className={
          Array.isArray(node.properties.className) ? node.properties.className.join(" ") : undefined
        }
        key={key}
      >
        {tokens(node.children)}
      </span>
    ) : null;
  });
}
export function ConversationFence({ code, lang }: { code: string; lang: string }) {
  const advanced = useAdvancedMode();
  const { state: copied, copy } = useCopyFeedback(code);
  const [wrap, setWrap] = useState(false);
  const highlighted = useMemo(
    () =>
      code.length <= 100_000 && grammar.registered(lang)
        ? tokens(grammar.highlight(lang, code).children)
        : code,
    [lang, code],
  );
  const copyLabel =
    copied === "copied"
      ? t("code.copiedTitle")
      : copied === "failed"
        ? t("common.copyFailed")
        : t("code.copyTitle");
  const actions = (
    <>
      <IconButton
        type="button"
        color="gray"
        variant="ghost"
        radius="full"
        size="1"
        className="code-action"
        onClick={copy}
        aria-label={copyLabel}
        title={copyLabel}
      >
        {copied === "failed" ? (
          <X size={14} />
        ) : copied === "copied" ? (
          <Check size={14} />
        ) : (
          <Copy size={14} />
        )}
      </IconButton>
      <IconButton
        type="button"
        aria-pressed={wrap}
        aria-label={t("code.wrapLines")}
        title={t("code.wrapLines")}
        onClick={() => setWrap(!wrap)}
        color="gray"
        variant="ghost"
        radius="full"
        size="1"
        className="code-action"
      >
        <WrapText size={14} />
      </IconButton>
    </>
  );
  return (
    <div dir="ltr" className="code-block" data-advanced={advanced || undefined}>
      {advanced ? (
        <div className="code-header">
          <span>{lang || "text"}</span>
          <div>{actions}</div>
        </div>
      ) : (
        <div className="code-actions">{actions}</div>
      )}
      <pre className="code-content">
        <code>{highlighted}</code>
      </pre>
    </div>
  );
}
