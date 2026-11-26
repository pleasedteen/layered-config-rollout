import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type MutationOutcome<T, R> = {
  result: R;
  next?: T;
};

/**
 * Tiny durable JSON store.
 *
 * Writes are serialized and use temp-file + rename so readers either observe
 * the old complete snapshot or the new complete snapshot, never a partial file.
 */
export class AtomicJsonStore<T extends object> {
  private state: T | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(public readonly filePath: string) {}

  async load(): Promise<T> {
    if (this.state) return this.state;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Error(`persistent state does not exist yet: ${this.filePath}`);
    }
    return this.state;
  }

  async initialize(factory: () => T): Promise<T> {
    try {
      return await this.load();
    } catch (error) {
      if ((error as Error).message.startsWith('persistent state does not exist')) {
        const initial = factory();
        await this.persist(initial);
        this.state = initial;
        return initial;
      }
      throw error;
    }
  }

  get(): T {
    if (!this.state) throw new Error(`store not loaded: ${this.filePath}`);
    return this.state;
  }

  /**
   * Runs `fn` against a deep clone. If `next` is returned it is atomically
   * persisted and then swapped into memory. The deep clone prevents async
   * readers from seeing a half-mutated snapshot before the rename.
   */
  mutate<R>(fn: (current: T) => MutationOutcome<T, R>): Promise<R> {
    const operation = this.writeChain.then(async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const outcome = fn(draft);
      if (outcome.next !== undefined) {
        await this.persist(outcome.next);
        this.state = outcome.next;
      }
      return outcome.result;
    });

    // Keep the chain alive even if one operation fails; callers still get the
    // rejection from `operation`.
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async persist(value: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
