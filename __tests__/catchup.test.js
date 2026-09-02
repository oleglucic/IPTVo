// Tests for catchup.js's snapshotAllEpgToHistory, updated in this PR to use
// an underscore-prefixed (unused) loop variable for the cache Map key.

jest.mock('../src/db', () => ({
    saveEpgSnapshot: jest.fn(),
    getEpgHistory: jest.fn()
}));

const { saveEpgSnapshot } = require('../src/db');
const { snapshotAllEpgToHistory } = require('../src/catchup');

describe('snapshotAllEpgToHistory', () => {
    let logSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    test('saves programs for each ready channel, ignoring the (unused) cache key', async () => {
        const userCaches = new Map([
            ['configKeyA', {
                status: 'ready',
                epgData: {
                    channel1: [{ title: 'Show 1' }, { title: 'Show 2' }],
                    channel2: [{ title: 'Show 3' }]
                }
            }],
            ['configKeyB', {
                status: 'ready',
                epgData: {
                    channel3: [{ title: 'Show 4' }]
                }
            }]
        ]);

        await snapshotAllEpgToHistory(userCaches);

        expect(saveEpgSnapshot).toHaveBeenCalledTimes(3);
        expect(saveEpgSnapshot).toHaveBeenCalledWith('channel1', [{ title: 'Show 1' }, { title: 'Show 2' }]);
        expect(saveEpgSnapshot).toHaveBeenCalledWith('channel2', [{ title: 'Show 3' }]);
        expect(saveEpgSnapshot).toHaveBeenCalledWith('channel3', [{ title: 'Show 4' }]);
    });

    test('skips entries that are not ready', async () => {
        const userCaches = new Map([
            ['a', { status: 'loading', epgData: { c: [{ title: 'x' }] } }],
            ['b', { status: 'error', epgData: { c: [{ title: 'x' }] } }]
        ]);

        await snapshotAllEpgToHistory(userCaches);

        expect(saveEpgSnapshot).not.toHaveBeenCalled();
    });

    test('skips falsy cache entries and entries missing epgData', async () => {
        const userCaches = new Map([
            ['a', null],
            ['b', undefined],
            ['c', { status: 'ready' }],
            ['d', { status: 'ready', epgData: null }]
        ]);

        await snapshotAllEpgToHistory(userCaches);

        expect(saveEpgSnapshot).not.toHaveBeenCalled();
    });

    test('skips non-array and empty program lists for individual channels', async () => {
        const userCaches = new Map([
            ['a', {
                status: 'ready',
                epgData: {
                    emptyChannel: [],
                    invalidChannel: 'not-an-array',
                    validChannel: [{ title: 'Real Show' }]
                }
            }]
        ]);

        await snapshotAllEpgToHistory(userCaches);

        expect(saveEpgSnapshot).toHaveBeenCalledTimes(1);
        expect(saveEpgSnapshot).toHaveBeenCalledWith('validChannel', [{ title: 'Real Show' }]);
    });

    test('handles an empty cache map without error', async () => {
        await expect(snapshotAllEpgToHistory(new Map())).resolves.toBeUndefined();
        expect(saveEpgSnapshot).not.toHaveBeenCalled();
    });

    test('logs a summary with accurate channel and program counts', async () => {
        const userCaches = new Map([
            ['a', {
                status: 'ready',
                epgData: {
                    channel1: [{ title: '1' }, { title: '2' }, { title: '3' }]
                }
            }]
        ]);

        await snapshotAllEpgToHistory(userCaches);

        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining('1 channels, 3 program entries processed')
        );
    });
});