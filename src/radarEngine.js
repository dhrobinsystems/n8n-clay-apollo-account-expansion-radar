'use strict';

/**
 * src/radarEngine.js
 * ---------------------------------------------------------------------------
 * Expansion-signal detection, scoring and action planning for existing customers.
 *
 *   HubSpot customer companies ──► prepareAccounts()          normalize, recheck cadence, cap
 *            │
 *            ├─ Apollo organization enrich + job postings ──► detectApolloSignals()
 *            │      FUNDING · EXEC_HIRING_SPIKE · TECH_ADOPTION · HEADCOUNT_GROWTH
 *            │
 *            └─ Clay table (async) ──► callback webhook ──► normalizeClayCallback()
 *                                                              CLAY_SIGNAL (and typed signals)
 *            ▼
 *   evaluateAccount()  score (0-100) · cooldown · thresholds
 *            ▼
 *   planActions()      expansion-signal custom object records · rep task ·
 *                      company play handoff (snapshot + upsell play) · Slack digest
 *
 * The radar never sends email itself. "Enrolment" is a handoff: it sets the company
 * property expansion_radar_play, and a HubSpot workflow you control enrols contacts
 * into the upsell sequence. That keeps sending, opt-outs and approvals in HubSpot.
 *
 * Zero dependencies, no require(): inlined into n8n Code nodes at build time.
 * Cross-realm safe (no instanceof), because n8n runs Code nodes in a separate VM.
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const ENGINE_VERSION = '1.0.0';
const DAY_MS = 24 * 60 * 60 * 1000;

const SIGNAL_TYPES = Object.freeze({
  FUNDING: 'FUNDING',
  EXEC_HIRING_SPIKE: 'EXEC_HIRING_SPIKE',
  TECH_ADOPTION: 'TECH_ADOPTION',
  HEADCOUNT_GROWTH: 'HEADCOUNT_GROWTH',
  CLAY_SIGNAL: 'CLAY_SIGNAL',
});

/** Company properties the radar reads and writes (create them in HubSpot; see README). */
const COMPANY_PROPS = Object.freeze({
  lastChecked: 'expansion_radar_last_checked_at',
  lastSignal: 'expansion_radar_last_signal_at',
  score: 'expansion_radar_score',
  play: 'expansion_radar_play',
  techSnapshot: 'expansion_radar_tech_snapshot',
  headcountSnapshot: 'expansion_radar_headcount_snapshot',
});

const SKIP_REASONS = Object.freeze({
  INVALID_RECORD: 'INVALID_RECORD',
  DUPLICATE: 'DUPLICATE',
  NO_DOMAIN: 'NO_DOMAIN',
  RECENTLY_CHECKED: 'RECENTLY_CHECKED',
  RUN_LIMIT_REACHED: 'RUN_LIMIT_REACHED',
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? new Date(value) : null;
  const t = String(value).trim();
  if (/^\d{12,13}$/.test(t)) return new Date(Number(t));
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function clean(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 500);
}

/** Strip emails, API keys, bearer tokens and webhook URLs from free text. */
function redact(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted-token]')
    .replace(/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/https:\/\/hooks\.slack\.com\/\S+/gi, '[redacted-webhook]')
    .replace(/https:\/\/api\.clay\.com\/\S+/gi, '[redacted-webhook]')
    .replace(/([?&](?:api_?key|key|token)=)[^&\s]+/gi, '$1[redacted]');
}

