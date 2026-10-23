import assert from "node:assert/strict";
import {
  createWebPushController,
  type WebPushControllerDependencies,
} from "../services/webPush";
import { WEB_PUSH_SUBSCRIPTION_EVENT } from "../services/pwaBridge";
import type { PushController } from "../services/mobilePush";

const keyBytes = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, index) => (index * 17 + 11) % 256)]);
const publicKey = Buffer.from(keyBytes).toString("base64url");
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface BrowserMockOptions {
  permission?: NotificationPermission;
  userAgent?: string;
  standalone?: boolean;
  notifications?: boolean;
  existingSubscription?: boolean;
  serviceWorkerFails?: boolean;
}

function installBrowserMock(options: BrowserMockOptions = {}) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const listeners = new Map<string, Set<() => void>>();
  const permissionListeners = new Set<() => void>();
  const keyBuffer = Uint8Array.from(keyBytes).buffer;
  const notification = {
    permission: options.permission ?? "default" as NotificationPermission,
    requestPermission: async () => {
      mock.requestCalls += 1;
      if (mock.requestResult) notification.permission = mock.requestResult;
      return notification.permission;
    },
  };
  const makeSubscription = () => ({
    options: { applicationServerKey: keyBuffer },
    getKey: (name: string) => name === "applicationServerKey" ? keyBuffer : null,
    unsubscribe: async () => {
      mock.subscription = null;
      return true;
    },
  }) as unknown as PushSubscription;
  const registration = {
    pushManager: {
      getSubscription: async () => mock.subscription,
      subscribe: async () => {
        mock.subscribeCalls += 1;
        mock.subscription ??= makeSubscription();
        return mock.subscription;
      },
    },
  };
  const permissionStatus = {
    addEventListener: (type: string, listener: () => void) => {
      if (type === "change") permissionListeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "change") permissionListeners.delete(listener);
    },
  };
  const window = {
    isSecureContext: true,
    Notification: notification,
    PushManager: function PushManager() {},
    matchMedia: () => ({ matches: options.standalone ?? false }),
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const document = {
    documentElement: { lang: "en" },
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const navigator = {
    userAgent: options.userAgent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0",
    maxTouchPoints: 0,
    serviceWorker: {
      getRegistration: async () => {
        mock.getRegistrationCalls += 1;
        if (options.serviceWorkerFails) throw new Error("test-only worker failure");
        return registration;
      },
      register: async () => {
        if (options.serviceWorkerFails) throw new Error("test-only worker failure");
        return registration;
      },
    },
    permissions: {
      query: async () => permissionStatus,
    },
  };
  const mock = {
    subscription: null as PushSubscription | null,
    requestResult: null as NotificationPermission | null,
    requestCalls: 0,
    subscribeCalls: 0,
    getRegistrationCalls: 0,
    setPermission(permission: NotificationPermission) {
      notification.permission = permission;
      for (const listener of permissionListeners) listener();
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    permissionListenerCount() {
      return permissionListeners.size;
    },
    restore() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
  if (options.existingSubscription) mock.subscription = makeSubscription();
  for (const [key, value] of Object.entries({ window, document, navigator })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  originals.set("Notification", Object.getOwnPropertyDescriptor(globalThis, "Notification"));
  if (options.notifications === false) Reflect.deleteProperty(window, "Notification");
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: options.notifications === false ? undefined : notification,
  });
  return mock;
}

function dependencies(overrides: Partial<WebPushControllerDependencies> = {}) {
  return { publicKey, ...overrides };
}

async function withController(
  mock: ReturnType<typeof installBrowserMock>,
  deps: WebPushControllerDependencies,
  run: (controller: PushController) => Promise<void>,
) {
  let controller: PushController | null = null;
  try {
    controller = await createWebPushController(() => undefined, () => undefined, () => undefined, deps);
    await run(controller);
  } finally {
    if (controller) await controller.dispose();
    assert.equal(mock.permissionListenerCount(), 0, "permission listener disposed");
    assert.equal(mock.listenerCount(WEB_PUSH_SUBSCRIPTION_EVENT), 0, "subscription listener disposed");
    mock.restore();
  }
}

test("Windows Chrome preserves Default and repairs a stale Denied state while open", async () => {
  const mock = installBrowserMock();
  let deactivations = 0;
  await withController(mock, dependencies({
    deactivateServerSubscription: async () => { deactivations += 1; },
  }), async (controller) => {
    assert.equal(controller.state, "not_requested");
    assert.deepEqual(controller.diagnostics, {
      capability: "available", permission: "default", serviceWorker: "registered",
      subscription: "not_subscribed", configuration: "configured",
    });
    mock.requestResult = "denied";
    assert.equal(await controller.enable(), "denied");
    assert.equal(controller.diagnostics.permission, "denied");
    assert.equal(controller.diagnostics.subscription, "not_subscribed");
    assert.equal(deactivations, 1);

    mock.setPermission("default");
    await flush();
    assert.equal(controller.state, "not_requested");
    assert.equal(controller.diagnostics.permission, "default");

    mock.setPermission("granted");
    await flush();
    assert.equal(controller.state, "granted");
    assert.equal(controller.diagnostics.permission, "granted");
    assert.equal(controller.diagnostics.subscription, "not_subscribed");
  });
});

test("granted permission and a successful device subscription report independent registered states", async () => {
  const mock = installBrowserMock({ permission: "granted" });
  let registrations = 0;
  await withController(mock, dependencies({
    registerSubscription: async () => { registrations += 1; },
  }), async (controller) => {
    assert.equal(controller.state, "granted");
    assert.equal(controller.diagnostics.subscription, "not_subscribed");
    assert.equal(await controller.enable(), "registered");
    assert.equal(controller.diagnostics.permission, "granted");
    assert.equal(controller.diagnostics.subscription, "registered");
    assert.equal(mock.requestCalls, 0, "no redundant permission prompt");
    assert.equal(mock.subscribeCalls, 1);
    assert.ok(mock.getRegistrationCalls > 0, "uses a registration, not serviceWorker.ready");

    mock.emit(WEB_PUSH_SUBSCRIPTION_EVENT);
    await flush();
    assert.equal(controller.state, "registered");
    assert.equal(registrations, 2, "provider rotation re-registers the opaque subscription");
  });
});

test("a server registration error does not rewrite Granted and retry recovers", async () => {
  const mock = installBrowserMock({ permission: "granted", existingSubscription: true });
  let fail = true;
  let registrations = 0;
  await withController(mock, dependencies({
    registerSubscription: async () => {
      registrations += 1;
      if (fail) throw new Error("test-only registration failure");
    },
  }), async (controller) => {
    assert.equal(controller.state, "error");
    assert.equal(controller.diagnostics.permission, "granted");
    assert.equal(controller.diagnostics.subscription, "error");
    fail = false;
    assert.equal(await controller.enable(), "registered");
    assert.equal(controller.diagnostics.permission, "granted");
    assert.equal(controller.diagnostics.subscription, "registered");
    assert.equal(registrations, 2);
  });
});

test("missing or invalid public Web Push configuration is visible without exposing key material", async () => {
  for (const [configuredKey, expected] of [["", "missing"], ["not-a-valid-key", "invalid"]] as const) {
    const mock = installBrowserMock({ permission: "granted" });
    await withController(mock, { publicKey: configuredKey }, async (controller) => {
      assert.equal(controller.state, "error");
      assert.equal(controller.diagnostics.permission, "granted");
      assert.equal(controller.diagnostics.serviceWorker, "registered");
      assert.equal(controller.diagnostics.subscription, "error");
      assert.equal(controller.diagnostics.configuration, expected);
    });
  }
});

test("server public-key fallback subscribes without exposing private configuration and caches only success", async () => {
  const mock = installBrowserMock({ permission: "granted" });
  let loads = 0;
  let registrations = 0;
  await withController(mock, {
    loadPublicKey: async () => { loads += 1; return publicKey; },
    registerSubscription: async () => { registrations += 1; },
  }, async (controller) => {
    assert.equal(controller.diagnostics.configuration, "configured");
    assert.equal(await controller.enable(), "registered");
    assert.equal(loads, 1);
    mock.emit(WEB_PUSH_SUBSCRIPTION_EVENT);
    await flush();
    assert.equal(controller.state, "registered");
    assert.equal(registrations, 2);
    assert.equal(loads, 1, "a valid public key is reused across focus/provider refreshes");
  });
});

test("public configuration transport failure is explicit and a later retry can recover", async () => {
  const mock = installBrowserMock({ permission: "granted" });
  let unavailable = true;
  await withController(mock, {
    loadPublicKey: async () => {
      if (unavailable) throw new Error("test-only configuration outage");
      return publicKey;
    },
    registerSubscription: async () => undefined,
  }, async (controller) => {
    assert.equal(controller.state, "error");
    assert.equal(controller.diagnostics.permission, "granted");
    assert.equal(controller.diagnostics.configuration, "unavailable");
    unavailable = false;
    assert.equal(await controller.enable(), "registered");
    assert.equal(controller.diagnostics.configuration, "configured");
  });
});

test("Service Worker failure stays distinct from permission and subscription failure", async () => {
  const mock = installBrowserMock({ permission: "granted", serviceWorkerFails: true });
  await withController(mock, dependencies(), async (controller) => {
    assert.equal(controller.state, "error");
    assert.equal(controller.diagnostics.permission, "granted");
    assert.equal(controller.diagnostics.serviceWorker, "error");
    assert.equal(controller.diagnostics.subscription, "error");
    assert.equal(controller.diagnostics.configuration, "configured");
  });
});

test("ordinary iPhone Safari requires installation without requesting device permission", async () => {
  const mock = installBrowserMock({
    userAgent: "Mozilla/5.0 (iPhone) Version/26.0 Mobile/15E148 Safari/604.1",
  });
  await withController(mock, dependencies(), async (controller) => {
    assert.equal(controller.state, "install_required");
    assert.deepEqual(controller.diagnostics, {
      capability: "install_required", permission: "default", serviceWorker: "not_checked",
      subscription: "not_subscribed", configuration: "not_checked",
    });
    assert.equal(await controller.enable(), "install_required");
    assert.equal(mock.requestCalls, 0);
  });
});

test("unsupported browser state is explicit and remains separate from the internal inbox", async () => {
  const mock = installBrowserMock({ notifications: false });
  await withController(mock, dependencies(), async (controller) => {
    assert.equal(controller.state, "unsupported");
    assert.deepEqual(controller.diagnostics, {
      capability: "unsupported", permission: "unsupported", serviceWorker: "unsupported",
      subscription: "unsupported", configuration: "not_applicable",
    });
    assert.equal(await controller.enable(), "unsupported");
    assert.equal(mock.requestCalls, 0);
  });
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`, error);
    process.exitCode = 1;
    break;
  }
}
if (passed === tests.length) console.log(`${passed}/${tests.length} Web Push controller tests passed`);
