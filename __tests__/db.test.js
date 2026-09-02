describe('voteCommunityChannel transaction', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let client;

  beforeEach(() => {
    jest.resetModules();
    process.env.DATABASE_URL = 'postgres://example.invalid/test';
    client = {
      query: jest.fn(async sql => {
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ community_channel_id: 7, votes: 3 }] };
        }
        if (sql.includes('SELECT canonical_id')) {
          return { rows: [{ canonical_id: 'iptvo_Community.us' }] };
        }
        return { rows: [] };
      }),
      release: jest.fn()
    };
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
      on: jest.fn(),
      query: jest.fn()
    };
    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    jest.restoreAllMocks();
  });

  test('commits the vote, override, and alias promotion together', async () => {
const { voteCommunityChannel } = require('../src/db');

    await expect(voteCommunityChannel({
      communityChannelId: 7,
      rawName: 'Community',
      scope: 'us',
      configKey: 'user-1'
    })).resolves.toEqual({ canonicalId: 'iptvo_Community.us', voteCount: 3, promoted: true });

    const queries = client.query.mock.calls.map(([sql]) => sql);
    expect(queries[0]).toBe('BEGIN');
    expect(queries.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(queries.some(sql => sql.includes('INSERT INTO community_channel_votes'))).toBe(true);
    expect(queries.some(sql => sql.includes('INSERT INTO ai_overrides'))).toBe(true);
    expect(queries.some(sql => sql.includes('UPDATE community_channels'))).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back and propagates an override failure', async () => {
    const overrideError = new Error('override failed');
    client.query.mockImplementation(async sql => {
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ community_channel_id: 7, votes: 1 }] };
      }
      if (sql.includes('SELECT canonical_id')) {
        return { rows: [{ canonical_id: 'iptvo_Community.us' }] };
      }
      if (sql.includes('INSERT INTO ai_overrides')) throw overrideError;
      return { rows: [] };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
const { voteCommunityChannel } = require('../src/db');

    await expect(voteCommunityChannel({
      communityChannelId: 7,
      rawName: 'Community',
      scope: 'us',
      configKey: 'user-1'
    })).rejects.toBe(overrideError);

    const queries = client.query.mock.calls.map(([sql]) => sql);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
