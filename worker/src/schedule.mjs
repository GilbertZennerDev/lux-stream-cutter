// Mirrors src/lib/schedule.ts — Tue/Wed/Thu 14:00–18:00 Europe/Luxembourg.
const TZ = "Europe/Luxembourg";

export const SCHEDULE = {
  weekdays: [2, 3, 4], // Tue, Wed, Thu
  startHour: 14,
  endHour: 18,
};

function luxParts(d) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

function luxLocalToUtc(y, m, d, hour) {
  for (const offset of [1, 2]) {
    const utc = new Date(Date.UTC(y, m - 1, d, hour - offset, 0, 0));
    const p = luxParts(utc);
    if (p.year === y && p.month === m && p.day === d && p.hour === hour) return utc;
  }
  return new Date(Date.UTC(y, m - 1, d, hour - 1, 0, 0));
}

function isoDate(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function nextSessionWindow(now = new Date()) {
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 86400_000);
    const p = luxParts(probe);
    if (!SCHEDULE.weekdays.includes(p.weekday)) continue;
    const start = luxLocalToUtc(p.year, p.month, p.day, SCHEDULE.startHour);
    const end = luxLocalToUtc(p.year, p.month, p.day, SCHEDULE.endHour);
    if (end.getTime() <= now.getTime()) continue;
    return { start, end, sessionDate: isoDate(p.year, p.month, p.day) };
  }
  const p = luxParts(now);
  return {
    start: luxLocalToUtc(p.year, p.month, p.day, SCHEDULE.startHour),
    end: luxLocalToUtc(p.year, p.month, p.day, SCHEDULE.endHour),
    sessionDate: isoDate(p.year, p.month, p.day),
  };
}

export function isInSession(now = new Date()) {
  const w = nextSessionWindow(now);
  if (now >= w.start && now < w.end) return w;
  return null;
}
