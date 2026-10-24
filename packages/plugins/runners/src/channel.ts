/** The most characters one job may leave queued (delivered to the reader late): past this the job is failed instead of held in memory. */
export const MAX_QUEUED_CHARS = 32 * 1024 * 1024;

/** A single-consumer queue of strings that is also an async iterable: the stdout lines of one job, as the runner's frames deliver them. */
export class LineChannel implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private waiter: ((result: IteratorResult<string>) => void) | undefined;
  private ended = false;
  private queued = 0;

  constructor(private readonly maxQueuedChars: number = MAX_QUEUED_CHARS) {}

  /** Queue a line. Answers false when the queue is over its limit (the line is not queued): the caller fails the job. */
  push(line: string): boolean {
    if (this.ended) return true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ value: line, done: false });
      return true;
    }
    if (this.queued + line.length > this.maxQueuedChars) return false;
    this.queued += line.length;
    this.items.push(line);
    return true;
  }

  /** No more lines will come; what is queued is still delivered. */
  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          this.queued -= item.length;
          return Promise.resolve({ value: item, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
