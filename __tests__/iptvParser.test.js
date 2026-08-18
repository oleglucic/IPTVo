// Basic test structure for iptvParser
const fs = require('fs');
const path = require('path');

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