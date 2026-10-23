/* global require */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- sandboxed Electron preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

// Electron's sandboxed preload bridge must be CommonJS. Keep this deliberately
// small and self-contained: importing the renderer contracts as ESM prevents
// the packaged sandboxed preload from running in Windows installs.
const IPC = Object.freeze({
  GET_CONTEXT: "alyq:app:get-context",
  SET_FULLSCREEN: "alyq:app:set-fullscreen",
  FULLSCREEN_CHANGED: "alyq:app:fullscreen-changed",
  OPEN_EXTERNAL: "alyq:app:open-external",
  GET_CONFIG: "alyq:config:get",
  GET_REGISTER_BINDING: "alyq:register-binding:get",
  SAVE_HARDWARE_CONFIG: "alyq:config:save-hardware",
  SAVE_REGISTER_BINDING: "alyq:config:save-register-binding",
  CLEAR_REGISTER_BINDING: "alyq:config:clear-register-binding",
  LIST_PRINTERS: "alyq:hardware:list-printers",
  PRINT_RECEIPT: "alyq:hardware:print-receipt",
  TEST_PRINT: "alyq:hardware:test-print",
  KICK_DRAWER: "alyq:hardware:kick-drawer",
  SET_RUNTIME_STATE: "alyq:runtime:set-state",
});

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
  getRegisterBinding: () => ipcRenderer.invoke(IPC.GET_REGISTER_BINDING),
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