function escapeSlack(value) {
  return String(value === undefined || value === null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Reduce a website / domain to a bare lowercase host without "www.". */
function normalizeDomain(value) {
  const host = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#\s]/)[0]
    .replace(/:\d+$/, '')
    .replace(/^www\d*\./, '')
    .replace(/\.+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

function splitList(value) {
  return String(value || '')
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function constantTimeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// HubSpot accounts
// ---------------------------------------------------------------------------

/** Body for POST /crm/v3/objects/companies/search (customer accounts). */
function buildCompanySearchRequest(config) {
  return {
    filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: config.hubspot.lifecycleStage }] }],
    sorts: [{ propertyName: COMPANY_PROPS.lastChecked, direction: 'ASCENDING' }],
    properties: ['name', 'domain', 'website', 'hubspot_owner_id', 'numberofemployees', 'lifecyclestage'].concat(Object.keys(COMPANY_PROPS).map((k) => COMPANY_PROPS[k])),
    limit: 100,
  };
}

function normalizeAccount(company) {
  if (!isPlainObject(company) || company.id === undefined || !isPlainObject(company.properties)) return null;
  const p = company.properties;
  const headcount = Number(p[COMPANY_PROPS.headcountSnapshot]);
  const techSnapshot = splitList(p[COMPANY_PROPS.techSnapshot]);
  return {
    companyId: String(company.id),
    name: clean(p.name || 'Unnamed company', 120),
    domain: normalizeDomain(p.domain) || normalizeDomain(p.website),
    ownerId: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
    lastCheckedAt: parseDate(p[COMPANY_PROPS.lastChecked]),
    lastSignalAt: parseDate(p[COMPANY_PROPS.lastSignal]),
    currentPlay: p[COMPANY_PROPS.play] ? String(p[COMPANY_PROPS.play]) : null,
    snapshot: {
      exists: Boolean(p[COMPANY_PROPS.techSnapshot]) || Number.isFinite(headcount),
      tech: techSnapshot,
      headcount: Number.isFinite(headcount) && headcount > 0 ? headcount : null,
    },
  };
}

/**
 * Flatten HubSpot search pages into accounts due for a check.
 * @returns {{ accounts: object[], skipped: Record<string, number>, errors: object[] }}
 */
function prepareAccounts(pages, config, now) {
  const at = parseDate(now) || new Date();
  const accounts = [];
  const skipped = {};
  const errors = [];
  const seen = {};
  const skip = (r) => (skipped[r] = (skipped[r] || 0) + 1);

  (Array.isArray(pages) ? pages : []).forEach((raw) => {
    const page = isPlainObject(raw) && isPlainObject(raw.json) ? raw.json : raw;
    if (!isPlainObject(page)) return;
    if (page.error) {
      const e = isPlainObject(page.error) ? page.error : { message: String(page.error) };
      errors.push({ status: Number(e.httpCode || e.statusCode || e.status) || null, message: redact(clean(e.message || 'HubSpot error', 300)) });
      return;
    }
    (Array.isArray(page.results) ? page.results : []).forEach((company) => {
      const account = normalizeAccount(company);
      if (!account) return skip(SKIP_REASONS.INVALID_RECORD);
      if (seen[account.companyId]) return skip(SKIP_REASONS.DUPLICATE);
      seen[account.companyId] = true;
      if (!account.domain) return skip(SKIP_REASONS.NO_DOMAIN);
      if (account.lastCheckedAt && (at - account.lastCheckedAt) / DAY_MS < config.hubspot.recheckDays) return skip(SKIP_REASONS.RECENTLY_CHECKED);
      if (accounts.length >= config.hubspot.maxAccountsPerRun) return skip(SKIP_REASONS.RUN_LIMIT_REACHED);
      accounts.push(account);
    });
  });
  return { accounts, skipped, errors };
}

/** Item JSON for one account (serializable: dates as ISO strings). */
function accountToJson(account, config) {
  return {
    kind: 'account',
    companyId: account.companyId,
    name: account.name,
    domain: account.domain,
    ownerId: account.ownerId,
    lastCheckedAt: account.lastCheckedAt ? account.lastCheckedAt.toISOString() : null,
    lastSignalAt: account.lastSignalAt ? account.lastSignalAt.toISOString() : null,
    currentPlay: account.currentPlay,
    snapshot: account.snapshot,
    apolloEnrichUrl: `https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(account.domain)}`,
    sandbox: Boolean(config.sandboxMode),
  };
}

function accountFromJson(json) {
  const j = isPlainObject(json) ? json : {};
  return {
    companyId: j.companyId ? String(j.companyId) : null,
    name: clean(j.name || 'Unnamed company', 120),
    domain: normalizeDomain(j.domain),
    ownerId: j.ownerId || null,
    lastCheckedAt: parseDate(j.lastCheckedAt),
    lastSignalAt: parseDate(j.lastSignalAt),
    currentPlay: j.currentPlay || null,
    snapshot: isPlainObject(j.snapshot) ? { exists: Boolean(j.snapshot.exists), tech: Array.isArray(j.snapshot.tech) ? j.snapshot.tech : [], headcount: Number(j.snapshot.headcount) || null } : { exists: false, tech: [], headcount: null },
  };
}

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

function apolloError(json) {
  if (!isPlainObject(json) || !json.error) return null;
  const e = isPlainObject(json.error) ? json.error : { message: String(json.error) };
  const status = Number(e.httpCode || e.statusCode || e.status) || null;
  const message = redact(clean(e.message || 'Apollo error', 200));
  return { status, message, rateLimited: status === 429 || /\b429\b|rate.?limit|too many/i.test(message) };
}

function signal(type, key, title, detail, occurredAt, sourceUrl, weight, source) {
  return {
    type,
    key,
    title: clean(title, 200),
    detail: clean(detail, 1000),
    occurredAt: occurredAt ? occurredAt.toISOString() : null,
    sourceUrl: sourceUrl && /^https:\/\//.test(String(sourceUrl)) ? String(sourceUrl).slice(0, 500) : null,
    weight: Math.max(0, Math.min(100, Math.round(weight))),
    source,
  };
}

function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
  return `${currency || 'USD'} ${unit}`;
}

