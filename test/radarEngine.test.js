'use strict';

/**
 * test/radarEngine.test.js
 * Unit tests for src/config.js and src/radarEngine.js (node:test). Synthetic data only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError, ENV_KEYS, DEFAULTS, isPlaceholder } = require('../src/config');
const R = require('../src/radarEngine');

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86400000;
const iso = (daysAgo) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const cfg = (o) => loadConfig(Object.assign({ AS_OF_DATE: '2026-06-01', TECH_WATCHLIST: 'Snowflake,Segment', HUBSPOT_PORTAL_ID: '12345678', RADAR_WEBHOOK_SECRET: 'test-only-radar-secret-0000' }, o || {}));

function account(overrides) {
  return Object.assign(
    { companyId: '1', name: 'Synthetic Company Alpha', domain: 'example-corp.com', ownerId: '901', lastCheckedAt: null, lastSignalAt: null, currentPlay: null, snapshot: { exists: true, tech: ['HubSpot'], headcount: 100 } },
    overrides || {}
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('config: safe defaults; every key declared; placeholders are unset', () => {
  const c = loadConfig({});
  assert.equal(c.sandboxMode, true);
  assert.equal(c.hubspot.lifecycleStage, 'customer');
  assert.equal(c.actions.playValue, 'expansion_upsell');
  Object.keys(DEFAULTS).forEach((k) => assert.ok(ENV_KEYS.includes(k), k));
  ['REPLACE_WITH_SLACK_WEBHOOK_URL', '{{X}}', 'YOUR_KEY', 'your-portal-id'].forEach((v) => assert.equal(isPlaceholder(v), true, v));
  assert.equal(loadConfig({ SLACK_WEBHOOK_URL: 'REPLACE_WITH_SLACK_WEBHOOK_URL' }).actions.slackWebhookConfigured, false);
});

test('config: webhook URLs are never stored, only their presence', () => {
  const c = cfg({ SLACK_WEBHOOK_URL: 'https://slack-webhook.example/test-only', CLAY_TABLE_WEBHOOK_URL: 'https://clay-webhook.example/test-only' });
  const text = JSON.stringify(c);
  assert.ok(!text.includes('slack-webhook.example') && !text.includes('clay-webhook.example'));
  assert.equal(c.actions.slackWebhookConfigured, true);
  assert.equal(c.sources.clayWebhookConfigured, true);
});

test('config: fail fast with every problem listed', () => {
  assert.throws(
    () =>
      loadConfig({
        SANDBOX_MODE: 'perhaps',
        AS_OF_DATE: 'soon',
        MAX_ACCOUNTS_PER_RUN: '0',
        EXPANSION_SIGNAL_OBJECT_TYPE: 'expansion_signals',
        SIGNAL_COMPANY_ASSOCIATION_TYPE_ID: 'abc',
        RADAR_WEBHOOK_SECRET: 'short',
        EXPANSION_PLAY_VALUE: 'Upsell Play',
        WEIGHT_FUNDING: '500',
        CLAY_TABLE_WEBHOOK_URL: 'http://insecure.example',
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      const t = err.problems.join('\n');
      ['SANDBOX_MODE', 'AS_OF_DATE', 'MAX_ACCOUNTS_PER_RUN', 'EXPANSION_SIGNAL_OBJECT_TYPE', 'signalAssociationTypeId', 'RADAR_WEBHOOK_SECRET', 'EXPANSION_PLAY_VALUE', 'WEIGHT_FUNDING', 'CLAY_TABLE_WEBHOOK_URL'].forEach((n) =>
        assert.ok(t.includes(n), `missing ${n}`)
      );
      return true;
    }
  );
});

test('config: live mode requirements', () => {
  assert.throws(() => cfg({ SANDBOX_MODE: 'false' }), /EXPANSION_SIGNAL_OBJECT_TYPE is required/);
  const live = cfg({ SANDBOX_MODE: 'false', EXPANSION_SIGNAL_OBJECT_TYPE: 'p12345678_expansion_signals', SIGNAL_COMPANY_ASSOCIATION_TYPE_ID: '45', SLACK_WEBHOOK_URL: 'https://slack-webhook.example/x' });
  assert.equal(live.hubspot.signalObjectType, 'p12345678_expansion_signals');
  assert.throws(() => cfg({ SANDBOX_MODE: 'false', ENABLE_SIGNAL_RECORDS: 'false', ENABLE_SLACK: 'false', ENABLE_APOLLO: 'false' }), /no signal source/);
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

test('normalizeDomain', () => {
  assert.equal(R.normalizeDomain('https://www.Example-Corp.com/about?x=1'), 'example-corp.com');
  assert.equal(R.normalizeDomain('example-corp.com:8080'), 'example-corp.com');
  ['', 'localhost', null, 'not a domain'].forEach((v) => assert.equal(R.normalizeDomain(v), ''));
});

test('buildCompanySearchRequest targets the lifecycle stage and requests radar properties', () => {
  const body = R.buildCompanySearchRequest(cfg({ TARGET_LIFECYCLE_STAGE: 'evangelist' }));
  assert.deepEqual(body.filterGroups[0].filters[0], { propertyName: 'lifecyclestage', operator: 'EQ', value: 'evangelist' });
  Object.values(R.COMPANY_PROPS).forEach((p) => assert.ok(body.properties.includes(p)));
});

test('prepareAccounts applies cadence, dedupe, domain and run cap rules', () => {
  const company = (id, props) => ({ id: String(id), properties: Object.assign({ name: `Synthetic ${id}`, domain: `c${id}.example` }, props) });
  const pages = [
    { results: [company(1, {}), company(2, { expansion_radar_last_checked_at: iso(2) }), company(3, { domain: '' }), company(1, {}), 'junk'] },
    { json: { results: [company(4, { website: 'https://www.c4.example' }), company(5, {})] } },
    { error: { message: 'Bad gateway', httpCode: '502' } },
  ];
  const out = R.prepareAccounts(pages, cfg({ MAX_ACCOUNTS_PER_RUN: '2' }), NOW);
  assert.deepEqual(out.accounts.map((a) => a.companyId), ['1', '4']);
  assert.equal(out.accounts[1].domain, 'c4.example');
  assert.deepEqual(out.skipped, { RECENTLY_CHECKED: 1, NO_DOMAIN: 1, DUPLICATE: 1, INVALID_RECORD: 1, RUN_LIMIT_REACHED: 1 });
  assert.equal(out.errors[0].status, 502);
  assert.deepEqual(R.prepareAccounts(null, cfg(), NOW).accounts, []);
});

test('accountToJson / accountFromJson round-trip', () => {
  const a = account({ lastSignalAt: new Date(iso(3)) });
  const back = R.accountFromJson(JSON.parse(JSON.stringify(R.accountToJson(a, cfg()))));
  assert.equal(back.companyId, '1');
  assert.equal(back.lastSignalAt.toISOString(), iso(3));
  assert.deepEqual(back.snapshot.tech, ['HubSpot']);
  assert.match(R.accountToJson(a, cfg()).apolloEnrichUrl, /^https:\/\/api\.apollo\.io\/api\/v1\/organizations\/enrich\?domain=example-corp\.com$/);
});

// ---------------------------------------------------------------------------
// Apollo signals
// ---------------------------------------------------------------------------

const org = (o) => ({ organization: Object.assign({ id: 'org1', estimated_num_employees: 100, current_technologies: [{ name: 'HubSpot' }], funding_events: [] }, o) });

test('FUNDING: only rounds inside the look-back window; large rounds weigh more', () => {
  const c = cfg();
  const r = R.detectApolloSignals(account(), org({ funding_events: [{ date: iso(10).slice(0, 10), type: 'Series C', amount: 80000000, currency: 'USD', news_url: 'https://news.example-corp.com/c' }, { date: iso(400).slice(0, 10), type: 'Seed' }] }), null, c, NOW);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].type, 'FUNDING');
  assert.equal(r.signals[0].weight, 50);
  assert.match(r.signals[0].title, /Series C \(USD 80\.0M\)/);
  assert.equal(r.signals[0].sourceUrl, 'https://news.example-corp.com/c');
  const small = R.detectApolloSignals(account(), org({ funding_events: [{ date: iso(5), type: 'Seed', amount: 1000000 }] }), null, c, NOW);
  assert.equal(small.signals[0].weight, 40);
});

test('TECH_ADOPTION: watchlist, baseline-only first run, empty watchlist', () => {
  const c = cfg();
  const tech = { current_technologies: [{ name: 'HubSpot' }, { name: 'Snowflake' }, { name: 'Notion' }] };
  const r = R.detectApolloSignals(account(), org(tech), null, c, NOW);
  assert.equal(r.signals.length, 1);
  assert.match(r.signals[0].title, /Snowflake/);
  assert.ok(!r.signals[0].title.includes('Notion'), 'not on watchlist');
  assert.deepEqual(r.snapshot.tech, ['HubSpot', 'Notion', 'Snowflake']);

  const first = R.detectApolloSignals(account({ snapshot: { exists: false, tech: [], headcount: null } }), org(tech), null, c, NOW);
  assert.equal(first.signals.length, 0, 'first run stores a baseline');
  assert.equal(first.snapshot.headcount, 100);

  const open = R.detectApolloSignals(account(), org(tech), null, cfg({ TECH_WATCHLIST: '' }), NOW);
  assert.match(open.signals[0].title, /Notion, Snowflake/);
  assert.equal(open.signals[0].weight, 15, 'reduced weight without a watchlist');
});

test('HEADCOUNT_GROWTH: threshold and strong-growth boost', () => {
  const c = cfg();
  assert.equal(R.detectApolloSignals(account(), org({ estimated_num_employees: 110 }), null, c, NOW).signals.length, 0);
  const mid = R.detectApolloSignals(account(), org({ estimated_num_employees: 120 }), null, c, NOW).signals[0];
  assert.equal(mid.type, 'HEADCOUNT_GROWTH');
  assert.equal(mid.weight, 15);
  assert.equal(R.detectApolloSignals(account(), org({ estimated_num_employees: 150 }), null, c, NOW).signals[0].weight, 23);
});

test('EXEC_HIRING_SPIKE: counts recent executive titles only', () => {
  const c = cfg();
  const post = (title, days) => ({ title, posted_at: iso(days) });
  const postings = { organization_job_postings: [post('VP of Sales', 3), post('Chief Financial Officer', 5), post('Head of Platform', 9), post('Director, Security', 12), post('Account Executive', 2), post('VP Product', 60), post('Vice President Ops', 1)] };
  const r = R.detectApolloSignals(account(), org({}), postings, c, NOW);
  const s = r.signals.find((x) => x.type === 'EXEC_HIRING_SPIKE');
  assert.match(s.title, /^5 executive roles/);
  assert.equal(s.weight, 36);
  const few = R.detectApolloSignals(account(), org({}), { organization_job_postings: [post('VP of Sales', 3)] }, c, NOW);
  assert.equal(few.signals.length, 0);
});

test('Apollo errors: 404 is "not found", 429 is reported as rate limited', () => {
  const c = cfg();
  const nf = R.detectApolloSignals(account(), { error: { message: 'Request failed with status code 404', httpCode: '404' } }, null, c, NOW);
  assert.deepEqual([nf.signals.length, nf.errors.length, nf.apolloOrganizationId], [0, 0, null]);
  const rl = R.detectApolloSignals(account(), org({}), { error: { message: 'Too Many Requests', httpCode: '429' } }, c, NOW);
  assert.equal(rl.errors[0].rateLimited, true);
  const auth = R.detectApolloSignals(account(), { error: { message: 'Invalid key for ops@example.com', httpCode: '401' } }, null, c, NOW);
  assert.equal(auth.errors[0].status, 401);
  assert.ok(!auth.errors[0].message.includes('ops@example.com'));
});

// ---------------------------------------------------------------------------
// Clay callbacks
// ---------------------------------------------------------------------------

const clayBody = { hubspot_company_id: '7', domain: 'example-corp.com', company_name: 'Synthetic Company Alpha', signals: [{ type: 'funding', title: 'Raised a round', occurred_at: '2026-05-30' }, { type: 'custom_intent', title: 'Hiring RevOps', weight: 12 }, 'junk'] };

test('normalizeClayCallback: authentication and signal mapping', () => {
  const c = cfg();
  const ok = R.normalizeClayCallback({ headers: { 'X-Radar-Secret': 'test-only-radar-secret-0000' }, body: clayBody }, c, NOW);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.signals.map((s) => [s.type, s.weight, s.source]), [['FUNDING', 40, 'clay'], ['CLAY_SIGNAL', 12, 'clay']]);
  assert.equal(R.normalizeClayCallback({ headers: { 'x-radar-secret': 'nope' }, body: clayBody }, c, NOW).reason, 'WEBHOOK_SECRET_MISMATCH');
  assert.equal(R.normalizeClayCallback({ headers: {}, body: clayBody }, c, NOW).reason, 'WEBHOOK_SECRET_MISSING');
  const noSecret = cfg({ RADAR_WEBHOOK_SECRET: '' });
  assert.equal(R.normalizeClayCallback({ body: clayBody }, noSecret, NOW).ok, true, 'sandbox accepts unauthenticated test calls');
  const auth = { 'x-radar-secret': 'test-only-radar-secret-0000' };
  assert.equal(R.normalizeClayCallback({ headers: auth, body: { signals: [] } }, c, NOW).reason, 'MISSING_COMPANY_ID');
  assert.equal(R.normalizeClayCallback({ headers: auth, body: { hubspot_company_id: '7', signals: [] } }, c, NOW).reason, 'NO_SIGNALS');
});

// ---------------------------------------------------------------------------
// Scoring, decisions and payloads
// ---------------------------------------------------------------------------

test('scoreSignals: strongest signal full weight, others half, capped at 100', () => {
  assert.equal(R.scoreSignals([]), 0);
  assert.equal(R.scoreSignals([{ weight: 40 }, { weight: 30 }, { weight: 10 }]), 60);
  assert.equal(R.scoreSignals([{ weight: 90 }, { weight: 90 }]), 100);
});

test('evaluateAccount: thresholds, cooldown and existing play', () => {
  const c = cfg();
  const s = (w) => ({ type: 'FUNDING', key: `k${w}`, title: 't', detail: 'd', occurredAt: NOW.toISOString(), sourceUrl: null, weight: w, source: 'apollo' });
  const hot = R.evaluateAccount(account(), [s(50), s(30)], c, NOW, {});
  assert.deepEqual([hot.score, hot.decisions.createTask, hot.decisions.setPlay, hot.decisions.alert], [65, true, true, true]);
  const warm = R.evaluateAccount(account(), [s(45)], c, NOW, {});
  assert.deepEqual([warm.decisions.createTask, warm.decisions.setPlay], [true, false]);
  const cooling = R.evaluateAccount(account({ lastSignalAt: new Date(iso(5)) }), [s(50), s(30)], c, NOW, {});
  assert.deepEqual([cooling.inCooldown, cooling.decisions.createTask], [true, false]);
  const already = R.evaluateAccount(account({ currentPlay: 'expansion_upsell' }), [s(80)], c, NOW, {});
  assert.equal(already.decisions.setPlay, false);
  const off = R.evaluateAccount(account(), [s(80)], cfg({ ENABLE_TASKS: 'false', ENABLE_PLAY_HANDOFF: 'false' }), NOW, {});
  assert.deepEqual([off.decisions.createTask, off.decisions.setPlay, off.decisions.alert], [false, false, false]);
});

test('payload builders: custom object record, task, company update and Slack', () => {
  const c = cfg({ EXPANSION_SIGNAL_OBJECT_TYPE: '2-1234567', SIGNAL_COMPANY_ASSOCIATION_TYPE_ID: '45', FALLBACK_OWNER_ID: '777' });
  const sig = { type: 'FUNDING', key: 'funding:2026-05-10:series_b', title: 'Series B', detail: 'd', occurredAt: '2026-05-10T00:00:00.000Z', sourceUrl: null, weight: 50, source: 'apollo' };
  const rec = R.buildSignalRecordPayload(account(), sig, 65, c);
  assert.equal(rec.properties.signal_key, '1:funding:2026-05-10:series_b');
  assert.equal(rec.properties.source_url, '');
  assert.equal(rec.associations[0].types[0].associationTypeId, 45);

  const task = R.buildTaskPayload(account({ ownerId: null }), [sig], 65, c, NOW);
  assert.equal(task.properties.hubspot_owner_id, '777');
  assert.equal(task.properties.hs_timestamp, new Date(NOW.getTime() + 3 * DAY).toISOString());
  assert.equal(task.associations[0].types[0].associationTypeId, 192);

  const ev = R.evaluateAccount(account(), [sig, Object.assign({}, sig, { key: 'x', weight: 30 })], c, NOW, { snapshot: { tech: ['A', 'B'], headcount: 120 } });
  const upd = R.buildCompanyUpdatePayload(ev, c, NOW).properties;
  assert.equal(upd.expansion_radar_tech_snapshot, 'A; B');
  assert.equal(upd.expansion_radar_play, 'expansion_upsell');
  assert.equal(upd.expansion_radar_last_checked_at, NOW.toISOString());

  const slack = R.buildSlackPayload([ev], c, { runId: 'r1' });
  assert.match(slack.text, /1 account/);
  assert.match(JSON.stringify(slack.blocks), /record\/0-2\/1\|Synthetic Company Alpha/);
});

test('planActions and buildDryRunReport', () => {
  const c = cfg();
  const sig = { type: 'FUNDING', key: 'k', title: 'Series A <b>', detail: 'd', occurredAt: null, sourceUrl: null, weight: 70, source: 'apollo' };
  const evals = [R.evaluateAccount(account(), [sig], c, NOW, { snapshot: { tech: [], headcount: 100 } }), R.evaluateAccount(account({ companyId: '2' }), [], c, NOW, { snapshot: null })];
  const items = R.planActions(evals, c, NOW, { runId: 'r1', skipped: { NO_DOMAIN: 1 }, errors: [{ source: 'apollo_enrich', status: 401, message: 'key for ops@example.com' }] });
  assert.deepEqual(items.map((i) => i.kind), ['run_summary', 'signal_record', 'task_create', 'company_update', 'company_update', 'slack_alert']);
  assert.ok(items.every((i) => i.sandbox === true));
  assert.ok(!JSON.stringify(items[0]).includes('ops@example.com'));
  assert.match(JSON.stringify(items[5].payload), /Series A &lt;b&gt;/);
  const dry = R.buildDryRunReport(items);
  assert.deepEqual(dry.planned, { run_summary: 1, signal_record: 1, task_create: 1, company_update: 2, slack_alert: 1 });
  assert.ok(dry.lines.some((l) => l.includes('company=1 score=70')));
});

test('redact strips secrets from free text', () => {
  const out = R.redact('ops@example.com Bearer abc.def https://hooks.slack.com/services/X/Y/Z https://api.clay.com/v3/sources/webhook/abc ?api_key=123');
  ['ops@example.com', 'abc.def', 'hooks.slack.com', 'api.clay.com', 'api_key=123'].forEach((s) => assert.ok(!out.includes(s), s));
});
