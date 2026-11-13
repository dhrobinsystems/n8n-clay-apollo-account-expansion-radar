'use strict';

/**
 * test/workflow.test.js
 * ---------------------------------------------------------------------------
 * 1. Validates the structure of workflow.json (nodes, connections, credentials).
 * 2. Executes every generated Code node in an isolated VM that mimics the n8n
 *    Code node runtime ($input, $json, $env, $execution, $().itemMatching()),
 *    replaying the full workflow against synthetic fixtures (no network calls).
 * 3. Security scan: fails if any repository file contains a live-looking API
 *    token, webhook URL, private key or a non-placeholder email address.
 *
 * Runs on the Node.js built-in test runner (node --test); no Jest install needed.
 * DISCLAIMER: provided "AS IS", without warranty of any kind. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildWorkflow, serialize } = require('../scripts/build-workflow');

const ROOT = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const SECRET = 'test-only-radar-secret-0000';

/** Test environment. AS_OF_DATE pins "now" to the fixture dates. */
const ENV = Object.freeze({
  SANDBOX_MODE: 'true',
  AS_OF_DATE: '2026-06-01',
  HUBSPOT_PORTAL_ID: '12345678',
  TECH_WATCHLIST: 'Snowflake,Segment',
  RADAR_WEBHOOK_SECRET: SECRET,
});
const LIVE_ENV = Object.freeze(
  Object.assign({}, ENV, {
    SANDBOX_MODE: 'false',
    EXPANSION_SIGNAL_OBJECT_TYPE: '2-1234567',
    SIGNAL_COMPANY_ASSOCIATION_TYPE_ID: '45',
    SLACK_WEBHOOK_URL: 'https://slack-webhook.example/test-only',
  })
);

function node(name) {
  const n = workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `missing node ${name}`);
  return n;
}

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Execute a Code node like n8n does (both "all items" and "each item" modes). */
async function runCodeNode(name, inputJsons, options) {
  const opts = options || {};
  const n = node(name);
  const items = (inputJsons || []).map((json) => ({ json }));
  const logs = [];
  const paired = opts.paired || {};
  const each = n.parameters.mode === 'runOnceForEachItem';
  const context = (index) => {
    const ctx = {
      $input: { all: () => items, first: () => items[0], item: items[index] },
      $json: each && items[index] ? items[index].json : undefined,
      $execution: { id: 'test-exec-1' },
      $: (nodeName) => ({
        itemMatching: (i) => {
          const list = paired[nodeName] || [];
          if (list[i] === undefined) throw new Error(`no paired item ${nodeName}[${i}]`);
          return { json: list[i] };
        },
        first: () => ({ json: (paired[nodeName] || [])[0] }),
      }),
      console: { log: (...a) => logs.push(a.join(' ')), warn: () => {}, error: () => {} },
    };
    if (opts.blockEnv) {
      Object.defineProperty(ctx, '$env', {
        get() {
          throw new Error('access to env vars denied');
        },
      });
    } else ctx.$env = opts.env || ENV;
    return ctx;
  };
  const run = (ctx) => vm.runInNewContext(`(async () => {\n${n.parameters.jsCode}\n})()`, ctx, { timeout: 10000 });
  if (!each) return { output: plain(await run(context(0))) || [], logs };
  const output = [];
  for (let i = 0; i < items.length; i += 1) output.push(plain(await run(context(i))));
  return { output: output.filter(Boolean), logs };
}

/** Replay the scheduled (Apollo) path against fixtures, following workflow.json routing. */
async function simulateScan(env) {
  const useEnv = env || ENV;
  const cfg = await runCodeNode('Load Configuration', [{}], { env: useEnv });
  const pages = fixture('hubspot-companies.json').pages;
  const prepared = await runCodeNode('Prepare Accounts', pages, { env: useEnv });
  const accounts = prepared.output.map((i) => i.json).filter((a) => a.apolloEnabled);
  const enrichFx = fixture('apollo-enrich.json').responses;
  const postingsFx = fixture('apollo-job-postings.json').responses;
  const requests = { apollo: [], hubspotWrites: [] };

  const enrich = accounts.map((a) => {
    requests.apollo.push(a.apolloEnrichUrl);
    return enrichFx[a.domain] || { error: { message: 'Request failed with status code 404', httpCode: '404' } };
  });
  const plans = (await runCodeNode('Plan Job Posting Lookup', enrich, { env: useEnv })).output.map((i) => i.json);
  const postings = plans.map((p) => {
    if (!p.jobPostingsUrl) return { error: { message: 'Invalid URL' } };
    requests.apollo.push(p.jobPostingsUrl);
    const id = p.jobPostingsUrl.split('/').slice(-2)[0];
    return postingsFx[id] || { error: { message: 'Request failed with status code 404', httpCode: '404' } };
  });
  const scored = await runCodeNode('Score Apollo Signals', postings, {
    env: useEnv,
    paired: { 'Prepare Accounts': accounts, 'Apollo Organization Enrich': enrich, 'Plan Job Posting Lookup': plans },
  });
  const items = scored.output.map((i) => i.json);
  const clayRows = (await runCodeNode('Build Clay Rows', accounts, { env: useEnv })).output.map((i) => i.json);
  let dryRun = null;
  if (items.length && items[0].sandbox) dryRun = (await runCodeNode('Dry-Run Telemetry', items, { env: useEnv })).output[0].json;
  else items.filter((i) => i.kind !== 'run_summary').forEach((i) => requests.hubspotWrites.push(i.kind));
  return { config: cfg.output[0].json, prepared, accounts, items, dryRun, clayRows, requests };
}

