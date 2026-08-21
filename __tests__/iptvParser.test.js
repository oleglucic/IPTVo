// Basic test structure for iptvParser

// Mock the required modules
jest.mock('../aiCurator', () => ({
  startAiQueue: jest.fn()
}));

jest.mock('../db', () => ({
  getAllOverrides: jest.fn()
}));

jest.mock('../redisCache', () => ({
  saveCacheToRedis: jest.fn(),
  saveLogoUrl: jest.fn()
}));

describe('iptvParser', () => {
  let iptvParser;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Dynamically require the module to get fresh instance
    iptvParser = require('../iptvParser');
  });

  describe('Module existence', () => {
    test('should exist', () => {
      expect(iptvParser).toBeDefined();
    });
  });

  describe('Exported functions', () => {
    test('should have streamFetchIPTV function', () => {
      expect(typeof iptvParser.streamFetchIPTV).toBe('function');
    });

    test('should have getEpgText function', () => {
      expect(typeof iptvParser.getEpgText).toBe('function');
    });
  });
});
describe('iptvParser (SSRF hardening)', () => {
  let iptvParser;

  beforeEach(() => {
    jest.clearAllMocks();
    iptvParser = require('../iptvParser');
  });

describe('revalidateResponseUrl', () => {
  test('should reject a response whose final URL is an internal address', () => {
    const res = {
      request: { res: { responseUrl: 'http://127.0.0.1:5432/db' } },
      config: { url: 'http://example.com/start' }
    };
    expect(() => iptvParser.revalidateResponseUrl(res)).toThrow(/private\/internal/);
  });

  test('should reject a response redirected to cloud metadata', () => {
    const res = {
      responseUrl: 'http://169.254.169.254/latest/meta-data/'
    };
    expect(() => iptvParser.revalidateResponseUrl(res)).toThrow(/private\/internal/);
  });

  test('should pass a response landing on a public URL after redirect', () => {
    const res = {
      request: { res: { responseUrl: 'https://cdn.example.com/playlist.m3u' } },
      config: { url: 'http://example.com/list.m3u' }
    };
    expect(() => iptvParser.revalidateResponseUrl(res)).not.toThrow();
  });

  test('should pass when no final URL is exposed (falls back to original)', () => {
    const res = { config: { url: 'https://example.com/list.m3u' } };
    expect(() => iptvParser.revalidateResponseUrl(res)).not.toThrow();
  });

  test('should destroy a stream when rejecting', () => {
    const destroyed = jest.fn();
    const stream = { destroy: destroyed };
    const res = { responseUrl: 'http://192.168.1.1/admin' };
    expect(() => iptvParser.revalidateResponseUrl(res, stream)).toThrow();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });
});

describe('isSafeUrl', () => {
  test.each([
    ['https://example.com/list.m3u', true],
    ['http://example.com:8080/x', true],
    ['http://127.0.0.1/x', false],
    ['http://localhost/x', false],
    ['http://10.0.0.5/x', false],
    ['http://192.168.1.1/x', false],
    ['http://172.16.0.1/x', false],
    ['http://169.254.169.254/latest', false],
    ['file:///etc/passwd', false],
    ['not-a-url', false]
  ])('isSafeUrl(%s) -> %s', (url, expected) => {
    expect(iptvParser.isSafeUrl(url)).toBe(expected);
  });
});

describe('epgScheduleNextRefresh (coverage-informed EPG cadence)', () => {
  test('returns the fail-fast retry for empty/failed feeds', () => {
    // 5 min
    expect(iptvParser.epgScheduleNextRefresh(0)).toBeGreaterThan(0);
    expect(iptvParser.epgScheduleNextRefresh(-1)).toBeGreaterThan(0);
    const retryAt = iptvParser.epgScheduleNextRefresh(0) - Date.now();
    expect(retryAt).toBeGreaterThanOrEqual(4.5 * 60 * 1000);
    expect(retryAt).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  test('clamps a short-coverage feed to the 30min floor', () => {
    // 10 minutes of coverage / 3 is only 3.3min, below the floor → 30min
    const next = iptvParser.epgScheduleNextRefresh(10 * 60 * 1000);
    const delay = next - Date.now();
    expect(delay).toBeGreaterThanOrEqual(29.5 * 60 * 1000);
    expect(delay).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  test('uses coverage/3 for a mid-range feed', () => {
    // 6 hours of coverage → 2h refresh
    const at = iptvParser.epgScheduleNextRefresh(6 * 60 * 60 * 1000);
    const delay = at - Date.now();
    expect(delay).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1000);
    expect(delay).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 1000);
  });

  test('caps to the 12h ceiling for a long feed', () => {
    // 7 days of coverage / 3 is 56h — capped at 12h
    const at = iptvParser.epgScheduleNextRefresh(7 * 24 * 60 * 60 * 1000);
    const delay = at - Date.now();
    expect(delay).toBeGreaterThanOrEqual(11.5 * 60 * 60 * 1000);
    expect(delay).toBeLessThanOrEqual(12 * 60 * 60 * 1000);
  });
});

describe('pickGenres (smart auto-grouping)', () => {
  test('prefers iptv-org categories for a generic Uncategorized group', () => {
    const match = { categories: ['sports', 'news'] };
    expect(iptvParser.pickGenres(match, 'Uncategorized')).toEqual(['sports', 'news']);
  });

  test('prefers iptv-org categories for a blank group', () => {
    const match = { categories: ['movies'] };
    expect(iptvParser.pickGenres(match, '   ')).toEqual(['movies']);
  });

  test('keeps the playlist group when it carries a real label', () => {
    const match = { categories: ['sports'] };
    expect(iptvParser.pickGenres(match, 'Sports')).toEqual(['Sports']);
  });

  test('returns the group even without categories', () => {
    expect(iptvParser.pickGenres(null, 'News')).toEqual(['News']);
    expect(iptvParser.pickGenres({ categories: [] }, '')).toEqual(['Uncategorized']);
  });
});
});
