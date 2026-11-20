import { contextBridge, ipcRenderer } from "electron";
import type { ApiRequest, ApiResult, DesktopBridge, DesktopNotice } from "./bridge.js";

const bridge: DesktopBridge = {
  request: (request: ApiRequest) =>
    ipcRenderer.invoke("aut:request", request) as Promise<ApiResult>,
  onNotice: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, value: DesktopNotice) => listener(value);
    ipcRenderer.on("aut:notice", callback);
    return () => ipcRenderer.removeListener("aut:notice", callback);
  },
};
contextBridge.exposeInMainWorld("aut", bridge);