function clayItem(secret) {
  const item = fixture('clay-callback.json').item;
  item.headers['x-radar-secret'] = secret;
  return item;
}

// ---------------------------------------------------------------------------
// 1. Structure
// ---------------------------------------------------------------------------

test('workflow.json is valid JSON and matches a fresh build of src/', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), serialize(buildWorkflow()), 'run npm run build');
  assert.equal(typeof workflow.name, 'string');
  assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length >= 15);
  assert.equal(workflow.active, false, 'workflow must import inactive');
  assert.equal(workflow.settings.executionOrder, 'v1');
});

test('required nodes exist with the expected types', () => {
  const expected = {
    'Daily Schedule': 'n8n-nodes-base.scheduleTrigger',
    'Manual Run': 'n8n-nodes-base.manualTrigger',
    'HubSpot API: Search Customer Accounts': 'n8n-nodes-base.httpRequest',
    'Apollo Organization Enrich': 'n8n-nodes-base.httpRequest',
    'Apollo Job Postings': 'n8n-nodes-base.httpRequest',
    'Clay Table Webhook': 'n8n-nodes-base.httpRequest',
    'Clay Signal Callback': 'n8n-nodes-base.webhook',
    'Score Apollo Signals': 'n8n-nodes-base.code',
    'Score Clay Signals': 'n8n-nodes-base.code',
    'Sandbox Mode?': 'n8n-nodes-base.if',
    'Route Actions': 'n8n-nodes-base.switch',
    'HubSpot Create Expansion Signal': 'n8n-nodes-base.httpRequest',
    'HubSpot Create Task': 'n8n-nodes-base.httpRequest',
    'HubSpot Update Company': 'n8n-nodes-base.httpRequest',
    'Slack Alert': 'n8n-nodes-base.httpRequest',
    'Dry-Run Telemetry': 'n8n-nodes-base.code',
  };
  Object.entries(expected).forEach(([name, type]) => assert.equal(node(name).type, type, name));
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length, 'unique node IDs');
  assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length, 'unique node names');
});

test('connections reference real nodes and every action node is reachable', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  const targets = new Set();
  Object.entries(workflow.connections).forEach(([src, v]) => {
    assert.ok(names.has(src), src);
    v.main.forEach((branch) => branch.forEach((c) => (assert.ok(names.has(c.node), c.node), targets.add(c.node))));
  });
  workflow.nodes.filter((n) => !/Trigger$|webhook$|stickyNote$/.test(n.type)).forEach((n) => assert.ok(targets.has(n.name), `${n.name} unreachable`));
  assert.equal(workflow.connections['Sandbox Mode?'].main[0][0].node, 'Dry-Run Telemetry');
  assert.equal(workflow.connections['Sandbox Mode?'].main[1][0].node, 'Route Actions');
  const kinds = node('Route Actions').parameters.rules.values.map((r) => r.conditions.conditions[0].rightValue);
  assert.deepEqual(kinds, ['signal_record', 'task_create', 'company_update', 'slack_alert']);
});

test('credentials are placeholders and outbound calls are retried, paced and fault-tolerant', () => {
  workflow.nodes
    .filter((n) => n.credentials)
    .forEach((n) =>
      Object.values(n.credentials).forEach((c) => {
        assert.match(c.id, /^REPLACE_WITH_/, n.name);
        assert.match(c.name, /REPLACE_WITH_/, n.name);
      })
    );
  workflow.nodes
    .filter((n) => n.type === 'n8n-nodes-base.httpRequest')
    .forEach((n) => {
      assert.equal(n.retryOnFail, true, n.name);
      assert.equal(n.onError, 'continueRegularOutput', n.name);
    });
  assert.equal(node('Slack Alert').parameters.url, '={{ $env.SLACK_WEBHOOK_URL }}', 'webhook URL comes from the environment');
  assert.equal(node('Clay Table Webhook').parameters.url, '={{ $env.CLAY_TABLE_WEBHOOK_URL }}');
  assert.equal(node('Apollo Organization Enrich').parameters.options.batching.batch.batchSize, 1);
  assert.equal(node('Clay Signal Callback').parameters.responseMode, 'onReceived');
});

