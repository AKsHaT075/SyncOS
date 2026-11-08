import { minutesInZone, ymdInZone } from "@/features/calendar/utils/dates";

const DAY_MINUTES = 1440;
const MIN_BLOCK_MINUTES = 24;

/**
 * Positions timed items inside one day column of the week/day grid.
 *  - Items are clipped to the day (a block that started yesterday starts at the top).
 *  - Overlapping items are packed into side-by-side columns: each cluster of mutually
 *    overlapping items shares the width equally, and an item takes the first free column.
 * Returns [{ item, top, height, left, width }] with top/height in minutes and left/width in percent.
 */
export function layoutDay(items, day, timeZone) {
  const blocks = items
    .filter((item) => !item.allDay)
    .map((item) => {
      const start = new Date(item.start).getTime();
      const end = Math.max(new Date(item.end).getTime(), start + 1);
      const startsToday = ymdInZone(start, timeZone) === day;
      const endsToday = ymdInZone(end - 1, timeZone) === day;
      const top = startsToday ? minutesInZone(start, timeZone) : 0;
      const bottom = endsToday ? Math.max(minutesInZone(end - 1, timeZone) + 1, top + 1) : DAY_MINUTES;
      return { item, start, top, bottom: Math.max(bottom, top + MIN_BLOCK_MINUTES) };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  const placed = [];
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const columns = [];
    cluster.forEach((block) => {
      let column = columns.findIndex((end) => end <= block.top);
      if (column === -1) {
        column = columns.length;
        columns.push(block.bottom);
      } else {
        columns[column] = block.bottom;
      }
      block.column = column;
    });
    cluster.forEach((block) => {
      placed.push({
        item: block.item,
        top: block.top,
        height: Math.min(block.bottom, DAY_MINUTES) - block.top,
        left: (block.column / columns.length) * 100,
        width: 100 / columns.length,
      });
    });
    cluster = [];
  };

  blocks.forEach((block) => {
    if (cluster.length && block.top >= clusterEnd) flush();
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.bottom);
    if (cluster.length === 1) clusterEnd = block.bottom;
  });
  flush();
  return placed;
}
