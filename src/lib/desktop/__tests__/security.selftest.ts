import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync("desktop/main.mjs", "utf8");
const preload = fs.readFileSync("desktop/preload.mjs", "utf8");
const contracts = fs.readFileSync("desktop/contracts.mjs", "utf8");
const packageManifest = fs.readFileSync("package.json", "utf8");

const tests: Array<[string, () => void]> = [
  ["renderer is isolated, sandboxed and has no Node integration", () => {
    assert.match(main, /contextIsolation:\s*true/);
    assert.match(main, /nodeIntegration:\s*false/);
    assert.match(main, /sandbox:\s*true/);
    assert.match(main, /webSecurity:\s*true/);
  }],
  ["new windows and untrusted navigation are denied", () => {
    assert.match(main, /setWindowOpenHandler/);
    assert.match(main, /return \{ action: "deny" \}/);
    assert.match(main, /will-navigate/);
    assert.match(main, /will-attach-webview/);
  }],
  ["browser permissions and packaged content policy fail closed", () => {
    assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
    assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
    assert.match(main, /Content-Security-Policy/);
    assert.match(main, /object-src 'none'; frame-src 'none'/);
  }],
  ["IPC authenticates the one main-frame sender", () => {
    assert.match(main, /event\.sender !== mainWindow\.webContents/);
    assert.match(main, /event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
    assert.ok((main.match(/assertSender\(event\)/g) ?? []).length >= 12);
  }],
  ["preload has no arbitrary IPC or Node/filesystem/process surface", () => {
    assert.doesNotMatch(preload, /ipcRenderer\.(send|sendSync|once)\s*\(/);
    assert.match(preload, /ipcRenderer\.on\(IPC\.FULLSCREEN_CHANGED/);
    assert.doesNotMatch(preload, /ipcRenderer\.on\((?!IPC\.FULLSCREEN_CHANGED)/);
    assert.doesNotMatch(preload, /node:(fs|child_process|process)|\bexec\s*\(|\bspawn\s*\(/);
    assert.match(preload, /contextBridge\.exposeInMainWorld\("alyqDesktop", api\)/);
    assert.match(preload, /Object\.freeze/);
  }],
  ["printer HTML is bounded and active content is removed", () => {
    assert.match(main, /MAX_RECEIPT_HTML_BYTES/);
    assert.match(main, /replace\(\/<script/);
    assert.match(main, /javascript:\s*false/);
    assert.match(main, /default-src \\'none\\'/);
  }],
  ["cash drawer accepts no executable or raw-byte command", () => {
    assert.doesNotMatch(main, /child_process|powershell|cmd\.exe|execFile|spawn\s*\(/i);
    assert.match(main, /drawerMode !== "printer-driver"/);
    assert.match(main, /Drawer command rate limited/);
  }],
  ["IPC names are fixed application constants", () => {
    assert.match(contracts, /Object\.freeze/);
    assert.doesNotMatch(preload, /invoke\((?!IPC\.)/);
  }],
  ["renderer-wide configuration redacts the register credential", () => {
    assert.match(main, /function publicConfig/);
    assert.match(main, /GET_CONFIG[\s\S]*publicConfig\(await readConfig\(\)\)/);
    assert.match(preload, /GET_REGISTER_BINDING/);
  }],
  ["packaged shell sources contain no privileged secret class", () => {
    const packagedShell = `${packageManifest}\n${main}\n${preload}\n${contracts}`;
    assert.doesNotMatch(packagedShell, /SUPABASE_SERVICE_ROLE|DATABASE_PASSWORD|MANAGER_PIN_HASH|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/i);
    assert.doesNotMatch(packageManifest, /\.env|credentials|private[-_]?key/i);
  }],
];

for (const [name, run] of tests) {
  run();
  console.log(`  ✓ ${name}`);
}
console.log(`\n${tests.length}/${tests.length} desktop security tests passed`);
