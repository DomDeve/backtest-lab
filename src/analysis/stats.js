// Statistik-Helfer (ohne Abhängigkeiten).

export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : NaN);
export function std(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}
export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (a) => quantile(a, 0.5);

/** Standardnormal-CDF */
export function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Student-t-CDF (zweiseitiger p-Wert) über regularisierte unvollständige Beta-Funktion */
function betacf(a, b, x) {
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const v of c) ser += v / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
export function tTwoSidedP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  return ibeta(df / 2, 0.5, df / (df + t * t));
}

/** Einstichproben-t-Test: ist der Mittelwert von 0 verschieden? */
export function tTestMean(a) {
  const n = a.length;
  if (n < 3) return { t: NaN, p: NaN };
  const t = mean(a) / (std(a) / Math.sqrt(n));
  return { t, p: tTwoSidedP(t, n - 1) };
}

/** Welch-t-Test zweier Stichproben */
export function welch(a, b) {
  if (a.length < 3 || b.length < 3) return { t: NaN, p: NaN };
  const va = std(a) ** 2 / a.length, vb = std(b) ** 2 / b.length;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  return { t, p: tTwoSidedP(t, df) };
}

/** deterministischer Zufall (für reproduzierbare Bootstraps/Monte-Carlo) */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Bootstrap-Konfidenzintervall des Mittelwerts */
export function bootstrapMeanCI(a, { n = 2000, alpha = 0.1, seed = 1 } = {}) {
  if (a.length < 5) return [NaN, NaN];
  const R = rng(seed);
  const ms = [];
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[Math.floor(R() * a.length)];
    ms.push(s / a.length);
  }
  return [quantile(ms, alpha / 2), quantile(ms, 1 - alpha / 2)];
}

export const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
