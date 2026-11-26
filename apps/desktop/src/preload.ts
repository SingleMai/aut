import { contextBridge, ipcRenderer } from "electron";
import type {
  ApiRequest,
  ApiResult,
  ConnectionAction,
  ConnectionActionResult,
  DesktopBridge,
  DesktopNotice,
  FileAction,
  FileActionResult,
} from "./bridge.js";

const bridge: DesktopBridge = {
  connection: (input: ConnectionAction) =>
    ipcRenderer.invoke("aut:connection", input) as Promise<ConnectionActionResult>,
  fileAction: (input: FileAction) =>
    ipcRenderer.invoke("aut:file", input) as Promise<FileActionResult>,
  request: (request: ApiRequest) =>
    ipcRenderer.invoke("aut:request", request) as Promise<ApiResult>,
  onNotice: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, value: DesktopNotice) => listener(value);
    ipcRenderer.on("aut:notice", callback);
    return () => ipcRenderer.removeListener("aut:notice", callback);
  },
};
contextBridge.exposeInMainWorld("aut", bridge);
