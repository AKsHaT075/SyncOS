const {
  addDaysToDateString,
  dateOnlyString,
  isValidTimeZone,
  localDateOf,
  localDateTimeOf,
  offsetMinutes,
  parseDateOnly,
  parseDateTime,
  wallToUtc,
  zonedParts,
} = require('../../src/utils/timezone');

const NY = 'America/New_York';
const iso = (ms) => new Date(ms).toISOString();
const wall = (tz, year, month, day, hour = 0, minute = 0) => wallToUtc({ year, month, day, hour, minute }, tz);

describe('zone validation & offsets', () => {
  it('validates IANA names', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    ['', 'Mars/Olympus', 'EST5EDT; DROP', null, undefined, 42, 'x'.repeat(70)].forEach((value) => expect(isValidTimeZone(value)).toBe(false));
  });

  it('knows real offsets, including half-hour and DST-less zones', () => {
    const winter = Date.UTC(2026, 0, 15, 12);
    const summer = Date.UTC(2026, 6, 15, 12);
    expect(offsetMinutes(winter, NY)).toBe(-300);
    expect(offsetMinutes(summer, NY)).toBe(-240);
    expect(offsetMinutes(winter, 'Asia/Kolkata')).toBe(330); // +05:30
    expect(offsetMinutes(summer, 'Asia/Kolkata')).toBe(330); // no DST
    expect(offsetMinutes(winter, 'Europe/London')).toBe(0);
    expect(offsetMinutes(summer, 'Europe/London')).toBe(60);
  });

  it('handles a 30-minute DST shift (Lord Howe)', () => {
    // Summer (Jan) +11:00, winter (Jul) +10:30
    expect(offsetMinutes(Date.UTC(2026, 0, 15), 'Australia/Lord_Howe')).toBe(660);
    expect(offsetMinutes(Date.UTC(2026, 6, 15), 'Australia/Lord_Howe')).toBe(630);
  });

  it('zonedParts reports the local wall clock and weekday', () => {
    expect(zonedParts(Date.UTC(2026, 2, 9, 13, 0), NY)).toMatchObject({ year: 2026, month: 3, day: 9, hour: 9, minute: 0, weekday: 1 });
    // Midnight rolls to the next day for zones ahead of UTC.
    expect(zonedParts(Date.UTC(2026, 0, 1, 20, 0), 'Asia/Tokyo')).toMatchObject({ month: 1, day: 2, hour: 5 });
  });
});

describe('wall-clock -> UTC across daylight saving', () => {
  it('ordinary times map one-to-one and round-trip', () => {
    const ms = wall(NY, 2026, 6, 15, 9, 30);
    expect(iso(ms)).toBe('2026-06-15T13:30:00.000Z');
    expect(localDateTimeOf(ms, NY)).toBe('2026-06-15T09:30');
    expect(wall(NY, 2026, 1, 15, 9, 30)).toBe(Date.UTC(2026, 0, 15, 14, 30));
  });

  it('SPRING FORWARD: a time inside the skipped hour moves forward by the gap (02:30 -> 03:30 EDT)', () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT, so 02:30 does not exist.
    expect(iso(wall(NY, 2026, 3, 8, 2, 30))).toBe('2026-03-08T07:30:00.000Z');
    expect(localDateTimeOf(wall(NY, 2026, 3, 8, 2, 30), NY)).toBe('2026-03-08T03:30');
    // Just before and after the gap are untouched.
    expect(iso(wall(NY, 2026, 3, 8, 1, 59))).toBe('2026-03-08T06:59:00.000Z');
    expect(iso(wall(NY, 2026, 3, 8, 3, 0))).toBe('2026-03-08T07:00:00.000Z');
  });

  it('FALL BACK: an ambiguous time resolves to the FIRST occurrence (01:30 EDT, not EST)', () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice.
    expect(iso(wall(NY, 2026, 11, 1, 1, 30))).toBe('2026-11-01T05:30:00.000Z'); // EDT, UTC-4
    expect(iso(wall(NY, 2026, 11, 1, 2, 0))).toBe('2026-11-01T07:00:00.000Z'); // after the repeat: EST
  });

  it('the same wall time lands on different UTC instants either side of a transition', () => {
    const before = wall(NY, 2026, 3, 7, 9, 0);
    const after = wall(NY, 2026, 3, 9, 9, 0);
    expect(iso(before)).toBe('2026-03-07T14:00:00.000Z');
    expect(iso(after)).toBe('2026-03-09T13:00:00.000Z');
    expect(after - before).toBe(47 * 3600 * 1000); // 2 days minus the lost hour
  });

  it('works in the southern hemisphere, Europe and zones with unusual transitions', () => {
    expect(iso(wall('Europe/London', 2026, 3, 29, 1, 30))).toBe('2026-03-29T01:30:00.000Z'); // 01:30 doesn't exist (01:00-02:00 skipped) -> 02:30 BST
    expect(iso(wall('Australia/Sydney', 2026, 10, 4, 2, 30))).toBe('2026-10-03T16:30:00.000Z'); // gap -> 03:30 AEDT
    expect(iso(wall('Pacific/Auckland', 2026, 4, 5, 2, 30))).toBe('2026-04-04T13:30:00.000Z'); // overlap -> first (NZDT)
    expect(iso(wall('Asia/Kolkata', 2026, 5, 1, 9, 0))).toBe('2026-05-01T03:30:00.000Z');
  });

  it('UTC is the identity', () => {
    expect(wall('UTC', 2026, 5, 1, 9, 0)).toBe(Date.UTC(2026, 4, 1, 9, 0));
  });
});

