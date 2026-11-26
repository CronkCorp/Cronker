import { afterEach, describe, expect, it, vi } from "vitest";
import { keepTicketsView, onTicketsView, storedTicketsView } from "../../web/src/storage.js";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("the Tickets view", () => {
  it("is the board on a browser where none was chosen", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(storedTicketsView()).toBe("board");
  });

  it("keeps the List, and forgets it again for the board", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    keepTicketsView("list");
    expect(storedTicketsView()).toBe("list");
    keepTicketsView("board");
    expect(storedTicketsView()).toBe("board");
    expect(storage.length).toBe(0);
  });

  it("tells listeners only when the view changes", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const listener = vi.fn();
    const stop = onTicketsView(listener);
    keepTicketsView("list");
    keepTicketsView("list");
    keepTicketsView("board");
    stop();
    keepTicketsView("list");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is the board when storage can't be read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => keepTicketsView("list")).not.toThrow();
    expect(storedTicketsView()).toBe("board");
  });
});
