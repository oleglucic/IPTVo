// Unit tests for epgHub (central multi-source EPG).
// Mock db/redisCache before importing epgHub so requiring it never creates real
// database or Redis clients (the module top-levels a connection pool).
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

const { normalizeSourceId, mergeForChannel } = require('../epgHub');

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
