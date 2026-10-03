import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "eg.alyq.management",
  appName: "ALYQ Mobile",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "https",
    iosScheme: "alyq",
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
