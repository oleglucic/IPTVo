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
});