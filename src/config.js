'use strict';

/**
 * src/config.js
 * ---------------------------------------------------------------------------
 * Environment parser and fail-fast validator for n8n-clay-apollo-account-expansion-radar.
 *
 *  - Zero dependencies, no require(): inlined into n8n Code nodes at build time.
 *  - Every problem is collected and thrown together as one ConfigError, before
 *    any HubSpot, Apollo or Clay request is made.
 *  - Values such as REPLACE_WITH_..., {{...}}, YOUR_... and your-... count as "not set".
 *  - API keys are never read here: HubSpot and Apollo keys live in n8n credentials.
 *    The Slack and Clay webhook URLs are only checked for presence (a boolean is
 *    kept); their values are never stored in the config object or logged.
 *    RADAR_WEBHOOK_SECRET is kept only to authenticate inbound Clay callbacks.
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const ENV_KEYS = Object.freeze([
  'SANDBOX_MODE',
  'AS_OF_DATE',
  'HUBSPOT_PORTAL_ID',
  'HUBSPOT_APP_BASE_URL',
  'TARGET_LIFECYCLE_STAGE',
  'MAX_ACCOUNTS_PER_RUN',
  'RECHECK_DAYS',
  'ENABLE_APOLLO',
  'ENABLE_APOLLO_JOB_POSTINGS',
  'ENABLE_CLAY_PUSH',
  'CLAY_TABLE_WEBHOOK_URL',
  'RADAR_WEBHOOK_SECRET',
  'FUNDING_LOOKBACK_DAYS',
  'HIRING_LOOKBACK_DAYS',
  'EXEC_HIRING_THRESHOLD',
  'EXEC_TITLE_KEYWORDS',
  'TECH_WATCHLIST',
  'HEADCOUNT_GROWTH_PCT',
  'WEIGHT_FUNDING',
  'WEIGHT_EXEC_HIRING',
  'WEIGHT_TECH_ADOPTION',
  'WEIGHT_HEADCOUNT_GROWTH',
  'WEIGHT_CLAY_SIGNAL',
  'TASK_SCORE_THRESHOLD',
  'PLAY_SCORE_THRESHOLD',
  'SIGNAL_COOLDOWN_DAYS',
  'TASK_DUE_DAYS',
  'FALLBACK_OWNER_ID',
  'EXPANSION_SIGNAL_OBJECT_TYPE',
  'SIGNAL_COMPANY_ASSOCIATION_TYPE_ID',
  'TASK_COMPANY_ASSOCIATION_TYPE_ID',
  'EXPANSION_PLAY_VALUE',
  'ENABLE_SIGNAL_RECORDS',
  'ENABLE_TASKS',
  'ENABLE_PLAY_HANDOFF',
  'ENABLE_SLACK',
  'SLACK_WEBHOOK_URL',
]);

const DEFAULTS = Object.freeze({
  SANDBOX_MODE: 'true',
  AS_OF_DATE: '',
  HUBSPOT_PORTAL_ID: '',
  HUBSPOT_APP_BASE_URL: 'https://app.hubspot.com',
  TARGET_LIFECYCLE_STAGE: 'customer',
  MAX_ACCOUNTS_PER_RUN: '100',
  RECHECK_DAYS: '7',
  ENABLE_APOLLO: 'true',
  ENABLE_APOLLO_JOB_POSTINGS: 'true',
  ENABLE_CLAY_PUSH: 'false',
  CLAY_TABLE_WEBHOOK_URL: '',
  RADAR_WEBHOOK_SECRET: '',
  FUNDING_LOOKBACK_DAYS: '90',
  HIRING_LOOKBACK_DAYS: '30',
  EXEC_HIRING_THRESHOLD: '3',
  EXEC_TITLE_KEYWORDS: 'chief,vp,vice president,head of,director,svp,evp,cro,cfo,cto,cio,ciso,coo,cmo,cpo',
  TECH_WATCHLIST: '',
  HEADCOUNT_GROWTH_PCT: '15',
  WEIGHT_FUNDING: '40',
  WEIGHT_EXEC_HIRING: '30',
  WEIGHT_TECH_ADOPTION: '25',
  WEIGHT_HEADCOUNT_GROWTH: '15',
  WEIGHT_CLAY_SIGNAL: '20',
  TASK_SCORE_THRESHOLD: '40',
  PLAY_SCORE_THRESHOLD: '60',
  SIGNAL_COOLDOWN_DAYS: '30',
  TASK_DUE_DAYS: '3',
  FALLBACK_OWNER_ID: '',
  EXPANSION_SIGNAL_OBJECT_TYPE: '',
  SIGNAL_COMPANY_ASSOCIATION_TYPE_ID: '',
  TASK_COMPANY_ASSOCIATION_TYPE_ID: '192',
  EXPANSION_PLAY_VALUE: 'expansion_upsell',
  ENABLE_SIGNAL_RECORDS: 'true',
  ENABLE_TASKS: 'true',
  ENABLE_PLAY_HANDOFF: 'true',
  ENABLE_SLACK: 'true',
  SLACK_WEBHOOK_URL: '',
});

const PLACEHOLDER = /^\{\{.*\}\}$|^<?(your[-_]|YOUR_|REPLACE_)/;
const OBJECT_TYPE = /^(2-\d+|p\d+_[a-z][a-z0-9_]*)$/;
const MIN_SECRET_LENGTH = 16;

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid expansion radar configuration:\n  - ' + problems.join('\n  - '));
    this.name = 'ConfigError';
    this.problems = problems.slice();
  }
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value.trim());
}

function deepFreeze(obj) {
  Object.keys(obj).forEach((k) => {
    if (obj[k] && typeof obj[k] === 'object' && !Object.isFrozen(obj[k])) deepFreeze(obj[k]);
  });
  return Object.freeze(obj);
}

/**
 * Parse and validate configuration.
 * @param {Record<string,string|undefined>} [env] process.env in Node, $env in n8n.
 * @throws {ConfigError}
 */
