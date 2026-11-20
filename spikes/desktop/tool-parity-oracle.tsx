// Test-only comparison harness. The left pane imports untouched OpenMausBot sources
// from commit 738ec88472a3b888ff7b7793755d89da613ed301 (Apache-2.0); see NOTICE.
// Both panes deliberately share locale/mode/API shims, never upstream backend state.
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskSessionResponse } from "@aut/protocol";
import { ToolActivity as OriginalTool } from "oracle-upstream/ToolActivity";
import { ActivityRun as OriginalRun } from "oracle-upstream/ActivityRun";
import { TurnNarrationRun as OriginalTurn } from "oracle-upstream/TurnNarrationRun";
import { groupTranscript as originalGroup } from "oracle-upstream/activity-runs";
import { ToolActivity as CopiedTool } from "../../apps/desktop/src/openmausbot/components/ToolActivity.js";
import { ActivityRun as CopiedRun } from "../../apps/desktop/src/openmausbot/components/ActivityRun.js";
import { TurnNarrationRun as CopiedTurn } from "../../apps/desktop/src/openmausbot/components/TurnNarrationRun.js";
import { AdvancedModeProvider } from "../../apps/desktop/src/openmausbot/context.js";
import {
  groupTranscript as copiedGroup,
  type TranscriptItem,
} from "../../apps/desktop/src/openmausbot/lib/activity-runs.js";
import { setLocale } from "../../apps/desktop/src/openmausbot/lib/i18n.js";
import type { Message } from "../../apps/desktop/src/openmausbot/types.js";
import { projectSession } from "../../apps/desktop/src/session-presentation.js";
import { TaskSessionView } from "../../apps/desktop/src/task-session-view.js";

setLocale("en");
const start = Date.parse("2026-11-17T12:00:00Z");
const base = {
  at: start,
  role: "bot" as const,
  kind: "activity" as const,
  turnId: "same-turn",
  from: { botId: "fixture" },
};
const tool = (
  id: string,
  name: string,
  extra: Partial<NonNullable<Message["tool"]>> = {},
): Message => ({
  ...base,
  id,
  tool: {
    name,
    ok: true,
    input: `fixture input: ${name}`,
    output: "fixture output\n<script>literal text only</script>",
    ...extra,
  },
});
const unresolvedTool = (
  id: string,
  name: string,
  extra: Partial<NonNullable<Message["tool"]>> = {},
): Message => {
  const message = tool(id, name, extra);
  if (message.tool) delete message.tool.ok;
  return message;
};
const running: Message[] = [
  { ...base, id: "input", role: "user", kind: "text", text: "Inspect the synthetic fixture." },
  { ...base, id: "progress", kind: "text", text: "PARITY_PROGRESS: progress stays visible." },
  tool("command-1", "pnpm test -- one", { summary: "pnpm test -- one" }),
  tool("command-2", "pnpm test -- two", { summary: "pnpm test -- two" }),
  tool("edit", "edit"),
  tool("search", "web_search"),
  tool("read", "read"),
  tool("write", "write"),
  tool("failure", "mcp__fixture__read_document", {
    ok: false,
    problem:
      "PARITY_PROBLEM: The requested document does not exist. Check the document identifier and retry.",
    output: "NOT_FOUND",
  }),
  unresolvedTool("unknown", "mcp__fixture__unfamiliar_tool", { output: "" }),
  {
    ...base,
    id: "progress-2",
    kind: "text",
    text: "PARITY_PROGRESS_2: failure and unknown remain visible.",
  },
  unresolvedTool("live", "synthetic-live --watch", {
    summary: "synthetic-live --watch",
    output: "",
  }),
];
const completed = running
  .map((message) =>
    message.id === "live"
      ? { ...message, tool: { ...message.tool!, ok: true, output: "PARITY_LIVE_UPDATE" } }
      : message,
  )
  .concat({
    ...base,
    id: "final",
    kind: "text",
    text: "PARITY_FINAL: successful tools fold; all narration remains visible.",
    turnTerminal: true,
    at: start + 31_000,
  });

