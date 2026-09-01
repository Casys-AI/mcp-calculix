interface SessionEventPayload {
  readonly data: unknown;
}

export interface SessionEventSource {
  on(
    action: string,
    handler: (payload: SessionEventPayload) => void,
  ): () => void;
}

export interface BufferedSessionReceiver<T> {
  activate(apply: (value: T) => void | Promise<void>): Promise<void>;
  drain(): Promise<void>;
  dispose(): void;
}

/**
 * Local compatibility shim for mcp-view's pre-connect viewer-session FIFO.
 * Supersedable: `createMcpApp` exposes `viewerSession` since @casys/mcp-view
 * 0.9.x. Replacing this shim is a lifecycle change, not a deletion — the
 * pre-connect buffering below must keep working through the swap.
 */
export function createBufferedSessionReceiver<T>(options: {
  readonly events: SessionEventSource;
  readonly action: string;
  readonly map: (value: unknown) => T | Promise<T>;
  readonly onError: (error: unknown) => void;
}): BufferedSessionReceiver<T> {
  const pending: unknown[] = [];
  let apply: ((value: T) => void | Promise<void>) | undefined;
  let queue = Promise.resolve();
  let disposed = false;

  const enqueue = (value: unknown): void => {
    queue = queue.then(async () => {
      if (!apply || disposed) return;
      try {
        const mapped = await options.map(value);
        if (!disposed) await apply(mapped);
      } catch (error) {
        options.onError(error);
      }
    });
  };

  const drain = async (): Promise<void> => {
    while (true) {
      const observed = queue;
      await observed;
      if (observed === queue) return;
    }
  };

  const off = options.events.on(options.action, (payload) => {
    if (disposed) return;
    if (!apply) pending.push(payload.data);
    else enqueue(payload.data);
  });

  return {
    async activate(nextApply): Promise<void> {
      if (disposed) throw new Error("BufferedSessionReceiver is disposed.");
      if (apply) {
        throw new Error("BufferedSessionReceiver.activate may only run once.");
      }
      apply = nextApply;
      for (const value of pending.splice(0)) enqueue(value);
      await drain();
    },
    drain,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending.splice(0);
      off();
    },
  };
}
