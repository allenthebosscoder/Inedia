export function installChromeStorageMock(): void {
  const store: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Promise.resolve(Object.fromEntries(keys.filter((item) => item in store).map((item) => [item, store[item]])));
        },
        set: (items: Record<string, unknown>) => {
          Object.assign(store, items);
          return Promise.resolve();
        },
      },
    },
  };
}
