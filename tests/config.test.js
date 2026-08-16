import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, maskSecret, cleanSecret, newAccountId } from '../src/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cfg-'));
}

function writeConfig(dir, value) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(value));
}

test('maskSecret hides middle of a key', () => {
  const masked = maskSecret('sk-abcdefghij1234567890');
  assert.match(masked, /^sk-/);
  assert.match(masked, /•/);
  assert.equal(masked.includes('abcdefghij1234567890'), false);
});

test('maskSecret handles short values', () => {
  assert.equal(maskSecret('sk-ab'), '•••••');
  assert.equal(maskSecret(''), '');
});

test('cleanSecret strips quotes and whitespace', () => {
  assert.equal(cleanSecret('  "abc"  '), 'abc');
  assert.equal(cleanSecret("'abc'"), 'abc');
  assert.equal(cleanSecret(123), '');
});

test('saveConfig writes 0600 file and round-trips', () => {
  const dir = tmpDir();
  const saved = saveConfig((c) => {
    c.providers = { deepseek: { accounts: [{ id: 'default', apiKey: 'sk-test1234567890' }] } };
    return c;
  }, dir);
  assert.equal(saved.providers.deepseek.accounts[0].apiKey, 'sk-test1234567890');
  const file = path.join(dir, 'config.json');
  const stat = fs.statSync(file);
  // 0600 = 0o600. Lower 12 bits only. Windows has no Unix permission bits
  // (chmod is best-effort via ACLs, files report 0o666), so only assert the
  // strict mode on POSIX systems; on Windows just confirm the file exists.
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  } else {
    assert.ok(stat.isFile(), 'config file written');
  }
  const loaded = loadConfig(dir);
  assert.equal(loaded.providers.deepseek.accounts[0].apiKey, 'sk-test1234567890');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig tolerates missing/malformed file', () => {
  const dir = tmpDir();
  const loaded = loadConfig(dir);
  assert.ok(loaded.providers);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy flat provider config normalizes to a "default" account', () => {
  const dir = tmpDir();
  writeConfig(dir, {
    providers: {
      zai: { apiKey: 'sk-legacy', region: 'bigmodel-cn' },
      deepseek: { apiKey: 'sk-ds', webToken: 'tok-ds' },
    },
  });
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.providers.zai.accounts, [
    { id: 'default', apiKey: 'sk-legacy', region: 'bigmodel-cn' },
  ]);
  assert.deepEqual(loaded.providers.deepseek.accounts, [
    { id: 'default', apiKey: 'sk-ds', webToken: 'tok-ds' },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accounts-array config round-trips ids and labels untouched', () => {
  const dir = tmpDir();
  writeConfig(dir, {
    providers: {
      zai: {
        accounts: [
          { id: 'a1b2c3', label: '工作', apiKey: 'sk-one', region: 'global' },
          { id: 'd4e5f6', apiKey: 'sk-two' },
        ],
      },
    },
  });
  const loaded = loadConfig(dir);
  assert.equal(loaded.providers.zai.accounts.length, 2);
  assert.equal(loaded.providers.zai.accounts[0].label, '工作');
  assert.equal(loaded.providers.zai.accounts[1].id, 'd4e5f6');
  assert.equal(loaded.providers.zai.accounts[1].label, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hand-edited accounts without ids get deterministic positional ids', () => {
  const dir = tmpDir();
  writeConfig(dir, {
    providers: { zai: { accounts: [{ apiKey: 'sk-a' }, { apiKey: 'sk-b' }] } },
  });
  const once = loadConfig(dir);
  const twice = loadConfig(dir);
  assert.deepEqual(once.providers.zai.accounts.map((a) => a.id), ['acc1', 'acc2']);
  assert.deepEqual(once.providers.zai.accounts.map((a) => a.id), twice.providers.zai.accounts.map((a) => a.id));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate account ids are de-duplicated on load', () => {
  const dir = tmpDir();
  writeConfig(dir, {
    providers: { zai: { accounts: [{ id: 'x1', apiKey: 'sk-a' }, { id: 'x1', apiKey: 'sk-b' }] } },
  });
  const loaded = loadConfig(dir);
  const ids = loaded.providers.zai.accounts.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving a legacy config migrates it to the accounts form on disk', () => {
  const dir = tmpDir();
  writeConfig(dir, { providers: { zai: { apiKey: 'sk-legacy' } } });
  saveConfig((c) => c, dir); // ui-only save — providers must still migrate
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.providers.zai.accounts, [{ id: 'default', apiKey: 'sk-legacy' }]);
  assert.equal(raw.providers.zai.apiKey, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('env vars become an ephemeral "env" account only when the file has none', () => {
  const dir = tmpDir();
  writeConfig(dir, { providers: { zai: { accounts: [{ id: 'default', apiKey: 'sk-file' }] } } });
  const prevZai = process.env.ZAI_API_KEY;
  const prevDs = process.env.DEEPSEEK_API_KEY;
  process.env.ZAI_API_KEY = 'sk-env';
  process.env.DEEPSEEK_API_KEY = 'sk-env-ds';
  try {
    const loaded = loadConfig(dir);
    // File account wins — env does not add a second z.ai account.
    assert.equal(loaded.providers.zai.accounts.length, 1);
    assert.equal(loaded.providers.zai.accounts[0].apiKey, 'sk-file');
    // No file accounts for deepseek → env key surfaces as the env account.
    assert.deepEqual(loaded.providers.deepseek.accounts, [{ id: 'env', apiKey: 'sk-env-ds' }]);
    // And it is ephemeral: a save never writes it to disk.
    saveConfig((c) => c, dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(raw.providers.deepseek, undefined);
    assert.equal(raw.providers.zai.accounts.length, 1);
  } finally {
    if (prevZai === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = prevZai;
    if (prevDs === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevDs;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('env vars fill per-field gaps on the legacy default account (old behaviour)', () => {
  const dir = tmpDir();
  writeConfig(dir, {
    providers: {
      // A region-only slice (what the old UI persisted when a key was cleared)
      // plus an env key must keep working, like before multi-account.
      zai: { accounts: [{ id: 'default', region: 'global' }] },
      // A file apiKey plus an env web token must merge onto one account.
      deepseek: { accounts: [{ id: 'default', apiKey: 'sk-file' }] },
    },
  });
  const prevZai = process.env.ZAI_API_KEY;
  const prevTok = process.env.DEEPSEEK_WEB_TOKEN;
  process.env.ZAI_API_KEY = 'sk-env-zai';
  process.env.DEEPSEEK_WEB_TOKEN = 'tok-env';
  try {
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.providers.zai.accounts, [{ id: 'default', region: 'global', apiKey: 'sk-env-zai' }]);
    assert.deepEqual(loaded.providers.deepseek.accounts, [{ id: 'default', apiKey: 'sk-file', webToken: 'tok-env' }]);
    // Still ephemeral — a save writes neither env value to disk.
    saveConfig((c) => c, dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(raw.providers.zai.accounts[0].apiKey, undefined);
    assert.equal(raw.providers.deepseek.accounts[0].webToken, undefined);
  } finally {
    if (prevZai === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = prevZai;
    if (prevTok === undefined) delete process.env.DEEPSEEK_WEB_TOKEN; else process.env.DEEPSEEK_WEB_TOKEN = prevTok;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('newAccountId avoids reserved and existing ids', () => {
  const id = newAccountId(['a1b2c3', 'default']);
  assert.match(id, /^[0-9a-f]{6}$/);
  assert.notEqual(id, 'a1b2c3');
  assert.notEqual(id, 'default');
  assert.notEqual(id, 'env');
});

test('ui prefs (lang/order) round-trip through save/load with defaults', () => {
  const dir = tmpDir();
  // Defaults on a fresh config — Chinese by default.
  const fresh = loadConfig(dir);
  assert.equal(fresh.ui.lang, 'zh');
  assert.deepEqual(fresh.ui.order, []);

  // Persist a language + order, then reload.
  saveConfig((c) => {
    c.ui = { lang: 'zh', order: ['deepseek', 'zai'] };
    return c;
  }, dir);
  const loaded = loadConfig(dir);
  assert.equal(loaded.ui.lang, 'zh');
  assert.deepEqual(loaded.ui.order, ['deepseek', 'zai']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig merges partial ui from file over defaults', () => {
  const dir = tmpDir();
  // Only lang persisted — order must still default to [].
  saveConfig((c) => {
    c.ui = { lang: 'zh' };
    return c;
  }, dir);
  const loaded = loadConfig(dir);
  assert.equal(loaded.ui.lang, 'zh');
  assert.deepEqual(loaded.ui.order, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
