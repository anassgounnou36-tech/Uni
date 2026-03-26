export class RouteEvalRpcGate {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number = 4) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.maxConcurrency <= 0) {
      return task();
    }
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.inFlight += 1;
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }
}
