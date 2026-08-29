jest.mock('axios');

const axios = require('axios');
const iptvOrgRef = require('../iptvOrgRef');

describe('iptv-org alias matching', () => {
    beforeAll(async () => {
        jest.useFakeTimers();
        axios.get.mockImplementation(async url => {
            if (url.endsWith('/channels.json')) {
                return {
                    data: [
                        { id: 'StarLife.rs', name: 'Star Life', alt_names: [], country: 'RS', categories: [] },
                        { id: 'TV1000.ua', name: 'TV1000', alt_names: [], country: 'UA', categories: [] },
                    ],
                };
            }
            if (url.endsWith('/countries.json')) {
                return { data: [{ code: 'RS', name: 'Serbia' }, { code: 'UA', name: 'Ukraine' }] };
            }
            return { data: [] };
        });

        iptvOrgRef.startAutoRefresh();
        await Promise.all(axios.get.mock.results.map(result => result.value));
        await Promise.resolve();
        await Promise.resolve();
    });

    afterAll(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test.each([
        ['Fox Life', 'rs', 'StarLife.rs'],
        ['FoxLife', 'rs', 'StarLife.rs'],
        ['Viasat Kino', 'ua', 'TV1000.ua'],
        ['ViasatKino', 'ua', 'TV1000.ua'],
    ])('resolves spaced and compact alias %s', (name, scope, expectedId) => {
        expect(iptvOrgRef.lookupChannelSmart(name, scope)).toMatchObject({ officialId: expectedId });
    });
});
