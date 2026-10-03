import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
} from "electron";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DRAWER_MODES,
  IPC,
  MAX_RECEIPT_HTML_BYTES,
  PAPER_WIDTHS,
} from "./contracts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL = /^[A-Za-z0-9_-]{32,160}$/;
const BUILD_SHA = String(process.env.ALYQ_BUILD_SHA || process.env.GITHUB_SHA || "development").slice(0, 64);
const CONFIG_FILE = "desktop-config.v1.json";

let mainWindow = null;
let quitting = false;
let runtimeState = { pending: 0, conflicts: 0 };
let lastDrawerAttemptAt = 0;
let allowedAppUrl = null;

const defaultHardware = Object.freeze({
  printerName: null,
  paperWidthMm: 80,
  copies: 1,
  silentPrint: true,
  autoPrintAfterSale: false,
  drawerMode: "none",
  autoOpenCashDrawer: false,
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, max, nullable = false) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string") throw new Error("Invalid text value");
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error("Invalid text value");
  }
  return result;
}

function sanitizeHardware(value) {
  if (!isRecord(value)) throw new Error("Invalid hardware configuration");
  const paperWidthMm = Number(value.paperWidthMm);
  const copies = value.copies == null ? 1 : Number(value.copies);
  const drawerMode = String(value.drawerMode ?? "none");
  if (!PAPER_WIDTHS.includes(paperWidthMm) || !Number.isInteger(copies) || copies < 1 || copies > 5 || !DRAWER_MODES.includes(drawerMode)) {
    throw new Error("Unsupported hardware configuration");
  }
  const printerName = text(value.printerName, 180, true);
  const autoOpenCashDrawer = value.autoOpenCashDrawer === true;
  const autoPrintAfterSale = value.autoPrintAfterSale === true;
  if ((drawerMode === "printer-driver" && !printerName) || (autoOpenCashDrawer && drawerMode === "none")) {
    throw new Error("Cash drawer configuration requires a printer-driver");
  }
  if (autoPrintAfterSale && !printerName) throw new Error("Auto-print requires a configured printer");
  return {
    printerName,
    paperWidthMm,
    copies,
    silentPrint: value.silentPrint !== false,
    autoPrintAfterSale,
    drawerMode,
    autoOpenCashDrawer,
  };
}

function sanitizeRegisterSnapshot(value) {
  if (!isRecord(value)) throw new Error("Invalid register snapshot");
  const id = text(value.id, 36);
  const branchId = text(value.branchId, 36);
  if (!UUID.test(id) || !UUID.test(branchId)) throw new Error("Invalid register identity");
  return {
    id,
    code: text(value.code, 32),
    name: text(value.name, 80),
    branchId,
    branchName: text(value.branchName, 120, true),
    active: value.active === true,
    validatedAt: text(value.validatedAt, 40),
  };
}

function sanitizeBinding(value, installationId) {
  if (!isRecord(value)) throw new Error("Invalid register binding");
  const registerId = text(value.registerId, 36);
  const suppliedInstallationId = text(value.installationId, 36);
  const credential = text(value.credential, 160);
  if (!UUID.test(registerId) || suppliedInstallationId !== installationId || !CREDENTIAL.test(credential)) {
    throw new Error("Invalid register binding");
  }
  return {
    registerId,
    installationId,
    credential,
    snapshot: sanitizeRegisterSnapshot(value.snapshot),
  };
}

function configPath() {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

async function readConfig() {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(configPath(), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("[desktop-config] unable to read configuration");
  }
  const installationId = typeof parsed.installationId === "string" && UUID.test(parsed.installationId)
    ? parsed.installationId
    : randomUUID();
  let hardware = { ...defaultHardware };
  let registerBinding = null;
  try { hardware = sanitizeHardware(parsed.hardware ?? defaultHardware); } catch { /* defaults are safe */ }
  try {
    if (parsed.registerBinding) registerBinding = sanitizeBinding(parsed.registerBinding, installationId);
  } catch {
    console.error("[desktop-config] ignored invalid register binding");
  }
  const config = { schemaVersion: 1, installationId, hardware, registerBinding };
  if (parsed.installationId !== installationId) await writeConfig(config);
  return config;
}

async function writeConfig(config) {
  const destination = configPath();
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  try { await chmod(destination, 0o600); } catch { /* Windows ACLs are inherited from userData */ }
}

function safeExternalUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedAppNavigation(raw) {
  try {
    const candidate = new URL(raw);
    const allowed = new URL(allowedAppUrl);
    if (candidate.protocol !== allowed.protocol || candidate.origin !== allowed.origin) return false;
    if (candidate.protocol === "file:" && candidate.pathname !== allowed.pathname) return false;
    return candidate.protocol === "file:" || candidate.pathname === allowed.pathname;
  } catch {
    return false;
  }
}

async function openExternal(raw) {
  const url = safeExternalUrl(raw);
  if (!url) throw new Error("External link was refused");
  await shell.openExternal(url, { activate: true });
  return true;
}

function assertSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC sender");
  }
}

