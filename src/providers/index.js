// Provider registry. Each provider exports `meta` (declarative UI/auth info)
// and an async `fetch({ config })` returning a normalized result object.
//
// Result contract (all providers):
//   {
//     provider, name, status, updatedAt,
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

// Run a single provider by id with its config slice. `opts` may carry `lang`
// ('en' | 'zh') which providers use to compose their human-readable strings.
export async function runProvider(id, config, opts = {}) {
  const provider = getProvider(id);
  if (!provider) {
    return {
      provider: id,
      name: id,
      status: 'unavailable',
      updatedAt: new Date().toISOString(),
      error: tr(opts.lang, 'error.unknownProvider'),
    };
  }
  const providerConfig = config?.providers?.[id] || {};
  try {
    return await provider.fetch({ config: providerConfig, lang: opts.lang });
  } catch (err) {
    return {
      provider: id,
      name: provider.meta.name,
      status: 'unavailable',
      updatedAt: new Date().toISOString(),
      error: errorText(err, opts.lang),
    };
  }
}

// Run every provider that has a key configured, in parallel. Providers without a
// key are returned as notConfigured so the UI can prompt for setup.
export async function runAll(config, opts = {}) {
  const ids = PROVIDERS.map((p) => p.meta.id);
  return Promise.all(ids.map((id) => runProvider(id, config, opts)));
}
