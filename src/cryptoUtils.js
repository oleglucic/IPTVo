// cryptoUtils.js
// AES-GCM encryption/decryption for user configs using Web Crypto API (Node.js 19+)
// or native node:crypto for compatibility

const crypto = require('crypto');
const log = require('./logger').for('cryptoUtils');

// Master encryption key from environment (32 bytes for AES-256)
// Derived from ENCRYPTION_KEY env var using PBKDF2 with per-user salt
function getMasterKey() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
        throw new Error('ENCRYPTION_KEY environment variable is required for user config encryption');
    }
    // Use SHA-256 to derive 32-byte key from any length input
    return crypto.createHash('sha256').update(key).digest();
}

/**
 * Derive encryption key from master key + user salt using PBKDF2
 * @param {Buffer} masterKey - 32-byte master key
 * @param {Buffer} salt - 16-byte salt
 * @returns {Promise<CryptoKey>} Web Crypto key or node key object
 */
async function deriveKey(masterKey, salt) {
    // Use Node's built-in crypto for PBKDF2 (more compatible)
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(masterKey, salt, 100000, 32, 'sha256', (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey);
        });
    });
}

/**
 * Encrypt a config object using AES-256-GCM
 * @param {object} config - Config object to encrypt
 * @param {string} [masterKeyB64] - Optional master key override (base64), otherwise uses ENCRYPTION_KEY env
 * @returns {Promise<{encryptedConfig: string, iv: string, salt: string}>} All values base64 encoded
 */
async function encryptConfig(config, masterKeyB64) {
    const masterKey = masterKeyB64
        ? Buffer.from(masterKeyB64, 'base64')
        : getMasterKey();

    // Generate random salt (16 bytes) and IV (12 bytes for GCM)
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);

    // Derive user-specific key
    const key = await deriveKey(masterKey, salt);

    // Encrypt config JSON
    const plaintext = Buffer.from(JSON.stringify(config), 'utf8');

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combine ciphertext + authTag for storage
    const encrypted = Buffer.concat([ciphertext, authTag]);

    return {
        encryptedConfig: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        salt: salt.toString('base64')
    };
}

/**
 * Decrypts an encrypted configuration object.
 * @param {string} encryptedConfigB64 - Base64-encoded ciphertext and authentication tag.
 * @param {string} ivB64 - Base64-encoded initialization vector.
 * @param {string} saltB64 - Base64-encoded key derivation salt.
 * @param {string} [masterKeyB64] - Optional Base64-encoded master key; otherwise uses the environment-derived key.
 * @returns {object|null} The decrypted configuration object, or `null` if decryption fails.
 */
async function decryptConfig(encryptedConfigB64, ivB64, saltB64, masterKeyB64) {
    try {
        const masterKey = masterKeyB64
            ? Buffer.from(masterKeyB64, 'base64')
            : getMasterKey();

        const encryptedConfig = Buffer.from(encryptedConfigB64, 'base64');
        const iv = Buffer.from(ivB64, 'base64');
        const salt = Buffer.from(saltB64, 'base64');

        // Split ciphertext and authTag (last 16 bytes)
        const authTag = encryptedConfig.slice(-16);
        const ciphertext = encryptedConfig.slice(0, -16);

        // Derive user-specific key
        const key = await deriveKey(masterKey, salt);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        return JSON.parse(plaintext.toString('utf8'));
    } catch (e) {
        log.error('Decrypt failed:', e.message);
        return null;
    }
}

/**
 * Creates a truncated SHA-256 fingerprint for a configuration key.
 * @param {string|undefined|null} configKey - The configuration key to fingerprint.
 * @return {string} The first 12 hexadecimal characters of the key's SHA-256 hash, or `'null'` when no key is provided.
 */
function configKeyFingerprint(configKey) {
    if (!configKey) return 'null';
    return crypto.createHash('sha256').update(String(configKey)).digest('hex').substring(0, 12);
}

/**
 * Hash password using bcrypt (using built-in Node crypto with PBKDF2 as alternative)
 * For production, use bcrypt library. This is a simplified version using PBKDF2.
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Base64 encoded hash:salt:iterations
 */
async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const iterations = 100000;
    const keyLen = 32;

    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, iterations, keyLen, 'sha256', (err, derivedKey) => {
            if (err) reject(err);
            else {
                // Format: iterations$salt$hash (all base64)
                resolve(`${iterations}$${salt.toString('base64')}$${derivedKey.toString('base64')}`);
            }
        });
    });
}

/**
 * Verify password against hash
 * @param {string} password - Plain text password
 * @param {string} hash - Stored hash in format iterations$salt$hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
    try {
        const [iterationsStr, saltB64, hashB64] = hash.split('$');
        const iterations = parseInt(iterationsStr, 10);
        const salt = Buffer.from(saltB64, 'base64');
        const expectedHash = Buffer.from(hashB64, 'base64');

        return new Promise((resolve, reject) => {
            crypto.pbkdf2(password, salt, iterations, expectedHash.length, 'sha256', (err, derivedKey) => {
                if (err) reject(err);
                else resolve(crypto.timingSafeEqual(derivedKey, expectedHash));
            });
        });
    } catch (e) {
        log.error('Verify password failed:', e.message);
        return false;
    }
}

/**
 * Generate a secure session token
 * @returns {string} Base64 encoded random token
 */
function generateSessionToken() {
    return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
    encryptConfig,
    decryptConfig,
    hashPassword,
    verifyPassword,
    generateSessionToken,
    getMasterKey,
    configKeyFingerprint
};