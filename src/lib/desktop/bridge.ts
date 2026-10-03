import type {
  ALYQDesktopApi,
  DesktopAppContext,
  DesktopConfig,
  DesktopHardwareConfig,
  DesktopPrinterInfo,
  DesktopRegisterBinding,
} from "./types";

export type { DesktopAppContext, DesktopConfig, DesktopHardwareConfig, DesktopPrintResult, DesktopPrinterInfo, DesktopRegisterBinding } from "./types";

/** Native behavior is optional and isolated here; business modules stay shared. */
export function desktopApi(): ALYQDesktopApi | null {
  return typeof window !== "undefined" && window.alyqDesktop ? window.alyqDesktop : null;
}

export function isDesktopRuntime(): boolean {
  return desktopApi() !== null;
}

export async function getDesktopContext(): Promise<DesktopAppContext | null> {
  return desktopApi()?.getContext() ?? null;
}

export async function getDesktopConfig(): Promise<DesktopConfig | null> {
  return desktopApi()?.getConfig() ?? null;
}

export async function saveDesktopHardwareConfig(config: DesktopHardwareConfig): Promise<DesktopHardwareConfig> {
  const api = desktopApi();
  if (!api) throw new Error("Desktop hardware is unavailable in the web application");
  return api.saveHardwareConfig(config);
}

export async function saveDesktopRegisterBinding(binding: DesktopRegisterBinding): Promise<void> {
  const api = desktopApi();
  if (!api) throw new Error("A desktop installation is required to bind a register");
  await api.saveRegisterBinding(binding);
}

export async function clearDesktopRegisterBinding(): Promise<void> {
  const api = desktopApi();
  if (!api) return;
  await api.clearRegisterBinding();
}

export async function listDesktopPrinters(): Promise<DesktopPrinterInfo[]> {
  return desktopApi()?.listPrinters() ?? [];
}