// ---------------------------------------------------------------------------
// 2. Code node execution against synthetic fixtures
// ---------------------------------------------------------------------------

test('Load Configuration fails fast in live mode without required settings', async () => {
  await assert.rejects(() => runCodeNode('Load Configuration', [{}], { env: { SANDBOX_MODE: 'false' } }), /EXPANSION_SIGNAL_OBJECT_TYPE is required/);
  const blocked = await runCodeNode('Load Configuration', [{}], { blockEnv: true });
  assert.equal(blocked.output[0].json.sandbox, true, 'blocked $env falls back to sandbox');
  assert.equal(blocked.output[0].json.searchBody.filterGroups[0].filters[0].value, 'customer');
});

test('sandbox scan: accounts are selected, scored and nothing is written', async () => {
  const r = await simulateScan();
  assert.deepEqual(r.accounts.map((a) => a.companyId), ['101', '102', '103', '106', '107', '108']);
  const summary = r.items.find((i) => i.kind === 'run_summary');
  assert.deepEqual(summary.skipped, { RECENTLY_CHECKED: 1, NO_DOMAIN: 1, DUPLICATE: 1 });
  assert.equal(summary.status, 'PARTIAL_RATE_LIMITED', 'Apollo 429 on one account is reported');
  const byCompany = Object.fromEntries(summary.accounts.map((a) => [a.companyId, a]));
  assert.deepEqual(byCompany['101'].signals.sort(), ['EXEC_HIRING_SPIKE', 'FUNDING']);
  assert.equal(byCompany['101'].score, 67);
  assert.equal(byCompany['101'].task, true);
  assert.equal(byCompany['101'].play, true);
  assert.deepEqual(byCompany['102'].signals.sort(), ['HEADCOUNT_GROWTH', 'TECH_ADOPTION']);
  assert.equal(byCompany['102'].task, false, 'below TASK_SCORE_THRESHOLD');
  assert.equal(byCompany['107'].cooldown, true);
  assert.equal(byCompany['107'].task, false);
  assert.equal(byCompany['103'], undefined, 'no signals');
  assert.equal(r.items.filter((i) => i.kind === 'signal_record').length, 5);
  assert.equal(r.items.filter((i) => i.kind === 'task_create').length, 1);
  assert.equal(r.items.filter((i) => i.kind === 'company_update').length, 6);
  assert.equal(r.items.filter((i) => i.kind === 'slack_alert').length, 1);
  assert.deepEqual(r.requests.hubspotWrites, [], 'sandbox writes nothing');
  assert.deepEqual(r.clayRows, [], 'no Clay push in sandbox');
  assert.ok(r.dryRun.lines.some((l) => l.includes('company=101 score=67')));
  assert.ok(r.requests.apollo.every((u) => u.startsWith('https://api.apollo.io/api/v1/organizations/')));
});

test('live scan: payloads for custom object, task, company update and Slack', async () => {
  const r = await simulateScan(LIVE_ENV);
  assert.equal(r.dryRun, null);
  const record = r.items.find((i) => i.kind === 'signal_record' && i.companyId === '101' && i.signalType === 'FUNDING');
  assert.equal(record.objectType, '2-1234567');
  assert.equal(record.body.properties.signal_key, '101:funding:2026-05-10:series_b');
  assert.deepEqual(record.body.associations[0], { to: { id: '101' }, types: [{ associationCategory: 'USER_DEFINED', associationTypeId: 45 }] });
  const task = r.items.find((i) => i.kind === 'task_create');
  assert.equal(task.body.properties.hubspot_owner_id, '901');
  assert.equal(task.body.properties.hs_task_priority, 'HIGH');
  const update101 = r.items.find((i) => i.kind === 'company_update' && i.companyId === '101').body.properties;
  assert.equal(update101.expansion_radar_play, 'expansion_upsell');
  assert.equal(update101.expansion_radar_score, '67');
  assert.equal(update101.expansion_radar_headcount_snapshot, '210');
  const update108 = r.items.find((i) => i.kind === 'company_update' && i.companyId === '108').body.properties;
  assert.equal(update108.expansion_radar_tech_snapshot, 'Klaviyo; Shopify', 'first run stores a baseline instead of flagging');
  const slack = r.items.find((i) => i.kind === 'slack_alert').payload;
  assert.ok(slack.blocks.length >= 3);
  assert.match(JSON.stringify(slack.blocks), /Synthetic Company Alpha/);
});

