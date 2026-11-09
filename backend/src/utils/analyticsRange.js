const AppError = require('./app-error');
const { ANALYTICS_LIMITS } = require('../constants/analytics.constants');
const { addDaysToDateString, localDateOf, parseDateOnly, wallToUtc } = require('./timezone');

const DAY_MS = 86400000;

/** Start of the local calendar day `date` ('YYYY-MM-DD') in `timeZone`, as a UTC instant. */
function startOfLocalDay(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(wallToUtc({ year, month, day }, timeZone));
}

/**
 * Turns the request's date range into everything the queries need.
 *  - `from`/`to` are inclusive calendar days in `timeZone` (default: the last 30 days).
 *  - `start`/`end` are the matching UTC instants (end is exclusive) for timestamp fields (createdAt, completedAt…).
 *  - `todayMs` is today's date as a floating date-only value (UTC midnight), for comparing due dates, which are
 *    never shifted by a timezone.
 *  - Ranges longer than 92 days are bucketed by month, otherwise by day; the bucket labels are generated up front
 *    so empty periods appear as zeros.
 */
function resolveRange({ from, to } = {}, timeZone, now = Date.now()) {
  const today = localDateOf(now, timeZone);
  const end = to || today;
  const start = from || addDaysToDateString(end, -(ANALYTICS_LIMITS.DEFAULT_RANGE_DAYS - 1));
  const startMs = parseDateOnly(start);
  const endMs = parseDateOnly(end);
  if (startMs === null || endMs === null) throw new AppError('Use dates in YYYY-MM-DD format', 400, 'INVALID_RANGE');
  if (startMs > endMs) throw new AppError('The start date must not be after the end date', 400, 'INVALID_RANGE');
  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  if (days > ANALYTICS_LIMITS.MAX_RANGE_DAYS) {
    throw new AppError(`Choose a range of at most ${ANALYTICS_LIMITS.MAX_RANGE_DAYS} days`, 400, 'RANGE_TOO_LARGE');
  }

  const granularity = days <= ANALYTICS_LIMITS.DAILY_BUCKET_MAX_DAYS ? 'day' : 'month';
  const format = granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';
  const buckets = [];
  for (let offset = 0; offset < days; offset += 1) {
    const label = addDaysToDateString(start, offset);
    const bucket = granularity === 'day' ? label : label.slice(0, 7);
    if (buckets[buckets.length - 1] !== bucket) buckets.push(bucket);
  }

  return {
    from: start,
    to: end,
    days,
    timeZone,
    granularity,
    format,
    buckets,
    today,
    todayMs: parseDateOnly(today),
    start: startOfLocalDay(start, timeZone),
    end: startOfLocalDay(addDaysToDateString(end, 1), timeZone),
  };
}

/** Mongo expression that buckets a timestamp field in the range's timezone. */
const bucketExpr = (field, range) => ({ $dateToString: { format: range.format, date: field, timezone: range.timeZone } });

/** Fills a [{_id: bucket, ...}] aggregation result into a dense series over the range's buckets. */
function denseSeries(rows, range, keys) {
  const byBucket = new Map(rows.map((row) => [row._id, row]));
  return range.buckets.map((bucket) => {
    const row = byBucket.get(bucket) || {};
    return Object.fromEntries([['date', bucket], ...keys.map((key) => [key, row[key] || 0])]);
  });
}

module.exports = { bucketExpr, denseSeries, resolveRange, startOfLocalDay };