describe('date-only values never shift', () => {
  it('parses and formats floating dates without any timezone', () => {
    const ms = parseDateOnly('2026-11-20');
    expect(ms).toBe(Date.UTC(2026, 10, 20));
    expect(dateOnlyString(ms)).toBe('2026-11-20');
    // Independent of the process timezone: round-trips for every day of a DST year.
    for (let day = 0; day < 366; day += 1) {
      const value = dateOnlyString(Date.UTC(2026, 0, 1) + day * 86400000);
      expect(dateOnlyString(parseDateOnly(value))).toBe(value);
    }
  });

  it('rejects impossible and malformed dates', () => {
    ['2026-02-30', '2026-13-01', '2026-1-1', 'tomorrow', '', null, '2026-11-20T00:00'].forEach((value) => expect(parseDateOnly(value)).toBeNull());
    expect(parseDateOnly('2028-02-29')).not.toBeNull(); // leap day
    expect(parseDateOnly('2027-02-29')).toBeNull();
  });

  it('adds days across month and year ends', () => {
    expect(addDaysToDateString('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDateString('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('localDateOf shows the viewer\'s calendar day for an instant', () => {
    const ms = Date.UTC(2026, 10, 20, 2, 30); // 02:30Z
    expect(localDateOf(ms, 'UTC')).toBe('2026-11-20');
    expect(localDateOf(ms, NY)).toBe('2026-11-19'); // still the evening before in New York
    expect(localDateOf(ms, 'Asia/Tokyo')).toBe('2026-11-20');
  });
});

describe('parseDateTime', () => {
  it('interprets wall-clock strings in the given zone and ISO instants as-is', () => {
    expect(iso(parseDateTime('2026-06-15T09:30', NY))).toBe('2026-06-15T13:30:00.000Z');
    expect(iso(parseDateTime('2026-06-15T09:30:00', 'UTC'))).toBe('2026-06-15T09:30:00.000Z');
    expect(iso(parseDateTime('2026-06-15T13:30:00Z', NY))).toBe('2026-06-15T13:30:00.000Z'); // zone ignored for instants
    expect(iso(parseDateTime('2026-06-15T09:30:00-04:00', 'Asia/Tokyo'))).toBe('2026-06-15T13:30:00.000Z');
  });

  it('rejects garbage', () => {
    ['not a date', '2026-06-15', '2026-02-30T10:00', '2026-06-15T25:00', null, 7].forEach((value) => expect(parseDateTime(value, NY)).toBeNull());
  });
});