test('Clay callback: authenticated signals are scored; bad secrets are rejected', async () => {
  const ok = await runCodeNode('Score Clay Signals', [clayItem(SECRET)], { env: ENV });
  const items = ok.output.map((i) => i.json);
  const summary = items.find((i) => i.kind === 'run_summary');
  assert.equal(summary.source, 'clay');
  assert.equal(summary.accounts[0].companyId, '103');
  assert.equal(summary.accounts[0].score, 45);
  assert.equal(summary.accounts[0].task, true);
  assert.equal(items.filter((i) => i.kind === 'signal_record').length, 2);
  const update = items.find((i) => i.kind === 'company_update').body.properties;
  assert.equal(update.expansion_radar_last_checked_at, undefined, 'Clay must not reset the Apollo cadence');

  const wrong = await runCodeNode('Score Clay Signals', [clayItem('wrong-secret-value-00000')], { env: ENV });
  assert.deepEqual(wrong.output, []);
  assert.ok(wrong.logs.some((l) => l.includes('WEBHOOK_SECRET_MISMATCH')));
  const missing = await runCodeNode('Score Clay Signals', [{ headers: {}, body: {} }], { env: ENV });
  assert.ok(missing.logs.some((l) => l.includes('WEBHOOK_SECRET_MISSING')));
});

test('empty and failed HubSpot searches end cleanly', async () => {
  const empty = await runCodeNode('Prepare Accounts', [{ results: [] }], { env: ENV });
  assert.deepEqual(empty.output, []);
  const failed = await runCodeNode('Prepare Accounts', [{ error: { message: 'Unauthorized for ops@example.com', httpCode: '401' } }], { env: ENV });
  assert.deepEqual(failed.output, []);
  assert.ok(failed.logs.some((l) => l.includes('[redacted-email]')), 'errors are redacted in logs');
});

test('Clay push is built only in live mode with ENABLE_CLAY_PUSH=true', async () => {
  const env = Object.assign({}, LIVE_ENV, { ENABLE_CLAY_PUSH: 'true', CLAY_TABLE_WEBHOOK_URL: 'https://clay-webhook.example/test-only' });
  const r = await simulateScan(env);
  assert.equal(r.clayRows.length, 6);
  assert.deepEqual(Object.keys(r.clayRows[0]).sort(), ['company_name', 'current_play', 'domain', 'hubspot_company_id', 'last_signal_at', 'owner_id']);
});

// ---------------------------------------------------------------------------
// 3. Security scan
// ---------------------------------------------------------------------------

test('security scan: no active API tokens, webhook URLs, keys or unauthorized email addresses', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (['node_modules', '.git', 'coverage'].includes(e.name)) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|json|md|yml|yaml|txt)$|^\.env\.example$|^\.gitignore$|^LICENSE$/.test(e.name)) files.push(full);
    });
  })(ROOT);
  assert.ok(files.length >= 12, `expected repository files, found ${files.length}`);

  const forbidden = [
    ['HubSpot private app token', /pat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}/i],
    ['HubSpot legacy API key', /hapikey=[0-9a-f-]{20,}/i],
    ['Slack token', /xox[abposr]-\d{6,}-/],
    ['Slack incoming webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{12,}/],
    ['Clay webhook URL', /api\.clay\.com\/v\d+\/sources\/webhook\/[A-Za-z0-9-]{12,}/],
    ['Bearer token', /Bearer\s+[A-Za-z0-9._-]{30,}/],
    ['AWS access key', /AKIA[0-9A-Z]{16}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['Google OAuth token', /ya29\.[A-Za-z0-9_-]{20,}/],
    ['Apollo-style API key assignment', /(?:apollo|x-api-key)["'\s:=]+[A-Za-z0-9_-]{22,}/i],
  ];
  const allowedEmail = /@([a-z0-9-]+\.)*(example\.(?:com|org|net)|example-corp\.com|[a-z0-9-]+\.example)$/i;

  files.forEach((file) => {
    if (file === __filename) return; // this file contains the detection patterns themselves
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    forbidden.forEach(([label, re]) => assert.ok(!re.test(text), `${label} found in ${rel}`));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((addr) =>
      assert.match(addr, allowedEmail, `unauthorized email address "${addr}" in ${rel}`)
    );
  });

  // Credential slots in workflow.json must be placeholders.
  const text = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
  assert.ok(!/"id":\s*"(?!REPLACE_WITH_)[^"]*"\s*,\s*"name":\s*"[^"]*(HubSpot|Apollo)[^"]*\(/.test(text));
});