type Components = {
  Tool: typeof CopiedTool;
  Run: typeof CopiedRun;
  Turn: typeof CopiedTurn;
  group: (messages: Message[]) => TranscriptItem[];
};
const original: Components = {
  Tool: OriginalTool,
  Run: OriginalRun,
  Turn: OriginalTurn,
  group: originalGroup,
};
const copied: Components = {
  Tool: CopiedTool,
  Run: CopiedRun,
  Turn: CopiedTurn,
  group: copiedGroup,
};
function Transcript({
  components: { Tool, Run, Turn, group },
  messages,
  showTools,
  focus,
  liveIds,
}: {
  components: Components;
  messages: Message[];
  showTools: boolean;
  focus: string;
  liveIds: Set<string>;
}) {
  const row = (message: Message) => (
    <div key={message.id} data-message-id={message.id}>
      {message.tool ? (
        <Tool tool={message.tool} live={liveIds.has(message.id)} />
      ) : (
        <p className="oracle-text">{message.text}</p>
      )}
    </div>
  );
  return (
    <>
      {group(messages).map((item) => {
        if (item.kind === "message")
          return !item.message.tool || showTools ? row(item.message) : null;
        if (!showTools) return null;
        const forceOpen = item.messages.some((message) => message.id === focus);
        const children = item.messages.map(row);
        return item.kind === "run" ? (
          <Run key={item.id} messages={item.messages} forceOpen={forceOpen}>
            {children}
          </Run>
        ) : (
          <Turn key={item.id} label={item.label} forceOpen={forceOpen}>
            {children}
          </Turn>
        );
      })}
    </>
  );
}

interface PreviewOptions {
  loading?: boolean;
  error?: string;
  focusedItemId?: string | undefined;
}

function App() {
  const [messages, setMessages] = useState(running);
  const [advanced, setAdvanced] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [focus, setFocus] = useState("");
  const [liveIds, setLiveIds] = useState(new Set(["live"]));
  const [preview, setPreview] = useState<PreviewOptions & { response: TaskSessionResponse }>();
  const consumeFocus = useCallback((id: string) => {
    setPreview((current) =>
      current?.focusedItemId === id ? { ...current, focusedItemId: undefined } : current,
    );
  }, []);
  window.productionFocusFixture = {
    focusItem: (focusedItemId) => setPreview((current) => current && { ...current, focusedItemId }),
    update: (response, options) => setPreview((current) => ({
      response,
      focusedItemId: current?.response.task.id === response.task.id ? current.focusedItemId : undefined,
      ...options,
    })),
    dispose: () => setPreview(undefined),
  };
  window.parityOracle = {
    setSnapshot: (response) => {
      const projected = projectSession(response);
      setMessages(projected.messages);
      setLiveIds(projected.liveMessageIds);
      setFocus("");
    },
    setMessages: (value) => {
      setMessages(value);
      setFocus("");
    },
    setAdvanced,
    setShowTools,
    setFocus,
    running: () => {
      setMessages(running);
      setLiveIds(new Set(["live"]));
      setFocus("");
    },
    complete: () => {
      setMessages(completed);
      setLiveIds(new Set());
      setFocus("");
    },
    compare: () => comparePanes(),
    grouping: () => ({ upstream: originalGroup(messages), copied: copiedGroup(messages) }),
    mountProduction: (response) => setPreview({ response }),
  };
  return (
    <>
      <header>
        <h1>Tool UI source comparison</h1>
        <p>
          OpenMausBot 738ec88 original source ↔ aut copied components · identical Message[] input ·
          test-only interface shims
        </p>
        <div className="oracle-controls">
          <button
            onClick={() => {
              setMessages(running);
              setLiveIds(new Set(["live"]));
              setFocus("");
            }}
          >
            Running fixture
          </button>
          <button
            onClick={() => {
              setMessages(completed);
              setLiveIds(new Set());
              setFocus("");
            }}
          >
            Completed fixture
          </button>
          <label>
            <input
              type="checkbox"
              checked={advanced}
              onChange={(event) => setAdvanced(event.target.checked)}
            />
            Advanced
          </label>
          <label>
            <input
              type="checkbox"
              checked={showTools}
              onChange={(event) => setShowTools(event.target.checked)}
            />
            Show tools
          </label>
          <button
            onClick={() => {
              setShowTools(true);
              setFocus("command-1");
            }}
          >
            Locate first command
          </button>
        </div>
      </header>
      <AdvancedModeProvider value={advanced}>
        <main>
          {[
            ["upstream", "Untouched upstream components", original],
            ["copied", "aut copied components", copied],
          ].map(([id, label, components]) => (
            <section key={id as string}>
              <h2>{label as string}</h2>
              <div data-pane={id} className="oracle-transcript">
                <Transcript
                  components={components as Components}
                  messages={messages}
                  showTools={showTools}
                  focus={focus}
                  liveIds={liveIds}
                />
              </div>
            </section>
          ))}
        </main>
      </AdvancedModeProvider>
      {preview && (
        <section
          id="production-focus-fixture"
          style={{ position: "fixed", inset: 40, height: 360, overflow: "auto",
            background: "white", padding: 20, border: "1px solid #999", zIndex: 10 }}
        >
          <div style={{ height: 800 }} />
          <TaskSessionView
            key={preview.response.task.id}
            task={preview.response.task}
            response={preview.response}
            busy={preview.loading ?? false}
            error={preview.error ?? ""}
            load={() => {}}
            {...(preview.focusedItemId && { focusedItemId: preview.focusedItemId })}
            onFocusConsumed={consumeFocus}
          />
        </section>
      )}
    </>
  );
}

