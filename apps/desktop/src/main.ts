import { join, resolve } from "node:path";
import { RemoteHostStatus, TailscaleLoginUrl } from "@aut/protocol";
import { Effect, Layer, Schema, Stream } from "effect";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { ApiRequest, ConnectionAction, type ConnectionActionResult } from "./bridge.js";
import { DesktopConnection, DesktopError } from "./connection.js";
import {
  ConnectionPairing,
  ConnectionPairingLive,
  encodeConnectionCode,
} from "./connection-pairing.js";
import { ConnectionPreferences, ConnectionPreferencesLive } from "./connection-preferences.js";
import { nativeFileAction } from "./native-files.js";
import { DesktopShellConnectionLive } from "./shell-connection.js";

if (process.env.AUT_DESKTOP_PROFILE) app.setPath("userData", process.env.AUT_DESKTOP_PROFILE);
const windows = new Set<BrowserWindow>();
const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "aut",
    show: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(app.getAppPath(), "dist/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  windows.add(window);
  window.on("closed", () => windows.delete(window));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  Effect.runFork(
    Effect.tryPromise({
      try: () => window.loadFile(join(app.getAppPath(), "dist/index.html")),
      catch: () =>
        new DesktopError({ code: "Startup", message: "无法加载桌面界面，请重新构建应用。" }),
    }).pipe(
      Effect.tap(() => Effect.logInfo("aut desktop interface ready")),
      Effect.catchAll((error) => Effect.sync(() => dialog.showErrorBox("aut", error.message))),
    ),
  );
  return window;
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const window = [...windows][0];
    window?.show();
    window?.focus();
  });
  const preferences = Layer.unwrapEffect(
    Effect.tryPromise({
      try: () => app.whenReady(),
      catch: () => new DesktopError({ code: "Startup", message: "无法初始化桌面窗口。" }),
    }).pipe(Effect.map(() => ConnectionPreferencesLive(app.getPath("userData")))),
  );
  const layer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const preferences = yield* ConnectionPreferences;
      return DesktopShellConnectionLive({
        daemonEntry: app.isPackaged
          ? join(process.resourcesPath, "daemon/main.mjs")
          : resolve(app.getAppPath(), "../../packages/daemon/dist/main.js"),
        executable: app.isPackaged ? process.execPath : (process.env.AUT_NODE_BINARY ?? "node"),
        electronNode: app.isPackaged,
        transportBinary: app.isPackaged
          ? join(process.resourcesPath, "transport/aut-transport")
          : resolve(app.getAppPath(), "../../packages/transport/dist/native/aut-transport"),
        transportDirectory: join(app.getPath("userData"), "transport-client"),
        ...(preferences.remote ? { remote: preferences.remote } : {}),
        ...(process.env.AUT_DATA_DIR ? { dataDirectory: process.env.AUT_DATA_DIR } : {}),
        port: Number(process.env.AUT_PORT ?? 4317),
      });
    }),
  ).pipe(Layer.provideMerge(preferences));
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => app.whenReady(),
        catch: () => new DesktopError({ code: "Startup", message: "无法初始化桌面窗口。" }),
      });
      const service = yield* DesktopConnection;
      const preferences = yield* ConnectionPreferences;
      const pairing = yield* ConnectionPairing;
      const watchWindow = (window: BrowserWindow) => {
        const owner = window.webContents.id;
        window.once("closed", () => Effect.runSync(pairing.clear(owner)));
        return window;
      };
      const ownedWindow = (event: Electron.IpcMainInvokeEvent) =>
        [...windows].find(
          (window) =>
            event.sender === window.webContents &&
            event.senderFrame === window.webContents.mainFrame,
        );
      ipcMain.handle(
        "aut:connection",
        (event, input: unknown): Promise<ConnectionActionResult> =>
          Effect.runPromise(
            Effect.gen(function* () {
              const window = ownedWindow(event);
              if (!window) return { ok: false as const, error: "请求来源无效。" };
              const action = yield* Schema.decodeUnknown(ConnectionAction)(input, {
                onExcessProperty: "error",
              }).pipe(
                Effect.mapError(
                  () =>
                    new DesktopError({
                      code: "Validation",
                      message: "连接信息无效，请完整粘贴 Pro 复制的内容。",
                    }),
                ),
              );
              if (action.action === "status")
                return { ok: true as const, status: yield* service.status };
              if (action.action === "copy") {
                const info = yield* service.exportConnection;
                yield* Effect.tryPromise({
                  try: async () => clipboard.writeText(encodeConnectionCode(info)),
                  catch: () =>
                    new DesktopError({ code: "Clipboard", message: "无法复制连接码，请重试。" }),
                });
                return { ok: true as const };
              }
              if (action.action === "inspect") {
                const text =
                  action.text === undefined
                    ? Effect.tryPromise({
                        try: async () => clipboard.readText(),
                        catch: () =>
                          new DesktopError({
                            code: "Clipboard",
                            message: "无法读取剪贴板，请使用手动粘贴。",
                          }),
                      })
                    : Effect.succeed(action.text);
                const preview = yield* pairing.inspect(event.sender.id, text);
                return { ok: true as const, preview };
              }
              if (action.action === "clear-pairing") {
                yield* pairing.clear(event.sender.id);
                return { ok: true as const };
              }
              if (action.action === "login") {
                let url = yield* service.loginUrl;
                if ((yield* service.status).mode === "local") {
                  const response = yield* service.request({
                    method: "GET",
                    path: "/v1/remote/host",
                  });
                  if (response.ok) {
                    const host = yield* Schema.decodeUnknown(RemoteHostStatus)(response.data).pipe(
                      Effect.mapError(
                        () => new DesktopError({ code: "Protocol", message: "主机版本不兼容。" }),
                      ),
                    );
                    url = host.loginUrl;
                  }
                }
                if (!url || !Schema.is(TailscaleLoginUrl)(url))
                  return { ok: false as const, error: "登录链接尚未生成，请稍后重试。" };
                const address = url;
                yield* Effect.tryPromise({
                  try: () => shell.openExternal(address),
                  catch: () => new DesktopError({ code: "Login", message: "无法打开登录页面。" }),
                });
                return { ok: true as const };
              }
              const connection =
                action.action === "pair"
                  ? yield* pairing.read(event.sender.id, action.id)
                  : action.action === "remote"
                    ? action.connection
                    : undefined;
              const choice = yield* Effect.tryPromise({
                try: () =>
                  dialog.showMessageBox(window, {
                    type: "question",
                    buttons: ["取消", "切换并重启"],
                    defaultId: 0,
                    cancelId: 0,
                    message: connection ? `切换到「${connection.name}」执行？` : "切换到本机执行？",
                    detail:
                      "切换会重启 aut，当前窗口尚未发送的草稿会清空。已提交给原主机的任务继续在原主机运行。",
                  }),
                catch: () => new DesktopError({ code: "Settings", message: "无法切换执行位置。" }),
              });
              if (choice.response !== 1) return { ok: true as const, cancelled: true };
              yield* preferences.save(connection);
              yield* pairing.clear(event.sender.id);
              app.relaunch();
              app.quit();
              return { ok: true as const };
            }).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({ ok: false as const, error: error.message }),
              ),
            ),
          ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => ipcMain.removeHandler("aut:connection")));
      ipcMain.handle("aut:file", (event, input: unknown) => {
        const window = ownedWindow(event);
        return window
          ? Effect.runPromise(
              nativeFileAction(
                input,
                window,
                service,
                preferences.remote
                  ? {
                      directory: join(app.getPath("userData"), "remote-files"),
                      hostId: preferences.remote.hostId,
                    }
                  : undefined,
              ),
            )
          : Promise.resolve({ ok: false, error: "请求来源无效。" });
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => ipcMain.removeHandler("aut:file")));
      ipcMain.handle("aut:request", (event, input: unknown) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (!ownedWindow(event))
              return yield* Effect.fail(
                new DesktopError({ code: "Forbidden", message: "请求来源无效。" }),
              );
            const request = yield* Schema.decodeUnknown(ApiRequest)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () => new DesktopError({ code: "Validation", message: "无效的本地 API 请求。" }),
              ),
            );
            return yield* service.request(request);
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({
                ok: false as const,
                error: { code: error.code, message: error.message },
              }),
            ),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => ipcMain.removeHandler("aut:request")));
      yield* service.notices.pipe(
        Stream.runForEach((notice) =>
          Effect.sync(() => {
            for (const window of windows)
              if (!window.isDestroyed()) window.webContents.send("aut:notice", notice);
          }),
        ),
        Effect.forkScoped,
      );
      if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), "assets/aut-icon.png"));
      watchWindow(createWindow());
      app.on("activate", () => {
        if (windows.size === 0) watchWindow(createWindow());
      });
      app.on("window-all-closed", () => app.quit());
      yield* Effect.async<void>((resume) => {
        app.once("before-quit", () => resume(Effect.void));
      });
    }).pipe(Effect.provide(Layer.merge(layer, ConnectionPairingLive))),
  ).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        dialog.showErrorBox("aut 无法连接服务", error.message);
        app.quit();
      }),
    ),
  );
  Effect.runFork(program);
}
