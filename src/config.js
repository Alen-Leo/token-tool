// Secure local configuration store for token-tool.
//
// Design goals:
//  - Zero runtime dependencies (Node built-ins only).
//  - API keys never live in source control; they live in a local JSON file
//    written with 0600 permissions, owner-only.
//  - Environment variables can override per-provider keys for CI / headless use.
//  - Keys are masked whenever surfaced to the UI or logs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CONFIG_DIR_ENV = 'TOKEN_TOOL_CONFIG_DIR';

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
  // UI preferences: display language ('en' | 'zh') and card order (provider ids).
  // Fresh installs default to Chinese — most users are zh speakers.
  ui: { lang: 'zh', order: [] },
  // providers: { zai: { apiKey, region }, deepseek: { apiKey }, opencode: { apiKey } }
  providers: {},
});

export function getConfigDir() {
  return defaultConfigDir();
}

// Load merged config. Precedence: env key override > file > defaults.
export function loadConfig(dir = defaultConfigDir()) {
  const file = configPath(dir);
  const fromFile = readJson(file) || {};
  const merged = {
    ...DEFAULTS,
    ...fromFile,
    ui: { ...DEFAULTS.ui, ...(fromFile.ui || {}) },
    providers: { ...(fromFile.providers || {}) },
  };

  // Allow env vars to supply keys without writing them to disk.
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
    if (!providers[id]) providers[id] = {};
    if (!providers[id].apiKey) {
      for (const name of names) {
        const v = cleanSecret(process.env[name]);
        if (v) {
          providers[id].apiKey = v;
          break;
        }
      }
    }
  }
  // Web session tokens (optional, separate from API keys).
  const webTokenMap = {
    deepseek: ['TOKEN_TOOL_DEEPSEEK_WEB_TOKEN', 'DEEPSEEK_WEB_TOKEN'],
  };
  for (const [id, names] of Object.entries(webTokenMap)) {
    if (!providers[id]) providers[id] = {};
    if (!providers[id].webToken) {
      for (const name of names) {
        const v = cleanSecret(process.env[name]);
        if (v) {
          providers[id].webToken = v;
          break;
        }
      }
    }
  }
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

// Persist config to disk (0600). Secrets are written locally only.
export function saveConfig(updater, dir = defaultConfigDir()) {
  const file = configPath(dir);
  const current = readJson(file) || { ...DEFAULTS, providers: {} };
  const next = typeof updater === 'function' ? updater(structuredCloneSafe(current)) : updater;
  // Re-apply defaults so the file is self-describing.
  const normalized = {
    ...DEFAULTS,
    ...next,
    ui: { ...DEFAULTS.ui, ...(next?.ui || {}) },
    providers: { ...(next?.providers || {}) },
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
