export type DesktopPaperWidth = 58 | 80;
export type DesktopDrawerMode = "none" | "printer-driver";

export interface DesktopAppContext {
  runtime: "electron";
  platform: string;
  arch: string;
  version: string;
  build: string;
  packaged: boolean;
  fullscreen: boolean;
  installationId: string;
}

export interface DesktopHardwareConfig {
  printerName: string | null;
  paperWidthMm: DesktopPaperWidth;
  copies: number;
  silentPrint: boolean;
  autoPrintAfterSale: boolean;
  drawerMode: DesktopDrawerMode;
  autoOpenCashDrawer: boolean;
}

export interface DesktopRegisterSnapshot {
  id: string;
  code: string;
  name: string;
  branchId: string;
  branchName: string | null;
  active: boolean;
  validatedAt: string;
}

/** Stored only in Electron's per-user configuration, never copied to diagnostics. */
export interface DesktopRegisterBinding {
  registerId: string;
  installationId: string;
  credential: string;
  snapshot: DesktopRegisterSnapshot;
}

export type DesktopPublicRegisterBinding = Omit<DesktopRegisterBinding, "credential">;

/** Renderer-wide configuration deliberately excludes the register credential. */
export interface DesktopConfig {
  schemaVersion: 1;
  installationId: string;
  hardware: DesktopHardwareConfig;
  registerBinding: DesktopPublicRegisterBinding | null;
}

export interface DesktopPrinterInfo {
  name: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  /** Driver-reported integer only; not interpreted as physical readiness. */
  driverStatus: number | null;
}

export interface DesktopPrintResult {
  submitted: true;
  /** False because OS-spool acceptance does not prove paper was produced. */
  confirmedPrinted: false;
  printerName: string;
  paperWidthMm: DesktopPaperWidth;
  reference: string;
  purpose: "receipt" | "test" | "drawer";
}

export interface ALYQDesktopApi {
  getContext(): Promise<DesktopAppContext>;
  setFullscreen(enabled: boolean): Promise<{ fullscreen: boolean }>;
  onFullscreenChanged(callback: (enabled: boolean) => void): () => void;
  openExternal(url: string): Promise<boolean>;
  getConfig(): Promise<DesktopConfig>;
  /** Narrow credential-bearing call used only by the register RPC adapter. */
  getRegisterBinding(): Promise<DesktopRegisterBinding | null>;
  saveHardwareConfig(config: DesktopHardwareConfig): Promise<DesktopHardwareConfig>;
  saveRegisterBinding(binding: DesktopRegisterBinding): Promise<{ saved: true; registerId: string }>;
  clearRegisterBinding(): Promise<{ cleared: true }>;
  listPrinters(): Promise<DesktopPrinterInfo[]>;
  printReceipt(request: { html: string; reference: string }): Promise<DesktopPrintResult>;
  testPrint(request?: Record<string, never>): Promise<DesktopPrintResult>;
  kickDrawer(request: { authorizationRef: string; reason: string }): Promise<DesktopPrintResult & { drawerState: "unknown" }>;
  setRuntimeState(state: { pending: number; conflicts: number }): Promise<{ accepted: true }>;
}

declare global {
  interface Window {
    alyqDesktop?: ALYQDesktopApi;
  }
}
