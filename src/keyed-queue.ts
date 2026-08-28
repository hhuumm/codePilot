export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#tails.set(key, current);
    return current.finally(() => {
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    });
  }
}
