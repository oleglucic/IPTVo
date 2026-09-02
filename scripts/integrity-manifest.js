#!/usr/bin/env node
/**
 * integrity-manifest.js
 *
 * Free code-integrity check that runs regardless of JScrambler credentials.
 *
 * For every dashboard bundle / server source that is shipped, it records an
 * SHA-256 of the exact bytes into dist/integrity.json. A deploy/runtime step
 * can compare the served files against this manifest to detect tampering
 * (e.g. an attacker swapping a script or a CDN serving a modified file).
 *
 * When JScrambler credentials are configured, the obfuscated output in
 * dist/dashboard/js/ is hashed instead of the plain sources, so the manifest
 * always describes exactly what is deployed.
 *
 * Usage:
 *   node scripts/integrity-manifest.js
 * (run by `npm run integrity`; CI invokes it via the fortify/jscrambler job)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(DIST, 'integrity.json');

// Artifacts that are expected to exist post-build. Each group resolves to the
// obfuscated output dir (dist/<subdir>) when present (JScrambler ran),
// otherwise it falls back to the plain source location so the manifest is
// still useful without credentials.
const GROUPS = [
  {
    // Dashboard client JS — JScrambler target; obfuscates into dist/dashboard/js/.
    name: 'dashboard/js',
    sourceRoot: 'dashboard/js',
    artifacts: ['main.js', 'api.js', 'state.js', 'matching.js', 'toast.js']
  },
  {
    // Server-side source lives at the repo root (no obfuscation target).
    name: 'server',
    sourceRoot: '.',
    artifacts: ['server.js', 'src/iptvParser.js', 'src/logger.js']
  }
];

function sha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function resolveDir(group) {
  const obfuscated = path.join(DIST, group.name);
  if (fs.existsSync(obfuscated)) return obfuscated;
  return path.join(ROOT, group.sourceRoot);
}

function build() {
  const manifest = {
    generatedAt: new Date().toISOString(),
    algo: 'sha256',
    files: {}
  };

  for (const group of GROUPS) {
    const dir = resolveDir(group);
    const obfuscated = dir === path.join(DIST, group.name);
    for (const file of group.artifacts) {
      const abs = path.join(dir, file);
      manifest.files[`${group.name}/${file}`] = {
        integrity: `sha256-${sha256(abs)}`,
        obfuscated
      };
    }
  }

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`Integrity manifest written to ${MANIFEST}`);
  return manifest;
}

build();