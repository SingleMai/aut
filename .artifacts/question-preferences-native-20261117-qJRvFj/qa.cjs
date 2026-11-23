const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const qa = __dirname;
const desktop = path.join(qa, 'desktop');
app.setPath('userData', path.join(qa, 'profile-visible-tools'));
app.setPath('sessionData', path.join(qa, 'profile-visible-tools'));
app.setPath('crashDumps', path.join(qa, 'crashes'));
app.name = 'aut isolated question QA';

const now = Date.now();
const botId = 'qa-question-worker';
const requestId = 'qa-long-question';
const task = (id, title) => ({
  id, botId, title, status: id === 'qa-task-a' ? 'waiting_user' : 'idle',
  createdAt: now - 10000, updatedAt: now, lastActivityAt: now,
  session: { instanceId: 'qa-fixture', cursor: { kind: 'fixture', data: id } },
  pendingRequestIds: id === 'qa-task-a' ? [requestId] : [], queue: [], origin: { kind: 'user' },
});
const tasks = [task('qa-task-a', 'QA 任务 A · 展示偏好'), task('qa-task-b', 'QA 任务 B · 跨任务检查')];
const longText = Array.from({ length: 12 }, (_, index) =>
  `第 ${index + 1} 段：这是一条仅供本地界面验收的合成长问题，用于确认完整内容在展开后可阅读、收起后仍保留选项和文字草稿。`
).join('\n') + '\nQA_LONG_QUESTION_END';
const question = { id: 'long', text: longText, options: [{ id: 'inspect', label: '检查折叠与展开', description: '仅测试展示，不提交答案。' }, { id: 'later', label: '稍后再答' }], multiSelect: false, allowFreeText: true };
const card = { id: 'qa-card', prompt: longText, requestId, state: 'open', multiSelect: false, allowFreeText: true, options: [] };
const messages = [{ id: 'qa-question-message', at: now, author: { botId, taskId: 'qa-task-a' }, kind: 'question-card', text: longText, taskId: 'qa-task-a', card }];
const request = { id: requestId, taskId: 'qa-task-a', kind: 'question', openedAt: now, raw: { fixture: 'native-ui-only' }, questions: [question] };
const history = (id) => ({ turns: [{ id: `${id}-turn`, status: 'completed', startedAt: now - 10000, completedAt: now, items: [
  { id: `${id}-input`, kind: 'user', status: 'completed', text: '只读会话展示验收；没有运行任何工具。', startedAt: now - 10000 },
  { id: `${id}-tool-1`, kind: 'tool', status: 'completed', text: '', startedAt: now - 9000, tool: { name: 'commandExecution', input: 'synthetic-command --no-execution', output: 'Synthetic recorded output only.' } },
  { id: `${id}-tool-2`, kind: 'tool', status: 'failed', text: '', startedAt: now - 8000, tool: { name: 'fileChange', input: 'fixture/example.txt', output: 'Synthetic failed file change only.' } },
  { id: `${id}-final`, kind: 'assistant', status: 'completed', phase: 'final', text: `QA_FINAL_${id}: 工具显示偏好不会隐藏这条最终回答。`, startedAt: now - 1000, completedAt: now },
] }] });
const requests = [];
const checks = [];
const screenshots = [];
let win;
let result = { ok: false, scope: 'Real copied Electron renderer and preload; synthetic IPC fixture only. No daemon, harness, existing app profile or ~/.aut used.' };

ipcMain.handle('aut:request', (_event, input) => {
  requests.push({ method: input.method, path: input.path });
  if (input.method !== 'GET') return { ok: false, error: { code: 'FixtureReadOnly', message: 'QA never submits native answers or changes real data.' } };
  const route = input.path.split('?')[0];
  let data;
  if (route === '/v1/messages') data = { messages };
  else if (route === '/v1/tasks') data = { tasks };
  else if (route === '/v1/bots') data = { bots: [{ id: botId, name: '隔离测试助手', description: 'Synthetic local UI fixture', soul: '', modelSelection: { instanceId: 'qa-fixture', model: 'synthetic' }, cwd: qa }] };
  else if (route === '/v1/config') data = { harnessInstances: [] };
  else if (route === `/v1/requests/${requestId}`) data = { request };
  else if (route === '/v1/health') data = { status: 'ok' };
  else {
    const match = /^\/v1\/tasks\/([^/]+)(\/session)?$/.exec(route);
    const found = tasks.find((entry) => entry.id === match?.[1]);
    if (found) data = match[2] ? { task: found, history: history(found.id), availability: 'available', hasEarlier: false } : { task: found };
  }
  return data ? { ok: true, data } : { ok: false, error: { code: 'NotFound', message: `Unknown fixture route: ${route}` } };
});