/**
 * Detect expansion signals from Apollo responses.
 * @param {object} account normalized account
 * @param {object} enrichJson GET /api/v1/organizations/enrich response (or n8n error item)
 * @param {object} postingsJson GET /api/v1/organizations/{id}/job_postings response (or error item / null)
 * @returns {{ signals: object[], snapshot: { tech: string[], headcount: number|null }, errors: object[], apolloOrganizationId: string|null }}
 */
function detectApolloSignals(account, enrichJson, postingsJson, config, now) {
  const at = parseDate(now) || new Date();
  const signals = [];
  const errors = [];
  const w = config.signals.weights;
  const enrichErr = apolloError(enrichJson);
  // 404 / 422 mean Apollo has no record for the domain: not a failure.
  if (enrichErr && enrichErr.status !== 404 && enrichErr.status !== 422) errors.push(Object.assign({ source: 'apollo_enrich' }, enrichErr));
  const org = !enrichErr && isPlainObject(enrichJson) && isPlainObject(enrichJson.organization) ? enrichJson.organization : null;
  const snapshot = { tech: account.snapshot.tech.slice(), headcount: account.snapshot.headcount };
  if (!org) return { signals, snapshot, errors, apolloOrganizationId: null };

  // FUNDING: rounds announced inside the look-back window.
  const fundingStart = at.getTime() - config.signals.fundingLookbackDays * DAY_MS;
  (Array.isArray(org.funding_events) ? org.funding_events : []).forEach((ev) => {
    const date = parseDate(isPlainObject(ev) ? ev.date : null);
    if (!date || date.getTime() < fundingStart || date > at) return;
    const money = formatMoney(ev.amount, ev.currency);
    const amountBoost = Number(ev.amount) >= 50e6 ? 1.25 : 1;
    signals.push(
      signal(
        SIGNAL_TYPES.FUNDING,
        `funding:${date.toISOString().slice(0, 10)}:${clean(ev.type || 'round', 40).toLowerCase().replace(/\s+/g, '_')}`,
        `${clean(ev.type || 'Funding round', 60)}${money ? ` (${money})` : ''}`,
        `Funding event on ${date.toISOString().slice(0, 10)}${ev.investors ? `; investors: ${clean(ev.investors, 300)}` : ''}`,
        date,
        ev.news_url,
        w.FUNDING * amountBoost,
        'apollo'
      )
    );
  });

  // TECH_ADOPTION: technologies not present in the previous snapshot.
  const currentTech = (Array.isArray(org.current_technologies) ? org.current_technologies.map((t) => (isPlainObject(t) ? t.name : t)) : Array.isArray(org.technology_names) ? org.technology_names : [])
    .map((t) => clean(t, 80))
    .filter(Boolean);
  const uniqueTech = currentTech.filter((t, i) => currentTech.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i).sort((a, b) => a.localeCompare(b));
  if (uniqueTech.length > 0) {
    if (account.snapshot.exists) {
      const previous = account.snapshot.tech.map((t) => t.toLowerCase());
      const watch = config.signals.techWatchlist;
      const added = uniqueTech.filter((t) => previous.indexOf(t.toLowerCase()) === -1).filter((t) => watch.length === 0 || watch.indexOf(t.toLowerCase()) !== -1);
      if (added.length > 0) {
        signals.push(
          signal(
            SIGNAL_TYPES.TECH_ADOPTION,
            `tech:${added.map((t) => t.toLowerCase()).join('+')}`.slice(0, 200),
            `New technology detected: ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` +${added.length - 5}` : ''}`,
            `Detected since the last radar check: ${added.join(', ')}`,
            at,
            null,
            w.TECH_ADOPTION * (watch.length === 0 ? 0.6 : 1),
            'apollo'
          )
        );
      }
    }
    snapshot.tech = uniqueTech;
  }

  // HEADCOUNT_GROWTH: growth versus the stored headcount snapshot.
  const headcount = Number(org.estimated_num_employees);
  if (Number.isFinite(headcount) && headcount > 0) {
    if (account.snapshot.headcount) {
      const growth = ((headcount - account.snapshot.headcount) / account.snapshot.headcount) * 100;
      if (growth >= config.signals.headcountGrowthPct) {
        signals.push(
          signal(
            SIGNAL_TYPES.HEADCOUNT_GROWTH,
            `headcount:${account.snapshot.headcount}>${headcount}`,
            `Headcount up ${Math.round(growth)}% (${account.snapshot.headcount} to ${headcount})`,
            `Estimated employees grew from ${account.snapshot.headcount} to ${headcount} since the last snapshot.`,
            at,
            null,
            w.HEADCOUNT_GROWTH * (growth >= config.signals.headcountGrowthPct * 2 ? 1.5 : 1),
            'apollo'
          )
        );
      }
    }
    snapshot.headcount = Math.round(headcount);
  }

  // EXEC_HIRING_SPIKE: executive job postings inside the hiring window.
  const postErr = apolloError(postingsJson);
  if (postErr && postErr.status !== 404) errors.push(Object.assign({ source: 'apollo_job_postings' }, postErr));
  const postings = !postErr && isPlainObject(postingsJson) && Array.isArray(postingsJson.organization_job_postings) ? postingsJson.organization_job_postings : [];
  const hiringStart = at.getTime() - config.signals.hiringLookbackDays * DAY_MS;
  const keywords = config.signals.execTitleKeywords;
  const execPostings = postings.filter((p) => {
    if (!isPlainObject(p)) return false;
    const posted = parseDate(p.posted_at || p.last_seen_at);
    if (!posted || posted.getTime() < hiringStart) return false;
    const title = ` ${String(p.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    return keywords.some((k) => title.indexOf(` ${k} `) !== -1);
  });
  if (execPostings.length >= config.signals.execHiringThreshold) {
    const extra = execPostings.length - config.signals.execHiringThreshold;
    signals.push(
      signal(
        SIGNAL_TYPES.EXEC_HIRING_SPIKE,
        `exec_hiring:${at.toISOString().slice(0, 7)}`,
        `${execPostings.length} executive roles posted in ${config.signals.hiringLookbackDays} days`,
        `Recent leadership openings: ${execPostings.slice(0, 6).map((p) => clean(p.title, 80)).join('; ')}`,
        at,
        null,
        w.EXEC_HIRING_SPIKE * (1 + Math.min(extra, 5) * 0.1),
        'apollo'
      )
    );
  }

  return { signals, snapshot, errors, apolloOrganizationId: org.id ? String(org.id) : null };
}

/**
 * Normalize a Clay callback (sent by a Clay "HTTP API" column to the radar webhook).
 * Expected body: { hubspot_company_id, domain, company_name?, owner_id?, signals: [{ type, title, detail?, occurred_at?, source_url?, weight? }] }
 * @returns {{ ok: boolean, reason?: string, account?: object, signals?: object[] }}
 */
function normalizeClayCallback(item, config, now) {
  const at = parseDate(now) || new Date();
  const j = isPlainObject(item) ? item : {};
  const headers = isPlainObject(j.headers) ? j.headers : {};
  const provided = Object.keys(headers).filter((k) => k.toLowerCase() === 'x-radar-secret').map((k) => headers[k])[0];
  if (!config.sources.webhookSecret) {
    if (!config.sandboxMode) return { ok: false, reason: 'WEBHOOK_SECRET_NOT_CONFIGURED' };
  } else if (!provided) {
    return { ok: false, reason: 'WEBHOOK_SECRET_MISSING' };
  } else if (!constantTimeEqual(Array.isArray(provided) ? provided[0] : provided, config.sources.webhookSecret)) {
    return { ok: false, reason: 'WEBHOOK_SECRET_MISMATCH' };
  }
  const body = isPlainObject(j.body) ? j.body : j;
  const companyId = String(body.hubspot_company_id || body.company_id || '').trim();
  if (!/^\d{1,20}$/.test(companyId)) return { ok: false, reason: 'MISSING_COMPANY_ID' };
  const raw = Array.isArray(body.signals) ? body.signals : [];
  const known = Object.keys(SIGNAL_TYPES);
  const signals = raw
    .filter(isPlainObject)
    .slice(0, 25)
    .map((s, i) => {
      const type = known.indexOf(String(s.type || '').toUpperCase()) !== -1 ? String(s.type).toUpperCase() : SIGNAL_TYPES.CLAY_SIGNAL;
      const occurred = parseDate(s.occurred_at) || at;
      const base = config.signals.weights[type] !== undefined ? config.signals.weights[type] : config.signals.weights.CLAY_SIGNAL;
      const weight = Number.isFinite(Number(s.weight)) ? Number(s.weight) : base;
      const title = clean(s.title || type.replace(/_/g, ' ').toLowerCase(), 200);
      return signal(type, `clay:${type.toLowerCase()}:${occurred.toISOString().slice(0, 10)}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60) || i}`, title, s.detail || title, occurred, s.source_url, weight, 'clay');
    })
    .filter((s) => s.title);
  if (signals.length === 0) return { ok: false, reason: 'NO_SIGNALS' };
  const account = {
    companyId,
    name: clean(body.company_name || 'Unnamed company', 120),
    domain: normalizeDomain(body.domain),
    ownerId: body.owner_id && /^\d+$/.test(String(body.owner_id)) ? String(body.owner_id) : null,
    lastCheckedAt: null,
    lastSignalAt: parseDate(body.last_signal_at),
    currentPlay: body.current_play ? String(body.current_play) : null,
    snapshot: { exists: false, tech: [], headcount: null },
  };
  return { ok: true, account, signals };
}

// ---------------------------------------------------------------------------
// Scoring and action planning
// ---------------------------------------------------------------------------

/** Combine signals into a 0-100 expansion score (strongest signal counts fully, the rest at 50%). */
function scoreSignals(signals) {
  const weights = (signals || []).map((s) => s.weight).sort((a, b) => b - a);
  if (weights.length === 0) return 0;
  const total = weights[0] + weights.slice(1).reduce((n, v) => n + v * 0.5, 0);
  return Math.min(100, Math.round(total));
}

/**
 * Decide actions for one account.
 * @param {object} account normalized account
 * @param {object[]} signals detected signals
 * @param {{ snapshot?: object, source: 'apollo'|'clay' }} context
 */
function evaluateAccount(account, signals, config, now, context) {
  const at = parseDate(now) || new Date();
  const ctx = context || {};
  const score = scoreSignals(signals);
  const inCooldown = Boolean(account.lastSignalAt && (at - account.lastSignalAt) / DAY_MS < config.actions.cooldownDays);
  const createTask = config.actions.tasksEnabled && signals.length > 0 && score >= config.actions.taskScoreThreshold && !inCooldown;
  const setPlay = config.actions.playHandoffEnabled && score >= config.actions.playScoreThreshold && account.currentPlay !== config.actions.playValue;
  return {
    account,
    signals,
    score,
    inCooldown,
    decisions: {
      signalRecords: config.actions.signalRecordsEnabled ? signals.length : 0,
      createTask,
      setPlay,
      alert: config.actions.slackEnabled && signals.length > 0 && (createTask || setPlay),
    },
    snapshot: ctx.snapshot || null,
    source: ctx.source || 'apollo',
  };
}

function companyUrl(companyId, config) {
  return config.hubspot.portalId ? `${config.hubspot.appBaseUrl}/contacts/${config.hubspot.portalId}/record/0-2/${encodeURIComponent(companyId)}` : null;
}

function buildSignalRecordPayload(account, s, score, config) {
  return {
    properties: {
      signal_key: `${account.companyId}:${s.key}`.slice(0, 250),
      signal_type: s.type,
      signal_title: s.title,
      signal_detail: s.detail,
      signal_source: s.source,
      signal_weight: String(s.weight),
      account_score: String(score),
      occurred_at: s.occurredAt,
      source_url: s.sourceUrl || '',
    },
    associations: [
      {
        to: { id: account.companyId },
        types: [{ associationCategory: 'USER_DEFINED', associationTypeId: Number(config.hubspot.signalAssociationTypeId) || 0 }],
      },
    ],
  };
}

function buildTaskPayload(account, signals, score, config, now) {
  const at = parseDate(now) || new Date();
  const owner = account.ownerId || config.hubspot.fallbackOwnerId || null;
  const lines = [`Expansion score ${score}/100 from ${signals.length} signal(s):`]
    .concat(signals.map((s) => `- [${s.type}] ${s.title}${s.sourceUrl ? ` (${s.sourceUrl})` : ''}`))
    .concat(['', 'Suggested next step: confirm the signal with your champion and qualify the expansion opportunity.', 'Created by the account expansion radar.']);
  const properties = {
    hs_timestamp: new Date(at.getTime() + config.actions.taskDueDays * DAY_MS).toISOString(),
    hs_task_subject: `Expansion signal: ${account.name} (score ${score})`.slice(0, 250),
    hs_task_body: lines.join('\n').slice(0, 5000),
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: score >= config.actions.playScoreThreshold ? 'HIGH' : 'MEDIUM',
    hs_task_type: 'TODO',
  };
  if (owner) properties.hubspot_owner_id = String(owner);
  return {
    properties,
    associations: [{ to: { id: account.companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: Number(config.hubspot.taskAssociationTypeId) || 192 }] }],
  };
}

function buildCompanyUpdatePayload(evaluation, config, now) {
  const at = parseDate(now) || new Date();
  // Only a scheduled scan counts as a "check"; Clay callbacks must not delay the next Apollo scan.
  const properties = evaluation.source === 'clay' ? {} : { [COMPANY_PROPS.lastChecked]: at.toISOString() };
  if (evaluation.snapshot) {
    if (Array.isArray(evaluation.snapshot.tech)) properties[COMPANY_PROPS.techSnapshot] = evaluation.snapshot.tech.join('; ').slice(0, 65000);
    if (evaluation.snapshot.headcount) properties[COMPANY_PROPS.headcountSnapshot] = String(evaluation.snapshot.headcount);
  }
  if (evaluation.signals.length > 0) {
    properties[COMPANY_PROPS.lastSignal] = at.toISOString();
    properties[COMPANY_PROPS.score] = String(evaluation.score);
  }
  if (evaluation.decisions.setPlay) properties[COMPANY_PROPS.play] = config.actions.playValue;
  return { properties };
}

/** Slack Incoming Webhook payload summarising accounts that triggered actions. */
function buildSlackPayload(evaluations, config, meta) {
  const list = (evaluations || []).filter((e) => e.decisions.alert).sort((a, b) => b.score - a.score);
  const info = meta || {};
  const text = `Account expansion radar: ${list.length} account(s) with new expansion signals`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📡 Expansion radar: ${list.length} account(s) heating up`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${config.sandboxMode ? 'SANDBOX · ' : ''}${info.source === 'clay' ? 'Clay callback' : 'Scheduled scan'}${info.runId ? ` · run ${escapeSlack(info.runId)}` : ''}` }] },
  ];
  list.slice(0, 40).forEach((e) => {
    const url = companyUrl(e.account.companyId, config);
    const name = escapeSlack(e.account.name);
    const actions = [e.decisions.createTask ? 'task created' : null, e.decisions.setPlay ? `play → \`${config.actions.playValue}\`` : null].filter(Boolean).join(' · ');
    const lines = e.signals.slice(0, 5).map((s) => `• *${s.type.replace(/_/g, ' ').toLowerCase()}*: ${escapeSlack(s.title)}`);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${url ? `<${url}|${name}>` : name} · score *${e.score}*${actions ? ` · ${actions}` : ''}\n${lines.join('\n')}`.slice(0, 2900) },
    });
  });
  if (list.length > 40) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${list.length - 40} more` }] });
  return { text, blocks };
}

