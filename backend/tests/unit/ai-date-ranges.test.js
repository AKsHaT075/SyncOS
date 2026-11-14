const { RANGES, compareSchedule, computeRange, dueWindow, mondayIndex, todayIn } = require('../../src/utils/aiDateRanges');

const at = (iso) => Date.parse(iso);
const range = (name, iso, timeZone) => computeRange({ range: name, nowMs: at(iso), timeZone });
const hours = (r) => (r.endMs - r.startMs) / 3600000;

describe('local days and the week (Monday to Sunday)', () => {
  test('"today" is the user\'s LOCAL date, not UTC: the same instant is different days in different zones', () => {
    const instant = '2026-11-14T20:00:00Z';
    expect(todayIn(at(instant), 'Asia/Kolkata')).toBe('2026-11-15'); // 01:30 Sunday in India
    expect(todayIn(at(instant), 'UTC')).toBe('2026-11-14');
    expect(todayIn(at(instant), 'America/Los_Angeles')).toBe('2026-11-14');
    expect(todayIn(at(instant), 'Pacific/Kiritimati')).toBe('2026-11-15'); // UTC+14
    expect(todayIn(at('2026-11-14T23:59:59.999Z'), 'Asia/Kolkata')).toBe('2026-11-15');
  });

  test.each([
    ['Mon', '2026-11-09', '2026-11-09'],
    ['Wed', '2026-11-11', '2026-11-09'],
    ['Sat', '2026-11-14', '2026-11-09'],
    ['Sun', '2026-11-15', '2026-11-09'], // Sunday belongs to the week that STARTED on Monday 9th
    ['next Mon', '2026-11-16', '2026-11-16'],
  ])('this_week on %s %s runs Monday %s to Sunday', (_d, today, monday) => {
    const r = range('this_week', `${today}T09:00:00Z`, 'UTC');
    expect(r.fromDate).toBe(monday);
    expect(r.toDate).toBe(new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10));
    expect(mondayIndex(r.fromDate)).toBe(0);
    expect(mondayIndex(r.toDate)).toBe(6);
  });

  test('rolling ranges start TODAY and are whole local days: next_7_days = today..+6, next_14_days = today..+13, today = one day', () => {
    expect(range('today', '2026-11-14T10:00:00Z', 'UTC')).toMatchObject({ fromDate: '2026-11-14', toDate: '2026-11-14' });
    expect(range('next_7_days', '2026-11-14T10:00:00Z', 'UTC')).toMatchObject({ fromDate: '2026-11-14', toDate: '2026-11-20' });
    expect(range('next_14_days', '2026-11-14T10:00:00Z', 'UTC')).toMatchObject({ fromDate: '2026-11-14', toDate: '2026-11-27' });
    expect(RANGES).toEqual(['today', 'next_7_days', 'this_week', 'next_14_days']);
  });

  test('month and year boundaries are plain calendar arithmetic', () => {
    expect(range('next_7_days', '2026-12-29T10:00:00Z', 'UTC').toDate).toBe('2027-01-04');
    expect(range('this_week', '2027-03-01T10:00:00Z', 'UTC')).toMatchObject({ fromDate: '2027-03-01', toDate: '2027-03-07' });
    expect(range('next_14_days', '2028-02-20T10:00:00Z', 'UTC').toDate).toBe('2028-03-04'); // leap year
  });

  test('an unknown range or an invalid timezone is refused, never guessed', () => {
    expect(() => range('last_week', '2026-11-14T10:00:00Z', 'UTC')).toThrow();
    for (const zone of ['Mars/Olympus', '', null, undefined, 'x'.repeat(80)]) expect(() => range('today', '2026-11-14T10:00:00Z', zone)).toThrow();
    expect(() => todayIn(0, 'Not/AZone')).toThrow();
  });
});