function safePrintHtml(raw) {
  if (typeof raw !== "string" || raw.length < 30 || Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_HTML_BYTES) {
    throw new Error("Invalid receipt document");
  }
  const withoutActiveContent = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(?:iframe|object|embed|link)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">';
  return withoutActiveContent.includes("<head>")
    ? withoutActiveContent.replace("<head>", `<head>${csp}`)
    : `${csp}${withoutActiveContent}`;
}

async function printHtml(html, reference, purpose) {
  const config = await readConfig();
  const printerName = config.hardware.printerName;
  const printers = await mainWindow.webContents.getPrintersAsync();
  if (printerName && !printers.some((printer) => printer.name === printerName)) {
    throw new Error("The configured printer is not reported by the operating system");
  }
  const printableWidth = Math.max(48, config.hardware.paperWidthMm - 4);
  const sizedHtml = html.replace(
    "</head>",
    `<style>@page{size:${config.hardware.paperWidthMm}mm auto;margin:2mm}.receipt{width:100%;max-width:${printableWidth}mm}</style></head>`,
  );
  const safeHtml = safePrintHtml(sizedHtml);
  const printWindow = new BrowserWindow({
    show: false,
    width: 500,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      javascript: false,
      devTools: false,
    },
  });
  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(safeHtml)}`);
    const result = await new Promise((resolve, reject) => {
      printWindow.webContents.print({
        silent: Boolean(printerName) && config.hardware.silentPrint,
        printBackground: true,
        copies: purpose === "receipt" ? config.hardware.copies : 1,
        deviceName: printerName ?? undefined,
        margins: { marginType: "none" },
        pageSize: {
          width: config.hardware.paperWidthMm * 1000,
          height: 297000,
        },
      }, (success, failureReason) => {
        if (!success) reject(new Error(failureReason || "Print submission failed"));
        else resolve({
          submitted: true,
          confirmedPrinted: false,
          printerName: printerName ?? "system-dialog",
          paperWidthMm: config.hardware.paperWidthMm,
          reference,
          purpose,
        });
      });
    });
    return result;
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

function testPage(widthMm) {
  const escapedVersion = app.getVersion().replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:${widthMm}mm auto;margin:3mm}body{font-family:Segoe UI,Tahoma,sans-serif;margin:0;color:#111}
    h1{text-align:center;font-size:17px;margin:0 0 5px}.line{border-top:1px dashed #111;margin:6px 0}
    p{font-size:11px;margin:3px 0}.center{text-align:center}.mono{font-family:monospace}
  </style></head><body><h1>ALYQ POS</h1><p class="center">Printer test · اختبار الطابعة</p><div class="line"></div>
  <p>Paper: ${widthMm}mm</p><p>Version: ${escapedVersion}</p><p class="mono">${new Date().toISOString()}</p>
  <div class="line"></div><p class="center">Submitted to the Windows print spooler.<br>تم الإرسال إلى قائمة طباعة ويندوز.</p></body></html>`;
}

function drawerPage() {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><style>@page{size:58mm 3mm;margin:0}body{margin:0;font-size:1px;color:white}</style></head><body>ALYQ drawer pulse job</body></html>";
}

