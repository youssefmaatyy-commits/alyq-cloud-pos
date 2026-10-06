import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SESSION_RESUME_MIN_BACKGROUND_MS,
  shouldRevalidateAfterWake,
  subscribeSessionWakeEvents,
  type SessionWakeEvent,
} from "../services/sessionLifecycle";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

class FakeTarget {
  private readonly listeners = new Map<string, Set<() => void>>();
  visibilityState: DocumentVisibilityState = "visible";

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : () => listener.handleEvent(new Event(name));
    const bucket = this.listeners.get(name) ?? new Set<() => void>();
    bucket.add(callback as () => void);
    this.listeners.set(name, bucket);
  }
  removeEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(name)?.delete(listener as () => void);
  }
  emit(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

test("online and native foreground always request one authoritative recovery", () => {
  const farFuture = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(shouldRevalidateAfterWake({ kind: "online", backgroundMs: null }, farFuture), true);
  assert.equal(shouldRevalidateAfterWake({ kind: "native_foreground", backgroundMs: 1 }, farFuture), true);
});

test("browser focus is thresholded unless the access token needs refresh", () => {
  const now = Date.now();
  assert.equal(
    shouldRevalidateAfterWake(
      { kind: "browser_foreground", backgroundMs: 5_000 },
      new Date(now + 3_600_000).toISOString(),
      now,
    ),
    false,
  );
  assert.equal(
    shouldRevalidateAfterWake(
      { kind: "browser_foreground", backgroundMs: SESSION_RESUME_MIN_BACKGROUND_MS },
      new Date(now + 3_600_000).toISOString(),
      now,
    ),
    true,
  );
  assert.equal(
    shouldRevalidateAfterWake(
      { kind: "browser_foreground", backgroundMs: 5_000 },
      new Date(now - 1).toISOString(),
      now,
    ),
    true,
    "expired access token refreshes instead of logging out",
  );
});

test("visibility plus focus emits one deduplicated Web/Desktop wake", () => {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  let now = 1_000;
  const seen: SessionWakeEvent[] = [];
  const unsubscribe = subscribeSessionWakeEvents((event) => seen.push(event), {
    window: win,
    document: doc,
    now: () => now,
  });

  doc.visibilityState = "hidden";
  doc.emit("visibilitychange");
  now += 70_000;
  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  win.emit("focus");

  assert.deepEqual(seen, [{ kind: "browser_foreground", backgroundMs: 70_000 }]);
  unsubscribe();
});

test("Capacitor background/foreground emits the same canonical wake", async () => {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  let now = 10_000;
  let nativeListener: ((active: boolean) => void) | null = null;
  let networkListener: ((connected: boolean) => void) | null = null;
  let removed = 0;
  const seen: SessionWakeEvent[] = [];
  const unsubscribe = subscribeSessionWakeEvents((event) => seen.push(event), {
    window: win,
    document: doc,
    now: () => now,
    native: {
      active: true,
      async addListener(listener: (active: boolean) => void) {
        nativeListener = listener;
        return { async remove() { removed += 1; } };
      },
      async addNetworkListener(listener: (connected: boolean) => void) {
        networkListener = listener;
        return { async remove() { removed += 1; } };
      },
    },
  });
  await Promise.resolve();
  assert.ok(nativeListener);
  assert.ok(networkListener);
  (nativeListener as (active: boolean) => void)(false);
  now += 5_000;
  // A WebView visibility callback can arrive before Capacitor's callback. It
  // still carries native semantics, so even a short mobile foreground recovers.
  doc.emit("visibilitychange");
  (nativeListener as (active: boolean) => void)(true);
  now += 300;
  (networkListener as (connected: boolean) => void)(true);
  assert.deepEqual(seen, [
    { kind: "native_foreground", backgroundMs: 5_000 },
    { kind: "online", backgroundMs: null },
  ]);
  unsubscribe();
  await Promise.resolve();
  assert.equal(removed, 2);
});

test("temporary push/health failures are isolated from the auth lifecycle", () => {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const seen: SessionWakeEvent[] = [];
  const unsubscribe = subscribeSessionWakeEvents((event) => seen.push(event), {
    window: win,
    document: doc,
  });
  // These failures are handled by their own modules. No auth signal is emitted,
  // and there is intentionally no health/push channel in the session adapter.
  void Promise.reject(new Error("health probe failed")).catch(() => undefined);
  void Promise.reject(new Error("push registration failed")).catch(() => undefined);
  assert.deepEqual(seen, []);
  unsubscribe();

  const providerSource = fs.readFileSync("src/lib/auth/hooks/AuthProvider.tsx", "utf8");
  assert.equal(/healthService|probeSystemBackend|mobilePush|createPushController/.test(providerSource), false);
  const mobileSource = fs.readFileSync("src/modules/mobile/MobileApp.tsx", "utf8");
  assert.match(mobileSource, /createPushController[\s\S]*\.catch\(\(\) =>/);
  assert.equal(/\.catch\([\s\S]{0,120}auth\.signOut/.test(mobileSource), false);
});

let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed}/${tests.length} session lifecycle tests passed.\n`);
