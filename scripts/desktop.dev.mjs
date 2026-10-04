import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";

const host = "127.0.0.1";
const port = Number(process.env.ALYQ_DESKTOP_DEV_PORT || 5173);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronBinary = process.platform === "win32"
  ? path.join("node_modules", ".bin", "electron.cmd")
  : path.join("node_modules", ".bin", "electron");
const children = new Set();
let stopping = false;

function start(command, args, env = process.env) {
  const child = spawn(command, args, { stdio: "inherit", env });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping && code !== 0) stop(code || 1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

function waitForPort(timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host, port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error("Vite did not start in time"));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start(npmCommand, ["run", "dev", "--", "--host", host, "--port", String(port), "--strictPort"]);
try {
  await waitForPort();
  const electron = start(electronBinary, ["."], {
    ...process.env,
    ALYQ_DESKTOP_DEV_URL: `http://${host}:${port}/`,
  });
  electron.once("exit", (code) => stop(code || 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
}
