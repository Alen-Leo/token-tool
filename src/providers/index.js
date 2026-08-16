// Provider registry. Each provider exports `meta` (declarative UI/auth info)
// and an async `fetch({ config })` returning a normalized result object.
//
// Result contract (all providers, one result PER ACCOUNT):
//   {
//     provider, name, status, updatedAt,
//     accountId,               // which account of the provider produced this
//     accountLabel?,           // user-set label (e.g. "work")
//     accountMask?,            // masked key — distinguishes unlabeled accounts
//     dashboard?,             // link to the provider's web console
//     plan?,                  // z.ai (subscription/product name)
//     renewsAt?,              // z.ai (subscription renewal, ISO)
//     region?,                // z.ai
//     windows?: [],           // z.ai (tokens), opencode (currency)
//                            //   each window: { kind, label, unit, usedPercent,
//                            //     remainingPercent, used, limit, resetsAt, resetDescription }
//     balances?: [],          // deepseek, openrouter, siliconflow, moonshot
//     isAvailable?,           // deepseek
//     currency?,              // openrouter/siliconflow/moonshot (headline currency)
//     models?, modelCount?,   // opencode
//     keyValid?,              // opencode
//     planLimits?,            // opencode
//     summary?,               // human one-liner
//     error?,                 // sanitized message on failure
//   }
//
// status ∈ ok | unauthorized | sourceRateLimited | timeout | unavailable |
//           notConfigured | blockedHost

import { tr, errorText } from '../i18n.js';
import { maskSecret, DEFAULT_ACCOUNT_ID } from '../config.js';
import * as zai from './zai.js';
import * as deepseek from './deepseek.js';
import * as opencode from './opencode.js';
import * as openrouter from './openrouter.js';
import * as siliconflow from './siliconflow.js';
import * as moonshot from './moonshot.js';

export const PROVIDERS = [zai, deepseek, opencode, openrouter, siliconflow, moonshot];

export function providerMeta() {
  return PROVIDERS.map((p) => ({ ...p.meta }));
}

export function getProvider(id) {
  return PROVIDERS.find((p) => p.meta.id === id) || null;
}

// Accounts of a provider from a normalized config (see config.js). Always an
// array; empty when nothing is configured for the provider.
export function listAccounts(config, providerId) {
  const slice = config?.providers?.[providerId];
  const accounts = Array.isArray(slice?.accounts) ? slice.accounts : [];
  return accounts.filter((a) => a && typeof a === 'object');
}

// Run one provider for one account. The account's fields become the provider
// config slice; `accountId` rides along so consumers (e.g. DeepSeek's spend
// tracker) can scope per-account state.
export async function runAccount(providerId, account, opts = {}) {
  const provider = getProvider(providerId);
  const id = account?.id || DEFAULT_ACCOUNT_ID;
  const base = {
    provider: providerId,
    accountId: id,
    accountLabel: account?.label || null,
    // Mask of whichever credential the account has — distinguishes cards in
    // multi-account providers even for webToken-only accounts.
    accountMask: maskSecret(account?.apiKey || account?.webToken || ''),
  };
  if (!provider) {
    return {
      ...base,
      name: providerId,
      status: 'unavailable',
      updatedAt: new Date().toISOString(),
      error: tr(opts.lang, 'error.unknownProvider'),
    };
  }
  try {
    const result = await provider.fetch({ config: { ...account, accountId: id }, lang: opts.lang });
    return { ...base, ...result, accountId: id };
  } catch (err) {
    return {
      ...base,
      name: provider.meta.name,
      status: 'unavailable',
      updatedAt: new Date().toISOString(),
      error: errorText(err, opts.lang),
    };
  }
}

// Run every account of one provider. A provider with no configured accounts
// yields a single notConfigured result (so the UI can prompt for setup).
export async function runProvider(id, config, opts = {}) {
  const accounts = listAccounts(config, id);
  if (!accounts.length) return [await runAccount(id, { id: DEFAULT_ACCOUNT_ID }, opts)];
  return Promise.all(accounts.map((a) => runAccount(id, a, opts)));
}

// Run every configured account of every provider, in parallel.
export async function runAll(config, opts = {}) {
  const ids = PROVIDERS.map((p) => p.meta.id);
  const perProvider = await Promise.all(ids.map((id) => runProvider(id, config, opts)));
  return perProvider.flat();
}
