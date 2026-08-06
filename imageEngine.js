const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

async function getPremiumPoster(cId, logoUrl, fallbackName) {
    // Cache key includes a hash of the logo URL so a changed logoUrl invalidates old cache
    const urlHash = logoUrl ? crypto.createHash('md5').update(logoUrl).digest('hex').substring(0, 8) : 'none';
    const cachePath = path.join(cacheDir, `${cId}_${urlHash}.png`);

    if (fs.existsSync(cachePath)) return cachePath;

    try {
        if (!logoUrl || !logoUrl.startsWith('http')) throw new Error("Invalid or missing logo URL");

        const response = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 7000 });
        const logoBuffer = Buffer.from(response.data);

        const background = await sharp(logoBuffer)
            .resize(600, 900, { fit: 'cover' })
            .blur(35)
            .linear(0.55, 0)
            .toBuffer();

        const haloSvg = `
            <svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <radialGradient id="haloGlow" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35" />
                        <stop offset="60%" stop-color="#ffffff" stop-opacity="0.15" />
                        <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0" />
                    </radialGradient>
                </defs>
                <circle cx="250" cy="250" r="250" fill="url(#haloGlow)" />
            </svg>
        `;
        const haloBuffer = Buffer.from(haloSvg);

        const foreground = await sharp(logoBuffer)
            .resize(400, 400, { fit: 'inside' })
            .toBuffer();

        await sharp(background)
            .composite([
                { input: haloBuffer, gravity: 'center' },
                { input: foreground, gravity: 'center' }
            ])
            .toFile(cachePath);

        return cachePath;
    } catch (err) {
        console.error(`[imageEngine] Poster generation failed for cId=${cId}, logoUrl=${logoUrl}: ${err.message}`);

        const cleanName = fallbackName ? fallbackName.toUpperCase() : "LIVE TV";
        const fallbackSvg = `
            <svg width="600" height="900" xmlns="http://www.w3.org/2000/svg">
                <rect width="100%" height="100%" fill="#0f172a"/>
                <rect x="20" y="20" width="560" height="860" rx="15" fill="none" stroke="#1e293b" stroke-width="4"/>
                <circle cx="300" cy="400" r="80" fill="#1e293b"/>
                <text x="300" y="415" font-family="sans-serif" font-size="50" font-weight="bold" fill="#6366f1" text-anchor="middle">TV</text>
                <text x="300" y="580" font-family="sans-serif" font-size="36" font-weight="bold" fill="#94a3b8" text-anchor="middle">${cleanName}</text>
            </svg>
        `;
        await sharp(Buffer.from(fallbackSvg)).toFile(cachePath);
        return cachePath;
    }
}

module.exports = { getPremiumPoster };