/**
 * Convert evaluations into routed n8n items:
 *   run_summary · signal_record · task_create · company_update · slack_alert
 */
function planActions(evaluations, config, now, meta) {
  const info = meta || {};
  const base = { sandbox: Boolean(config.sandboxMode), runId: info.runId || null };
  const items = [];
  const counts = { accounts: evaluations.length, withSignals: 0, signalRecords: 0, tasks: 0, plays: 0, companyUpdates: 0, alerts: 0 };

  evaluations.forEach((e) => {
    if (e.signals.length > 0) counts.withSignals += 1;
    if (config.actions.signalRecordsEnabled) {
      e.signals.forEach((s) => {
        counts.signalRecords += 1;
        items.push(Object.assign({ kind: 'signal_record', companyId: e.account.companyId, signalType: s.type, objectType: config.hubspot.signalObjectType || null, body: buildSignalRecordPayload(e.account, s, e.score, config) }, base));
      });
    }
    if (e.decisions.createTask) {
      counts.tasks += 1;
      items.push(Object.assign({ kind: 'task_create', companyId: e.account.companyId, body: buildTaskPayload(e.account, e.signals, e.score, config, now) }, base));
    }
    if (e.decisions.setPlay) counts.plays += 1;
    const update = buildCompanyUpdatePayload(e, config, now);
    if (Object.keys(update.properties).length > 0) {
      counts.companyUpdates += 1;
      items.push(Object.assign({ kind: 'company_update', companyId: e.account.companyId, body: update }, base));
    }
  });

  const alerting = evaluations.filter((e) => e.decisions.alert);
  if (alerting.length > 0) {
    counts.alerts = alerting.length;
    items.push(Object.assign({ kind: 'slack_alert', payload: buildSlackPayload(evaluations, config, info) }, base));
  }

  const summary = Object.assign(
    {
      kind: 'run_summary',
      engineVersion: ENGINE_VERSION,
      source: info.source || 'apollo',
      status: info.status || 'OK',
      counts,
      skipped: info.skipped || {},
      errors: (info.errors || []).map((x) => ({ source: x.source || null, status: x.status || null, rateLimited: Boolean(x.rateLimited), message: redact(x.message) })),
      accounts: evaluations
        .filter((e) => e.signals.length > 0)
        .map((e) => ({ companyId: e.account.companyId, score: e.score, signals: e.signals.map((s) => s.type), task: e.decisions.createTask, play: e.decisions.setPlay, cooldown: e.inCooldown })),
    },
    base
  );
  return [summary].concat(items);
}

