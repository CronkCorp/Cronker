/**
 * Tells the clients watching a Workspace that something in it changed. Callers report a
 * change only once its transaction has committed, so nothing is pushed for a change that
 * failed. Each watcher works out for itself what the change means for its client.
 */
export interface Live {
  /** Watches a Workspace until the returned function is called. */
  watch(workspaceId: string, watcher: Watcher): () => void;
  /** Reports a committed change to the Workspace. */
  changed(workspaceId: string): void;
  /** Ends every watch, as Cronk shuts down. */
  endAll(): void;
}

export interface Watcher {
  /** Called after each committed change to the Workspace. */
  changed(): void;
  /** Called when Cronk ends the watch. */
  end(): void;
}

export function createLive(): Live {
  const watchers = new Map<string, Set<Watcher>>();
  return {
    watch(workspaceId, watcher) {
      const set = watchers.get(workspaceId) ?? new Set();
      watchers.set(workspaceId, set);
      set.add(watcher);
      return () => {
        set.delete(watcher);
        if (set.size === 0) watchers.delete(workspaceId);
      };
    },
    changed(workspaceId) {
      for (const watcher of [...(watchers.get(workspaceId) ?? [])]) watcher.changed();
    },
    endAll() {
      for (const set of [...watchers.values()]) for (const watcher of [...set]) watcher.end();
    },
  };
}