function installIpcHandlers() {
  ipcMain.handle(IPC.GET_CONTEXT, async (event) => {
    assertSender(event);
    const config = await readConfig();
    return {
      runtime: "electron",
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      build: BUILD_SHA,
      packaged: app.isPackaged,
      fullscreen: mainWindow.isFullScreen(),
      installationId: config.installationId,
    };
  });
  ipcMain.handle(IPC.SET_FULLSCREEN, (event, enabled) => {
    assertSender(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid full-screen state");
    mainWindow.setFullScreen(enabled);
    return { fullscreen: mainWindow.isFullScreen() };
  });
  ipcMain.handle(IPC.OPEN_EXTERNAL, async (event, raw) => {
    assertSender(event);
    return openExternal(raw);
  });
  ipcMain.handle(IPC.GET_CONFIG, async (event) => {
    assertSender(event);
    return readConfig();
  });
  ipcMain.handle(IPC.SAVE_HARDWARE_CONFIG, async (event, raw) => {
    assertSender(event);
    const current = await readConfig();
    const hardware = sanitizeHardware(raw);
    await writeConfig({ ...current, hardware });
    return hardware;
  });
  ipcMain.handle(IPC.SAVE_REGISTER_BINDING, async (event, raw) => {
    assertSender(event);
    const current = await readConfig();
    const registerBinding = sanitizeBinding(raw, current.installationId);
    await writeConfig({ ...current, registerBinding });
    return { saved: true, registerId: registerBinding.registerId };
  });
  ipcMain.handle(IPC.CLEAR_REGISTER_BINDING, async (event) => {
    assertSender(event);
    const current = await readConfig();
    await writeConfig({ ...current, registerBinding: null });
    return { cleared: true };
  });
  ipcMain.handle(IPC.LIST_PRINTERS, async (event) => {
    assertSender(event);
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      description: printer.description || null,
      isDefault: printer.isDefault === true,
      // Driver status is intentionally not interpreted as physical paper,
      // cover, connectivity, or drawer health.
      driverStatus: Number.isFinite(printer.status) ? printer.status : null,
    }));
  });
  ipcMain.handle(IPC.PRINT_RECEIPT, async (event, request) => {
    assertSender(event);
    if (!isRecord(request)) throw new Error("Invalid receipt request");
    return printHtml(request.html, text(request.reference, 100), "receipt");
  });
  ipcMain.handle(IPC.TEST_PRINT, async (event) => {
    assertSender(event);
    const config = await readConfig();
    return printHtml(testPage(config.hardware.paperWidthMm), `TEST-${Date.now()}`, "test");
  });
  ipcMain.handle(IPC.KICK_DRAWER, async (event, request) => {
    assertSender(event);
    if (!isRecord(request)) throw new Error("Invalid drawer request");
    const authorizationRef = text(request.authorizationRef, 120);
    const reason = text(request.reason, 160);
    const now = Date.now();
    if (now - lastDrawerAttemptAt < 2000) throw new Error("Drawer command rate limited");
    const config = await readConfig();
    if (config.hardware.drawerMode !== "printer-driver" || !config.hardware.printerName) {
      throw new Error("Cash drawer requires a configured printer-driver job");
    }
    lastDrawerAttemptAt = now;
    const result = await printHtml(drawerPage(), authorizationRef, "drawer");
    return { ...result, reason, drawerState: "unknown" };
  });
  ipcMain.handle(IPC.SET_RUNTIME_STATE, (event, state) => {
    assertSender(event);
    if (!isRecord(state)) throw new Error("Invalid runtime state");
    runtimeState = {
      pending: Math.max(0, Math.min(999999, Math.trunc(Number(state.pending) || 0))),
      conflicts: Math.max(0, Math.min(999999, Math.trunc(Number(state.conflicts) || 0))),
    };
    return { accepted: true };
  });
}

function installSessionPolicy() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    // Browser-window navigation is guarded separately. This blocks accidental
    // file:// reads outside the packaged UI from subresources.
    if (details.resourceType !== "mainFrame" && details.url.startsWith("file:") && !details.url.startsWith(allowedAppUrl)) {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!app.isPackaged || !isAllowedAppNavigation(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    // The renderer is a Vite single-file document, so its own scripts/styles
    // are inline. Network access is limited to TLS backend/image endpoints.
    callback({ responseHeaders: {
      ...details.responseHeaders,
      "Content-Security-Policy": [
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self' https:",
      ],
    } });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: "ALYQ POS",
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f8fafc",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAppNavigation(url)) {
      void mainWindow.loadURL(url);
    } else if (safeExternalUrl(url)) {
      void openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url)) return;
    event.preventDefault();
    if (safeExternalUrl(url)) void openExternal(url).catch(() => {});
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    } else if (input.type === "keyDown" && input.key === "Escape" && mainWindow.isFullScreen()) {
      event.preventDefault();
      mainWindow.setFullScreen(false);
    }
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[desktop] renderer stopped", { reason: details.reason, exitCode: details.exitCode });
  });
  mainWindow.on("enter-full-screen", () => mainWindow?.webContents.send(IPC.FULLSCREEN_CHANGED, true));
  mainWindow.on("leave-full-screen", () => mainWindow?.webContents.send(IPC.FULLSCREEN_CHANGED, false));
  mainWindow.on("close", (event) => {
    if (quitting || runtimeState.pending + runtimeState.conflicts === 0) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["Keep ALYQ open", "Close safely"],
      defaultId: 0,
      cancelId: 0,
      title: "Pending offline operations",
      message: `${runtimeState.pending + runtimeState.conflicts} offline operation(s) still need attention.`,
      detail: "They are stored durably and will remain after restart. Keep ALYQ open to sync now, or close safely and resume later.",
      noLink: true,
    });
    if (choice === 0) event.preventDefault();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadURL(allowedAppUrl);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("eg.alyq.pos");
    const dev = process.env.ALYQ_DESKTOP_DEV_URL;
    if (dev && !app.isPackaged) {
      const parsed = new URL(dev);
      if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
        throw new Error("ALYQ_DESKTOP_DEV_URL must be a local HTTP origin");
      }
      allowedAppUrl = parsed.toString();
    } else {
      allowedAppUrl = pathToFileURL(path.resolve(__dirname, "..", "dist", "index.html")).toString();
    }
    installSessionPolicy();
    installIpcHandlers();
    await createWindow();
  }).catch((error) => {
    console.error("[desktop] startup failed", error instanceof Error ? error.message : error);
    app.exit(1);
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => { if (!mainWindow) void createWindow(); });
}
