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
});