describe('instants (timestamps) versus floating dates (date-only)', () => {
  test('an India day is exactly 24 hours; its instants are 18:30Z the previous evening', () => {
    const r = range('today', '2026-11-14T10:00:00Z', 'Asia/Kolkata');
    expect(new Date(r.startMs).toISOString()).toBe('2026-11-13T18:30:00.000Z');
    expect(new Date(r.endMs).toISOString()).toBe('2026-11-14T18:30:00.000Z');
    expect(hours(r)).toBe(24);
  });

  test('date-only bounds are UTC-midnight Dates that NEVER shift with the timezone; instants do', () => {
    for (const zone of ['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      const r = range('today', '2026-11-14T12:00:00Z', zone);
      if (r.today === '2026-11-14') {
        expect(r.fromDateUtc.toISOString()).toBe('2026-11-14T00:00:00.000Z');
        expect(r.toDateUtc.toISOString()).toBe('2026-11-14T00:00:00.000Z');
      }
      expect(r.fromDateUtc.getUTCHours()).toBe(0);
    }
    // same wall-clock day, different zones: the INSTANT interval differs, the floating date does not
    const ist = range('today', '2026-11-14T10:00:00Z', 'Asia/Kolkata');
    const la = range('today', '2026-11-14T10:00:00Z', 'America/Los_Angeles');
    expect(ist.fromDate).toBe(la.fromDate);
    expect(ist.fromDateUtc.getTime()).toBe(la.fromDateUtc.getTime());
    expect(ist.startMs).not.toBe(la.startMs);
  });

  test('the server\'s own timezone has no influence', () => {
    const original = process.env.TZ;
    const results = [];
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        const r = range('this_week', '2026-11-14T20:00:00Z', 'Asia/Kolkata');
        results.push(JSON.stringify([r.today, r.fromDate, r.toDate, r.startMs, r.endMs, r.fromDateUtc.toISOString()]));
      }
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
    expect(new Set(results).size).toBe(1);
  });
});

describe('daylight-saving transitions (each boundary converted on its own)', () => {
  test('New York spring forward (2026-03-08): that local day is 23 hours; the week around it is 167 hours', () => {
    const day = range('today', '2026-03-08T15:00:00Z', 'America/New_York');
    expect(day).toMatchObject({ fromDate: '2026-03-08', toDate: '2026-03-08' });
    expect(new Date(day.startMs).toISOString()).toBe('2026-03-08T05:00:00.000Z'); // midnight EST (UTC-5)
    expect(new Date(day.endMs).toISOString()).toBe('2026-03-09T04:00:00.000Z'); // midnight EDT (UTC-4)
    expect(hours(day)).toBe(23);
    const week = range('this_week', '2026-03-08T15:00:00Z', 'America/New_York'); // Sunday: week began Monday 2nd
    expect(week).toMatchObject({ fromDate: '2026-03-02', toDate: '2026-03-08' });
    expect(hours(week)).toBe(7 * 24 - 1);
  });

  test('New York fall back (2026-11-01): that local day is 25 hours', () => {
    const day = range('today', '2026-11-01T12:00:00Z', 'America/New_York');
    expect(new Date(day.startMs).toISOString()).toBe('2026-11-01T04:00:00.000Z'); // midnight EDT (UTC-4)
    expect(new Date(day.endMs).toISOString()).toBe('2026-11-02T05:00:00.000Z'); // midnight EST (UTC-5)
    expect(hours(day)).toBe(25);
  });

  test('a rolling range across the change keeps whole local days (7 days spanning fall back = 169 hours)', () => {
    const r = range('next_7_days', '2026-10-30T12:00:00Z', 'America/New_York');
    expect(r).toMatchObject({ fromDate: '2026-10-30', toDate: '2026-11-05' });
    expect(hours(r)).toBe(7 * 24 + 1);
  });

  test('Europe/London (2026-03-29 forward, 2026-10-25 back) and a southern-hemisphere zone', () => {
    expect(hours(range('today', '2026-03-29T12:00:00Z', 'Europe/London'))).toBe(23);
    expect(hours(range('today', '2026-10-25T12:00:00Z', 'Europe/London'))).toBe(25);
    expect(hours(range('today', '2026-09-26T20:00:00Z', 'Pacific/Auckland'))).toBe(23); // NZ spring forward
    expect(hours(range('today', '2026-04-04T20:00:00Z', 'Pacific/Auckland'))).toBe(25); // NZ fall back
  });

  test('India has no daylight saving: every day of the year is 24 hours', () => {
    for (const month of ['2026-03-08', '2026-06-21', '2026-10-25', '2026-11-01']) expect(hours(range('today', `${month}T10:00:00Z`, 'Asia/Kolkata'))).toBe(24);
  });

  test('the instant of the first moment of a day is correct on the day the clocks move at midnight (Sao Paulo style gaps are handled by wallToUtc)', () => {
    // Asia/Beirut springs forward at 00:00 -> 01:00 on 2026-03-29: local midnight does not exist; the day must still start at the first real instant
    const r = range('today', '2026-03-29T12:00:00Z', 'Asia/Beirut');
    expect(r.endMs).toBeGreaterThan(r.startMs);
    expect(hours(r)).toBe(23);
  });
});

