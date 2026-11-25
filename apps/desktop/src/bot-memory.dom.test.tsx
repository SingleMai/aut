// @vitest-environment happy-dom
import {
  type BotConfig,
  BotId,
  type BotMemoryResponse,
  type MemoryFile,
  type MemoryGraphResponse,
  TaskId,
  type Trigger,
  TriggerId,
  TriggerRunId,
} from "@aut/protocol";
import { Deferred, Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import { BotMemory } from "./bot-memory.js";
import { t } from "./i18n.js";

const bot: BotConfig = {
  id: BotId.make("memory-bot"),
  name: "研究助手",
  description: "研究",
  soul: "",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
};
const dream: Trigger = {
  id: TriggerId.make("dream-memory-bot"),
  name: "记忆整理",
  enabled: true,
  botId: bot.id,
  prompt: "整理记忆",
  payload: {},
  schedule: { kind: "daily", at: "03:00", timeZone: "Asia/Shanghai" },
  overlap: "skip",
  createdAt: 1000,
  updatedAt: 1000,
  nextAt: 10000,
};
const document = (path: string, content: string): MemoryFile => ({
  path,
  content,
  bytes: new TextEncoder().encode(content).byteLength,
  updatedAt: 1000,
});
const core = document("MEMORY.md", "# 核心\n保持简洁。\n\n[项目入口](knowledge/project.md)"),
  knowledge = document(
    "knowledge/project.md",
    "# 项目\n目前的知识。\n\n[关联方法](method.md) · [核心](../MEMORY.md) · [缺失文档](missing.md)",
  ),
  method = document(
    "knowledge/method.md",
    "# 方法\n验证后再记录。\n\n[工作笔记](../notes/session.md)",
  ),
  note = document("notes/session.md", "# 会话发现\n值得归纳的发现。"),
  historical = document("MEMORY.md", "# 旧的核心记忆\n\n[旧项目](knowledge/project.md)");
const graphFixture: MemoryGraphResponse = {
  botId: bot.id,
  nodes: [
    { path: knowledge.path, title: "项目", updatedAt: 1000 },
    { path: method.path, title: "方法", updatedAt: 1000 },
  ],
  edges: [{ source: knowledge.path, target: method.path }],
  brokenLinks: [{ source: knowledge.path, target: "knowledge/missing.md" }],
};
const listing: BotMemoryResponse = {
  botId: bot.id,
  directory: "/tmp/test-memory",
  files: [core, knowledge, method, note],
  snapshots: [
    { id: "snapshot-one", createdAt: 500, reason: "dream" },
    { id: "snapshot-two", createdAt: 700, reason: "dream" },
  ],
  dream,
};
afterEach(() => vi.restoreAllMocks());
const query = <T extends HTMLElement>(selector: string) => {
  const value = globalThis.document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing element: ${selector}`);
  return value;
};
const byText = (text: string, scope = globalThis.document) => {
  const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
};
const click = (button: HTMLElement) => act(async () => button.click());
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const change = (selector: string, value: string) =>
  act(async () => {
    const node = query<HTMLInputElement | HTMLTextAreaElement>(selector);
    const prototype =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
const setup = () => {
  const documents = new Map([core, knowledge, method, note].map((file) => [file.path, file]));
  const list = vi.spyOn(desktopApi, "listBotMemory").mockImplementation((_id, snapshot) =>
    Effect.succeed({
      ...listing,
      files: snapshot ? [historical, knowledge, method] : [...documents.values()],
    }),
  );
  const read = vi.spyOn(desktopApi, "readBotMemory").mockImplementation((_id, path, snapshot) => {
    const file = snapshot && path === core.path ? historical : documents.get(path);
    return file ? Effect.succeed({ file }) : Effect.fail(new UiError({ message: "Missing" }));
  });
  const graph = vi
    .spyOn(desktopApi, "getBotMemoryGraph")
    .mockReturnValue(Effect.succeed(graphFixture));
  const save = vi.spyOn(desktopApi, "writeBotMemory").mockImplementation((_id, value) =>
    Effect.sync(() => {
      const file = document(value.path, value.content);
      documents.set(file.path, file);
      return { file };
    }),
  );
  const remove = vi.spyOn(desktopApi, "deleteBotMemory").mockImplementation((_id, path) =>
    Effect.sync(() => {
      documents.delete(path);
      if (path === core.path) documents.set(core.path, document(core.path, ""));
      return { accepted: true as const };
    }),
  );
  const clear = vi.spyOn(desktopApi, "clearBotMemory").mockImplementation(() =>
    Effect.sync(() => {
      documents.clear();
      documents.set(core.path, document(core.path, ""));
      return { accepted: true as const };
    }),
  );
  const pause = vi
    .spyOn(desktopApi, "pauseTrigger")
    .mockReturnValue(Effect.succeed({ trigger: { ...dream, enabled: false } }));
  const resume = vi
    .spyOn(desktopApi, "resumeTrigger")
    .mockReturnValue(Effect.succeed({ trigger: dream }));
  const runs = vi.spyOn(desktopApi, "listTriggerRuns").mockReturnValue(
    Effect.succeed({
      runs: [
        {
          id: TriggerRunId.make("dream-run"),
          triggerId: dream.id,
          occurrenceKey: "one",
          scheduledAt: 1000,
          status: "ran",
          taskId: TaskId.make("dream-task"),
        },
      ],
    }),
  );
  const flash = vi.fn(),
    close = vi.fn(),
    openTask = vi.fn();
  const view = renderView(<BotMemory bot={bot} flash={flash} close={close} openTask={openTask} />);
  return {
    view,
    list,
    read,
    graph,
    documents,
    save,
    remove,
    clear,
    pause,
    resume,
    runs,
    flash,
    close,
    openTask,
  };
};

const editing = async () => {
  await click(byText(t.edit));
};
const openHistory = async () => {
  await click(byText(t.memoryHistory));
};
const snapshotOption = async () => {
  await act(async () =>
    query<HTMLButtonElement>("#memory-snapshot-select").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  const options = [...globalThis.document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(new Set(options.map((node) => node.textContent)).size).toBe(options.length);
  const option = options.find((node) => node.textContent?.includes(t.memorySnapshotReason.dream));
  if (!option) throw new Error("Missing snapshot option");
  await click(option);
};

it("opens core memory as readable prose with secondary maintenance and no editor", async () => {
  const test = setup();
  await flush();
  expect(query(".memory-prose h1").textContent).toBe("核心");
  expect(query(".memory-prose").textContent).toContain("保持简洁。");
  expect(globalThis.document.querySelector("textarea")).toBeNull();
  expect(globalThis.document.querySelector(".memory-maintenance")).toBeNull();
  expect(globalThis.document.querySelector("#memory-snapshot-select")).toBeNull();
  expect(test.graph).not.toHaveBeenCalled();
  expect(query(".memory-dream-status").textContent).toContain(t.memoryDreamEnabled);
});

it("keeps a failed save as an editable draft and returns to reading after a successful save", async () => {
  const test = setup();
  await flush();
  await editing();
  expect(query<HTMLTextAreaElement>(".memory-textarea textarea").value).toBe(core.content);
  await change(".memory-textarea textarea", "# 我的修改");
  test.save.mockReturnValueOnce(Effect.fail(new UiError({ message: "Unavailable" })));
  await click(byText(t.save));
  expect(query<HTMLTextAreaElement>(".memory-textarea textarea").value).toBe("# 我的修改");
  expect(test.flash).toHaveBeenCalledWith(expect.stringContaining("Unavailable"));
  await click(byText(t.save));
  expect(test.save).toHaveBeenLastCalledWith(bot.id, { path: core.path, content: "# 我的修改" });
  expect(test.flash).toHaveBeenCalledWith(t.memorySaved);
  expect(globalThis.document.querySelector("textarea")).toBeNull();
  expect(query(".memory-prose h1").textContent).toBe("我的修改");
});

it("protects unsaved edits before changing tabs or closing", async () => {
  const test = setup();
  await flush();
  await editing();
  await change(".memory-textarea textarea", "Unsaved");
  await click(query("#memory-tab-knowledge"));
  expect(test.read).toHaveBeenCalledTimes(1);
  expect(query(".memory-confirm").textContent).toContain(t.memoryUnsaved);
  await click(byText(t.memoryKeepEditing));
  expect(query("#memory-tab-core").getAttribute("aria-selected")).toBe("true");
  await click(query(`button[aria-label="${t.close}"]`));
  expect(test.close).not.toHaveBeenCalled();
  await click(byText(t.memoryDiscard));
  expect(test.close).toHaveBeenCalledOnce();
  expect(test.save).not.toHaveBeenCalled();
});

it("cancels editing without saving and requires confirmation to discard a changed draft", async () => {
  const test = setup();
  await flush();
  await editing();
  await click(byText(t.cancel));
  expect(globalThis.document.querySelector("textarea")).toBeNull();
  await editing();
  await change(".memory-textarea textarea", "A discarded edit");
  await click(byText(t.cancel));
  await click(byText(t.memoryKeepEditing));
  expect(query<HTMLTextAreaElement>("textarea").value).toBe("A discarded edit");
  await click(byText(t.cancel));
  await click(byText(t.memoryDiscard));
  expect(query(".memory-prose").textContent).toContain("保持简洁。");
  expect(test.save).not.toHaveBeenCalled();
});

it("navigates the knowledge graph and document links without moving the small graph", async () => {
  const test = setup();
  await flush();
  await click(byText("项目入口"));
  expect(test.graph).toHaveBeenCalledExactlyOnceWith(bot.id, undefined);
  expect(query("#memory-tab-knowledge").getAttribute("aria-selected")).toBe("true");
  expect(query(".memory-prose").textContent).toContain("目前的知识。");
  const before = [
    ...globalThis.document.querySelectorAll<HTMLButtonElement>(".memory-graph-node"),
  ].map((node) => node.style.cssText);
  await click(query(`.memory-graph-node[aria-label="${t.memoryOpenDocument("方法")}"]`));
  expect(test.read).toHaveBeenLastCalledWith(bot.id, method.path, undefined);
  expect(query(".memory-prose").textContent).toContain("验证后再记录。");
  const after = [
    ...globalThis.document.querySelectorAll<HTMLButtonElement>(".memory-graph-node"),
  ].map((node) => node.style.cssText);
  expect(after).toEqual(before);
  await click(byText("工作笔记"));
  expect(query("#memory-tab-notes").getAttribute("aria-selected")).toBe("true");
  expect(query(".memory-prose").textContent).toContain("值得归纳的发现。");
  expect(globalThis.document.querySelector(".memory-graph-node")).toBeNull();
});

it("searches titles and file paths in graph and list views and marks missing targets", async () => {
  setup();
  await flush();
  await click(query("#memory-tab-knowledge"));
  expect(globalThis.document.querySelectorAll(".memory-graph-node")).toHaveLength(2);
  await change(`input[aria-label="${t.memorySearchKnowledge}"]`, "method");
  expect(globalThis.document.querySelectorAll(".memory-graph-node")).toHaveLength(1);
  await click(byText(t.memoryList));
  expect(globalThis.document.querySelectorAll(".memory-file")).toHaveLength(1);
  await change(`input[aria-label="${t.memorySearchKnowledge}"]`, "项目");
  await click(query('.memory-file[title="knowledge/project.md"]'));
  expect(query<HTMLButtonElement>(".memory-document-link.is-missing").disabled).toBe(true);
  expect(query(".memory-broken").textContent).toContain("knowledge/missing.md");
  await change(`input[aria-label="${t.memorySearchKnowledge}"]`, "no match");
  expect(query(".memory-knowledge").textContent).toContain(t.memorySearchEmpty);
});

it("ignores a delayed previous document response after selecting a graph node", async () => {
  const gate = Effect.runSync(Deferred.make<{ file: MemoryFile }>());
  const interrupted = vi.fn();
  const test = setup();
  test.view.dispose();
  test.read.mockImplementation((_id, path) =>
    path === core.path
      ? Deferred.await(gate).pipe(Effect.onInterrupt(() => Effect.sync(interrupted)))
      : Effect.succeed({ file: knowledge }),
  );
  renderView(
    <BotMemory bot={bot} flash={test.flash} close={test.close} openTask={test.openTask} />,
  );
  await flush();
  await click(query("#memory-tab-knowledge"));
  await click(query(`.memory-graph-node[aria-label="${t.memoryOpenDocument("项目")}"]`));
  await act(async () => {
    await Effect.runPromise(
      Deferred.succeed(gate, { file: document(core.path, "Old delayed response") }),
    );
  });
  expect(interrupted).toHaveBeenCalledOnce();
  expect(query(".memory-prose").textContent).toContain("目前的知识。");
});

it("protects a dirty knowledge draft when another graph node is selected", async () => {
  const test = setup();
  await flush();
  await click(byText("项目入口"));
  await editing();
  await change("textarea", "Unsaved knowledge");
  await click(query(`.memory-graph-node[aria-label="${t.memoryOpenDocument("方法")}"]`));
  expect(test.read).toHaveBeenLastCalledWith(bot.id, knowledge.path, undefined);
  await click(byText(t.memoryKeepEditing));
  expect(query<HTMLTextAreaElement>("textarea").value).toBe("Unsaved knowledge");
  await click(query(`.memory-graph-node[aria-label="${t.memoryOpenDocument("方法")}"]`));
  await click(byText(t.memoryDiscard));
  expect(test.read).toHaveBeenLastCalledWith(bot.id, method.path, undefined);
  expect(globalThis.document.querySelector("textarea")).toBeNull();
});

it("creates nested Markdown files without overwriting an existing path", async () => {
  const test = setup();
  await flush();
  await click(query("#memory-tab-knowledge"));
  await click(byText(t.memoryNew));
  await change("#memory-file-path", "knowledge/project.md");
  await change("textarea", "New content");
  await click(byText(t.save));
  expect(test.save).not.toHaveBeenCalled();
  expect(test.flash).toHaveBeenCalledWith(expect.stringContaining(t.memoryPathTaken));
  await change("#memory-file-path", "knowledge/project/new.md");
  await click(byText(t.save));
  expect(test.save).toHaveBeenCalledWith(bot.id, {
    path: "knowledge/project/new.md",
    content: "New content",
  });
  expect(query(".memory-prose").textContent).toBe("New content");
  expect(test.graph).toHaveBeenCalledTimes(2);
});

it("confirms deletion and clearing from management independently", async () => {
  const test = setup();
  await flush();
  await click(byText(t.memoryManage));
  await click(byText(t.delete));
  expect(test.remove).not.toHaveBeenCalled();
  await click(query(".memory-confirm button:last-child"));
  expect(test.remove).toHaveBeenCalledExactlyOnceWith(bot.id, core.path);
  await click(byText(t.memoryClear));
  expect(test.clear).not.toHaveBeenCalled();
  await click(query(".memory-confirm button:last-child"));
  expect(test.clear).toHaveBeenCalledExactlyOnceWith(bot.id);
  expect(query(".memory-reader").textContent).toContain(t.memoryCoreEmpty);
});

it("keeps snapshots read-only while following their own document links and graph", async () => {
  const test = setup();
  await flush();
  await openHistory();
  await snapshotOption();
  expect(test.list).toHaveBeenLastCalledWith(bot.id, "snapshot-one");
  expect(test.read).toHaveBeenLastCalledWith(bot.id, core.path, "snapshot-one");
  expect(query(".memory-prose h1").textContent).toBe("旧的核心记忆");
  await click(byText("旧项目"));
  expect(test.read).toHaveBeenLastCalledWith(bot.id, knowledge.path, "snapshot-one");
  expect(test.graph).toHaveBeenLastCalledWith(bot.id, "snapshot-one");
  await click(byText(t.memoryManage));
  expect(
    [...globalThis.document.querySelectorAll("button")].some((button) =>
      [t.save, t.edit, t.delete, t.memoryClear].some((label) => label === button.textContent),
    ),
  ).toBe(false);
  expect(globalThis.document.querySelector("textarea")).toBeNull();
  expect(test.save).not.toHaveBeenCalled();
});

it("keeps a dirty draft when a snapshot switch is cancelled", async () => {
  const test = setup();
  await flush();
  await editing();
  await change("textarea", "Unsaved current memory");
  await openHistory();
  await snapshotOption();
  expect(test.list).toHaveBeenCalledTimes(1);
  await click(byText(t.memoryKeepEditing));
  expect(query<HTMLTextAreaElement>("textarea").value).toBe("Unsaved current memory");
  expect(query<HTMLTextAreaElement>("textarea").readOnly).toBe(false);
});

it("does not discard an editable draft while retrying a failed directory read", async () => {
  const test = setup();
  test.view.dispose();
  test.list.mockClear();
  test.list.mockReturnValueOnce(Effect.fail(new UiError({ message: "Unavailable" })));
  renderView(
    <BotMemory bot={bot} flash={test.flash} close={test.close} openTask={test.openTask} />,
  );
  await flush();
  await editing();
  await change("textarea", "Draft after list failure");
  await click(query(".memory-list-error button"));
  expect(test.list).toHaveBeenCalledTimes(1);
  expect(query<HTMLTextAreaElement>("textarea").value).toBe("Draft after list failure");
  await click(byText(t.memoryKeepEditing));
  expect(test.save).not.toHaveBeenCalled();
});

it("supports the existing dream schedule and lazy session audit in secondary panels", async () => {
  const test = setup();
  await flush();
  expect(test.runs).not.toHaveBeenCalled();
  await click(byText(t.memoryManage));
  await click(byText(t.automationPause));
  expect(test.pause).toHaveBeenCalledExactlyOnceWith(dream.id);
  expect(query(".memory-dream-status").textContent).toContain(t.memoryDreamPaused);
  await click(byText(t.automationResume));
  expect(test.resume).toHaveBeenCalledExactlyOnceWith(dream.id);
  await openHistory();
  await click(query(".memory-dream-history summary"));
  expect(test.runs).toHaveBeenCalledExactlyOnceWith(dream.id);
  await click(byText(t.memoryDreamTask));
  expect(test.openTask).toHaveBeenCalledExactlyOnceWith("dream-task");
  expect(test.close).toHaveBeenCalledOnce();
});

it("falls back to the knowledge list on graph failure and retries independently", async () => {
  const test = setup();
  await flush();
  test.graph.mockReturnValueOnce(Effect.fail(new UiError({ message: "Unavailable" })));
  await click(query("#memory-tab-knowledge"));
  expect(query(".memory-knowledge [role=alert]").textContent).toContain(t.memoryGraphFailed);
  await click(byText(t.memoryList));
  await click(query('.memory-file[title="knowledge/project.md"]'));
  expect(query(".memory-prose").textContent).toContain("目前的知识。");
  await click(query(".memory-knowledge [role=alert] button"));
  await click(byText(t.memoryGraph));
  expect(globalThis.document.querySelectorAll(".memory-graph-node")).toHaveLength(2);
});

it("shows explicit empty knowledge and notes states", async () => {
  const test = setup();
  await flush();
  test.graph.mockReturnValue(
    Effect.succeed({ ...graphFixture, nodes: [], edges: [], brokenLinks: [] }),
  );
  test.documents.delete(note.path);
  await click(byText(t.refresh));
  await click(query("#memory-tab-knowledge"));
  expect(query(".memory-knowledge").textContent).toContain(t.memoryKnowledgeEmpty);
  await click(query("#memory-tab-notes"));
  expect(query(".memory-note-browser").textContent).toContain(t.memoryNotesEmpty);
});

it("bounds the graph while allowing every document to be found in the searchable list", async () => {
  const test = setup();
  await flush();
  const nodes = Array.from({ length: 80 }, (_, index) => ({
    path: `knowledge/item-${index}.md`,
    title: `知识 ${index}`,
    updatedAt: 1000,
  }));
  test.graph.mockReturnValue(
    Effect.succeed({ ...graphFixture, nodes, edges: [], brokenLinks: [] }),
  );
  await click(query("#memory-tab-knowledge"));
  expect(globalThis.document.querySelectorAll(".memory-graph-node")).toHaveLength(24);
  expect(query(".memory-graph-caption").textContent).toContain(t.memoryGraphLimited(24));
  await click(byText(t.memoryList));
  expect(globalThis.document.querySelectorAll(".memory-file")).toHaveLength(80);
  await change(`input[aria-label="${t.memorySearchKnowledge}"]`, "item-79");
  expect(globalThis.document.querySelectorAll(".memory-file")).toHaveLength(1);
});

it("renders memory safely without raw HTML, external images, or navigable external links", async () => {
  const test = setup();
  test.documents.set(
    core.path,
    document(
      core.path,
      "# Safe\n\n<script>bad()</script>\n\n![remote](https://example.com/pixel.png)\n\n[web](https://example.com) [outside](../../private.md) [script](javascript:alert(1))",
    ),
  );
  await flush();
  await click(byText(t.refresh));
  expect(
    globalThis.document.querySelector(".memory-prose script, .memory-prose img, .memory-prose a"),
  ).toBeNull();
  expect(
    globalThis.document.querySelector(".memory-prose button[title*='https://example.com']"),
  ).not.toBeNull();
  expect(globalThis.document.querySelectorAll(".memory-prose .memory-document-link")).toHaveLength(
    0,
  );
});