/** Sanitized log lines for the sandbox branch. */
function buildDryRunReport(itemJsons) {
  const list = (Array.isArray(itemJsons) ? itemJsons : []).filter(isPlainObject);
  const summaries = list.filter((i) => i.kind === 'run_summary');
  const byKind = {};
  list.forEach((i) => (byKind[i.kind] = (byKind[i.kind] || 0) + 1));
  const lines = [];
  summaries.forEach((s) => {
    lines.push(`[radar] DRY RUN source=${s.source} status=${s.status} accounts=${s.counts.accounts} withSignals=${s.counts.withSignals} skipped=${JSON.stringify(s.skipped)}`);
    s.accounts.forEach((a) => lines.push(`[radar]   company=${a.companyId} score=${a.score} signals=${a.signals.join(',')} task=${a.task} play=${a.play}${a.cooldown ? ' (cooldown)' : ''}`));
    s.errors.forEach((e) => lines.push(`[radar]   error source=${e.source} status=${e.status} rateLimited=${e.rateLimited} ${e.message}`));
  });
  lines.push(`[radar] would create ${byKind.signal_record || 0} signal record(s), ${byKind.task_create || 0} task(s), update ${byKind.company_update || 0} compan(ies), send ${byKind.slack_alert || 0} Slack alert(s)`);
  return { kind: 'dry_run_report', mode: 'SANDBOX', planned: byKind, lines: lines.map(redact) };
}

module.exports = {
  ENGINE_VERSION,
  SIGNAL_TYPES,
  COMPANY_PROPS,
  SKIP_REASONS,
  parseDate,
  redact,
  normalizeDomain,
  constantTimeEqual,
  buildCompanySearchRequest,
  normalizeAccount,
  prepareAccounts,
  accountToJson,
  accountFromJson,
  detectApolloSignals,
  normalizeClayCallback,
  scoreSignals,
  evaluateAccount,
  buildSignalRecordPayload,
  buildTaskPayload,
  buildCompanyUpdatePayload,
  buildSlackPayload,
  planActions,
  buildDryRunReport,
};
