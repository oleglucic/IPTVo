// Tests for the imageEngine poster pipeline. Focused on the square-poster
// change (imageEngine generates the channel-logo poster at a square 1:1 size
// so Stremio/Nuvio render it natively and storage/bandwidth drops).
//
// The real sharp pipeline is exercised end-to-end; only the external logo
// fetch is stubbed (axios) so the test runs offline.

jest.mock('axios');

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');

const IMAGE_ENGINE = require('../imageEngine');
const { getPremiumPoster } = IMAGE_ENGINE;

// Caller in production reaches only getPremiumPoster(); the module is loaded
// once here, so each test needs its own cache dir to act as a pristine cache.
const cacheRoot = path.join(__dirname, '..', 'cache', `__imgtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);

const pngBuffer = async () => {
    return await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 30, g: 120, b: 200 } },
    }).png().toBuffer();
};

describe('imageEngine square posters', () => {
    beforeAll(() => {
        fs.mkdirSync(cacheRoot, { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(cacheRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        axios.get.mockReset();
        axios.get.mockImplementation(async () => ({
            data: await pngBuffer(),
            headers: { 'content-type': 'image/png', 'x-logo-source': 'square-test' },
        }));
    });

    test('renders a square 1:1 poster and writes it to disk', async () => {
        const id = 'cnn';
        const posterPath = await getPremiumPoster(id, 'https://cdn.example.com/icon.png', 'CNN');
        const meta = await sharp(posterPath).metadata();
        expect(meta.width).toBe(meta.height);
        expect(meta.width).toBeGreaterThan(0);
        expect(fs.existsSync(posterPath)).toBe(true);
    });

    test('regenerates a square poster when the cache file is missing', async () => {
        const id = 'bbc';
        const first = await getPremiumPoster(id, 'https://cdn.example.com/icon2.png', 'BBC One');
        const sizeBefore = fs.statSync(first).size;
        // Corrupt/remove the cached file to force regeneration
        fs.unlinkSync(first);
        const second = await getPremiumPoster(id, 'https://cdn.example.com/icon2.png', 'BBC One');
        const metaAfter = await sharp(second).metadata();
        expect(metaAfter.width).toBe(metaAfter.height);
        expect(fs.statSync(second).size).toBeGreaterThan(0);
    });

    test('uses a cached poster file on repeat calls without re-fetching the logo', async () => {
        const id = 'usa';
        await getPremiumPoster(id, 'https://cdn.example.com/icon3.png', 'USA News');
        const fetchCountAfterFirst = axios.get.mock.calls.length;
        // Second call hits the disk cache and should not fetch again.
        await getPremiumPoster(id, 'https://cdn.example.com/icon3.png', 'USA News');
        expect(axios.get.mock.calls.length).toBe(fetchCountAfterFirst);
    });

    test('falls back to a direct fetch when the Worker proxy returns a quota error', async () => {
        const id = `quota_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const uniqueUrl = `https://cdn.quota.example.com/icon_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
        // The module reads LOGO_PROXY_URL at load time to decide whether a proxy is
        // configured, and both the module and axios must be re-required so the fresh
        // instance uses the fresh axios mock (jest.resetModules gives a new registry).
        jest.resetModules();
        process.env.LOGO_PROXY_URL = 'https://logo.proxy.example/logo'; // proxy "configured"
        const freshAxios = require('axios');
        const quotaEngine = require('../imageEngine');
        const { getPremiumPoster: quotaPoster } = quotaEngine;
        // Worker returns HTTP 429 (quota exceeded) → axios rejects in fetchLogoViaProxy
        freshAxios.get
            .mockReset()
            .mockImplementation(async (...args) => {
                // Simulate a transport/HTTP 429 from the Worker proxy (axios rejects
                // with a status attached), and a normal image response for direct fetch.
                if (args[0] && String(args[0]).startsWith('https://logo.proxy.example/')) {
                    const err = new Error('Quota exceeded');
                    err.response = { status: 429 };
                    throw err;
                }
                return { data: await pngBuffer(), headers: { 'content-type': 'image/png' } };
            });
        const posterPath = await quotaPoster(id, uniqueUrl, 'Quota TV');
        const proxyCalls = freshAxios.get.mock.calls.filter(([u]) => String(u).includes('proxy.example')).length;
        const directCalls = freshAxios.get.mock.calls.filter(([u]) => String(u).includes('cdn.quota')).length;
        expect(proxyCalls).toBe(1); // worker(429)
        expect(directCalls).toBe(1); // direct fetch fallback
        expect(fs.existsSync(posterPath)).toBe(true);
        // restore env so later tests run with proxy unconfigured as before
        delete process.env.LOGO_PROXY_URL;
        jest.resetModules();
    });

    test('keeps serving the existing server-side poster instead of overwriting with a placeholder', async () => {
        const id = 'sticky';
        const url = 'https://cdn.sticky.example.com/icon.png';
        // Render once successfully (disk poster exists)
        await getPremiumPoster(id, url, 'Sticky TV');
        const firstFetchCount = axios.get.mock.calls.length;
        // Now every fetch fails (dead upstream) — the previous real poster must survive
        axios.get.mockImplementation(async () => {
            const err = new Error('fetch failed');
            err.response = { status: 503 };
            throw err;
        });
        const posterPath = await getPremiumPoster(id, url, 'Sticky TV');
        // Still the earlier real render is served (exists, non-empty PNG)
        expect(fs.existsSync(posterPath)).toBe(true);
        const meta = await sharp(posterPath).metadata();
        expect(meta.width).toBe(meta.height);
        // The on-disk file must NOT have been overwritten by a placeholder SVG
        const raw = fs.readFileSync(posterPath);
        const isSvg = raw.subarray(0, 5).toString() === '<svg';
        expect(isSvg).toBe(false);
    });
});