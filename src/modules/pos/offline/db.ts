/**
 * POS offline database — a thin, typed wrapper around IndexedDB.
 *
 * IndexedDB, not localStorage, is the primary store: it is the browser's
 * real transactional database (structured clone, per-store keys, survives a
 * refresh and a browser restart the same way any other site data does),
 * where `localStorage` is a synchronous string blob that was never meant to
 * hold a growing queue of financial records.
 *
 * The interface below (`OfflineDb`) is deliberately small — get/getAll/put/
 * putMany/delete/clear per named store — so it can have TWO implementations
 * that behave identically to every caller:
 *
 *   · `IndexedDbBackend`  — real `indexedDB`, used in every browser this app
 *     ships to.
 *   · `MemoryBackend`     — an in-memory Map, used automatically when
 *     `indexedDB` is not present (jsdom in the test suites has no IndexedDB
 *     implementation). Logic tests exercise the exact same outbox/cache code
 *     paths against this backend; only the persistence-across-reload
 *     property itself needs a real browser, which the Chromium script in
 *     this module's sibling test covers.
 *
 * Every store keeps its records under a single primary key (see
 * `STORE_KEY_PATH`), matching `./types.ts`.
 */
import type { OfflineStoreName } from "./types";

const DB_NAME = "alyq-pos-offline";
const DB_VERSION = 1;

const STORE_KEY_PATH: Record<OfflineStoreName, string> = {
  cached_products: "id",
  cached_variants: "id",
  offline_sales: "id",
  offline_sale_lines: "id",
  sync_outbox: "client_ref",
  sync_metadata: "key",
};

export interface OfflineDb {
  get<T>(store: OfflineStoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: OfflineStoreName): Promise<T[]>;
  put<T>(store: OfflineStoreName, value: T): Promise<void>;
  putMany<T>(store: OfflineStoreName, values: T[]): Promise<void>;
  delete(store: OfflineStoreName, key: string): Promise<void>;
  clear(store: OfflineStoreName): Promise<void>;
}

/** Real IndexedDB — what every shipped browser session uses. */
class IndexedDbBackend implements OfflineDb {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of Object.keys(STORE_KEY_PATH) as OfflineStoreName[]) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: STORE_KEY_PATH[name] });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return this.dbPromise;
  }

  private async tx<T>(store: OfflineStoreName, mode: IDBTransactionMode, run: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const os = transaction.objectStore(store);
      const request = run(os);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  }

  async get<T>(store: OfflineStoreName, key: string): Promise<T | undefined> {
    return this.tx<T | undefined>(store, "readonly", (os) => os.get(key));
  }

  async getAll<T>(store: OfflineStoreName): Promise<T[]> {
    const result = await this.tx<T[]>(store, "readonly", (os) => os.getAll());
    return result ?? [];
  }

  async put<T>(store: OfflineStoreName, value: T): Promise<void> {
    await this.tx(store, "readwrite", (os) => os.put(value));
  }

  async putMany<T>(store: OfflineStoreName, values: T[]): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(store, "readwrite");
      const os = transaction.objectStore(store);
      for (const value of values) os.put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB bulk write failed"));
    });
  }

  async delete(store: OfflineStoreName, key: string): Promise<void> {
    await this.tx(store, "readwrite", (os) => os.delete(key));
  }

  async clear(store: OfflineStoreName): Promise<void> {
    await this.tx(store, "readwrite", (os) => os.clear());
  }
}

/**
 * In-memory fallback — used automatically when `indexedDB` is unavailable
 * (the jsdom test environment; a browser context that has disabled it). Not
 * persistent, by construction: there is nothing durable to fall back to in
 * that environment, so the till still works for the current tab session
 * rather than refusing to run.
 */
class MemoryBackend implements OfflineDb {
  private stores = new Map<OfflineStoreName, Map<string, unknown>>();

  private storeFor(name: OfflineStoreName): Map<string, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  private keyOf(store: OfflineStoreName, value: unknown): string {
    return (value as Record<string, string>)[STORE_KEY_PATH[store]];
  }

  async get<T>(store: OfflineStoreName, key: string): Promise<T | undefined> {
    return this.storeFor(store).get(key) as T | undefined;
  }

  async getAll<T>(store: OfflineStoreName): Promise<T[]> {
    return [...this.storeFor(store).values()] as T[];
  }

  async put<T>(store: OfflineStoreName, value: T): Promise<void> {
    this.storeFor(store).set(this.keyOf(store, value), value);
  }

  async putMany<T>(store: OfflineStoreName, values: T[]): Promise<void> {
    const map = this.storeFor(store);
    for (const value of values) map.set(this.keyOf(store, value), value);
  }

  async delete(store: OfflineStoreName, key: string): Promise<void> {
    this.storeFor(store).delete(key);
  }

  async clear(store: OfflineStoreName): Promise<void> {
    this.storeFor(store).clear();
  }
}

let singleton: OfflineDb | null = null;

/** True when a real, persistent IndexedDB is available in this runtime. */
export function hasPersistentOfflineStorage(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * The one offline database instance for this tab. Backend choice happens
 * once, lazily, so importing this module has no side effects in a
 * non-browser context (SSR/build tooling never touches `indexedDB`).
 */
export function getOfflineDb(): OfflineDb {
  if (!singleton) {
    singleton = hasPersistentOfflineStorage() ? new IndexedDbBackend() : new MemoryBackend();
  }
  return singleton;
}

/** Test-only: force a fresh backend (e.g. between selftest cases). */
export function resetOfflineDbForTests(): void {
  singleton = null;
}
