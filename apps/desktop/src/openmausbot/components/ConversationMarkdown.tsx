// Copied from OpenMausBot src/components/ChatMarkdown.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut omits thread references and file previews: rendered content has no file or application capabilities.
import { memo, type ReactNode, useMemo, useState } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCopyFeedback } from "../lib/copy-feedback.js";
import { t } from "../lib/i18n.js";
import { repairMarkdownTables } from "../lib/markdown-tables.js";
import { ConversationFence } from "./ConversationFence.js";

/** A reply's newlines and a table cell's attribute-free <br> tags become Markdown breaks, without parsing raw HTML. */
interface MarkdownNode {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
}
function remarkSoftBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode, inTableCell = false) => {
      if (!node.children) return;
      const tableCell = inTableCell || node.type === "tableCell";
      node.children = node.children.flatMap((child) => {
        if (tableCell && child?.type === "html" && /^<br\s*\/?>$/i.test(child.value ?? ""))
          return [{ type: "break" }];
        if (child?.type !== "text" || !child.value?.includes("\n")) {
          visit(child, tableCell);
          return [child];
        }
        return child.value
          .split("\n")
          .flatMap((value, index) => [
            ...(index ? [{ type: "break" }] : []),
            ...(value ? [{ type: "text", value }] : []),
          ]);
      });
    };
    visit(tree);
  };
}

// Not dir="auto": that algorithm skips descendants carrying their own dir, so a blockquote or table of per-block
// directions falls back to LTR. JS regexes cannot match Bidi_Class, so these are the blocks Unicode reserves for
// right-to-left letters.
const RTL_LETTER =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

export function textDirection(value: string): "rtl" | "ltr" {
  const strong = /\p{Letter}/u.exec(value);
  return strong && RTL_LETTER.test(strong[0]) ? "rtl" : "ltr";
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

function blockText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code" || node.tagName === "pre") return "";
  return (node.children ?? []).map(blockText).join("");
}

export function blockDirection(node: unknown): "rtl" | "ltr" {
  return textDirection(blockText(node as HastNode));
}

interface BlockProps {
  node?: unknown;
  children?: ReactNode;
}

function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <span className="markdown-spoiler">
        <span aria-hidden="true" inert className="spoiler-content">
          {children}
        </span>
        <button
          type="button"
          aria-label={t("chat.spoiler.reveal")}
          title={t("chat.spoiler.reveal")}
          onClick={() => setRevealed(true)}
          className="spoiler-reveal"
        />
      </span>
    );
  }
  return (
    <span className="markdown-spoiler spoiler-revealed">
      {children}
      <button
        type="button"
        aria-label={t("chat.spoiler.hide")}
        title={t("chat.spoiler.hide")}
        onClick={() => setRevealed(false)}
        className="spoiler-hide"
      >
        {t("chat.spoiler.hideShort")}
      </button>
    </span>
  );
}
// Opening a URL would leave the local-only desktop boundary (ADR-0025).
export function WebAddress({ href, children }: { href: string; children?: ReactNode }) {
  const { state, copy } = useCopyFeedback(href);
  const label =
    state === "copied"
      ? t("code.copiedTitle")
      : state === "failed"
        ? t("common.copyFailed")
        : `${t("chat.copyLink")} · ${href}`;
  return (
    <button type="button" className="markdown-link" title={label} aria-label={label} onClick={copy}>
      {children}
      {state !== "idle" && (
        <span role="status" className="visually-hidden">
          {label}
        </span>
      )}
    </button>
  );
}
function webUrl(value: string) {
  try {
    if (!/^https?:\/\//i.test(value)) return "";
    const url = new URL(value);
    return url.username || url.password ? "" : url.href;
  } catch {
    return "";
  }
}
const components: Components = {
  pre({ node }) {
    const child = node?.children[0];
    if (child?.type !== "element") return null;
    const lang =
      (child.properties.className as string[] | undefined)
        ?.find((key) => key.startsWith("language-"))
        ?.slice(9) ?? "";
    const code = child.children
      .map((n) => (n.type === "text" ? n.value : ""))
      .join("")
      .replace(/\n$/, "");
    return <ConversationFence code={code} lang={lang} />;
  },
  img({ alt }) {
    return <span>{alt}</span>;
  },
  a({ href, children }) {
    return href ? <WebAddress href={href}>{children}</WebAddress> : <span>{children}</span>;
  },
  code({ children }) {
    return (
      <code dir="ltr" className="markdown-inline-code">
        {children}
      </code>
    );
  },
  table({ children }) {
    return (
      <div className="markdown-table">
        <table>{children}</table>
      </div>
    );
  },
  p({ node, children }: BlockProps) {
    return <p dir={blockDirection(node)}>{children}</p>;
  },
  ul({ node, children }: BlockProps) {
    return <ul dir={blockDirection(node)}>{children}</ul>;
  },
  ol({ node, children }: BlockProps) {
    return <ol dir={blockDirection(node)}>{children}</ol>;
  },
  h1({ node, children }: BlockProps) {
    return <h1 dir={blockDirection(node)}>{children}</h1>;
  },
  h2({ node, children }: BlockProps) {
    return <h2 dir={blockDirection(node)}>{children}</h2>;
  },
  h3({ node, children }: BlockProps) {
    return <h3 dir={blockDirection(node)}>{children}</h3>;
  },
  h4({ node, children }: BlockProps) {
    return <h4 dir={blockDirection(node)}>{children}</h4>;
  },
  h5({ node, children }: BlockProps) {
    return <h5 dir={blockDirection(node)}>{children}</h5>;
  },
  h6({ node, children }: BlockProps) {
    return <h6 dir={blockDirection(node)}>{children}</h6>;
  },
  blockquote({ node, children }: BlockProps) {
    return <blockquote dir={blockDirection(node)}>{children}</blockquote>;
  },
  del({ children }: { children?: ReactNode }) {
    return <Spoiler>{children}</Spoiler>;
  },
};

const plugins: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }], remarkSoftBreaks];
export const ConversationMarkdown = memo(function ConversationMarkdown({ text }: { text: string }) {
  const prepared = useMemo(() => repairMarkdownTables(text), [text]);
  return (
    <div className="markdown-body">
      <Markdown skipHtml components={components} remarkPlugins={plugins} urlTransform={webUrl}>
        {prepared}
      </Markdown>
    </div>
  );
});
