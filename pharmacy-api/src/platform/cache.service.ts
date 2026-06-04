import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

/**
 * Redis cache/coordination service (Plan §0: roles R-1/R-2/R-3 ONLY).
 * HARD RULE: Redis is never a source of truth — the outbox, idempotency keys,
 * ledger, and stock all live in Postgres. With REDIS_URL unset or the server
 * unreachable, every method degrades to a safe no-op and the API stays correct
 * (PRD §2: rural connectivity; no new hard dependency).
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly log = new Logger(CacheService.name);
  private client: Redis | null = null;
  private healthy = false;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.log.warn("REDIS_URL not set — running in degraded mode (no cache, no rate limit, JWT-only overrides)");
      return;
    }
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    this.client.on("ready", () => { this.healthy = true; this.log.log("Redis connected"); });
    this.client.on("error", (e) => {
      if (this.healthy) this.log.error(`Redis error — degrading gracefully: ${e.message}`);
      this.healthy = false;
    });
  }

  get enabled(): boolean {
    return this.healthy && this.client !== null;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.enabled) return null;
    try {
      const raw = await this.client!.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { return null; }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.enabled) return;
    try { await this.client!.set(key, JSON.stringify(value), "EX", ttlSeconds); } catch { /* degrade */ }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.enabled || keys.length === 0) return;
    try { await this.client!.del(...keys); } catch { /* degrade */ }
  }

  /** Invalidate a key family, e.g. stock:{pharmacyId}:* (SCAN-based; small keyspaces only). */
  async delPrefix(prefix: string): Promise<void> {
    if (!this.enabled) return;
    try {
      let cursor = "0";
      do {
        const [next, keys] = await this.client!.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
        cursor = next;
        if (keys.length) await this.client!.del(...keys);
      } while (cursor !== "0");
    } catch { /* degrade */ }
  }

  /** R-2: fixed-window counter. Returns current count, or null in degraded mode (limit open). */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number | null> {
    if (!this.enabled) return null;
    try {
      const n = await this.client!.incr(key);
      if (n === 1) await this.client!.expire(key, ttlSeconds);
      return n;
    } catch { return null; }
  }

  /**
   * R-1: atomic single-use consume (GETDEL). Returns the stored value once; second
   * caller gets null. Degraded mode returns undefined → caller falls back to JWT-only.
   */
  async consume(key: string): Promise<string | null | undefined> {
    if (!this.enabled) return undefined;
    try { return await this.client!.getdel(key); } catch { return undefined; }
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.enabled) return;
    try { await this.client!.set(key, value, "EX", ttlSeconds); } catch { /* degrade */ }
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
  }
}
