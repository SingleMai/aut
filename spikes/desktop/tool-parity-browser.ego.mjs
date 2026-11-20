// Run after `ego-browser skill` and the oracle server:
// rtk proxy ego-browser nodejs < spikes/desktop/tool-parity-browser.ego.mjs
// The TaskSpace stays open for desktop fixture QA; finish it in a separate final command.
const spaceName = "aut tool UI source parity acceptance";
const existing = (await listTaskSpaces()).find((space) => space.name === spaceName);
const task = existing ? await taskSpace(existing.id) : await taskSpace(spaceName);
const page = (await task.pages())[0];
await page.goto("http://127.0.0.1:4318");
await page.waitForFunction(() => Boolean(window.parityOracle));
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1040,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.evaluate(() => document.fonts.ready);
console.log(await page.snapshot());
const fs = await import("node:fs/promises");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const directory = await fs.mkdtemp(join(tmpdir(), "aut-tool-parity-"));
const compare = () => page.evaluate(() => window.parityOracle.compare());
const report = {
  referenceCommit: "738ec88472a3b888ff7b7793755d89da613ed301",
  sharedInterfaces: ["i18n catalog", "mode context", "tool-output reader"],
  viewport: { width: 1040, height: 900 },
  runningSimple: await compare(),
};
await page.screenshot({ path: `${directory}/oracle-running-simple.png` });
await page.click('[data-pane="upstream"] button');
await page.click('[data-pane="copied"] button');
await page.click('[data-pane="upstream"] [data-message-id="command-1"] summary');
await page.click('[data-pane="copied"] [data-message-id="command-1"] summary');
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-pane="copied"] [data-message-id="command-1"] summary')
      .getAttribute("aria-expanded") === "true",
);
report.runningExpanded = await compare();
await page.click('loc=role:checkbox[name="Advanced"]');
report.runningAdvanced = await compare();
await page.click('loc=role:button[name="Completed fixture"]');
await page.waitForFunction(() => document.body.innerText.includes("PARITY_FINAL"));
report.completedAdvanced = await compare();
await page.click('loc=role:checkbox[name="Advanced"]');
report.completedSimple = await compare();
await page.screenshot({ path: `${directory}/oracle-completed-simple.png` });
await page.click('loc=role:button[name="Locate first command"]');
await page.waitForFunction(() =>
  Boolean(document.querySelector('[data-pane="copied"] [data-message-id="command-1"]')),
);
report.focusExpanded = await compare();
await page.press('[data-pane="upstream"] [data-message-id="command-1"] summary', "Space");
await page.press('[data-pane="copied"] [data-message-id="command-1"] summary', "Space");
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-pane="copied"] [data-message-id="command-1"] summary')
      .getAttribute("aria-expanded") === "true",
);
report.keyboardDetail = await compare();
// Compare behavior with upstream, and measure the aut pane against the desktop layout.
const toolLayout = async (width) => {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  return page.evaluate(() => {
    const opened = document.querySelector('[data-pane="copied"] details[open]');
    const summary = opened.querySelector("summary");
    return {
      width: opened.getBoundingClientRect().width,
      available: opened.parentElement.clientWidth,
      overflow: opened.scrollWidth > opened.clientWidth,
      focusVisible: document.activeElement === summary && summary.matches(":focus-visible") &&
        getComputedStyle(summary).outlineStyle === "solid",
    };
  });
};
report.wideTool = await toolLayout(1600);
report.narrowTool = await toolLayout(760);
if (report.wideTool.width !== 608 || report.narrowTool.available >= 608 ||
    report.narrowTool.width !== report.narrowTool.available || report.narrowTool.overflow ||
    !report.narrowTool.focusVisible)
  throw new Error("Tool width, overflow or keyboard focus failed: " +
    JSON.stringify([report.wideTool, report.narrowTool]));
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1040, height: 900, deviceScaleFactor: 1, mobile: false,
});
await page.click('loc=role:checkbox[name="Show tools"]');
report.hiddenTools = await page.evaluate(() => ({
  ...window.parityOracle.compare(),
  visibleTools: document.querySelectorAll("details").length,
  text: document.querySelector('[data-pane="copied"]').innerText,
}));
report.noHorizontalOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth <= innerWidth,
);
await fs.writeFile(`${directory}/oracle-report.json`, JSON.stringify(report, null, 2));
const failed = Object.entries(report).filter(
  ([, value]) => typeof value === "object" && value !== null && "equal" in value && !value.equal,
);
if (failed.length || report.hiddenTools.visibleTools !== 0 || !report.noHorizontalOverflow)
  throw new Error(`Parity check failed: ${JSON.stringify(failed)}`);
console.log({
  spaceId: task.spaceId,
  report: `${directory}/oracle-report.json`,
  comparedStates: 8,
  equal: true,
});
console.log(await page.snapshot());
