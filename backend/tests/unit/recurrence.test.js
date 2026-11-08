const { expandRecurrence, isOccurrenceOf, nthWeekdayOfMonth } = require('../../src/utils/recurrence');
const { LIMITS } = require('../../src/constants/calendar.constants');
const { localDateTimeOf, wallToUtc } = require('../../src/utils/timezone');

const NY = 'America/New_York';
const HOUR = 3600000;
const wall = (tz, y, m, d, h = 0, mi = 0) => wallToUtc({ year: y, month: m, day: d, hour: h, minute: mi }, tz);
const iso = (ms) => new Date(ms).toISOString();
const localStarts = (occurrences, tz) => occurrences.map((o) => localDateTimeOf(o.start, tz));

function series(tz, [y, m, d, h, mi], recurrence, durationHours = 1, extra = {}) {
  const start = wall(tz, y, m, d, h, mi);
  return { start, end: start + durationHours * HOUR, allDay: false, timezone: tz, recurrence, ...extra };
}
const range = (tz, from, to) => [wall(tz, ...from), wall(tz, ...to)];

describe('daily / weekly / monthly rules', () => {
  it('daily with an interval', () => {
    const event = series('UTC', [2026, 1, 1, 9, 0], { freq: 'daily', interval: 3 });
    const occ = expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 1, 15]));
    expect(localStarts(occ, 'UTC')).toEqual(['2026-01-01T09:00', '2026-01-04T09:00', '2026-01-07T09:00', '2026-01-10T09:00', '2026-01-13T09:00']);
  });

  it('weekly on selected weekdays, every 2 weeks (anchored to the first week)', () => {
    // Start Monday Jan 5 2026; Mon+Thu every 2 weeks.
    const event = series('UTC', [2026, 1, 5, 10, 0], { freq: 'weekly', interval: 2, byWeekday: [1, 4] });
    const occ = expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 2, 10]));
    expect(localStarts(occ, 'UTC').map((v) => v.slice(0, 10))).toEqual([
      '2026-01-05', '2026-01-08', '2026-01-19', '2026-01-22', '2026-02-02', '2026-02-05',
    ]);
  });

  it('weekly never produces dates before the series start (start mid-week)', () => {
    // Start Wednesday; byWeekday includes Monday: that week's Monday is before the start.
    const event = series('UTC', [2026, 1, 7, 10, 0], { freq: 'weekly', interval: 1, byWeekday: [1, 3] });
    const occ = expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 1, 20]));
    expect(localStarts(occ, 'UTC').map((v) => v.slice(0, 10))).toEqual(['2026-01-07', '2026-01-12', '2026-01-14', '2026-01-19']);
  });

  it('weekly defaults to the start date\'s weekday', () => {
    const event = series('UTC', [2026, 1, 7, 10, 0], { freq: 'weekly', interval: 1 });
    const occ = expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 1, 25]));
    expect(localStarts(occ, 'UTC').map((v) => v.slice(0, 10))).toEqual(['2026-01-07', '2026-01-14', '2026-01-21']);
  });

  it('monthly by date, clamping short months to their last day', () => {
    const event = series('UTC', [2026, 1, 31, 9, 0], { freq: 'monthly', interval: 1, monthly: { mode: 'date', day: 31 } });
    const occ = expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 5, 1]));
    expect(localStarts(occ, 'UTC').map((v) => v.slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('monthly by Nth weekday: 2nd Tuesday, and the last Friday', () => {
    const second = series('UTC', [2026, 1, 13, 9, 0], { freq: 'monthly', interval: 1, monthly: { mode: 'nthWeekday', nth: 2, weekday: 2 } });
    expect(localStarts(expandRecurrence(second, ...range('UTC', [2026, 1, 1], [2026, 5, 1])), 'UTC').map((v) => v.slice(0, 10)))
      .toEqual(['2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14']);

    const last = series('UTC', [2026, 1, 30, 9, 0], { freq: 'monthly', interval: 1, monthly: { mode: 'nthWeekday', nth: -1, weekday: 5 } });
    expect(localStarts(expandRecurrence(last, ...range('UTC', [2026, 1, 1], [2026, 5, 1])), 'UTC').map((v) => v.slice(0, 10)))
      .toEqual(['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
  });

  it('monthly every 2 months and nthWeekday helper edge cases', () => {
    const event = series('UTC', [2026, 1, 15, 9, 0], { freq: 'monthly', interval: 2, monthly: { mode: 'date', day: 15 } });
    expect(localStarts(expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 8, 1])), 'UTC').map((v) => v.slice(0, 7)))
      .toEqual(['2026-01', '2026-03', '2026-05', '2026-07']);
    expect(nthWeekdayOfMonth(2026, 2, 5, 1)).toBeNull(); // February 2026 has no 5th Monday
    expect(nthWeekdayOfMonth(2026, 3, -1, 0)).toBe(29); // last Sunday of March 2026
  });

  it('a rule never yields a date before the series start, and occurrences are the rule\'s dates', () => {
    // 4th Friday, series starting on the 4th Friday of January (the 23rd).
    const event = series('UTC', [2026, 1, 23, 9, 0], { freq: 'monthly', interval: 1, monthly: { mode: 'nthWeekday', nth: 4, weekday: 5 } });
    expect(localStarts(expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 4, 1])), 'UTC').map((v) => v.slice(0, 10)))
      .toEqual(['2026-01-23', '2026-02-27', '2026-03-27']);
  });
});