function loadConfig(env) {
  const source = env !== undefined ? env : typeof process !== 'undefined' && process.env ? process.env : {};
  const problems = [];
  const warnings = [];

  const raw = (key) => {
    let value;
    try {
      value = source[key];
    } catch (err) {
      value = undefined;
    }
    if (value === undefined || value === null || String(value).trim() === '') return DEFAULTS[key] || '';
    return String(value).trim();
  };
  const str = (key) => (isPlaceholder(raw(key)) ? '' : raw(key));
  const bool = (key) => {
    const v = raw(key).toLowerCase();
    if (['true', '1', 'yes', 'on'].indexOf(v) !== -1) return true;
    if (['false', '0', 'no', 'off'].indexOf(v) !== -1) return false;
    problems.push(`${key} must be true or false, received "${v}"`);
    return DEFAULTS[key] === 'true';
  };
  const num = (key, min, max) => {
    const v = raw(key);
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) {
      problems.push(`${key} must be a number, received "${v}"`);
      return Number(DEFAULTS[key]);
    }
    if (n < min || n > max) problems.push(`${key} must be between ${min} and ${max}, received ${n}`);
    return n;
  };
  const list = (key) =>
    str(key)
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && !isPlaceholder(p));

  const sandboxMode = bool('SANDBOX_MODE');

  // Optional fixed "now" for reproducible dry runs and backtests (ISO date). Blank = current time.
  let asOf = null;
  const asOfRaw = str('AS_OF_DATE');
  if (asOfRaw) {
    const ms = Date.parse(asOfRaw);
    if (!/^\d{4}-\d{2}-\d{2}/.test(asOfRaw) || Number.isNaN(ms)) problems.push('AS_OF_DATE must be an ISO date such as 2026-06-01, or blank');
    else asOf = new Date(ms).toISOString();
  }

  const hubspot = {
    portalId: str('HUBSPOT_PORTAL_ID'),
    appBaseUrl: raw('HUBSPOT_APP_BASE_URL').replace(/\/+$/, ''),
    lifecycleStage: raw('TARGET_LIFECYCLE_STAGE').toLowerCase(),
    maxAccountsPerRun: num('MAX_ACCOUNTS_PER_RUN', 1, 5000),
    recheckDays: num('RECHECK_DAYS', 0, 365),
    signalObjectType: str('EXPANSION_SIGNAL_OBJECT_TYPE'),
    signalAssociationTypeId: str('SIGNAL_COMPANY_ASSOCIATION_TYPE_ID'),
    taskAssociationTypeId: str('TASK_COMPANY_ASSOCIATION_TYPE_ID'),
    fallbackOwnerId: str('FALLBACK_OWNER_ID'),
  };
  if (hubspot.portalId && !/^\d+$/.test(hubspot.portalId)) problems.push('HUBSPOT_PORTAL_ID must be numeric');
  if (!/^https:\/\/\S+$/.test(hubspot.appBaseUrl)) problems.push('HUBSPOT_APP_BASE_URL must be an https:// URL');
  if (!/^[a-z0-9_]{2,64}$/.test(hubspot.lifecycleStage)) problems.push('TARGET_LIFECYCLE_STAGE must be a lifecycle stage internal value such as "customer"');
  if (hubspot.signalObjectType && !OBJECT_TYPE.test(hubspot.signalObjectType)) {
    problems.push('EXPANSION_SIGNAL_OBJECT_TYPE must be a custom object type ID like 2-1234567 or a name like p1234567_expansion_signals');
  }
  ['signalAssociationTypeId', 'taskAssociationTypeId', 'fallbackOwnerId'].forEach((k) => {
    if (hubspot[k] && !/^\d+$/.test(hubspot[k])) problems.push(`${k} must be numeric`);
  });

  const sources = {
    apolloEnabled: bool('ENABLE_APOLLO'),
    apolloJobPostings: bool('ENABLE_APOLLO_JOB_POSTINGS'),
    clayPushEnabled: bool('ENABLE_CLAY_PUSH'),
    clayWebhookConfigured: Boolean(str('CLAY_TABLE_WEBHOOK_URL')),
    webhookSecret: str('RADAR_WEBHOOK_SECRET'),
  };
  const clayUrl = str('CLAY_TABLE_WEBHOOK_URL');
  if (clayUrl && !/^https:\/\/\S+$/.test(clayUrl)) problems.push('CLAY_TABLE_WEBHOOK_URL must be an https:// URL');
  if (sources.webhookSecret && sources.webhookSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`RADAR_WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const signals = {
    fundingLookbackDays: num('FUNDING_LOOKBACK_DAYS', 1, 730),
    hiringLookbackDays: num('HIRING_LOOKBACK_DAYS', 1, 365),
    execHiringThreshold: num('EXEC_HIRING_THRESHOLD', 1, 100),
    execTitleKeywords: list('EXEC_TITLE_KEYWORDS').map((k) => k.toLowerCase()),
    techWatchlist: list('TECH_WATCHLIST').map((k) => k.toLowerCase()),
    headcountGrowthPct: num('HEADCOUNT_GROWTH_PCT', 1, 1000),
    weights: {
      FUNDING: num('WEIGHT_FUNDING', 0, 100),
      EXEC_HIRING_SPIKE: num('WEIGHT_EXEC_HIRING', 0, 100),
      TECH_ADOPTION: num('WEIGHT_TECH_ADOPTION', 0, 100),
      HEADCOUNT_GROWTH: num('WEIGHT_HEADCOUNT_GROWTH', 0, 100),
      CLAY_SIGNAL: num('WEIGHT_CLAY_SIGNAL', 0, 100),
    },
  };
  if (signals.execTitleKeywords.length === 0) problems.push('EXEC_TITLE_KEYWORDS must list at least one keyword');
  if (signals.techWatchlist.length === 0) warnings.push('TECH_WATCHLIST is empty: any newly detected technology counts as a TECH_ADOPTION signal');

  const actions = {
    taskScoreThreshold: num('TASK_SCORE_THRESHOLD', 1, 100),
    playScoreThreshold: num('PLAY_SCORE_THRESHOLD', 1, 100),
    cooldownDays: num('SIGNAL_COOLDOWN_DAYS', 0, 365),
    taskDueDays: num('TASK_DUE_DAYS', 0, 60),
    playValue: raw('EXPANSION_PLAY_VALUE'),
    signalRecordsEnabled: bool('ENABLE_SIGNAL_RECORDS'),
    tasksEnabled: bool('ENABLE_TASKS'),
    playHandoffEnabled: bool('ENABLE_PLAY_HANDOFF'),
    slackEnabled: bool('ENABLE_SLACK'),
    slackWebhookConfigured: Boolean(str('SLACK_WEBHOOK_URL')),
  };
  if (!/^[a-z0-9_]{2,64}$/.test(actions.playValue)) problems.push('EXPANSION_PLAY_VALUE must be lowercase snake_case (it is a dropdown option value)');
  if (actions.playScoreThreshold < actions.taskScoreThreshold) warnings.push('PLAY_SCORE_THRESHOLD is below TASK_SCORE_THRESHOLD: accounts may enter the upsell play without a rep task');

  // Live-mode requirements (fail fast); sandbox only warns.
  const live = [];
  if (actions.signalRecordsEnabled && !hubspot.signalObjectType) live.push('EXPANSION_SIGNAL_OBJECT_TYPE is required when ENABLE_SIGNAL_RECORDS=true');
  if (actions.signalRecordsEnabled && !hubspot.signalAssociationTypeId) live.push('SIGNAL_COMPANY_ASSOCIATION_TYPE_ID is required when ENABLE_SIGNAL_RECORDS=true');
  if (actions.tasksEnabled && !hubspot.taskAssociationTypeId) live.push('TASK_COMPANY_ASSOCIATION_TYPE_ID is required when ENABLE_TASKS=true');
  if (actions.slackEnabled && !actions.slackWebhookConfigured) live.push('SLACK_WEBHOOK_URL is required when ENABLE_SLACK=true');
  if (sources.clayPushEnabled && !sources.clayWebhookConfigured) live.push('CLAY_TABLE_WEBHOOK_URL is required when ENABLE_CLAY_PUSH=true');
  if (!sources.webhookSecret) live.push('RADAR_WEBHOOK_SECRET is required to accept Clay signal callbacks');
  if (!sources.apolloEnabled && !sources.clayPushEnabled) live.push('Both ENABLE_APOLLO and ENABLE_CLAY_PUSH are false: no signal source is active');
  if (sandboxMode) live.forEach((i) => warnings.push(`[sandbox] ${i}`));
  else live.forEach((i) => problems.push(i));
  if (!hubspot.portalId) warnings.push('HUBSPOT_PORTAL_ID is not set; HubSpot links will be omitted from Slack alerts');

  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze({ sandboxMode, asOf, hubspot, sources, signals, actions, warnings });
}

module.exports = { ENV_KEYS, DEFAULTS, MIN_SECRET_LENGTH, ConfigError, isPlaceholder, loadConfig };
