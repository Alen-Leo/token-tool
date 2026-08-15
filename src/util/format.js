// Shared formatting + normalization helpers shared across providers and the UI.

export function toNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function clampPct(value) {
  const n = toNum(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

export function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

// Convert a value to an ISO string. Accepts: seconds, milliseconds, or a date
// string. Returns null when unparseable.
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds timestamps stay under ~2e10 for many centuries; treat
    // anything below that as seconds, anything above as milliseconds.
    const ms = value < 20_000_000_000 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Relative-time label like "in 3h 20m" / "5m ago" (en) or "3小时20分后" /
// "5分钟前" (zh) for the UI. `lang` only affects the label wording.
export function relativeFromNow(iso, nowMs = Date.now(), lang = 'en') {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = t - nowMs;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const sign = diff >= 0 ? 'in ' : '';
  const suffix = diff >= 0 ? '' : ' ago';
  const zh = lang === 'zh';
  if (zh) {
    const zhAgo = diff >= 0 ? '后' : '前';
    if (mins < 60) return `${mins}分钟${zhAgo}`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 48) return m ? `${h}小时${m}分${zhAgo}` : `${h}小时${zhAgo}`;
    return `${Math.round(h / 24)}天${zhAgo}`;
  }
  if (mins < 60) return `${sign}${mins}m${suffix}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return `${sign}${h}h${m ? ` ${m}m` : ''}${suffix}`;
  const d = Math.round(h / 24);
  return `${sign}${d}d${suffix}`;
}

// Build a normalized usage window. All providers funnel through this so the UI
// can render any window uniformly. `unit` ('tokens' | 'currency' | null) tells
// the UI how to format used/limit — token counts (z.ai) vs money (opencode).
export function makeWindow({ kind, label, usedPercent, used, limit, resetsAt, resetDescription, unit = null }) {
  const pct = clampPct(usedPercent);
  const usedN = toNum(used);
  const limitN = toNum(limit);
  // Derive percent from used/limit when not provided directly.
  let pctFinal = pct;
  if (pctFinal === null && usedN !== null && limitN !== null && limitN > 0) {
    pctFinal = clampPct((usedN / limitN) * 100);
  }
  return {
    kind,
    label: label || kind,
    unit,
    usedPercent: pctFinal,
    remainingPercent: pctFinal === null ? null : round(100 - pctFinal, 1),
    used: usedN === null ? null : round(usedN, 2),
    limit: limitN,
    resetsAt: toIso(resetsAt),
    resetDescription: resetDescription || null,
  };
}
