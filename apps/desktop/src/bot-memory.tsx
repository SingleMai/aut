import {
  type BotConfig,
  type BotMemoryResponse,
  MEMORY_FILE_MAX_BYTES,
  type MemoryFile,
  type MemoryGraphResponse,
  MemoryWriteInput,
  type Trigger,
  type TriggerRun,
} from "@aut/protocol";
import { Badge, Button, Select, TextArea, TextField } from "@radix-ui/themes";
import { Effect, Fiber } from "effect";
import { type SyntheticEvent, useEffect, useState } from "react";
import { desktopApi, UiError, validate } from "./api.js";
import { formatTime, t } from "./i18n.js";
import { MemoryKnowledge, memoryFileName } from "./memory-graph.js";
import { MemoryMarkdown } from "./memory-markdown.js";
import { Dialog } from "./ui/dialog.js";
import { type Flash, useAction } from "./ui/use-action.js";

type Selection = { readonly path?: string; readonly snapshot?: string; readonly creating?: true };
type ReadStatus = "loading" | "ready" | "failed";
const snapshotTime = (at: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(at);
function DreamHistory({
  trigger,
  flash,
  openTask,
}: {
  trigger: Trigger;
  flash: Flash;
  openTask: (id: string) => void;
}) {
  const [runs, setRuns] = useState<readonly TriggerRun[]>();
  const load = useAction(flash);
  const read = () =>
    load.run(
      desktopApi
        .listTriggerRuns(trigger.id)
        .pipe(Effect.tap((response) => Effect.sync(() => setRuns(response.runs)))),
    );
  const toggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open && runs === undefined && !load.busy) read();
  };
  return (
    <details className="memory-dream-history" onToggle={toggle}>
      <summary>{t.memoryDreamRuns}</summary>
      <div className="memory-history-body">
        {load.busy && (
          <p role="status" className="muted">
            {t.automationRunLoading}
          </p>
        )}
        {!load.busy && runs?.length === 0 && <p className="muted">{t.automationNoRuns}</p>}
        {runs && (
          <ul className="automation-run-list">
            {runs.slice(0, 10).map((run) => (
              <li key={run.id} className="automation-run">
                <div>
                  <span className="automation-run-status" data-status={run.status}>
                    {t.automationRunStatus[run.status]}
                  </span>
                  <time dateTime={new Date(run.scheduledAt).toISOString()}>
                    {formatTime(run.scheduledAt)}
                  </time>
                </div>
                {run.taskId && (
                  <Button
                    type="button"
                    size="1"
                    variant="ghost"
                    onClick={() => openTask(run.taskId ?? "")}
                  >
                    {t.memoryDreamTask}
                  </Button>
                )}
                {run.error && <p className="automation-run-error">{run.error}</p>}
              </li>
            ))}
          </ul>
        )}
        <Button type="button" size="1" variant="ghost" disabled={load.busy} onClick={read}>
          {t.refresh}
        </Button>
      </div>
    </details>
  );
}

function DreamSchedule({
  dream,
  busy,
  toggle,
}: {
  dream: Trigger | null;
  busy: boolean;
  toggle: () => void;
}) {
  return (
    <div className="memory-dream-schedule">
      <div>
        <strong>{t.memoryDream}</strong>
        {dream ? (
          <p className="muted">
            {dream.schedule.kind === "daily"
              ? `${t.automationDaily} ${dream.schedule.at} · ${dream.schedule.timeZone ?? "UTC"}`
              : t.automationSchedule}
            {dream.nextAt !== undefined && ` · ${t.automationNext} ${formatTime(dream.nextAt)}`}
          </p>
        ) : (
          <p className="muted">{t.memoryDreamMissing}</p>
        )}
      </div>
      {dream && (
        <>
          <Badge color={dream.enabled ? "green" : "gray"}>
            {dream.enabled ? t.memoryDreamEnabled : t.memoryDreamPaused}
          </Badge>
          <Button type="button" size="1" variant="surface" disabled={busy} onClick={toggle}>
            {dream.enabled ? t.automationPause : t.automationResume}
          </Button>
        </>
      )}
    </div>
  );
}