const evaluate = (expression) => win.webContents.executeJavaScript(expression, true);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(expression, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await pause(40);
  }
  throw new Error(`Timed out: ${label}`);
}
function check(name, condition, observed) {
  checks.push({ name, passed: Boolean(condition), observed });
  if (!condition) throw new Error(`Check failed: ${name}`);
}
async function click(selector) {
  const rect = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing click target');
    element.scrollIntoView({block:'center', inline:'center'});
    const box = element.getBoundingClientRect();
    return {x: box.left+box.width/2, y:box.top+box.height/2, width:box.width, height:box.height, text:element.textContent, tag:element.tagName};
  })()`);
  if (!rect.width || !rect.height) throw new Error(`Invisible click target: ${selector}`);
  win.focus();
  win.webContents.focus();
  const event = { x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 };
  win.webContents.sendInputEvent({ type: 'mouseMove', x: event.x, y: event.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...event });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...event });
  return rect;
}
async function shot(name) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await pause(120);

  const target = path.join(qa, name);
  await fs.writeFile(target, (await win.webContents.capturePage()).toPNG());
  screenshots.push(target);
}
const preferences = () => evaluate(`(() => ({advanced:document.querySelector('[data-session-mode]')?.getAttribute('aria-pressed'), showToolCalls:document.querySelector('[data-session-tools]')?.getAttribute('aria-pressed'), storedAdvanced:localStorage.getItem('aut-session-display-advanced'), storedTools:localStorage.getItem('aut-session-display-showToolCalls'), toolRows:document.querySelectorAll('[data-testid="tool-activity"]').length, finalVisible:document.querySelector('.task-session-final')?.textContent}))()`);
async function openTask(id) {
  const title = tasks.find((entry) => entry.id === id).title;
  await click(`.sidebar-task[title=${JSON.stringify(title)}]`);
  await waitFor(`Boolean(document.querySelector('[data-session-mode]')) && document.querySelector('.task-session-final')?.textContent.includes(${JSON.stringify(`QA_FINAL_${id}`)})`, `open ${id}`);
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1280, height: 860, show: true, title: 'aut · 隔离原生交互验收', backgroundColor: '#fcfcfc', webPreferences: { preload: path.join(desktop, 'dist/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    await win.loadFile(path.join(desktop, 'dist/index.html'));
    await waitFor(`document.querySelector('.question-copy button')?.textContent==='显示完整问题'`, 'native question renders');
    const collapsed = await evaluate(`(() => { const node=document.querySelector('.question-copy .line-clamp-4');return {height:node?.getBoundingClientRect().height,scrollHeight:node?.scrollHeight,lineHeight:node&&getComputedStyle(node).lineHeight,expanded:document.querySelector('.question-copy button')?.getAttribute('aria-expanded'),fullTextPresent:node?.textContent.includes('QA_LONG_QUESTION_END')};})()`);
    check('Long question is genuinely clamped to four rendered lines', collapsed.expanded === 'false' && collapsed.height <= Number.parseFloat(collapsed.lineHeight) * 4 + 1 && collapsed.scrollHeight > collapsed.height && collapsed.fullTextPresent, collapsed);
    await shot('01-question-collapsed.png');
    await click('.question-copy button');
    await waitFor(`document.querySelector('.question-copy button')?.getAttribute('aria-expanded')==='true'`, 'question expands after native mouse input');
    const expanded = await evaluate(`(() => {const node=document.querySelector('.question-copy > div > div');return {height:node?.getBoundingClientRect().height,clamped:Boolean(document.querySelector('.question-copy .line-clamp-4')),text:document.querySelector('.question-copy button')?.textContent,fullTextPresent:node?.textContent.includes('QA_LONG_QUESTION_END')};})()`);
    check('Native click expands the complete question', expanded.height > collapsed.height && !expanded.clamped && expanded.text === '收起' && expanded.fullTextPresent, expanded);
    await shot('02-question-expanded.png');
    await click('.answer-free-input');
    win.webContents.insertText('isolated native QA draft');
    await waitFor(`document.querySelector('.answer-free-input')?.value==='isolated native QA draft'`, 'typed draft');
    await click('.question-copy button');
    await waitFor(`document.querySelector('.question-copy button')?.getAttribute('aria-expanded')==='false'`, 'question collapses again');
    check('Collapse preserves the actual typed answer draft without submission', await evaluate(`document.querySelector('.answer-free-input')?.value==='isolated native QA draft'`) && requests.every((entry) => entry.method === 'GET'), { writes: requests.filter((entry) => entry.method !== 'GET') });

    await openTask('qa-task-a');
    const defaults = await preferences();
    check('Fresh isolated profile starts in Simple mode with tools visible', defaults.advanced === 'false' && defaults.showToolCalls === 'true' && defaults.toolRows > 0, defaults);
    await click('[data-session-mode]');
    await waitFor(`document.querySelector('[data-session-mode]')?.getAttribute('aria-pressed')==='true'`, 'advanced preference');
    await click('[data-session-tools]');
    await waitFor(`document.querySelector('[data-session-tools]')?.getAttribute('aria-pressed')==='false'`, 'hidden-tool preference');
    const changed = await preferences();
    check('Native toggles persist settings and keep final text visible', changed.storedAdvanced === '1' && changed.storedTools === '0' && changed.toolRows === 0 && changed.finalVisible?.includes('QA_FINAL_qa-task-a'), changed);
    await shot('03-task-a-preferences.png');

    await openTask('qa-task-b');
    const second = await preferences();
    check('Preferences survive switching to another task', second.advanced === 'true' && second.showToolCalls === 'false' && second.finalVisible?.includes('QA_FINAL_qa-task-b'), second);
    const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.reload();
    await loaded;
    await waitFor(`Boolean(document.querySelector('.question-copy button'))`, 'renderer reload');
    await openTask('qa-task-b');
    const reloaded = await preferences();
    check('Preferences survive a full renderer reload', reloaded.advanced === 'true' && reloaded.showToolCalls === 'false' && reloaded.storedAdvanced === '1' && reloaded.storedTools === '0', reloaded);
    await shot('04-task-b-after-reload.png');

    await click('[data-session-mode]');
    await click('[data-session-tools]');
    await waitFor(`document.querySelector('[data-session-mode]')?.getAttribute('aria-pressed')==='false' && document.querySelector('[data-session-tools]')?.getAttribute('aria-pressed')==='true'`, 'reset isolated preferences');
    await openTask('qa-task-a');
    const returned = await preferences();
    check('Changing settings back also survives another task switch', returned.advanced === 'false' && returned.showToolCalls === 'true' && returned.toolRows > 0, returned);
    check('The fixture run never submitted an answer or wrote backend data', requests.every((entry) => entry.method === 'GET'), { requestCount: requests.length });
    result.ok = true;
  } catch (error) {
    result.error = String(error?.stack ?? error);
    if (win && !win.isDestroyed()) {
      try { await shot('failure.png'); result.visibleText = await evaluate('document.body.innerText'); } catch {}
    }
  } finally {
    result = { ...result, checks, screenshots, requests, profile: app.getPath('userData'), electron: process.versions.electron, chrome: process.versions.chrome, rendererSha256: crypto.createHash('sha256').update(await fs.readFile(path.join(desktop, 'dist/ui.js'))).digest('hex'), finishedAt: new Date().toISOString() };
    const report = path.join(qa, 'report.json');
    await fs.writeFile(report, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: result.ok, report, passed: checks.filter((entry) => entry.passed).length, checks: checks.length, error: result.error }));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(result.ok ? 0 : 1);
  }
});
