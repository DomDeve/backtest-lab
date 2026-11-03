// Zeit-Helfer: alles intern in UTC-Millisekunden, Strategien sehen lokale Börsenzeit (Default Europe/Berlin).
// Gleiche Semantik wie die n8n-Code-Nodes (berlin(), hmList(), utcFor()), aber mit Cache für Geschwindigkeit.

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('de-DE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return fmtCache.get(tz);
}

const offsetCache = new Map(); // key: tz|stunde -> Offset in Minuten
function offsetMinutes(ms, tz) {
  const hourKey = Math.floor(ms / 3600000);
  const key = tz + '|' + hourKey;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const p = {};
    for (const x of formatter(tz).formatToParts(new Date(hourKey * 3600000))) p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    off = Math.round((asUtc - hourKey * 3600000) / 60000);
    offsetCache.set(key, off);
  }
  return off;
}

const pad = (n) => String(n).padStart(2, '0');

/** Lokale Zeit-Teile für einen UTC-Zeitstempel. */
export function local(ms, tz = 'Europe/Berlin') {
  const d = new Date(ms + offsetMinutes(ms, tz) * 60000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { date, hm, weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** Liste von HH:MM im 5-Min-Raster, inklusive Ende (wie hmList() im Bot). */
export function hmList(from, toIncl, stepMin = 5) {
  const out = [];
  let [h, m] = from.split(':').map(Number);
  for (;;) {
    const s = `${pad(h)}:${pad(m)}`;
    if (s > toIncl) break;
    out.push(s);
    m += stepMin;
    while (m >= 60) { m -= 60; h++; }
    if (h > 23) break;
  }
  return out;
}

/** HH:MM + Minuten -> HH:MM */
export function addMinutes(hm, minutes) {
  const [h, m] = hm.split(':').map(Number);
  const t = h * 60 + m + minutes;
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}

export function hmToMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** Lokales Datum + HH:MM -> UTC-ms (DST-sicher). */
export function utcFor(date, hm, tz = 'Europe/Berlin') {
  const [y, mo, d] = date.split('-').map(Number);
  const [H, M] = hm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, H, M);
  for (const off of [offsetMinutes(guess, tz), offsetMinutes(guess - 7200000, tz), offsetMinutes(guess + 7200000, tz)]) {
    const ms = guess - off * 60000;
    const l = local(ms, tz);
    if (l.date === date && l.hm === hm) return ms;
  }
  return null;
}

export const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
