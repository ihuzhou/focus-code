const presets = { today: [0, 1], yesterday: [-1, 0], lastTwoDays: [-1, 1], lastSevenDays: [-6, 1], lastThirtyDays: [-29, 1] };

function midnight(date, offset = 0) {
  const start = new Date(date);
  start.setDate(start.getDate() + offset);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function dateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

// UI dates use the viewer's local calendar. The server filters on a half-open interval.
export function timeBounds({ period, start, end }, now = new Date()) {
  if (period === 'all') return {};
  if (period === 'custom') {
    const first = dateInput(start);
    const last = dateInput(end);
    if (!first || !last || first > last) return null;
    return { from: midnight(first), until: midnight(last, 1) };
  }
  if (!Object.hasOwn(presets, period)) return null;
  const [startOffset, endOffset] = presets[period];
  return { from: midnight(now, startOffset), until: midnight(now, endOffset) };
}
