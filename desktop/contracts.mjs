export const IPC = Object.freeze({
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

export const PAPER_WIDTHS = Object.freeze([58, 80]);
export const DRAWER_MODES = Object.freeze(["none", "printer-driver"]);
export const MAX_RECEIPT_HTML_BYTES = 1_000_000;
