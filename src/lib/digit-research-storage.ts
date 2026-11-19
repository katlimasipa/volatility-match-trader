const DATABASE_NAME = "thdpst-digit-research-v1";
const STORE_NAME = "records";
const FALLBACK_PREFIX = "thdpst-digit-research:storage-fallback:v1:";

interface ResearchRecord {
  key: string;
  value: unknown;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  databasePromise = new Promise((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    try {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => request.result.close();
        finish(request.result);
      };
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
  return databasePromise;
}

function readFallback(key: string): unknown | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(`${FALLBACK_PREFIX}${key}`);
    return value === null ? null : (JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function writeFallback(key: string, value: unknown): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(`${FALLBACK_PREFIX}${key}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export async function readResearchValue<T>(key: string): Promise<T | null> {
  const database = await openDatabase();
  if (database) {
    try {
      const stored = await new Promise<ResearchRecord | undefined>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(key) as IDBRequest<
          ResearchRecord | undefined
        >;
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (stored) return stored.value as T;
    } catch {
      // Try the small local-storage fallback if IndexedDB is temporarily unavailable.
    }
  }
  return readFallback(key) as T | null;
}

export async function writeResearchValue(key: string, value: unknown): Promise<boolean> {
  const database = await openDatabase();
  if (database) {
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({ key, value } satisfies ResearchRecord);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(`${FALLBACK_PREFIX}${key}`);
        } catch {
          // The IndexedDB write is already durable.
        }
      }
      return true;
    } catch {
      // Fall through to local storage if the database write fails.
    }
  }
  return writeFallback(key, value);
}

export async function deleteResearchValue(key: string): Promise<void> {
  const database = await openDatabase();
  if (database) {
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch {
      // Still clear the fallback below.
    }
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`${FALLBACK_PREFIX}${key}`);
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }
}
