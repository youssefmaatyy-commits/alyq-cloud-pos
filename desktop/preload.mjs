import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./contracts.mjs";

/**
 * Deliberately tiny native surface. The renderer receives no Electron object,
 * filesystem primitive, shell command, arbitrary IPC channel, or Node API.
 * Every argument is validated again in the main process.
 */
const api = Object.freeze({
  getContext: () => ipcRenderer.invoke(IPC.GET_CONTEXT),
  setFullscreen: (enabled) => ipcRenderer.invoke(IPC.SET_FULLSCREEN, enabled),
  onFullscreenChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, enabled) => callback(enabled === true);
    ipcRenderer.on(IPC.FULLSCREEN_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.FULLSCREEN_CHANGED, listener);
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  getConfig: () => ipcRenderer.invoke(IPC.GET_CONFIG),
  saveHardwareConfig: (config) => ipcRenderer.invoke(IPC.SAVE_HARDWARE_CONFIG, config),
  saveRegisterBinding: (binding) => ipcRenderer.invoke(IPC.SAVE_REGISTER_BINDING, binding),
  clearRegisterBinding: () => ipcRenderer.invoke(IPC.CLEAR_REGISTER_BINDING),
  listPrinters: () => ipcRenderer.invoke(IPC.LIST_PRINTERS),
  printReceipt: (request) => ipcRenderer.invoke(IPC.PRINT_RECEIPT, request),
  testPrint: (request) => ipcRenderer.invoke(IPC.TEST_PRINT, request),
  kickDrawer: (request) => ipcRenderer.invoke(IPC.KICK_DRAWER, request),
  setRuntimeState: (state) => ipcRenderer.invoke(IPC.SET_RUNTIME_STATE, state),
});

contextBridge.exposeInMainWorld("alyqDesktop", api);
