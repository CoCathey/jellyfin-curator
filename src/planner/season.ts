/** Time-of-year context for the planner. Pure: everything derives from the
 * given instant (UTC calendar), so tests inject dates and the output never
 * carries a machine-readable date that could look like part of the catalog.
 * Northern hemisphere only; the household is in the United States. */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Per-month season and the feel a video-store clerk would write on the card. */
const MONTH_MOOD: ReadonlyArray<{ season: string; feel: string }> = [
  { season: "winter", feel: "the year has just turned; long nights, fresh starts, staying in" },
  { season: "winter", feel: "deep winter with the first stirrings of spring; romance and cabin fever" },
  { season: "spring", feel: "winter loosening its grip; wind, mud and restlessness" },
  { season: "spring", feel: "spring proper; rain, blossom, everything waking up" },
  { season: "spring", feel: "long light evenings; the year opening outward" },
  { season: "summer", feel: "early summer; school out, days at their longest" },
  { season: "summer", feel: "high summer; heat, holidays, late sunsets" },
  { season: "summer", feel: "late summer; the heat slowing down, the end of it in sight" },
  { season: "autumn", feel: "school back, first cool evenings, the last of summer" },
  { season: "autumn", feel: "short days, fog and leaves, things going bump" },
  { season: "autumn", feel: "grey skies, early dark, gathering indoors" },
  { season: "winter", feel: "the dark of the year; lights, feasts and the year closing" },
];

/** How far ahead an occasion is worth mentioning. */
const LOOKAHEAD_DAYS = 56;
const DAY_MS = 86_400_000;

const utc = (year: number, month: number, day: number): Date => new Date(Date.UTC(year, month, day));

/** Anonymous Gregorian algorithm. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** Fourth Thursday of November. */
export function thanksgiving(year: number): Date {
  const firstOfNovember = utc(year, 10, 1);
  const firstThursday = 1 + ((4 - firstOfNovember.getUTCDay() + 7) % 7);
  return utc(year, 10, firstThursday + 21);
}

function occasions(year: number): Array<{ name: string; date: Date }> {
  return [
    { name: "New Year's Day", date: utc(year, 0, 1) },
    { name: "Valentine's Day", date: utc(year, 1, 14) },
    { name: "St Patrick's Day", date: utc(year, 2, 17) },
    { name: "Easter", date: easterSunday(year) },
    { name: "Independence Day", date: utc(year, 6, 4) },
    { name: "Halloween", date: utc(year, 9, 31) },
    { name: "Thanksgiving", date: thanksgiving(year) },
    { name: "Christmas", date: utc(year, 11, 25) },
    { name: "New Year's Eve", date: utc(year, 11, 31) },
  ];
}

function relative(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  const weeks = Math.round(days / 7);
  return `in ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}

/** One paragraph: the date, the season and its feel, and what is coming up
 * within the next eight weeks. Goes in the volatile user message, never in the
 * cached blocks. */
export function describeSeason(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = utc(year, month, now.getUTCDate());
  const mood = MONTH_MOOD[month];
  if (!mood) throw new Error(`no mood for month index ${month}`);

  const upcoming = [...occasions(year), ...occasions(year + 1)]
    .map((o) => ({ name: o.name, days: Math.round((o.date.getTime() - today.getTime()) / DAY_MS) }))
    .filter((o) => o.days >= 0 && o.days <= LOOKAHEAD_DAYS)
    .sort((a, b) => a.days - b.days)
    .map((o) => `${o.name} ${relative(o.days)}`);

  const when = `${WEEKDAYS[today.getUTCDay()]} ${today.getUTCDate()} ${MONTHS[month]} ${year}`;
  const calendar = upcoming.length === 0 ? "Nothing on the calendar in the next eight weeks." : `Coming up: ${upcoming.join(", ")}.`;
  return `Today is ${when}, ${mood.season} in the northern hemisphere: ${mood.feel}. ${calendar}`;
}