describe('end conditions', () => {
  it('COUNT limits the total number of occurrences, counted from the series start', () => {
    const event = series('UTC', [2026, 1, 1, 9, 0], { freq: 'daily', interval: 1, count: 5 });
    expect(expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 12, 31]))).toHaveLength(5);
    // A window after the 5th occurrence sees none; one overlapping the tail sees only the remaining ones.
    expect(expandRecurrence(event, ...range('UTC', [2026, 1, 6], [2026, 12, 31]))).toHaveLength(0);
    expect(localStarts(expandRecurrence(event, ...range('UTC', [2026, 1, 4], [2026, 1, 10])), 'UTC').map((v) => v.slice(0, 10))).toEqual(['2026-01-04', '2026-01-05']);
  });

  it('UNTIL is inclusive of an occurrence starting exactly then', () => {
    const until = new Date(wall('UTC', 2026, 1, 5, 9, 0));
    const event = series('UTC', [2026, 1, 1, 9, 0], { freq: 'daily', interval: 1, until });
    expect(expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2026, 2, 1]))).toHaveLength(5);
  });

  it('is bounded: a series with no end only yields what the window asks for', () => {
    const event = series('UTC', [2020, 1, 1, 9, 0], { freq: 'daily', interval: 1 });
    const occ = expandRecurrence(event, ...range('UTC', [2026, 6, 1], [2026, 6, 8]));
    expect(occ).toHaveLength(7);
  });

  it('never exceeds the occurrence limit', () => {
    const event = series('UTC', [2026, 1, 1, 9, 0], { freq: 'daily', interval: 1 });
    expect(expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2030, 1, 1]), { limit: 50 })).toHaveLength(50);
    expect(expandRecurrence(event, ...range('UTC', [2026, 1, 1], [2040, 1, 1])).length).toBeLessThanOrEqual(LIMITS.MAX_OCCURRENCES_PER_REQUEST);
  });

  it('returns nothing for an empty or reversed window or no rule', () => {
    const event = series('UTC', [2026, 1, 1, 9, 0], { freq: 'daily', interval: 1 });
    expect(expandRecurrence(event, 100, 100)).toEqual([]);
    expect(expandRecurrence(event, 200, 100)).toEqual([]);
    expect(expandRecurrence({ ...event, recurrence: null }, 0, 1e15)).toEqual([]);
  });
});

