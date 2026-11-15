const { resolveRange } = require('../../src/utils/analyticsRange');
const { cacheKey } = require('../../src/services/analytics/cache');

const NOW = Date.parse('2026-11-08T20:00:00Z'); // 01:30 on 9 Nov in IST, still 8 Nov in New York

describe('resolveRange', () => {
  it('defaults to the last 30 days, ending today in the given timezone', () => {
    const ist = resolveRange({}, 'Asia/Kolkata', NOW);
    expect(ist).toMatchObject({ to: '2026-11-09', from: '2026-10-11', days: 30, granularity: 'day', today: '2026-11-09' });
    const ny = resolveRange({}, 'America/New_York', NOW);
    expect(ny).toMatchObject({ to: '2026-11-08', today: '2026-11-08' });
  });

  it('turns calendar days into the matching UTC instants (end exclusive)', () => {
    const range = resolveRange({ from: '2026-11-01', to: '2026-11-02' }, 'Asia/Kolkata', NOW);
    expect(range.start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-02T18:30:00.000Z');
    expect(range.buckets).toEqual(['2026-11-01', '2026-11-02']);
  });

  it('exposes today as a floating date-only value (UTC midnight), never shifted by the timezone', () => {
    expect(new Date(resolveRange({}, 'Asia/Kolkata', NOW).todayMs).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(new Date(resolveRange({}, 'America/New_York', NOW).todayMs).toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  it('switches to monthly buckets beyond 92 days and refuses unbounded ranges', () => {
    const long = resolveRange({ from: '2026-01-01', to: '2026-06-30' }, 'Asia/Kolkata', NOW);
    expect(long.granularity).toBe('month');
    expect(long.buckets).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(() => resolveRange({ from: '2025-01-01', to: '2026-06-30' }, 'Asia/Kolkata', NOW)).toThrow(/at most 366/);
    expect(() => resolveRange({ from: '2026-05-02', to: '2026-05-01' }, 'Asia/Kolkata', NOW)).toThrow(/must not be after/);
    expect(() => resolveRange({ from: '2026-02-30', to: '2026-03-01' }, 'Asia/Kolkata', NOW)).toThrow(/YYYY-MM-DD/);
  });
});

describe('cache keys', () => {
  const base = { organization: 'org1', actor: { _id: 'u1' }, role: 'manager', permissions: ['VIEW_ANALYTICS'], fingerprint: 'f1', timeZone: 'Asia/Kolkata' };
  const parts = (scope = {}, extra = {}) => ({ scope: { ...base, ...scope }, endpoint: 'tasks', filters: {}, range: { from: '2026-11-01', to: '2026-11-08' }, ...extra });

  it.each([
    ['organization', { organization: 'org2' }],
    ['user', { actor: { _id: 'u2' } }],
    ['role', { role: 'hr' }],
    ['permissions', { permissions: ['VIEW_ANALYTICS', 'VIEW_ASSETS'] }],
    ['resolved scope (teams / project membership)', { fingerprint: 'f2' }],
    ['timezone', { timeZone: 'America/New_York' }],
  ])('changes when the %s changes', (_name, change) => {
    expect(cacheKey(parts(change))).not.toBe(cacheKey(parts()));
  });

  it('changes with the endpoint, filters and date range', () => {
    const key = cacheKey(parts());
    expect(cacheKey(parts({}, { endpoint: 'people' }))).not.toBe(key);
    expect(cacheKey(parts({}, { filters: { teamId: 'a' } }))).not.toBe(key);
    expect(cacheKey(parts({}, { range: { from: '2026-11-02', to: '2026-11-08' } }))).not.toBe(key);
  });
});
