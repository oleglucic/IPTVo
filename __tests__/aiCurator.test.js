// Tests for aiCurator.js, focused on the log-sanitization behavior and
// AI-queue processing logic introduced/changed in this PR.

jest.mock('axios');
jest.mock('../db', () => ({
    setOverride: jest.fn(),
    getAllOverrides: jest.fn()
}));
jest.mock('../iptvOrgRef', () => ({
    lookupChannel: jest.fn(),
    lookupChannelFuzzy: jest.fn()
}));

const axios = require('axios');
const { setOverride, getAllOverrides } = require('../db');
const { lookupChannel, lookupChannelFuzzy } = require('../iptvOrgRef');
const { startAiQueue, globalAiCache } = require('../aiCurator');

describe('aiCurator', () => {
    let logSpy;
    let errorSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        globalAiCache.clear();
        getAllOverrides.mockResolvedValue([]);
        lookupChannel.mockReturnValue(null);
        lookupChannelFuzzy.mockReturnValue(null);
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    describe('startAiQueue - guard clauses', () => {
        test('does nothing when openrouterKey is missing', async () => {
            await startAiQueue([{ rawName: 'a', baseCleanName: 'a', cId: '1' }], 'cfg', null);
            expect(axios.post).not.toHaveBeenCalled();
            expect(getAllOverrides).not.toHaveBeenCalled();
        });

        test('does nothing when dirtyChannels is undefined', async () => {
            await startAiQueue(undefined, 'cfg', 'key123');
            expect(axios.post).not.toHaveBeenCalled();
        });

        test('does nothing when dirtyChannels is empty', async () => {
            await startAiQueue([], 'cfg', 'key123');
            expect(axios.post).not.toHaveBeenCalled();
        });

        test('skips a new cycle while one is already running (prevents stacked 55k queues)', async () => {
            // Halt the first cycle inside the AI batch resolution using an axios
            // mock that never settles until the test lets it proceed.
            let release;
            axios.post.mockImplementation(() => new Promise(res => { release = res; }));
            lookupChannel.mockReturnValue(null);
            getAllOverrides.mockResolvedValue([]);

            const dirtyChannels = [
                { rawName: 'Channel A', baseCleanName: 'chana', cId: 'us_chana', countryScopeKey: 'us' }
            ];

            const first = startAiQueue(dirtyChannels, 'cfg', 'key123');
            // Let the first cycle reach the axios post (past pre-filter).
            await new Promise(r => setTimeout(r, 20));

            // Second trigger while the first is mid-cycle must be dropped.
            await startAiQueue(dirtyChannels, 'cfg2', 'otherkey');
            expect(axios.post).toHaveBeenCalledTimes(1);

            // Let the first cycle finish so the module's guard resets cleanly.
            release({ data: { choices: [{ message: { content: '{}' } }] } });
            await first;

            // A follow-up call with no work left is not spuriously blocked.
            await startAiQueue([], 'cfg3', 'key3');
            expect(axios.post).toHaveBeenCalledTimes(1);
        });
    });

    describe('log sanitization', () => {
        test('sanitizes control characters and newlines in the configKey log message', async () => {
            // All channels already matched by iptv-org, so uniqueToProcess is empty
            // and the "no flagged channels" branch (which logs configKey) is hit.
            lookupChannel.mockReturnValue({ officialId: 'cnn', countryScopeKey: 'us' });

            const dirtyChannels = [
                { rawName: 'CNN HD', baseCleanName: 'cnn', cId: 'us_cnn', countryScopeKey: 'us' }
            ];
            const maliciousConfigKey = 'user1\n[FAKE LOG] admin logged in\tsuffix\x1b[31m';

            await startAiQueue(dirtyChannels, maliciousConfigKey, 'key123');

            const noFlaggedCall = logSpy.mock.calls.find(call =>
                call[0].includes('No flagged channels requiring processing for')
            );
            expect(noFlaggedCall).toBeDefined();
            // Newlines/tabs/escape sequences must be replaced with '?'
            expect(noFlaggedCall[0]).not.toMatch(/[\r\n\t\x1b]/);
            expect(noFlaggedCall[0]).toContain('user1?');
            expect(noFlaggedCall[0]).toContain('[FAKE LOG] admin logged in?suffix?');
        });

        test('sanitizes unsafe characters in raw/clean channel names when logging an iptv-org match', async () => {
            // First lookup (pre-AI) returns null so the channel is queued for AI processing.
            // Second lookup (post-AI, using the AI-cleaned name) returns a match, triggering
            // the "AI-cleaned ... now matches iptv-org" log line.
            lookupChannel
                .mockReturnValueOnce(null) // priority classification pass
                .mockReturnValueOnce({ officialId: 'cnn\n[injected]', countryScopeKey: 'us\tX' }); // post-AI match

            axios.post.mockResolvedValue({
                data: {
                    choices: [{
                        message: { content: '{"CNN\\nHD [bad]": "cnn"}' }
                    }]
                }
            });

            const rawName = 'CNN\nHD [bad]';
            const dirtyChannels = [
                { rawName, baseCleanName: 'unk', cId: 'us_unk', countryScopeKey: 'us' }
            ];

            await startAiQueue(dirtyChannels, 'cfgKey', 'key123');

            const matchLog = logSpy.mock.calls.find(call =>
                call[0].includes('now matches iptv-org')
            );
            expect(matchLog).toBeDefined();
            expect(matchLog[0]).not.toMatch(/[\r\n\t]/);
        });

        test('sanitizes error messages on generic axios failure', async () => {
            lookupChannel.mockReturnValue(null);
            const err = new Error('boom\nInjected line\tafter tab');
            axios.post.mockRejectedValue(err);

            const dirtyChannels = [
                { rawName: 'Unknown Channel', baseCleanName: 'unknown', cId: 'us_unk', countryScopeKey: 'us' }
            ];

            await startAiQueue(dirtyChannels, 'cfgKey', 'key123');

            const errCall = errorSpy.mock.calls.find(call =>
                call[0].includes('[AI Curator Error] Failed to process batch:')
            );
            expect(errCall).toBeDefined();
            expect(errCall[1]).toBe('boom?Injected line?after tab');
        });

        test('logs a dedicated message and stops early on rate limit (status 429)', async () => {
            lookupChannel.mockReturnValue(null);
            const rateLimitError = new Error('Too Many Requests');
            rateLimitError.response = { status: 429 };
            axios.post.mockRejectedValue(rateLimitError);

            const dirtyChannels = [
                { rawName: 'Unknown Channel', baseCleanName: 'unknown', cId: 'us_unk', countryScopeKey: 'us' }
            ];

            await startAiQueue(dirtyChannels, 'cfgKey', 'key123');

            const stoppingLog = logSpy.mock.calls.find(call =>
                call[0].includes('Stopping early due to rate limit')
            );
            expect(stoppingLog).toBeDefined();
            expect(setOverride).not.toHaveBeenCalled();
        });

        // Regression/boundary case: sanitizeForLog() treats its argument as falsy
        // when it is `0`, and short-circuits to an empty string. Since the batch
        // start index `i` is `0` on the very first iteration, that numeric value
        // is silently dropped from the "Stopping early" log line. This test
        // documents the current, real behavior of the sanitization helper.
        test('sanitizeForLog collapses a numeric 0 (batch start index) into an empty string', async () => {
            lookupChannel.mockReturnValue(null);
            const rateLimitError = new Error('Too Many Requests');
            rateLimitError.response = { status: 429 };
            axios.post.mockRejectedValue(rateLimitError);

            const dirtyChannels = [
                { rawName: 'Unknown Channel', baseCleanName: 'unknown', cId: 'us_unk', countryScopeKey: 'us' }
            ];

            await startAiQueue(dirtyChannels, 'cfgKey', 'key123');

            const stoppingLog = logSpy.mock.calls.find(call =>
                call[0].includes('Stopping early due to rate limit')
            );
            expect(stoppingLog).toBeDefined();
            // "Processed " is immediately followed by " of" because sanitizeForLog(0) === ''
            expect(stoppingLog[0]).toContain('Processed  of 1 channels this cycle.');
        });
    });

    describe('override persistence', () => {
        test('persists an AI-derived canonical id when no iptv-org match is found', async () => {
            lookupChannel.mockReturnValue(null);
            lookupChannelFuzzy.mockReturnValue(null);
            axios.post.mockResolvedValue({
                data: {
                    choices: [{
                        message: { content: '{"Some Channel Backup": "somechannel"}' }
                    }]
                }
            });

            const dirtyChannels = [
                { rawName: 'Some Channel Backup', baseCleanName: 'unknown', cId: 'us_unk', countryScopeKey: 'us' }
            ];

            await startAiQueue(dirtyChannels, 'cfgKey', 'key123');

            expect(setOverride).toHaveBeenCalledWith('Some Channel Backup', 'iptvo_Somechannel.us', 0.85);
            expect(globalAiCache.get('Some Channel Backup')).toBe('iptvo_Somechannel.us');
        });

        test('uses the authoritative iptv-org id when the AI-cleaned name matches after normalization', async () => {
            lookupChannel
                .mockReturnValueOnce(null) // initial classification: no match yet
                .mockReturnValueOnce({ officialId: 'cnn', countryScopeKey: 'us' }); // post-AI match
            axios.post.mockResolvedValue({
                data: {
                    choices: [{
                        message: { content: '{"CNN Backup Feed": "cnn"}' }
                    }]
                }
            });

            const dirtyChannels = [
                { rawName: 'CNN Backup Feed', baseCleanName: 'unknown', cId: 'us_unk', countryScopeKey: 'us' }
            ];

            await startAiQueue(dirtyChannels, 'cfgKey', 'key123');

            expect(setOverride).toHaveBeenCalledWith('CNN Backup Feed', 'iptvo_cnn', 0.85);
        });

        test('skips channels already matched by iptv-org (never sent to AI)', async () => {
            lookupChannel.mockReturnValue({ officialId: 'bbc', countryScopeKey: 'gb' });

            const dirtyChannels = [
                { rawName: 'BBC One', baseCleanName: 'bbcone', cId: 'gb_bbc', countryScopeKey: 'gb' }
            ];

            await startAiQueue(dirtyChannels, 'cfgKey', 'key123');

            expect(axios.post).not.toHaveBeenCalled();
            expect(setOverride).not.toHaveBeenCalled();
        });
    });
});