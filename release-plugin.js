/**
 * Custom semantic-release plugins for IPTVo.
 *
 * 1. `generateNotes` — generates the release notes (via the standard
 *    @semantic-release/release-notes-generator) and appends a "Contributors"
 *    section listing the real GitHub handles of everyone who authored or
 *    co-authored the commits in this release.
 *
 * 2. `analyzeCommits` — enforces the project's "first feature release on a
 *    0.x series graduates to 1.0.0" policy.
 *
 * The plugin is wired as the FIRST "generateNotes" plugin (see package.json),
 * so the annotated notes (base notes + contributors) are what lands in
 * CHANGELOG.md, the release commit message, and the GitHub release body.
 */

// Maps a conventional-changelog preset name to the package that provides it.
// release-notes-generator resolves presets dynamically from cwd; listing the
// preset as a devDependency (conventional-changelog-conventionalcommits) keeps
// that resolution working inside CI.
async function generateNotes(pluginConfig, context) {
  const { commits, logger } = context;

  // `generator` may be `[moduleName, options]` (semantic-release plugin
  // shorthand) or already a plain options object. Extract the options either
  // way and hand them to the real generator as its pluginConfig.
  let generatorOpts = pluginConfig.generator || {};
  if (Array.isArray(generatorOpts) && generatorOpts.length === 2) {
    generatorOpts = generatorOpts[1];
  }
  const opts = { ...generatorOpts };

  const base = require('@semantic-release/release-notes-generator');
  let notes = '';
  try {
    notes = await base.generateNotes(opts, context);
  } catch (e) {
    // Never silently swallow this. A missing/empty base is what produced the
    // long run of contributor-only releases in the changelog; surface it so the
    // release fails loudly instead of shipping broken notes.
    throw new Error(`Failed to generate release notes: ${e.message}`);
  }

  const section = buildContributorsSection(commits || []);
  const body = section
    ? `${notes.trimEnd()}\n\n${section}`.trimEnd() + '\n'
    : notes;
  logger.log('Generated release notes with base notes + contributors section.');
  return body;
}

/**
 * Derives a readable GitHub handle from the various ways an author identity can
 * surface in a commit:
 *   - `author.username` (populated when semantically-release knows the account)
 *   - `+handle@users.noreply.github.com` (the handle is the part after the `+`)
 *   - a bare `@handle` in the name
 *   - a plain email localpart (last resort)
 *
 * npm-style numeric IDs (e.g. `183150217+oleglucic`) and commit-author IDs are
 * dropped so we never print `(@183150217+...)`.
 */
function deriveUsername(commit, name, email) {
  if (commit && commit.author && commit.author.username) return commit.author.username;
  const em = (email || '').trim();
  // GitHub noreply format: <numeric-id>+<handle>@users.noreply.github.com
  let m = /^(\d+\+)?([^@+]+)@users\.noreply\.github\.com$/.exec(em);
  if (m) return m[2];
  const local = em.split('@')[0];
  if (local && !/^\d+$/.test(local) && !local.includes('bot')) return local;
  // Fall back to a name that already carries the handle.
  m = /^@?([a-zA-Z0-9][a-zA-Z0-9-]{0,38})$/.exec((name || '').trim());
  return m ? m[1] : null;
}

/**
 * Collects contributors from commit authors and `Co-authored-by` trailers,
 * normalising handles case-insensitively and dropping bots / ghosts that would
 * render as `(@noreply)`.
 */
function collectContributors(commits) {
  const byHandle = new Map();
  const byIdentity = new Map();
  const add = (name, email, commit) => {
    const cleanName = (name || '').trim().replace(/[<>]/g, '');
    const handle = deriveUsername(commit, cleanName, email);
    const isGhost =
      !handle ||
      /\[bot\]|noreply/i.test(handle) ||
      /bot|\[bot\]/i.test(cleanName);
    if (isGhost) return;
    const key = (handle || '').toLowerCase();
    const existing = byHandle.get(key);
    if (existing) {
      existing.names.add(cleanName);
      return;
    }
    const identity = `${cleanName}|${(email || '').toLowerCase()}`;
    if (byIdentity.has(identity)) return;
    byIdentity.set(identity, true);
    byHandle.set(key, { handle, names: new Set([cleanName]) });
  };

  for (const commit of commits) {
    const a = commit.author;
    if (a && a.name) add(a.name, a.email, commit);
    const body = `${commit.body || ''} ${commit.subject || ''}`;
    const re = /Co-authored-by:\s*([^<]+?)\s*<([^>]+)>/g;
    let m;
    while ((m = re.exec(body))) add(m[1].trim(), m[2].trim(), null);
  }
  return byHandle;
}

/**
 * Renders the Contributors section from the collected handles, using the
 * shortest distinct display name per handle.
 */
function buildContributorsSection(commits) {
  const byHandle = collectContributors(commits);
  if (byHandle.size === 0) return '';
  const lines = [...byHandle.values()]
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .map(({ handle, names }) => {
      // Prefer the most human-looking display name: one that contains a space
      // or a capital letter (e.g. "Oleg Lučić") over bare handles / nicks, so a
      // single contributor who appears via multiple identities renders nicely.
      const byScore = (n) =>
        (/\s/.test(n) ? 2 : 0) + (/[A-ZÀ-ÿ]/.test(n) ? 1 : 0) + (/[a-z]/.test(n) ? 1 : 0);
      const name = [...names].sort((x, y) => byScore(y) - byScore(x))[0];
      return `- ${name} (@${handle})`;
    });
  return `## 🤝 Contributors\n\n${lines.join('\n')}\n`;
}

/**
 * Enforces first-feature-graduates-to-1.0.0 for pre-1.0 projects.
 * Semantic-release composes all plugins' analyzeCommits and takes the highest
 * level; we return 'major' only when the project is still 0.x and the release
 * contains a feature (or a breaking change already escalates it).
 */
async function analyzeCommits(pluginConfig, context) {
  const previousVersion = (context.lastRelease && context.lastRelease.version) || '0.0.0';
  const isPreOne = /^0\./.test(previousVersion);
  if (!isPreOne) return null;

  const commits = context.commits || [];
  const hasFeat = commits.some(c => /^feat(\(.*\))?!?:/i.test(c.message || c.subject));
  const hasBreaking = commits.some(
    c => /^feat\(.*\)!:|^feat!:|^fix!:|^BREAKING CHANGE:/im.test(c.message || c.subject)
  );

  // Breaking already yields major via the analyzer; we only need to force it
  // for the first plain feat.
  if (hasBreaking) return 'major';
  if (hasFeat) return 'major';
  return null;
}

module.exports = { analyzeCommits, generateNotes };