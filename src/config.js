// Secure local configuration store for token-tool.
//
// Design goals:
//  - Zero runtime dependencies (Node built-ins only).
//  - API keys never live in source control; they live in a local JSON file
//    written with 0600 permissions, owner-only.
//  - Environment variables can override per-provider keys for CI / headless use.
//  - Keys are masked whenever surfaced to the UI or logs.
//
// Account model: each provider may hold MULTIPLE accounts (e.g. two z.ai
// keys). On disk that is `providers.<id>.accounts: [ { id, label?, apiKey?,
// webToken?, region? } ]`. The legacy single-account shape (credentials
// directly on `providers.<id>`) is still accepted and normalized on load into
// one account with the reserved id "default", so old config files keep working
// — and are migrated to the accounts form on the next save.
//   - "default"  → the materialized legacy account.
//   - "env"      → an ephemeral account synthesized from environment
//                  variables (never written back to disk).
//   - 6-hex ids  → accounts created via the UI.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CONFIG_DIR_ENV = 'TOKEN_TOOL_CONFIG_DIR';

export const DEFAULT_ACCOUNT_ID = 'default';
export const ENV_ACCOUNT_ID = 'env';

function defaultConfigDir() {
  const override = process.env[CONFIG_DIR_ENV];
  if (override) return override;
  // macOS / Linux: ~/.token-tool ; Windows: %USERPROFILE%\.token-tool
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.token-tool');
}

function configPath(dir = defaultConfigDir()) {
  return path.join(dir, 'config.json');
}

// Read JSON defensively; a missing or malformed file is treated as empty.
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Ensure the config dir exists and is locked to the owner.
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
}

// Atomic write: write to temp + rename. Tighten perms to 0600 every time.
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
}

const DEFAULTS = Object.freeze({
  port: 0, // 0 = pick a free port
  openBrowser: true,
  // UI preferences: display language ('en' | 'zh') and card order. Order
  // entries are either a provider id (groups all its cards) or
  // 'provider:accountId' (one card).
  // Fresh installs default to Chinese — most users are zh speakers.
  ui: { lang: 'zh', order: [] },
  // providers: { zai: { accounts: [ { id, label, apiKey, region } ] }, ... }
  providers: {},
});

export function getConfigDir() {
  return defaultConfigDir();
}

const CREDENTIAL_FIELDS = ['apiKey', 'webToken', 'region', 'label'];

// Normalize one provider slice into the accounts form. Accepts:
//   { accounts: [ ... ] }  → keep (ids filled in when hand-edited out)
//   { apiKey, ... }        → legacy flat form → single "default" account
//   {} / null / junk       → no accounts
// Credential values are cleaned but otherwise trusted locally (0600 file).
function normalizeSlice(slice) {
  if (!slice || typeof slice !== 'object' || Array.isArray(slice)) return [];

  if (Array.isArray(slice.accounts)) {
    const seen = new Set();
    const accounts = [];
    slice.accounts.forEach((a, i) => {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return;
      const account = {};
      let id = typeof a.id === 'string' && a.id.trim() && !a.id.includes(':') ? a.id.trim() : '';
      if (!id || seen.has(id)) id = fallbackAccountId(i, seen);
      seen.add(id);
      account.id = id;
      for (const f of CREDENTIAL_FIELDS) {
        if (a[f] != null && typeof a[f] !== 'object') account[f] = String(a[f]).trim();
      }
      if (!account.label) delete account.label;
      accounts.push(account);
    });
    return accounts;
  }

  // Legacy flat credentials directly on the provider slice.
  const flat = {};
  for (const f of CREDENTIAL_FIELDS) {
    if (slice[f] != null && typeof slice[f] !== 'object') flat[f] = String(slice[f]).trim();
  }
  if (!flat.apiKey && !flat.webToken && !flat.region) return [];
  if (!flat.label) delete flat.label;
  return [{ id: DEFAULT_ACCOUNT_ID, ...flat }];
}

// Positional id for hand-edited accounts arrays that lack ids. Deterministic
// per position so repeated loads don't reshuffle identities.
function fallbackAccountId(index, seen) {
  let n = index + 1;
  let id = `acc${n}`;
  while (seen.has(id)) {
    n += 1;
    id = `acc${n}`;
  }
  return id;
}

// Normalize the providers map of a raw config object into accounts form.
// Providers left with no accounts are dropped — the file stays clean.
function normalizeProviders(rawProviders) {
  const out = {};
  for (const [id, slice] of Object.entries(rawProviders || {})) {
    const accounts = normalizeSlice(slice);
    if (accounts.length) out[id] = { accounts };
  }
  return out;
}

