// Unit tests for epgHub (central multi-source EPG).
// Mock db/redisCache/iptvOrgRef before importing epgHub so requiring it never
// creates real database/Redis clients or loads the iptv-org reference indexes.
jest.mock('../db', () => ({
  saveEpgPrograms: jest.fn(),
  listEpgSources: jest.fn(async () => []),
  setEpgSourceStatus: jest.fn(),
  upsertEpgSource: jest.fn(),
  pruneEpgPrograms: jest.fn(async () => 0)
}));
jest.mock('../redisCache', () => ({
  saveEpgCache: jest.fn(),
  getHubGeneration: jest.fn(async () => 0),
  bumpGeneration: jest.fn(async () => 1),
  setHubState: jest.fn(async () => 1),
  hasRedis: false
}));
jest.mock('../iptvOrgRef', () => {
  let _lastRefreshed = 1; // reference "ready" for canonical matching
  return {
    lookupChannelSmart: jest.fn(() => null),
    lookupChannel: jest.fn(() => null),
    isValidCountryCode: jest.fn((cc) => /^[a-z]{2}$/.test(cc)),
    get lastRefreshed() { return _lastRefreshed; },
    set lastRefreshed(value) { _lastRefreshed = value; }
  };
});

const { normalizeSourceId, mergeForChannel, resolveCanonicalSourceId } = require('../epgHub');

describe('epgHub normalizeSourceId', () => {
  test('passes through iptv-org-style id (name.cc)', () => {
    expect(normalizeSourceId('#Vamos.es')).toBe('vamos.es'); // leading # stripped
    expect(normalizeSourceId('DAZN.LaLiga.es')).toBe('dazn.laliga.es');
    expect(normalizeSourceId('CNN.International.ae')).toBe('cnn.international.ae');
  });

  test('lowercases + trims + strips leading hashtag', () => {
    expect(normalizeSourceId('  #VAMOS.ES ')).toBe('vamos.es');
  });

  test('returns null for a name-keyed/unknown id', () => {
    expect(normalizeSourceId('mjh-sky-hgtv')).toBeNull();
    expect(normalizeSourceId('')).toBeNull();
    expect(normalizeSourceId(null)).toBeNull();
  });
});

describe('epgHub mergeForChannel', () => {
  test('dedupes by (start,title) across sources', () => {
    const candidates = [
      { source: 'a', programs: [
        { title: 'News', desc: '', start: 100, stop: 200 },
        { title: 'Film', desc: '', start: 200, stop: 300 }
      ] },
      { source: 'b', programs: [
        { title: 'News', desc: '', start: 100, stop: 200 } // duplicate
      ] }
    ];
    const merged = mergeForChannel(candidates);
    expect(merged.length).toBe(2);
    expect(merged.map(p => p.title)).toEqual(expect.arrayContaining(['News', 'Film']));
  });

  test('prefers the source with more programmes first', () => {
    const candidates = [
      { source: 'few', programs: [
        { title: 'A', desc: '', start: 1, stop: 2 },
        { title: 'D', desc: '', start: 7, stop: 8 }
      ] },
      { source: 'many', programs: [
        { title: 'A', desc: '', start: 1, stop: 2 },
        { title: 'B', desc: '', start: 3, stop: 4 },
        { title: 'C', desc: '', start: 5, stop: 6 }
      ] }
    ];
    const merged = mergeForChannel(candidates);
    // 'many' (3 programmes) is drained first, so B/C appear before 'few''s D;
    // A is a cross-source duplicate and is only emitted once (the 'many' copy).
    expect(merged.map(p => p.title)).toEqual(['A', 'B', 'C', 'D']);
  });

  test('returns [] for empty input', () => {
    expect(mergeForChannel([])).toEqual([]);
    expect(mergeForChannel(null)).toEqual([]);
  });
});

describe('epgHub resolveCanonicalSourceId', () => {
  const ref = require('../iptvOrgRef');

  beforeEach(() => {
    ref.lookupChannelSmart.mockClear();
    ref.lookupChannel.mockClear();
  });

  test('returns null when no iptv-org match exists', async () => {
    ref.lookupChannelSmart.mockReturnValue(null);
    ref.lookupChannel.mockReturnValue(null);
    const result = await resolveCanonicalSourceId('no.such.channel.xx');
    expect(result).toBeNull();
  });

  test('does not cache miss while reference is unready, retries when ready', async () => {
    // Simulate unready state (lastRefreshed = 0)
    ref.lastRefreshed = 0;
    ref.lookupChannelSmart.mockReturnValue(null);
    ref.lookupChannel.mockReturnValue(null);

    // First call while unready - should return null but not cache
    const firstResult = await resolveCanonicalSourceId('cnn.us');
    expect(firstResult).toBeNull();
    expect(ref.lookupChannelSmart).toHaveBeenCalledTimes(1);

    // Simulate reference becoming ready
    ref.lastRefreshed = 1;
    ref.lookupChannelSmart.mockReturnValue({ officialId: 'CNN.us' });

    // Second call after ready - should re-run matcher and return result
    const secondResult = await resolveCanonicalSourceId('cnn.us');
    expect(secondResult).toEqual({ official: 'cnn.us', base: 'cnn' });
    expect(ref.lookupChannelSmart).toHaveBeenCalledTimes(2);

    // Third call - should use cache now
    const thirdResult = await resolveCanonicalSourceId('cnn.us');
    expect(thirdResult).toEqual({ official: 'cnn.us', base: 'cnn' });
    expect(ref.lookupChannelSmart).toHaveBeenCalledTimes(2);

    // Restore to ready state
    ref.lastRefreshed = 1;
  });

  test('passes the normalized name + country scope to the matcher', async () => {
    ref.lookupChannelSmart.mockReturnValue({ officialId: 'SkySportsNews.uk', countryScopeKey: 'gb' });
    const result = await resolveCanonicalSourceId('sky.sports.news.hd.uk');
    expect(ref.lookupChannelSmart).toHaveBeenCalledWith('sky sports news', 'uk');
    expect(result).toEqual({ official: 'skysportsnews.uk', base: 'skysportsnews' });
  });

  test('handles a supported non-UK country suffix', async () => {
    ref.lookupChannelSmart.mockReturnValue({ officialId: 'Eurosport1.de', countryScopeKey: 'de' });
    const result = await resolveCanonicalSourceId('eurosport.1.hd.de');
    expect(ref.lookupChannelSmart).toHaveBeenCalledWith('eurosport 1', 'de');
    expect(result).toEqual({ official: 'eurosport1.de', base: 'eurosport1' });
  });

  test('caches results so repeated calls do not re-match', async () => {
    ref.lookupChannelSmart.mockReturnValue({ officialId: 'BBC.uk' });
    ref.lookupChannel.mockReturnValue(null);
    const before = ref.lookupChannelSmart.mock.calls.length;
    const first = await resolveCanonicalSourceId('bbc.uk');
    const second = await resolveCanonicalSourceId('bbc.uk');
    expect(second).toEqual(first);
    expect(ref.lookupChannelSmart.mock.calls.length).toBe(before + 1);
    expect(ref.lookupChannelSmart).toHaveBeenCalledWith('bbc', 'uk');
  });
});