type MemorySection = "core" | "knowledge" | "notes";
const sectionOf = (path: string): MemorySection =>
  path.startsWith("knowledge/") ? "knowledge" : path.startsWith("notes/") ? "notes" : "core";
const sections = [
  { key: "core", label: t.memoryCore, hint: t.memoryCoreHint },
  { key: "knowledge", label: t.memoryKnowledge, hint: t.memoryKnowledgeHint },
  { key: "notes", label: t.memoryNotes, hint: t.memoryNotesHint },
] as const;

export function BotMemory({
  bot,
  flash,
  close,
  openTask,
}: {
  bot: BotConfig;
  flash: Flash;
  close: () => void;
  openTask: (id: string) => void;
}) {
  const [section, setSection] = useState<MemorySection>("core");
  const [selection, setSelection] = useState<Selection>({ path: "MEMORY.md" });
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<"history" | "manage">();
  const [listing, setListing] = useState<BotMemoryResponse>();
  const [listStatus, setListStatus] = useState<ReadStatus>("loading");
  const [fileStatus, setFileStatus] = useState<ReadStatus>("loading");
  const [graphStatus, setGraphStatus] = useState<ReadStatus>("loading");
  const [graph, setGraph] = useState<MemoryGraphResponse>();
  const [file, setFile] = useState<MemoryFile>();
  const [draft, setDraft] = useState("");
  const [newPath, setNewPath] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [graphRevision, setGraphRevision] = useState(0);
  const [pending, setPending] = useState<{ run: () => void }>();
  const [confirm, setConfirm] = useState<"delete" | "clear">();
  const write = useAction(flash);
  const dreamAction = useAction(flash);
  const snapshot = selection.snapshot;
  const path = selection.path;
  const creating = selection.creating === true;
  const dirty =
    snapshot === undefined &&
    editing &&
    (creating ? draft !== "" || newPath !== "" : file !== undefined && draft !== file.content);
  const guarded = (run: () => void) => {
    if (write.busy) return;
    const proceed = () => {
      setConfirm(undefined);
      setEditing(false);
      setDraft(file?.content ?? "");
      setNewPath("");
      run();
    };
    if (dirty) setPending({ run: proceed });
    else proceed();
  };
  const reload = () => setRevision((value) => value + 1);
  const select = (target: string) =>
    guarded(() => {
      setSection(sectionOf(target));
      setSelection({ path: target, ...(snapshot === undefined ? {} : { snapshot }) });
    });
  const pickSection = (target: MemorySection) =>
    guarded(() => {
      setSection(target);
      const first =
        target === "core"
          ? "MEMORY.md"
          : target === "notes"
            ? listing?.files.find((entry) => entry.path.startsWith("notes/"))?.path
            : undefined;
      setSelection({
        ...(first ? { path: first } : {}),
        ...(snapshot === undefined ? {} : { snapshot }),
      });
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes native filesystem changes.
  useEffect(() => {
    let active = true;
    setListStatus("loading");
    setListing(undefined);
    const fiber = Effect.runFork(
      desktopApi.listBotMemory(bot.id, snapshot).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (!active) return;
            setListing(value);
            setListStatus("ready");
            setSelection((current) => {
              if (
                current.snapshot !== snapshot ||
                current.creating ||
                !current.path ||
                value.files.some((entry) => entry.path === current.path)
              )
                return current;
              return { ...(snapshot === undefined ? {} : { snapshot }) };
            });
          }),
        ),
        Effect.catchAll(() =>
          Effect.sync(() => {
            if (active) setListStatus("failed");
          }),
        ),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [bot.id, snapshot, revision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads the selected file.
  useEffect(() => {
    let active = true;
    setFile(undefined);
    if (creating || !path) {
      setFileStatus("ready");
      return;
    }
    setFileStatus("loading");
    const fiber = Effect.runFork(
      desktopApi.readBotMemory(bot.id, path, snapshot).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (!active) return;
            setFile(value.file);
            setDraft(value.file.content);
            setFileStatus("ready");
          }),
        ),
        Effect.catchAll(() =>
          Effect.sync(() => {
            if (active) setFileStatus("failed");
          }),
        ),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [bot.id, path, snapshot, creating, revision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revisions refresh the graph after writes or native edits.
  useEffect(() => {
    if (section !== "knowledge") return;
    let active = true;
    setGraph(undefined);
    setGraphStatus("loading");
    const fiber = Effect.runFork(
      desktopApi.getBotMemoryGraph(bot.id, snapshot).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (active) {
              setGraph(value);
              setGraphStatus("ready");
            }
          }),
        ),
        Effect.catchAll(() =>
          Effect.sync(() => {
            if (active) setGraphStatus("failed");
          }),
        ),
      ),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [bot.id, section, snapshot, revision, graphRevision]);

  const save = () =>
    write.run(
      Effect.gen(function* () {
        const target = creating ? newPath.trim() : path;
        if (creating && listing?.files.some((entry) => entry.path === target))
          return yield* Effect.fail(new UiError({ message: t.memoryPathTaken }));
        if (new TextEncoder().encode(draft).byteLength > MEMORY_FILE_MAX_BYTES)
          return yield* Effect.fail(new UiError({ message: t.memoryTooLarge }));
        const input = yield* validate(MemoryWriteInput, { path: target, content: draft });
        const saved = yield* desktopApi.writeBotMemory(bot.id, input);
        yield* Effect.sync(() => {
          setFile(saved.file);
          setDraft(saved.file.content);
          setSelection({ path: saved.file.path });
          setSection(sectionOf(saved.file.path));
          setEditing(false);
          setNewPath("");
          reload();
          flash(t.memorySaved);
        });
      }),
    );
  const remove = () => {
    const operation =
      confirm === "clear"
        ? desktopApi.clearBotMemory(bot.id)
        : desktopApi.deleteBotMemory(bot.id, path ?? "MEMORY.md");
    write.run(
      operation.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            flash(confirm === "clear" ? t.memoryCleared : t.memoryDeleted);
            setConfirm(undefined);
            setSection("core");
            setSelection({ path: "MEMORY.md" });
            setFile(undefined);
            setDraft("");
            setNewPath("");
            setEditing(false);
            reload();
          }),
        ),
      ),
    );
  };
  const newFile = () =>
    guarded(() => {
      setSelection({ creating: true });
      setEditing(true);
      setFile(undefined);
      setDraft("");
      setNewPath("");
    });
  const cancelEdit = () =>
    guarded(() => {
      if (creating) {
        setSection("core");
        setSelection({ path: "MEMORY.md" });
      }
    });
  const pickSnapshot = (value: string) =>
    guarded(() => {
      setSection("core");
      setSelection({ path: "MEMORY.md", ...(value === "current" ? {} : { snapshot: value }) });
    });
  const dream = listing?.dream;
  const toggleDream = () => {
    if (!dream) return;
    dreamAction.run(
      (dream.enabled ? desktopApi.pauseTrigger(dream.id) : desktopApi.resumeTrigger(dream.id)).pipe(
        Effect.tap((value) =>
          Effect.sync(() =>
            setListing((current) => current && { ...current, dream: value.trigger }),
          ),
        ),
      ),
    );
  };
  const notes = listing?.files.filter((entry) => entry.path.startsWith("notes/")) ?? [];
  const visibleNotes = notes.filter((entry) =>
    entry.path.toLocaleLowerCase().includes(noteQuery.trim().toLocaleLowerCase()),
  );
  const paths = new Set(listing?.files.map((entry) => entry.path));
  const relatedPaths = new Set(
    graph?.edges.flatMap((edge) =>
      edge.source === path ? [edge.target] : edge.target === path ? [edge.source] : [],
    ) ?? [],
  );
  relatedPaths.delete(path ?? "");
  const related = graph?.nodes.filter((node) => relatedPaths.has(node.path)) ?? [];
  const broken = graph?.brokenLinks.filter((link) => link.source === path) ?? [];

  return (
    <Dialog
      title={t.botMemoryTitle(bot.name)}
      maxWidth="1160px"
      onClose={() => guarded(close)}
      initialFocus="#memory-tab-core"
    >
      <div className="memory-panel">
        <div className="memory-toolbar">
          <div className="memory-tabs" role="tablist" aria-label={t.botMemory}>
            {sections.map((entry, index) => (
              <button
                type="button"
                role="tab"
                id={`memory-tab-${entry.key}`}
                key={entry.key}
                aria-selected={section === entry.key}
                aria-controls="memory-content"
                tabIndex={section === entry.key ? 0 : -1}
                disabled={write.busy}
                onClick={() => {
                  if (section !== entry.key) pickSection(entry.key);
                }}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % sections.length
                      : event.key === "ArrowLeft"
                        ? (index + sections.length - 1) % sections.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? sections.length - 1
                            : undefined;
                  const target = next === undefined ? undefined : sections[next];
                  if (!target) return;
                  event.preventDefault();
                  document.getElementById(`memory-tab-${target.key}`)?.focus();
                  if (section !== target.key) pickSection(target.key);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="memory-toolbar-actions">
            {section !== "core" && snapshot === undefined && (
              <Button
                type="button"
                size="1"
                variant="soft"
                disabled={write.busy || listStatus !== "ready"}
                onClick={newFile}
              >
                {t.memoryNew}
              </Button>
            )}
            <Button
              type="button"
              size="1"
              variant="ghost"
              color="gray"
              aria-expanded={panel === "history"}
              onClick={() => setPanel(panel === "history" ? undefined : "history")}
            >
              {t.memoryHistory}
            </Button>
            <Button
              type="button"
              size="1"
              variant="ghost"
              color="gray"
              disabled={write.busy}
              onClick={() => guarded(reload)}
            >
              {t.refresh}
            </Button>
          </div>
        </div>
        {pending && (
          <div className="memory-confirm" role="alert">
            <p>{t.memoryUnsaved}</p>
            <Button type="button" size="1" variant="surface" onClick={() => setPending(undefined)}>
              {t.memoryKeepEditing}
            </Button>
            <Button
              type="button"
              size="1"
              color="red"
              variant="soft"
              onClick={() => {
                const action = pending.run;
                setPending(undefined);
                action();
              }}
            >
              {t.memoryDiscard}
            </Button>
          </div>
        )}
        {panel === "history" && (
          <section className="memory-history-panel" aria-label={t.memoryHistory}>
            {listing && listing.snapshots.length > 0 ? (
              <div className="memory-snapshots">
                <label htmlFor="memory-snapshot-select">{t.memorySnapshots}</label>
                <Select.Root
                  value={snapshot ?? "current"}
                  onValueChange={pickSnapshot}
                  disabled={write.busy}
                >
                  <Select.Trigger id="memory-snapshot-select" aria-label={t.memorySnapshots} />
                  <Select.Content>
                    <Select.Item value="current">{t.memoryCurrent}</Select.Item>
                    {listing.snapshots.map((entry) => (
                      <Select.Item key={entry.id} value={entry.id}>
                        {snapshotTime(entry.createdAt)} · {t.memorySnapshotReason[entry.reason]}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </div>
            ) : (
              <p className="muted">{t.memoryNoHistory}</p>
            )}
            {listing?.dream && (
              <DreamHistory
                key={listing.dream.id}
                trigger={listing.dream}
                flash={flash}
                openTask={(id) =>
                  guarded(() => {
                    close();
                    openTask(id);
                  })
                }
              />
            )}
          </section>
        )}
        {snapshot !== undefined && (
          <div className="memory-readonly">
            <Badge color="gray">{t.memorySnapshotReadonly}</Badge>
            <Button type="button" size="1" variant="ghost" onClick={() => pickSnapshot("current")}>
              {t.memoryCurrent}
            </Button>
          </div>
        )}
        {listStatus === "failed" && (
          <div role="alert" className="memory-list-error">
            <p>{t.memoryLoadFailed}</p>
            <Button type="button" size="1" onClick={() => guarded(reload)}>
              {t.retry}
            </Button>
          </div>
        )}
        <div
          id="memory-content"
          role="tabpanel"
          aria-labelledby={`memory-tab-${section}`}
          className="memory-workspace"
          data-section={section}
        >
          {section === "knowledge" && (
            <MemoryKnowledge
              graph={graph}
              status={graphStatus}
              files={listing?.files ?? []}
              selected={path}
              disabled={write.busy}
              select={select}
              retry={() => setGraphRevision((value) => value + 1)}
            />
          )}
          {section === "notes" && (
            <aside className="memory-note-browser">
              <TextField.Root
                aria-label={t.memorySearchNotes}
                placeholder={t.memorySearchNotes}
                value={noteQuery}
                onChange={(event) => setNoteQuery(event.target.value)}
              />
              {listStatus === "loading" ? (
                <p role="status" className="muted">
                  {t.loading}
                </p>
              ) : notes.length === 0 ? (
                <p className="memory-browser-message muted">{t.memoryNotesEmpty}</p>
              ) : (
                <nav className="memory-document-list" aria-label={t.memoryNotes}>
                  {visibleNotes.map((entry) => (
                    <button
                      type="button"
                      key={entry.path}
                      className="memory-file"
                      title={entry.path}
                      aria-current={entry.path === path ? "page" : undefined}
                      disabled={write.busy}
                      onClick={() => select(entry.path)}
                    >
                      <strong>{memoryFileName(entry.path)}</strong>
                      <span>{entry.path.slice("notes/".length)}</span>
                    </button>
                  ))}
                  {visibleNotes.length === 0 && <p className="muted">{t.memorySearchEmpty}</p>}
                </nav>
              )}
            </aside>
          )}
          <section
            className={`memory-reader${editing ? " is-editing" : ""}`}
            aria-label={t.memoryContent}
          >
            <div className="memory-reader-heading">
              <div>
                <span className="memory-eyebrow">
                  {sections.find((entry) => entry.key === section)?.hint}
                </span>
              </div>
              {!editing && file && snapshot === undefined && (
                <Button
                  type="button"
                  size="1"
                  variant="surface"
                  disabled={write.busy}
                  onClick={() => setEditing(true)}
                >
                  {t.edit}
                </Button>
              )}
            </div>
            {creating && (
              <div className="field">
                <label className="field-label" htmlFor="memory-file-path">
                  {t.memoryPath}
                </label>
                <TextField.Root
                  id="memory-file-path"
                  value={newPath}
                  onChange={(event) => setNewPath(event.target.value)}
                  placeholder={section === "notes" ? "notes/一次讨论.md" : "knowledge/项目.md"}
                  disabled={write.busy}
                />
                <p className="muted">{t.memoryPathHint}</p>
              </div>
            )}
            {fileStatus === "loading" && (
              <p role="status" className="muted">
                {t.loading}
              </p>
            )}
            {fileStatus === "failed" && (
              <div role="alert">
                <p>{t.memoryReadFailed}</p>
                <Button type="button" size="1" onClick={() => guarded(reload)}>
                  {t.retry}
                </Button>
              </div>
            )}
            {fileStatus === "ready" && (file || creating) ? (
              editing ? (
                <>
                  {!creating && path && <p className="memory-edit-path">{path}</p>}
                  <TextArea
                    className="memory-textarea"
                    aria-label={t.memoryContent}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={write.busy}
                    resize="none"
                  />
                  <div className="memory-edit-actions">
                    <span className="muted">{dirty ? t.memoryUnsaved : ""}</span>
                    <Button
                      type="button"
                      size="2"
                      variant="surface"
                      color="gray"
                      disabled={write.busy}
                      onClick={cancelEdit}
                    >
                      {t.cancel}
                    </Button>
                    <Button type="button" size="2" disabled={write.busy || !dirty} onClick={save}>
                      {t.save}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {file &&
                    (file.content.trim() ? (
                      <MemoryMarkdown
                        content={file.content}
                        path={file.path}
                        paths={paths}
                        disabled={write.busy || listStatus !== "ready"}
                        open={select}
                      />
                    ) : (
                      <div className="memory-empty-state">
                        <strong>
                          {section === "core" ? t.memoryCoreEmpty : t.memoryDocumentEmpty}
                        </strong>
                        <p>
                          {section === "core" ? t.memoryCoreEmptyHint : t.memoryDocumentEmptyHint}
                        </p>
                      </div>
                    ))}
                  {section === "knowledge" && related.length > 0 && (
                    <div className="memory-related">
                      <h4>{t.memoryRelated}</h4>
                      {related.map((node) => (
                        <button
                          type="button"
                          key={node.path}
                          title={node.path}
                          disabled={write.busy}
                          onClick={() => select(node.path)}
                        >
                          {node.title}
                          <span aria-hidden="true">↗</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {section === "knowledge" && broken.length > 0 && (
                    <details className="memory-broken">
                      <summary>{t.memoryBrokenCount(broken.length)}</summary>
                      <ul>
                        {broken.map((link) => (
                          <li key={link.target}>{link.target}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {file && (
                    <div className="memory-file-meta">
                      <span>{t.memoryUpdated}</span>
                      <time dateTime={new Date(file.updatedAt).toISOString()}>
                        {formatTime(file.updatedAt)}
                      </time>
                    </div>
                  )}
                </>
              )
            ) : (
              fileStatus === "ready" && (
                <div className="memory-empty-state">
                  <strong>{t.memorySelectDocument}</strong>
                  <p>{section === "knowledge" ? t.memorySelectKnowledgeHint : t.memoryNoFile}</p>
                </div>
              )
            )}
          </section>
        </div>
        <div className="memory-footer">
          <p className="memory-dream-status">
            <span className="memory-status-dot" data-enabled={dream?.enabled || undefined} />
            {t.memoryDream}
            <span>
              {dream
                ? dream.enabled
                  ? t.memoryDreamEnabled
                  : t.memoryDreamPaused
                : t.memoryDreamMissing}
            </span>
            {dream?.enabled && dream.schedule.kind === "daily" && (
              <span>
                · {t.automationDaily} {dream.schedule.at}
              </span>
            )}
          </p>
          <Button
            type="button"
            size="1"
            variant="ghost"
            color="gray"
            aria-expanded={panel === "manage"}
            onClick={() => setPanel(panel === "manage" ? undefined : "manage")}
          >
            {t.memoryManage}
          </Button>
        </div>
        {panel === "manage" && listing && (
          <section className="memory-maintenance" aria-label={t.memoryManage}>
            <DreamSchedule dream={listing.dream} busy={dreamAction.busy} toggle={toggleDream} />
            <details className="memory-directory">
              <summary>{t.memoryDirectory}</summary>
              <p className="identifier">{listing.directory}</p>
            </details>
            {snapshot === undefined && (
              <div className="memory-danger-actions">
                {!creating && file && (
                  <Button
                    type="button"
                    color="red"
                    variant="ghost"
                    size="1"
                    disabled={write.busy}
                    onClick={() => setConfirm("delete")}
                  >
                    {t.delete}
                  </Button>
                )}
                <Button
                  type="button"
                  color="red"
                  variant="ghost"
                  size="1"
                  disabled={write.busy || listing.files.length === 0}
                  onClick={() => setConfirm("clear")}
                >
                  {t.memoryClear}
                </Button>
              </div>
            )}
          </section>
        )}
        {confirm && (
          <div className="memory-confirm" role="alert">
            <p>
              {confirm === "clear" ? t.memoryClearHint : t.memoryDeleteHint(path ?? "MEMORY.md")}
            </p>
            <Button
              type="button"
              size="1"
              color="gray"
              variant="surface"
              disabled={write.busy}
              onClick={() => setConfirm(undefined)}
            >
              {t.cancel}
            </Button>
            <Button type="button" size="1" color="red" disabled={write.busy} onClick={remove}>
              {confirm === "clear" ? t.memoryClear : t.delete}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