describe('fast-forward is equivalent to expanding from the start', () => {
  it.each([
    ['daily x3', { freq: 'daily', interval: 3 }],
    ['weekly x2 Mon/Fri', { freq: 'weekly', interval: 2, byWeekday: [1, 5] }],
    ['monthly day 31', { freq: 'monthly', interval: 1, monthly: { mode: 'date', day: 31 } }],
    ['monthly 3rd Wednesday x2', { freq: 'monthly', interval: 2, monthly: { mode: 'nthWeekday', nth: 3, weekday: 3 } }],
  ])('%s', (name, rule) => {
    const event = series(NY, [2024, 2, 29, 9, 0], rule);
    const [from, to] = range(NY, [2026, 3, 1], [2026, 6, 30]);
    // count is only used to force the "iterate from the start" path in the reference
    const slow = expandRecurrence({ ...event, recurrence: { ...rule, count: 5000 } }, from, to, { limit: 5000 });
    const fast = expandRecurrence(event, from, to);
    expect(fast.map((o) => o.originalStart)).toEqual(slow.map((o) => o.originalStart));
    expect(fast.length).toBeGreaterThan(0);
  });
});

describe('daylight saving: the WALL CLOCK is what repeats', () => {
  it('"every Monday 09:00 New York" stays 09:00 local across spring-forward (UTC instant shifts)', () => {
    const event = series(NY, [2026, 3, 2, 9, 0], { freq: 'weekly', interval: 1, byWeekday: [1] });
    const occ = expandRecurrence(event, ...range(NY, [2026, 3, 1], [2026, 3, 24]));
    expect(localStarts(occ, NY)).toEqual(['2026-03-02T09:00', '2026-03-09T09:00', '2026-03-16T09:00', '2026-03-23T09:00']);
    expect(occ.map((o) => iso(o.start))).toEqual([
      '2026-03-02T14:00:00.000Z', // EST
      '2026-03-09T13:00:00.000Z', // EDT: an hour earlier in UTC
      '2026-03-16T13:00:00.000Z',
      '2026-03-23T13:00:00.000Z',
    ]);
  });

  it('and across fall-back', () => {
    const event = series(NY, [2026, 10, 26, 9, 0], { freq: 'weekly', interval: 1, byWeekday: [1] });
    const occ = expandRecurrence(event, ...range(NY, [2026, 10, 25], [2026, 11, 10]));
    expect(localStarts(occ, NY)).toEqual(['2026-10-26T09:00', '2026-11-02T09:00', '2026-11-09T09:00']);
    expect(occ.map((o) => iso(o.start))).toEqual(['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z']);
  });

  it('a daily 02:30 event on the spring-forward day moves to 03:30 for that day only, then returns to 02:30', () => {
    const event = series(NY, [2026, 3, 6, 2, 30], { freq: 'daily', interval: 1 });
    const occ = expandRecurrence(event, ...range(NY, [2026, 3, 6], [2026, 3, 11]));
    expect(localStarts(occ, NY)).toEqual(['2026-03-06T02:30', '2026-03-07T02:30', '2026-03-08T03:30', '2026-03-09T02:30', '2026-03-10T02:30']);
  });

  it('a daily 01:30 event on the fall-back day occurs once (first occurrence), not twice', () => {
    const event = series(NY, [2026, 10, 31, 1, 30], { freq: 'daily', interval: 1 });
    const occ = expandRecurrence(event, ...range(NY, [2026, 10, 31], [2026, 11, 3]));
    expect(occ).toHaveLength(3);
    expect(iso(occ[1].start)).toBe('2026-11-01T05:30:00.000Z');
  });

  it('keeps the absolute duration even when a transition falls inside the event', () => {
    const event = series(NY, [2026, 3, 7, 23, 0], { freq: 'daily', interval: 1 }, 4); // 23:00 + 4h spans spring-forward night
    const [night] = expandRecurrence(event, ...range(NY, [2026, 3, 7], [2026, 3, 8]));
    expect(night.end - night.start).toBe(4 * HOUR);
  });

  it('works for zones with half-hour offsets and for southern-hemisphere DST', () => {
    const kolkata = series('Asia/Kolkata', [2026, 1, 5, 9, 30], { freq: 'daily', interval: 1 });
    expect(expandRecurrence(kolkata, ...range('Asia/Kolkata', [2026, 1, 5], [2026, 1, 8])).map((o) => iso(o.start)))
      .toEqual(['2026-01-05T04:00:00.000Z', '2026-01-06T04:00:00.000Z', '2026-01-07T04:00:00.000Z']);

    const sydney = series('Australia/Sydney', [2026, 4, 3, 9, 0], { freq: 'daily', interval: 1 }); // AEDT ends Apr 5 2026
    const occ = expandRecurrence(sydney, ...range('Australia/Sydney', [2026, 4, 3], [2026, 4, 8]));
    expect(localStarts(occ, 'Australia/Sydney').every((v) => v.endsWith('T09:00'))).toBe(true);
    expect(iso(occ[0].start)).toBe('2026-04-02T22:00:00.000Z'); // UTC+11
    expect(iso(occ[4].start)).toBe('2026-04-06T23:00:00.000Z'); // Apr 7 09:00 at UTC+10 (AEST)
  });
});

