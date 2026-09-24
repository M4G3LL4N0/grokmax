/**
 * L0: in-process hot cache + request coalescing (duplicate in-flight suppression).
 */
import type { CacheItem } from "@grokmax/core";

interface HotEntry {
  item: CacheItem;
  at: number;
}

export class HotCache {
  private readonly map = new Map<string, HotEntry>();
  private readonly inFlight = new Map<string, Promise<CacheItem>>();
  private coalescedCount = 0;

  constructor(
    private readonly capacity = 256,
    private readonly ttlMs = 5 * 60 * 1000
  ) {}

  get(key: string): CacheItem | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return entry.item;
  }

  set(key: string, item: CacheItem): void {
    if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey) this.map.delete(oldestKey);
    }
    this.map.set(key, { item, at: Date.now() });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Deduplicate concurrent work: only one compute() runs per key.
   */
  async coalesce(key: string, compute: () => Promise<CacheItem>): Promise<CacheItem> {
    const pending = this.inFlight.get(key);
    if (pending) {
      this.coalescedCount += 1;
      return pending;
    }
    const p = compute().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  coalescedHits(): number {
    return this.coalescedCount;
  }

  size(): number {
    return this.map.size;
  }
}