// Load merged config. Precedence: env key override > file > defaults.
// Providers are normalized to the accounts form; env vars surface as an
// ephemeral "env" account when the file holds no accounts for the provider,
// and otherwise fill per-field gaps on the legacy "default" account (env
// values never reach disk and never override file-stored credentials).
export function loadConfig(dir = defaultConfigDir()) {
  const file = configPath(dir);
  const fromFile = readJson(file) || {};
  const merged = {
    ...DEFAULTS,
    ...fromFile,
    ui: { ...DEFAULTS.ui, ...(fromFile.ui || {}) },
    providers: normalizeProviders(fromFile.providers),
  };

  applyEnvKeys(merged.providers);

  return merged;
}

function applyEnvKeys(providers) {
  const map = {
    zai: ['TOKEN_TOOL_ZAI_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'],
    deepseek: ['TOKEN_TOOL_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'],
    opencode: ['TOKEN_TOOL_OPENCODE_API_KEY', 'OPENCODE_API_KEY'],
    openrouter: ['TOKEN_TOOL_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
    siliconflow: ['TOKEN_TOOL_SILICONFLOW_API_KEY', 'SILICONFLOW_API_KEY'],
    moonshot: ['TOKEN_TOOL_MOONSHOT_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  };
  for (const [id, names] of Object.entries(map)) {
    if (!providers[id]) providers[id] = { accounts: [] };
    const accounts = providers[id].accounts;
    const envKey = firstEnvValue(names);
    if (!accounts.length) {
      if (envKey) providers[id].accounts = [{ id: ENV_ACCOUNT_ID, apiKey: envKey }];
    } else {
      // Legacy semantics: env fills per-field gaps on the "default" (legacy)
      // account only — a file apiKey plus an env web token (or a region-only
      // file slice plus an env key) keeps working exactly as before. Providers
      // restructured into custom multi-account setups get no env merging.
      const def = accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID);
      if (def && envKey && !def.apiKey) def.apiKey = envKey;
    }
  }
  // Web session tokens (optional, separate from API keys).
  const webTokenMap = {
    deepseek: ['TOKEN_TOOL_DEEPSEEK_WEB_TOKEN', 'DEEPSEEK_WEB_TOKEN'],
  };
  for (const [id, names] of Object.entries(webTokenMap)) {
    if (!providers[id]) providers[id] = { accounts: [] };
    const v = firstEnvValue(names);
    if (!v) continue;
    // Attach to the env account when present, else fill the gap on the
    // default (legacy) account, else add an env account carrying only the
    // web token.
    const accounts = providers[id].accounts;
    const env = accounts.find((a) => a.id === ENV_ACCOUNT_ID);
    if (env) env.webToken = v;
    else {
      const def = accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID);
      if (def && !def.webToken) def.webToken = v;
      else if (!accounts.length) providers[id].accounts = [{ id: ENV_ACCOUNT_ID, webToken: v }];
    }
  }
}

function firstEnvValue(names) {
  for (const name of names) {
    const v = cleanSecret(process.env[name]);
    if (v) return v;
  }
  return '';
}

export function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

// A fresh account id for UI-created accounts. Avoids the reserved ids and any
// id already present, so card identity / spend tracking never collide.
export function newAccountId(existingIds = []) {
  const taken = new Set([...existingIds, DEFAULT_ACCOUNT_ID, ENV_ACCOUNT_ID]);
  for (;;) {
    const id = crypto.randomBytes(3).toString('hex'); // 6 hex chars
    if (!taken.has(id)) return id;
  }
}

// Persist config to disk (0600). Secrets are written locally only.
// The updater receives the CURRENT on-disk state normalized to the accounts
// form (legacy flat credentials become the "default" account), and whatever it
// returns is normalized again before writing — so the file migrates to the
// accounts form on the first save and stays there.
export function saveConfig(updater, dir = defaultConfigDir()) {
  const file = configPath(dir);
  const current = readJson(file) || { ...DEFAULTS, providers: {} };
  current.providers = normalizeProviders(current.providers);
  const next = typeof updater === 'function' ? updater(structuredCloneSafe(current)) : updater;
  // Re-apply defaults so the file is self-describing.
  const normalized = {
    ...DEFAULTS,
    ...next,
    ui: { ...DEFAULTS.ui, ...(next?.ui || {}) },
    providers: normalizeProviders(next?.providers),
  };
  writeJson(file, normalized);
  return normalized;
}

// Mask a secret for display: show first 3 + last 3 chars, hide the middle.
export function maskSecret(value) {
  const s = cleanSecret(value);
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 3)}${'•'.repeat(Math.min(12, s.length - 6))}${s.slice(-3)}`;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