describe('all-day series are floating dates', () => {
  it('repeats on the same calendar dates regardless of any timezone', () => {
    const start = Date.UTC(2026, 2, 6);
    const event = { start, end: start + 86400000, allDay: true, timezone: NY, recurrence: { freq: 'daily', interval: 1 } };
    const occ = expandRecurrence(event, Date.UTC(2026, 2, 5), Date.UTC(2026, 2, 12));
    expect(occ.map((o) => new Date(o.start).toISOString().slice(0, 10))).toEqual([
      '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11',
    ]);
    occ.forEach((o) => expect(o.end - o.start).toBe(86400000)); // always exactly one day, even over DST
  });
});

describe('stable identity', () => {
  it('occurrence identity (originalStart) is unchanged by editing the series title or by a window shift', () => {
    const event = series(NY, [2026, 3, 2, 9, 0], { freq: 'weekly', interval: 1, byWeekday: [1] });
    const a = expandRecurrence(event, ...range(NY, [2026, 3, 1], [2026, 3, 20]));
    const b = expandRecurrence({ ...event, title: 'renamed' }, ...range(NY, [2026, 3, 8], [2026, 5, 1]));
    const shared = a.map((o) => o.originalStart).filter((id) => b.some((o) => o.originalStart === id));
    expect(shared.length).toBeGreaterThan(0);
  });

  it('isOccurrenceOf accepts real occurrences and rejects forged ones', () => {
    const event = series(NY, [2026, 3, 2, 9, 0], { freq: 'weekly', interval: 1, byWeekday: [1] });
    expect(isOccurrenceOf(event, wall(NY, 2026, 3, 16, 9, 0))).toBe(true);
    expect(isOccurrenceOf(event, wall(NY, 2026, 3, 17, 9, 0))).toBe(false); // a Tuesday
    expect(isOccurrenceOf(event, wall(NY, 2026, 3, 16, 9, 1))).toBe(false); // wrong minute
    expect(isOccurrenceOf(event, wall(NY, 2026, 2, 23, 9, 0))).toBe(false); // before the series start
    const counted = series(NY, [2026, 3, 2, 9, 0], { freq: 'weekly', interval: 1, byWeekday: [1], count: 3 });
    expect(isOccurrenceOf(counted, wall(NY, 2026, 3, 16, 9, 0))).toBe(true); // the 3rd and last
    expect(isOccurrenceOf(counted, wall(NY, 2026, 3, 23, 9, 0))).toBe(false); // the 4th is past COUNT
  });
});
