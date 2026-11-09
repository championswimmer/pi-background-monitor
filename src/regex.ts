import { Worker } from "node:worker_threads";

// A fixed worker program keeps untrusted regex execution off the broker's event loop.
// Only data, never executable source, is sent in messages. The small cache avoids
// recompiling on every snapshot without retaining an unbounded number of patterns.
const program = `
const { parentPort } = require('node:worker_threads');
const cache = new Map();
parentPort.on('message', ({ pattern, flags, text }) => {
  try {
    const key = JSON.stringify([pattern, flags]);
    let regex = cache.get(key);
    if (!regex) {
      regex = new RegExp(pattern, flags);
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(key, regex);
    }
    parentPort.postMessage({ matched: text === undefined ? false : regex.test(text) });
  } catch {
    parentPort.postMessage({ error: 'Invalid regex syntax' });
  }
});`;

/** Serialized by the broker. A timed-out worker is discarded, never reused. */
export class RegexMatcher {
  private worker?: Worker;

  async test(pattern: string, flags: string, text?: string): Promise<boolean> {
    let worker = this.worker;
    if (!worker) {
      worker = new Worker(program, {
        eval: true,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
      });
      this.worker = worker;
      const created = worker;
      created.on("error", () => {
        if (this.worker === created) this.worker = undefined;
      });
      created.on("exit", () => {
        if (this.worker === created) this.worker = undefined;
      });
    }
    worker.ref();
    const current = worker;
    return new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        current.off("message", onMessage);
        current.off("error", onError);
        current.off("exit", onExit);
        current.off("online", onOnline);
      };
      const fail = (message: string) => {
        cleanup();
        if (this.worker === current) this.worker = undefined;
        void current.terminate();
        reject(new Error(message));
      };
      const onMessage = (result: { matched?: boolean; error?: string }) => {
        cleanup();
        current.unref();
        if (result.error) reject(new Error("Invalid regex syntax"));
        else if (typeof result.matched === "boolean") resolve(result.matched);
        else fail("Regex worker unavailable");
      };
      const onError = () => fail("Regex worker unavailable");
      const onExit = () => fail("Regex worker unavailable");
      current.once("message", onMessage);
      current.once("error", onError);
      current.once("exit", onExit);
      // Allow startup separately from the matching budget.
      const dispatch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail("Regex evaluation timed out"), 200);
        current.postMessage({ pattern, flags, text });
      };
      const onOnline = () => {
        this.ready = current;
        dispatch();
      };
      timer = setTimeout(() => fail("Regex worker unavailable"), 2000);
      if (this.ready === current) dispatch();
      else current.once("online", onOnline);
    });
  }
  private ready?: Worker;

  close() {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    if (worker) void worker.terminate();
  }
}