function comparePanes() {
  const capture = (name: string) => {
    const pane = document.querySelector<HTMLElement>(`[data-pane="${name}"]`)!;
    const elements = [
      ...pane.querySelectorAll<HTMLElement>("button,summary,details,[data-message-id],pre,svg"),
    ];
    const visibleText = [...pane.querySelectorAll<HTMLElement>("button,summary,p,pre")]
      .filter((element) => element.checkVisibility())
      .map((element) => element.textContent);
    return {
      visibleText,
      elements: elements.map((element) => ({
        tag: element.tagName,
        text: element.textContent,
        expanded: element.getAttribute("aria-expanded"),
        role: element.getAttribute("role"),
        label: element.getAttribute("aria-label"),
        open: element.hasAttribute("open"),
        messageId: element.getAttribute("data-message-id"),
      })),
    };
  };
  const upstream = capture("upstream");
  const copied = capture("copied");
  const differences = [];
  for (let index = 0; index < Math.max(upstream.elements.length, copied.elements.length); index++) {
    const left = upstream.elements[index], right = copied.elements[index];
    if (JSON.stringify(left) !== JSON.stringify(right))
      differences.push({ index, upstream: left, copied: right });
  }
  const sameVisibleText = JSON.stringify(upstream.visibleText) === JSON.stringify(copied.visibleText);
  return {
    equal: differences.length === 0 && sameVisibleText,
    sameVisibleText,
    upstreamElements: upstream.elements.length,
    copiedElements: copied.elements.length,
    differences,
  };
}

declare global {
  interface Window {
    productionFocusFixture: {
      focusItem: (itemId: string) => void;
      update: (response: TaskSessionResponse, options?: PreviewOptions) => void;
      dispose: () => void;
    };
    parityOracle: {
      mountProduction: (response: TaskSessionResponse) => void;
      setSnapshot: (response: TaskSessionResponse) => void;
      setMessages: (messages: Message[]) => void;
      setAdvanced: (value: boolean) => void;
      setShowTools: (value: boolean) => void;
      setFocus: (id: string) => void;
      running: () => void;
      complete: () => void;
      compare: typeof comparePanes;
      grouping: () => { upstream: TranscriptItem[]; copied: TranscriptItem[] };
    };
  }
}
createRoot(document.getElementById("root")!).render(<App />);
