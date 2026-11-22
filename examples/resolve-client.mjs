/* global AbortSignal, URL, console, fetch, process */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const apiKey = process.env.RESOLVE_API_KEY?.trim();
const baseUrl = new URL(process.env.RESOLVE_BASE_URL ?? 'http://127.0.0.1:3000');

async function call(method, path, statuses, data, idempotencyKey) {
  const headers = { Authorization: 'Bearer ' + apiKey };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (data !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const body = await response.json().catch(() => null);
  if (!statuses.includes(response.status)) {
    const code = body?.error?.code ?? 'UNEXPECTED_RESPONSE';
    const requestId = response.headers.get('x-request-id') ?? 'unavailable';
    const retryAfter = response.headers.get('retry-after');
    const retry = retryAfter ? ' Retry after ' + retryAfter + ' seconds.' : '';
    throw new Error(
      method +
        ' ' +
        path +
        ' returned HTTP ' +
        response.status +
        ' ' +
        code +
        ' (request ID ' +
        requestId +
        ').' +
        retry,
    );
  }
  assert.ok(body, method + ' ' + path + ' did not return JSON');
  return { body, headers: response.headers };
}

async function waitForJob(jobId) {
  const path = '/v1/jobs/' + encodeURIComponent(jobId);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { body } = await call('GET', path, [200]);
    if (body.status === 'SUCCEEDED') return body;
    if (body.status === 'FAILED') {
      throw new Error('Batch ' + jobId + ' failed (' + (body.error?.code ?? 'unknown error') + ')');
    }
    await delay(300);
  }
  throw new Error('Batch ' + jobId + ' did not finish within 60 seconds.');
}

async function run() {
  assert.ok(apiKey, 'Set RESOLVE_API_KEY to the demo tenant API key.');
  assert.ok(['http:', 'https:'].includes(baseUrl.protocol), 'Use an HTTP(S) API base URL.');

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
