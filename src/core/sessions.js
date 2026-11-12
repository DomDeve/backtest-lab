// Zentrale Session-Zeiten aus config/sessions.yaml (Gegenstück: tools/sessions.py).
// Umrechnung nach UTC nur über die IANA-Zeitzone (utcFor -> Intl), nie über feste Offsets.
//
//   loadSessions()                       ganze Tabelle
//   epicSession(epic, name?)             { open_local, close_local, tz } (ohne name: Hauptsession = erste)
//   sessionUtc(epic, date, name?)        { open, close } in UTC-ms oder null (Wochenende / Feiertag)
//   isTradingDay(epic, date)             Wochenende, Kalender-Feiertage, Volumen-Feiertage (sessions_no_trading_days.json)
//   localHm(epic, hmLocalOfSession, date, tz) Session-Uhrzeit in einer anderen Zeitzone (z. B. NY-Open in Berlin)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { utcFor, local } from './time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'config', 'sessions.yaml');
const NTD = path.join(ROOT, 'config', 'sessions_no_trading_days.json');

function stripComment(raw) {
  let q = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if ((ch === '"' || ch === "'") && (q === null || q === ch)) q = q ? null : ch;
    else if (ch === '#' && q === null && (i === 0 || raw[i - 1] === ' ')) return raw.slice(0, i).trimEnd();
  }
  return raw.trimEnd();
}
function scalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) { const inner = v.slice(1, -1).trim(); return inner ? inner.split(',').map(scalar) : []; }
  if (v.length >= 2 && v[0] === v.at(-1) && (v[0] === '"' || v[0] === "'")) return v[0] === '"' ? v.slice(1, -1).replace(/\\\\/g, '\\') : v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}
/** Eingeschränktes YAML (Maps über Einrückung, Inline-Listen, Skalare, Kommentare). */
export function parseYaml(text) {
  const root = {};
  const stack = [[-1, root]];
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const ind = line.length - line.trimStart().length;
    const t = line.trim();
    const k = t.indexOf(':');
    const key = t.slice(0, k), val = t.slice(k + 1);
    while (stack.at(-1)[0] >= ind) stack.pop();
    const cur = stack.at(-1)[1];
    if (!val.trim()) { cur[key] = {}; stack.push([ind, cur[key]]); } else cur[key] = scalar(val);
  }
  return root;
}

let cache = null;
export function loadSessions(file = FILE) {
  if (!cache || file !== FILE) {
    const S = parseYaml(fs.readFileSync(file, 'utf8'));
    S.noTradingDays = fs.existsSync(NTD) ? JSON.parse(fs.readFileSync(NTD, 'utf8')) : {};
    if (file !== FILE) return S;
    cache = S;
  }
  return cache;
}

export function epicSession(epic, name, S = loadSessions()) {
  const e = S.epics[epic];
  if (!e) throw new Error(`Epic nicht in sessions.yaml: ${epic}`);
  return e.sessions[name || Object.keys(e.sessions)[0]];
}

const weekday = (date) => new Date(date + 'T12:00:00Z').getUTCDay();
export function isTradingDay(epic, date, S = loadSessions()) {
  const e = S.epics[epic];
  const wd = weekday(date);
  if ((wd === 0 || wd === 6) && e.calendar !== 'NONE') return false;
  if ((S.calendars[e.calendar]?.holidays || []).map(String).includes(date)) return false;
  return !(S.noTradingDays[epic] || []).includes(date);
}

/** Session-Fenster eines Handelstags (date = Datum in Börsen-Ortszeit) in UTC-ms; null = kein Handelstag. */
export function sessionUtc(epic, date, name, S = loadSessions()) {
  if (!isTradingDay(epic, date, S)) return null;
  const s = epicSession(epic, name, S);
  return { open: utcFor(date, s.open_local, s.tz), close: utcFor(date, s.close_local, s.tz), tz: s.tz };
}

/** Uhrzeit (HH:MM) der Session-Eröffnung/-Schluss in einer anderen Zeitzone, z. B. NY-Open in Berlin am Datum. */
export function sessionHmIn(epic, date, tz = 'Europe/Berlin', which = 'open', name, S = loadSessions()) {
  const s = epicSession(epic, name, S);
  const t = utcFor(date, which === 'open' ? s.open_local : s.close_local, s.tz);
  return local(t, tz).hm;
}

/** Feste Berlin-Uhrzeiten einer Session, wenn sie in Berlin liegt (für Strategien mit Berlin-Logik), sonst Fehler. */
export function berlinSession(epic, name, S = loadSessions()) {
  const s = epicSession(epic, name, S);
  if (s.tz !== 'Europe/Berlin') throw new Error(`${epic}: Session in ${s.tz}, nicht Europe/Berlin – sessionUtc() je Datum verwenden`);
  return { from: s.open_local, to: s.close_local };
}

/** Kernzeit für cleanBars (Vollständigkeitsprüfung): Hauptsession, letzte Kerze = Schluss − barMin, in der Session-Zeitzone. */
export function cleanSession(epic, barMin = 5, S = loadSessions()) {
  const s = epicSession(epic, undefined, S);
  const [h, m] = s.close_local.split(':').map(Number);
  const t = h * 60 + m - barMin;
  const to = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  return { from: s.open_local, to, tz: s.tz };
}
