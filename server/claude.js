import Anthropic from '@anthropic-ai/sdk';

/**
 * Everything that talks to the Claude API: which models are "the latest Haiku,
 * Sonnet and Opus", how hard each one thinks, and one call wrapper that copes
 * with the things that differ between models.
 *
 * "Latest" is resolved at startup from the Models API rather than hard-coded,
 * so the app picks up a new Haiku, Sonnet or Opus the day it ships without a
 * redeploy. MODEL_HAIKU / MODEL_SONNET / MODEL_OPUS override it.
 */

export const FAMILIES = ['haiku', 'sonnet', 'opus'];

/** Used when the Models API cannot be reached — the newest IDs at time of writing. */
const FALLBACK_IDS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};

/** Default effort for the chat partners, per the brief: Opus thinks hardest. */
export const CHAT_EFFORT = { haiku: 'medium', sonnet: 'medium', opus: 'high' };

/** Approximate list prices, USD per million tokens, for the cost line in the report. */
const PRICES = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
};

let client = null;
let resolved = null;
// Models that have refused the `effort` parameter once. Remembered so the
// retry only ever happens on the first call.
const noEffort = new Set();

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function getClient() {
  if (!hasApiKey()) return null;
  if (!client) client = new Anthropic();
  return client;
}

function familyOf(id) {
  return FAMILIES.find((family) => String(id).includes(family)) || null;
}

function prettyName(id, family) {
  const version = String(id).replace(/^claude-/, '').replace(new RegExp(`${family}-?`), '')
    .replace(/-(\d{8})$/, '').split('-').filter(Boolean).join('.');
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${name} ${version}` : name;
}

/**
 * Find the newest model in each family. Called once at startup; the result is
 * what every round, every analysis and the console use.
 */
export async function resolveModels() {
  const picks = {};
  const api = getClient();
  if (api) {
    try {
      const newest = {};
      for await (const model of api.models.list({ limit: 100 })) {
        const family = familyOf(model.id);
        if (!family) continue;
        const when = Date.parse(model.created_at || 0) || 0;
        if (!newest[family] || when > newest[family].when) {
          newest[family] = { id: model.id, when, display: model.display_name };
        }
      }
      for (const family of FAMILIES) if (newest[family]) picks[family] = newest[family];
    } catch (err) {
      console.warn('[claude] Could not list models, using the built-in defaults:', err.message);
    }
  }

  resolved = {};
  for (const family of FAMILIES) {
    const override = process.env[`MODEL_${family.toUpperCase()}`];
    const id = override || picks[family]?.id || FALLBACK_IDS[family];
    resolved[family] = {
      family,
      id,
      label: (!override && picks[family]?.display) || prettyName(id, family),
      effort: CHAT_EFFORT[family],
      source: override ? 'override' : picks[family] ? 'models api' : 'default',
    };
  }
  return resolved;
}

export function models() {
  if (!resolved) {
    resolved = {};
    for (const family of FAMILIES) {
      resolved[family] = {
        family, id: FALLBACK_IDS[family], label: prettyName(FALLBACK_IDS[family], family),
        effort: CHAT_EFFORT[family], source: 'default',
      };
    }
  }
  return resolved;
}

export function modelInfo(family) {
  return models()[family] || null;
}

export function estimateCost(family, inputTokens, outputTokens) {
  const price = PRICES[family] || PRICES.sonnet;
  return (inputTokens * price.input + outputTokens * price.output) / 1e6;
}

const isEffortRejection = (err) =>
  err?.status === 400 && /effort|output_config/i.test(String(err?.message || ''));
const isFormatRejection = (err) =>
  err?.status === 400 && /format|schema|json/i.test(String(err?.message || ''));

/**
 * One request to the Messages API.
 *
 * Handles the per-model differences so callers do not have to: a model that
 * rejects `effort` is retried without it (and remembered), and a JSON schema
 * request that a model rejects falls back to asking for JSON in plain text.
 *
 * @returns {Promise<{text: string, usage: {input: number, output: number}, stopReason: string}>}
 */
export async function ask({ model, system, messages, maxTokens = 2000, effort, schema }) {
  const api = getClient();
  if (!api) throw Object.assign(new Error('No ANTHROPIC_API_KEY set.'), { code: 'NO_KEY' });

  const build = ({ withEffort, withSchema }) => {
    const request = { model, max_tokens: maxTokens, system, messages };
    const config = {};
    if (withEffort && effort) config.effort = effort;
    if (withSchema && schema) config.format = { type: 'json_schema', schema };
    if (Object.keys(config).length) request.output_config = config;
    return request;
  };

  let withEffort = Boolean(effort) && !noEffort.has(model);
  let withSchema = Boolean(schema);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await api.messages.create(build({ withEffort, withSchema }));
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const usage = {
        input: (response.usage?.input_tokens || 0)
          + (response.usage?.cache_read_input_tokens || 0)
          + (response.usage?.cache_creation_input_tokens || 0),
        output: response.usage?.output_tokens || 0,
      };
      return { text, usage, stopReason: response.stop_reason };
    } catch (err) {
      if (withEffort && isEffortRejection(err)) { noEffort.add(model); withEffort = false; continue; }
      if (withSchema && isFormatRejection(err)) { withSchema = false; continue; }
      throw err;
    }
  }
  throw new Error('Request kept being rejected.');
}

/**
 * Ask for JSON and get an object back, whether or not the model honoured the
 * schema natively. Tolerates a code fence or a sentence around the object.
 */
export async function askJson(options) {
  const prompt = options.messages;
  const result = await ask(options);
  const parsed = parseJsonLoose(result.text);
  if (parsed) return { data: parsed, usage: result.usage };

  // One repair attempt: give the model its own output back.
  const retry = await ask({
    ...options,
    schema: undefined,
    messages: [
      ...prompt,
      { role: 'assistant', content: result.text || '(empty)' },
      { role: 'user', content: 'That was not valid JSON. Reply again with only the JSON object, nothing before or after it.' },
    ],
  });
  const second = parseJsonLoose(retry.text);
  if (!second) throw new Error('The model did not return valid JSON.');
  return {
    data: second,
    usage: { input: result.usage.input + retry.usage.input, output: result.usage.output + retry.usage.output },
  };
}

export function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw, raw.replace(/^```(?:json)?\s*|\s*```$/g, '')];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch { /* try the next */ }
  }
  return null;
}
