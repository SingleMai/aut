import { resolveMemoryLink } from "@aut/protocol";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { t } from "./i18n.js";
import { WebAddress } from "./openmausbot/components/ConversationMarkdown.js";

export function MemoryMarkdown({
  content,
  path,
  paths,
  disabled,
  open,
}: {
  content: string;
  path: string;
  paths: ReadonlySet<string>;
  disabled: boolean;
  open: (path: string) => void;
}) {
  return (
    <div className="markdown-body memory-prose">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          if (resolveMemoryLink(path, url)) return url;
          if (!/^https?:\/\//iu.test(url)) return "";
          try {
            const target = new URL(url);
            return target.username || target.password ? "" : target.href;
          } catch {
            return "";
          }
        }}
        components={{
          a({ href, children }) {
            const target = href && resolveMemoryLink(path, href);
            if (target) {
              const exists = paths.has(target);
              return (
                <button
                  type="button"
                  className={`markdown-link memory-document-link${exists ? "" : " is-missing"}`}
                  title={exists ? target : t.memoryMissingLink(target)}
                  disabled={disabled || !exists}
                  onClick={() => open(target)}
                >
                  {children}
                  {!exists && <span className="memory-link-status">{t.memoryLinkMissing}</span>}
                </button>
              );
            }
            return href ? <WebAddress href={href}>{children}</WebAddress> : <span>{children}</span>;
          },
          img({ alt }) {
            return <span className="muted">{alt}</span>;
          },
          table({ children }) {
            return (
              <div className="markdown-table">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
