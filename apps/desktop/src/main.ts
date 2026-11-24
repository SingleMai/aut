import { join, resolve } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { ApiRequest } from "./bridge.js";
import { DesktopConnection, DesktopConnectionLive, DesktopError } from "./connection.js";
import { nativeFileAction } from "./native-files.js";

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
  const layer = DesktopConnectionLive({
    daemonEntry: app.isPackaged
      ? join(process.resourcesPath, "daemon/main.mjs")
      : resolve(app.getAppPath(), "../../packages/daemon/dist/main.js"),
    executable: app.isPackaged ? process.execPath : (process.env.AUT_NODE_BINARY ?? "node"),
    electronNode: app.isPackaged,
    ...(process.env.AUT_DATA_DIR ? { dataDirectory: process.env.AUT_DATA_DIR } : {}),
    port: Number(process.env.AUT_PORT ?? 4317),
  });
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => app.whenReady(),
        catch: () => new DesktopError({ code: "Startup", message: "无法初始化桌面窗口。" }),
      });
      const service = yield* DesktopConnection;
      ipcMain.handle("aut:file", (event, input: unknown) => {
        const window = [...windows].find(
          (window) =>
            event.sender === window.webContents &&
            event.senderFrame === window.webContents.mainFrame,
        );
        return window
          ? Effect.runPromise(nativeFileAction(input, window, service))
          : Promise.resolve({ ok: false, error: "请求来源无效。" });
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => ipcMain.removeHandler("aut:file")));
      ipcMain.handle("aut:request", (event, input: unknown) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (
              ![...windows].some(
                (window) =>
                  event.sender === window.webContents &&
                  event.senderFrame === window.webContents.mainFrame,
              )
            )
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
      createWindow();
      app.on("activate", () => {
        if (windows.size === 0) createWindow();
      });
      app.on("window-all-closed", () => app.quit());
      yield* Effect.async<void>((resume) => {
        app.once("before-quit", () => resume(Effect.void));
      });
    }).pipe(Effect.provide(layer)),
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
