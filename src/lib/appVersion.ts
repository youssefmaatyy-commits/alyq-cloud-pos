import packageInfo from "../../package.json";

/** Shared source version for web previews; Electron returns its packaged version at runtime. */
export const APP_VERSION = packageInfo.version;
