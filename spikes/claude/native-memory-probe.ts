/**
 * Isolated native-memory loading probe for the installed Claude Code CLI.
 * Uses synthetic canaries, no model tools, and a temporary memory directory.
 * Records an allowlisted protocol projection, never raw prompts or user config.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const executable = process.env.AUT_CLAUDE_BIN ?? "claude";
const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const output = resolve(process.argv[2] ?? `spikes/claude/fixtures/native-memory-${version.split(" ")[0]}.jsonl`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, "", { flag: "wx" });
const record = (payload: unknown) => appendFileSync(output, `${JSON.stringify(payload)}\n`);
const root = mkdtempSync(join(tmpdir(), "aut-claude-native-memory-"));
const project = join(root, "project");
const memory = join(root, "memory");
mkdirSync(project);
mkdirSync(memory);
const projectToken = `PROJECT_${randomUUID()}`;
const memoryToken = `MEMORY_${randomUUID()}`;
writeFileSync(join(project, "CLAUDE.md"), `# Synthetic probe instructions\n\nThe project_probe_value is ${projectToken}.\n`);
writeFileSync(join(memory, "MEMORY.md"), `# Synthetic probe memory\n\nThe memory_probe_value is ${memoryToken}.\n`);
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const beforeMemory = digest(join(memory, "MEMORY.md"));
const beforeProject = digest(join(project, "CLAUDE.md"));
const prompt = "Return one JSON object only with keys project_probe_value and memory_probe_value. Copy each exact value from already-loaded context if present, otherwise use null. Do not infer or invent values. Do not use tools or read files.";
const cases = [
  { name: "env-forced-on", autoMemoryEnabled: true, env: "0", expectMemory: true },
  { name: "env-forced-off", autoMemoryEnabled: true, env: "1", expectMemory: false },
  { name: "settings-on", autoMemoryEnabled: true, env: undefined, expectMemory: true },
  { name: "settings-off", autoMemoryEnabled: false, env: undefined, expectMemory: false },
  { name: "settings-env-overrides-process", autoMemoryEnabled: true, env: "1", settingsEnv: "0", expectMemory: true },
  { name: "settings-env-forced-off", autoMemoryEnabled: false, env: "1", settingsEnv: "1", expectMemory: false },
] as const;
record({ type: "meta", cli: "claude", version, recordedAt: new Date().toISOString(), prompt,
  projection: "Only synthetic marker values and allowlisted init/result metadata are saved. Other paths and model output are redacted.",
  scope: "New sessions only; startup loading and instruction-file independence. Tools and auto-dream are disabled in all cases; this does not probe native-memory writes or resumed-session cleanup.",
  safety: "Uses existing authentication/provider without changing HOME or CLAUDE_CONFIG_DIR. No-session-persistence; temporary autoMemoryDirectory; no tools/MCP/hooks.",
});

let allPassed = true;
try {
  for (const scenario of cases.filter((entry) => !process.argv[3] || entry.name === process.argv[3])) {
    const settings = { autoMemoryEnabled: scenario.autoMemoryEnabled, autoMemoryDirectory: memory,
      autoDreamEnabled: false, disableAllHooks: true,
      ...("settingsEnv" in scenario ? { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: scenario.settingsEnv } } : {}) };
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--tools", "",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
      "--no-session-persistence", "--max-turns", "1", "--settings", JSON.stringify(settings)];
    if (process.env.AUT_CLAUDE_MODEL) args.push("--model", process.env.AUT_CLAUDE_MODEL);
    args.push(prompt);
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_CRON: "1" };
    delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    if (scenario.env !== undefined) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = scenario.env;
    record({ type: "scenario", name: scenario.name,
      settings: { ...settings, autoMemoryDirectory: "<temporary-memory>" },
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: scenario.env ?? "<unset>" },
      args: args.map((arg) => arg === JSON.stringify(settings) ? "<scenario-settings>" : arg),
    });
    const child = spawn(executable, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let result: Record<string, unknown> | undefined;
    let initialization: Record<string, unknown> | undefined;
    let stderrBytes = 0;
    let malformedFrames = 0;
    let spawnFailed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(line) as Record<string, unknown>; } catch { malformedFrames++; return; }
      if (frame.type === "system" && frame.subtype === "init") initialization = frame;
      if (frame.type === "result") result = frame;
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.on("error", () => { spawnFailed = true; });
      child.on("close", (code, signal) => done({ code, signal }));
    });
    clearTimeout(timer);
    const normalizePath = (value: unknown) => typeof value !== "string" ? "<non-string>"
      : value === join(project, "CLAUDE.md") ? "<temporary-project>/CLAUDE.md"
      : value === join(memory, "MEMORY.md") ? "<temporary-memory>/MEMORY.md"
      : "<other-instruction-path>";
    record({ type: "system", subtype: "init", scenario: scenario.name,
      received: initialization !== undefined,
      model: initialization?.model, claude_code_version: initialization?.claude_code_version,
      memory_paths: Array.isArray(initialization?.memory_paths) ? initialization.memory_paths.map(normalizePath) : null,
      tool_count: Array.isArray(initialization?.tools) ? initialization.tools.length : null,
    });
    let parsed: Record<string, unknown> | undefined;
    if (typeof result?.result === "string") {
      const text = result.result.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* Only the known marker shape is retained. */ }
    }
    const recognized = (value: unknown, token: string) => value === token ? "<expected-synthetic-token>" : value === null ? null : "<unrecognized>";
    const projectLoaded = parsed?.project_probe_value === projectToken;
    const memoryLoaded = parsed?.memory_probe_value === memoryToken;
    const memoryAbsent = parsed?.memory_probe_value === null;
    const passed = exit.code === 0 && !timedOut && !spawnFailed && result?.is_error === false && projectLoaded
      && (scenario.expectMemory ? memoryLoaded : memoryAbsent);
    allPassed &&= passed;
    record({ type: "result", scenario: scenario.name, subtype: result?.subtype,
      is_error: result?.is_error, num_turns: result?.num_turns,
      project_probe_value: recognized(parsed?.project_probe_value, projectToken),
      memory_probe_value: recognized(parsed?.memory_probe_value, memoryToken),
      assertions: { projectLoaded, memoryLoaded, memoryAbsent, expectedMemory: scenario.expectMemory, passed },
      exit, timedOut, spawnFailed, stderrBytes, malformedFrames,
    });
    console.log(`${scenario.name}: ${passed ? "PASS" : "FAIL"}; project=${projectLoaded}; memory=${memoryLoaded}; null=${memoryAbsent}`);
  }
  const filesUnchanged = digest(join(memory, "MEMORY.md")) === beforeMemory && digest(join(project, "CLAUDE.md")) === beforeProject;
  allPassed &&= filesUnchanged;
  record({ type: "summary", allPassed, syntheticFilesUnchanged: filesUnchanged });
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (!allPassed) process.exitCode = 1;
