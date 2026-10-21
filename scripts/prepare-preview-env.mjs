#!/usr/bin/env node
/**
 * When building a Vercel Preview deployment (`VERCEL_ENV === "preview"`),
 * resolve the isolated Supabase Staging public configuration so preview URLs
 * never read or write the Production Supabase project (`zeaacjmmvyuwzmkgxhqf`).
 * Production builds (`VERCEL_ENV === "production"`) and local/CI builds are
 * untouched.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".staging-preview-env.json");

if (process.env.VERCEL_ENV !== "preview") {
  if (fs.existsSync(target)) fs.unlinkSync(target);
  process.exit(0);
}

const endpoint = "https://bubvtxctwqsfohrkenej.supabase.co/functions/v1/staging-client-config";
try {
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch staging preview config (${response.status})`);
  }
  const cfg = await response.json();
  if (!cfg?.url || !cfg?.anonKey) {
    throw new Error("Incomplete staging preview config payload");
  }
  fs.writeFileSync(target, JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey }), { mode: 0o600 });
  console.log(`Configured Vercel Preview build for Staging host: ${new URL(cfg.url).host}`);
} catch (err) {
  console.warn(`Staging preview config fetch failed (${err instanceof Error ? err.message : String(err)}); isolating preview from Production.`);
  fs.writeFileSync(target, JSON.stringify({ url: "", anonKey: "" }), { mode: 0o600 });
}
