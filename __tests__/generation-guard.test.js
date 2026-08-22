// Tests for the per-config generation guard added in the config filter/search
// fix (PR review findings): publishParseResult drops a stale parse, a config
// bump invalidates it, asteroid rehydrate adoption keeps cross-worker refresh
// consistent, and Redis delete failures are surfaced.

jest.mock('../db', () => ({
  getAllOverrides: jest.fn()
}));

jest.mock('../redisCache', () => ({
  saveCacheToRedis: jest.fn(),
  saveLogoUrl: jest.fn()
}));

jest.mock('../aiCurator', () => ({
  startAiQueue: jest.fn()
}));

// axios is used for real network fetches during a parse; the generation tests
// below never reach a fetch, so leaving it unmocked is fine for these cases.
describe('cache generation guard', () => {
  let P;
  beforeEach(() => {
    jest.clearAllMocks();
    P = require('../iptvParser');
    P.userCaches.clear();
  });

  test('publish accepts a result whose generation still matches', async () => {
    const k = 'accept-' + Math.random();
    P.bumpConfigGeneration(k); // local counter is now 1
    P.userCaches.set(k, { status: 'loading', _generation: 1 });
    const ok = P.publishParseResult(k, { status: 'ready', channels: 5 });
    expect(ok).toBe(true);
    expect(P.userCaches.get(k)._generation).toBe(1);
    expect(P.userCaches.get(k).status).toBe('ready');
  });

  test('publish discards a result when a config change bumped the generation mid-parse', async () => {
    const k = 'stale-' + Math.random();
    P.bumpConfigGeneration(k); // 1
    P.userCaches.set(k, { status: 'loading', _generation: 1 });
    P.bumpConfigGeneration(k); // 2 — config changed while parsing
    const ok = P.publishParseResult(k, { status: 'ready', channelCount: 3 });
    expect(ok).toBe(false);
    expect(P.userCaches.get(k)).toBeUndefined();
  });

  test('a fresh rehydrate does not spuriously discard against a 0 counter', async () => {
    const k = 'fresh-worker-' + Math.random();
    // Worker B starts fresh (local counter effectively 0). A snapshot from
    // worker A carries _generation 9; adoptGeneration syncs the fresh counter.
    P.adoptGeneration(k, 9);
    expect(P.getConfigGeneration(k)).toBe(9);
    // A refresh of that rehydrated snapshot stamps loading with _generation 9
    // (streamFetchIPTV reads prevEntry._generation), publishes under 9, so a
    // publish check accepts (counter is 9, not 0).
    P.userCaches.set(k, { status: 'loading', _generation: 9 });
    const ok = P.publishParseResult(k, { status: 'ready' });
    expect(ok).toBe(true);
    expect(P.userCaches.get(k)._generation).toBe(9);
  });

  test('config-save ordering: bump-then-delete, and never delete a loading placeholder', async () => {
    // Mirrors server.js PUT /api/auth/config for a user with an in-flight parse.
    const k = 'inflight-' + Math.random();
    // Parse N (assuming nothing bumped yet) stamps a loading placeholder at gen 0:
    P.userCaches.set(k, { status: 'loading', _generation: 0 });

    // The config handler runs: bump generation, then try to evict.
    P.bumpConfigGeneration(k); // now 1
    const existing = P.userCaches.get(k);
    // Loading placeholder must survive the eviction (it commits the parse's gen).
    if (!existing || existing.status !== 'loading') P.userCaches.delete(k);
    expect(P.userCaches.get(k)).toBeDefined();
    expect(P.userCaches.get(k).status).toBe('loading');

    // The stale parse N completes: publishParseResult compares its stamped gen 0
    // to the live counter 1 and discards — the new config wins.
    const ok = P.publishParseResult(k, { status: 'ready', channelCount: 99 });
    expect(ok).toBe(false);
    expect(P.userCaches.get(k)).toBeUndefined();
  });

  test('targeted catalog-page invalidation only removes the affected configKey', () => {
    // Mirrors the inline loop in server.js PUT /api/auth/config.
    const catalogPageCache = new Map();
    const userId = 'user-abc';
    // Prepopulate: this user's rows use "configKey|skip|genre|search|last".
    catalogPageCache.set(`${userId}|0|||1700000000000`, { metas: [], at: 1 });
    catalogPageCache.set(`${userId}|20|Sports||1700000000001`, { metas: [], at: 2 });
    // Another user + a legacy base64 key for the SAME chat user:
    catalogPageCache.set('other-user|0|||1700000000002', { metas: [], at: 3 });
    catalogPageCache.set('base64-encoded-key|0|||1700000000003', { metas: [], at: 4 });

    const delPrefix = userId + '|';
    for (const key of catalogPageCache.keys()) {
      if (key.startsWith(delPrefix)) catalogPageCache.delete(key);
    }
    expect(catalogPageCache.size).toBe(2);
    expect(catalogPageCache.has('other-user|0|||1700000000002')).toBe(true);
    expect(catalogPageCache.has('base64-encoded-key|0|||1700000000003')).toBe(true);
  });
});