describe('task due windows (floating dates)', () => {
  const now = at('2026-11-14T10:00:00Z');
  const todayUtc = new Date('2026-11-14T00:00:00.000Z');

  test('overdue is STRICTLY before today: due today is not overdue', () => {
    const w = dueWindow({ due: 'overdue', nowMs: now, timeZone: 'Asia/Kolkata' });
    expect(w.filter).toEqual({ $ne: null, $lt: todayUtc });
    expect(w.today).toBe('2026-11-14');
  });
  test('today, none and the ranges', () => {
    expect(dueWindow({ due: 'today', nowMs: now, timeZone: 'Asia/Kolkata' }).filter).toEqual(todayUtc);
    expect(dueWindow({ due: 'none', nowMs: now, timeZone: 'Asia/Kolkata' }).filter).toBeNull();
    expect(dueWindow({ due: 'next_7_days', nowMs: now, timeZone: 'UTC' }).filter).toEqual({ $gte: todayUtc, $lte: new Date('2026-11-20T00:00:00.000Z') });
    expect(dueWindow({ due: 'this_week', nowMs: now, timeZone: 'UTC' }).filter).toEqual({ $gte: new Date('2026-11-09T00:00:00.000Z'), $lte: new Date('2026-11-15T00:00:00.000Z') });
  });
  test('the user\'s timezone decides what "today" is for a date-only deadline', () => {
    const late = at('2026-11-14T20:00:00Z');
    expect(dueWindow({ due: 'today', nowMs: late, timeZone: 'UTC' }).filter).toEqual(new Date('2026-11-14T00:00:00.000Z'));
    expect(dueWindow({ due: 'today', nowMs: late, timeZone: 'Asia/Kolkata' }).filter).toEqual(new Date('2026-11-15T00:00:00.000Z'));
  });
});

describe('schedule ordering', () => {
  const tz = 'Asia/Kolkata';
  const meeting = (id, start) => ({ id, allDay: false, start, title: id });
  const allDay = (id, date) => ({ id, allDay: true, startDate: date, title: id });
  test('chronological by LOCAL day; all-day entries first within a day; then start time; stable by title', () => {
    const items = [
      meeting('m-late', '2026-11-14T10:00:00.000Z'), // 15:30 IST on the 14th
      allDay('t-15', '2026-11-15'),
      meeting('m-early', '2026-11-14T04:00:00.000Z'), // 09:30 IST
      allDay('t-14', '2026-11-14'),
      meeting('m-night', '2026-11-14T19:00:00.000Z'), // 00:30 IST on the 15th (a different LOCAL day than its UTC date)
    ];
    expect(items.sort((a, b) => compareSchedule(a, b, tz)).map((i) => i.id)).toEqual(['t-14', 'm-early', 'm-late', 't-15', 'm-night']);
  });
});
