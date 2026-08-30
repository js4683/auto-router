export interface ProxySession {
  taskTarget: string | null;
  prevMessage?: string;
}

export interface ProxySessionStore {
  get(id: string): ProxySession;
  set(id: string, next: ProxySession): void;
}

export function memorySessions(): ProxySessionStore {
  const store = new Map<string, ProxySession>();
  return {
    get(id) {
      return store.get(id) ?? { taskTarget: null };
    },
    set(id, next) {
      store.set(id, next);
    },
  };
}
