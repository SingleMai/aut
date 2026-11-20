// Copied from OpenMausBot src/lib/formatted-reply.ts (table splitting only),
// commit 738ec88472a3b888ff7b7793755d89da613ed301. Apache-2.0; see NOTICE.
export interface ReplyBlock {
  kind: "prose" | "table";
  text: string;
}

const PIPE_ROW = /^ {0,3}\|/;
const DELIMITER_ROW = /^ {0,3}\|?(?: *:?-+:? *\|)+(?: *:?-+:? *)?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Splits a reply into prose and its tables, so Simple mode can draw each table as its own card. A table starts at a
 * top-level line opening with "|" that a delimiter row follows, and runs while its lines open with "|"; nothing inside a
 * code fence counts. A reply with no table comes back as one prose block. */
export function splitReplyBlocks(text: string): ReplyBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReplyBlock[] = [];
  const push = (kind: ReplyBlock["kind"], chunk: string[]) => {
    const body = chunk.join("\n").replace(/^\n+|\n+$/g, "");
    if (!body.trim()) return;
    const last = blocks.at(-1);
    if (kind === "prose" && last?.kind === "prose") last.text = `${last.text}\n\n${body}`;
    else blocks.push({ kind, text: body });
  };
  let prose: string[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const match = FENCE.exec(line);
    const marker = match?.[1];
    if (match && marker) {
      const suffix = match[2] ?? "";
      if (!fence) {
        if (marker[0] === "~" || !suffix.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(suffix)
      ) {
        fence = null;
      }
    }
    if (fence || marker || !PIPE_ROW.test(line) || !DELIMITER_ROW.test(lines[index + 1] ?? "")) {
      prose.push(line);
      continue;
    }
    let end = index + 2;
    while (end < lines.length && PIPE_ROW.test(lines[end] ?? "")) end++;
    push("prose", prose);
    prose = [];
    push("table", lines.slice(index, end));
    index = end - 1;
  }
  push("prose", prose);
  return blocks.length ? blocks : [{ kind: "prose", text }];
}
