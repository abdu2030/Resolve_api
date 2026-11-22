/* global URL, console, process */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createResolveClient } from './resolve-http.mjs';

const apiKey = process.env.RESOLVE_API_KEY?.trim();
const baseUrl = new URL(process.env.RESOLVE_BASE_URL ?? 'http://127.0.0.1:3000');

async function run() {
  assert.ok(apiKey, 'Set RESOLVE_API_KEY to the demo tenant API key.');
  assert.ok(['http:', 'https:'].includes(baseUrl.protocol), 'Use an HTTP(S) API base URL.');

  const { call, waitForJob } = createResolveClient(baseUrl, apiKey);

  for (const source of [
    { name: 'demo-crm', type: 'api', priority: 10 },
    { name: 'demo-billing', type: 'api', priority: 100 },
  ]) {
    await call('POST', '/v1/sources', [200, 201], source);
  }

  const runId = randomUUID();
  const name = 'Synthetic Contact ' + runId;
  const email = 'demo-' + runId + '@example.test';
  const crmRecord = {
    source: 'demo-crm',
    external_id: 'crm-' + runId,
    entity_type: 'person',
    data: { name, email },
  };
  const recordKey = 'demo-crm-' + runId;
  const { body: first } = await call('POST', '/v1/records', [201], crmRecord, recordKey);
  assert.equal(first.decision, 'NO_MATCH');

  const replay = await call('POST', '/v1/records', [201], crmRecord, recordKey);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal(replay.body.record_id, first.record_id);

  const billingRecord = {
    source: 'demo-billing',
    external_id: 'bill-' + runId,
    entity_type: 'person',
    data: { name: name.toUpperCase(), email: email.replace('example.test', 'EXAMPLE.TEST') },
  };
  const { body: batch } = await call(
    'POST',
    '/v1/records/batch',
    [202],
    { records: [billingRecord] },
    'demo-batch-' + runId,
  );
  const completed = await waitForJob(batch.job_id);
  const matched = completed.results[0]?.result;
  assert.equal(completed.succeeded_records, 1);
  assert.equal(matched?.decision, 'AUTO_MATCH');
  assert.equal(matched.entity_id, first.entity_id);

  const { body: canonical } = await call(
    'GET',
    '/v1/entities/' + encodeURIComponent(first.entity_id),
    [200],
  );
  assert.equal(canonical.record_count, 2);
  console.log(
    JSON.stringify(
      {
        first_decision: first.decision,
        replayed: true,
        batch_status: completed.status,
        duplicate_decision: matched.decision,
        entity_id: canonical.entity_id,
        linked_records: canonical.record_count,
      },
      null,
      2,
    ),
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
