import { contextBridge, ipcRenderer } from "electron";
import type {
  ApiRequest,
  ApiResult,
  DesktopBridge,
  DesktopNotice,
  FileAction,
  FileActionResult,
} from "./bridge.js";

const bridge: DesktopBridge = {
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
