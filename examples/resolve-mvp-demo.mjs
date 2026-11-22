/* global URL, console, process */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import billing from './fixtures/demo-billing.json' with { type: 'json' };
import crm from './fixtures/demo-crm.json' with { type: 'json' };
import { createResolveClient } from './resolve-http.mjs';

function makeRecord(dataset, scenario, runId) {
  const fixture = dataset.records[scenario];
  return {
    source: dataset.source.name,
    external_id: `${scenario}-${runId}`,
    entity_type: fixture.entity_type,
    data: Object.fromEntries(
      Object.entries(fixture.data).map(([key, value]) => [key, value.replaceAll('{run}', runId)]),
    ),
  };
}

async function approveCompanyReview(get, post, company, renamedCompany, companyRecords) {
  assert.equal(renamedCompany.decision, 'REVIEW');
  const { items } = await get('/v1/reviews?limit=100');
  const review = items.find((item) => item.source_record_id === renamedCompany.record_id);
  assert.ok(review, 'Expected a review case for the billing company record.');
  assert.equal(review.candidate_entity_id, company.entity_id);

  const path = `/v1/reviews/${review.review_id}`;
  const detail = await get(path);
  assert.equal(detail.status, 'OPEN');
  assert.equal(detail.approval_available, true);
  assert.equal(detail.human_decision, null);
  assert.deepEqual(detail.source_record.evidence_raw_payload, companyRecords.billing.data);
  assert.deepEqual(detail.candidate_record.evidence_raw_payload, companyRecords.crm.data);
  assert.equal((await get(`/v1/entities/${company.entity_id}`)).record_count, 1);

  const approval = await post(`${path}/decision`, 200, {
    decision: 'APPROVE',
    reason: 'The synthetic scenario confirms the company rename.',
    expected_source_version: detail.source_record.current_version,
    expected_candidate_version: detail.candidate_entity.canonical_version,
  });
  assert.equal(approval.decision, 'APPROVE');
  assert.equal(approval.entity_id, company.entity_id);

  const resolved = await get(path);
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.human_decision.review_decision_id, approval.review_decision_id);
  assert.deepEqual(resolved.evidence, detail.evidence);
  const canonical = await get(`/v1/entities/${company.entity_id}`);
  assert.equal(canonical.record_count, 2);
  return {
    review_id: review.review_id,
    confidence: detail.confidence,
    algorithm_version: detail.algorithm_version,
    status: resolved.status,
    records_after_approval: canonical.record_count,
  };
}

async function reverseMistakenMerge(get, post, target, source, targetRecordIds, sourceRawData) {
  const targetPath = `/v1/entities/${target.entity_id}`;
  const sourcePath = `/v1/entities/${source.entity_id}`;
  const sourceBefore = await get(sourcePath);
  const merged = await post(`${targetPath}/merge`, 200, {
    source_entity_id: source.entity_id,
    expected_source_version: sourceBefore.canonical_version,
    expected_target_version: target.canonical_version,
    reason: 'Intentionally merge two distinct synthetic contacts to demonstrate reversal.',
  });
  assert.equal(merged.operation, 'MERGE');
  assert.deepEqual(merged.record_ids, [source.record_id]);
  const sourceAfterMerge = await get(sourcePath);
  assert.equal(sourceAfterMerge.status, 'MERGED');
  assert.equal(sourceAfterMerge.merged_into_entity_id, target.entity_id);
  assert.equal(sourceAfterMerge.record_count, 0);
  const targetAfterMerge = await get(targetPath);
  assert.equal(targetAfterMerge.record_count, targetRecordIds.length + 1);

  const reversal = await post(`${targetPath}/split`, 200, {
    merge_event_id: merged.operation_id,
    expected_version: targetAfterMerge.canonical_version,
    reason: 'Restore the separate synthetic contact after verifying the original records.',
  });
  assert.equal(reversal.operation, 'UNMERGE');
  assert.equal(reversal.target_entity_id, source.entity_id);
  assert.equal(reversal.reversed_operation_id, merged.operation_id);
  assert.deepEqual(reversal.record_ids, [source.record_id]);

  const restored = await get(sourcePath);
  assert.equal(restored.status, 'ACTIVE');
  assert.equal(restored.merged_into_entity_id, null);
  assert.equal(restored.record_count, 1);
  const sourceRecords = await get(`${sourcePath}/records`);
  assert.deepEqual(
    sourceRecords.items.map((item) => item.record_id),
    [source.record_id],
  );
  assert.deepEqual(sourceRecords.items[0].raw_payload, sourceRawData);
  const targetRecords = await get(`${targetPath}/records`);
  assert.deepEqual(
    targetRecords.items.map((item) => item.record_id).sort(),
    [...targetRecordIds].sort(),
  );

  const history = await get(`${targetPath}/history`);
  const operationIds = history.items.map((item) => item.entity_operation?.operation_id);
  assert.ok(operationIds.includes(merged.operation_id), 'Expected the original merge in history.');
  assert.ok(operationIds.includes(reversal.operation_id), 'Expected the reversal in history.');
  return {
    merge_id: merged.operation_id,
    reversal_id: reversal.operation_id,
    restored_entity_id: restored.entity_id,
  };
}

async function verifyTenantIsolation(foreign, record, primaryEntityId, reviewId, jobId, runId) {
  await foreign.call('POST', '/v1/sources', [200, 201], crm.source);
  const { body: seeded } = await foreign.call(
    'POST',
    '/v1/records',
    [201],
    record,
    `foreign-contact-${runId}`,
  );
  assert.equal(seeded.decision, 'NO_MATCH');
  assert.equal(seeded.explanation.candidate_count, 0);
  assert.notEqual(seeded.entity_id, primaryEntityId);
  await foreign.call('GET', `/v1/entities/${seeded.entity_id}`, [200]);

  for (const [path, code] of [
    [`/v1/entities/${primaryEntityId}`, 'ENTITY_NOT_FOUND'],
    [`/v1/reviews/${reviewId}`, 'REVIEW_NOT_FOUND'],
    [`/v1/jobs/${jobId}`, 'JOB_NOT_FOUND'],
  ]) {
    const { body } = await foreign.call('GET', path, [404]);
    assert.equal(body.error?.code, code);
  }
  return { candidate_count: seeded.explanation.candidate_count, denied_entity_review_job: 404 };
}

async function run() {
  const apiKey = process.env.RESOLVE_API_KEY?.trim();
  const foreignApiKey = process.env.RESOLVE_FOREIGN_API_KEY?.trim();
  const baseUrl = new URL(process.env.RESOLVE_BASE_URL ?? 'http://127.0.0.1:3000');
  assert.ok(apiKey, 'Set RESOLVE_API_KEY to the primary test tenant API key.');
  assert.ok(foreignApiKey, 'Set RESOLVE_FOREIGN_API_KEY to a separate test tenant API key.');
  assert.ok(apiKey !== foreignApiKey, 'Use keys from two separate test tenants.');
  assert.ok(['http:', 'https:'].includes(baseUrl.protocol), 'Use an HTTP(S) API base URL.');

  const runId = randomUUID();
  const { call, waitForJob } = createResolveClient(baseUrl, apiKey);
  const foreign = createResolveClient(baseUrl, foreignApiKey);
  const get = async (path) => (await call('GET', path, [200])).body;
  const post = async (path, status, data) =>
    (await call('POST', path, [status], data, randomUUID())).body;
  const ingest = (record) => post('/v1/records', 201, record);

  for (const dataset of [crm, billing]) {
    await call('POST', '/v1/sources', [200, 201], dataset.source);
  }

  const crmContact = makeRecord(crm, 'contact', runId);
  const contactKey = `crm-contact-${runId}`;
  const { body: first } = await call('POST', '/v1/records', [201], crmContact, contactKey);
  assert.equal(first.decision, 'NO_MATCH');
  const contactPath = `/v1/entities/${first.entity_id}`;
  const replay = await call('POST', '/v1/records', [201], crmContact, contactKey);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(replay.body, first);
  assert.equal((await get(contactPath)).record_count, 1);

  const distinctRecord = makeRecord(crm, 'distinctContact', runId);
  const distinct = await ingest(distinctRecord);
  assert.equal(distinct.decision, 'NO_MATCH');
  const companyRecords = {
    crm: makeRecord(crm, 'company', runId),
    billing: makeRecord(billing, 'company', runId),
  };
  const company = await ingest(companyRecords.crm);
  assert.equal(company.decision, 'NO_MATCH');

  const billingContact = makeRecord(billing, 'contact', runId);
  const match = await ingest(billingContact);
  assert.equal(match.decision, 'AUTO_MATCH');
  assert.equal(match.entity_id, first.entity_id);
  const contact = await get(contactPath);
  assert.equal(contact.record_count, 2);
  assert.equal(contact.provenance.email.source_record_id, first.record_id);
  const linked = await get(`${contactPath}/records`);
  assert.deepEqual(
    linked.items.find((item) => item.record_id === match.record_id)?.raw_payload,
    billingContact.data,
  );

  const renamedCompany = await ingest(companyRecords.billing);
  const review = await approveCompanyReview(get, post, company, renamedCompany, companyRecords);
  const reversal = await reverseMistakenMerge(
    get,
    post,
    contact,
    distinct,
    [first.record_id, match.record_id],
    distinctRecord.data,
  );

  const submission = await post('/v1/records/batch', 202, {
    records: [
      makeRecord(billing, 'batchDuplicate', runId),
      makeRecord(billing, 'batchNewContact', runId),
    ],
  });
  const batch = await waitForJob(submission.job_id);
  assert.equal(batch.succeeded_records, 2);
  assert.equal(batch.failed_records, 0);
  const duplicate = batch.results.find((item) => item.index === 0)?.result;
  const newContact = batch.results.find((item) => item.index === 1)?.result;
  assert.equal(duplicate?.decision, 'AUTO_MATCH');
  assert.equal(duplicate.entity_id, contact.entity_id);
  assert.equal(newContact?.decision, 'NO_MATCH');
  assert.notEqual(newContact.entity_id, contact.entity_id);
  assert.equal((await get(contactPath)).record_count, 3);

  const isolation = await verifyTenantIsolation(
    foreign,
    crmContact,
    contact.entity_id,
    review.review_id,
    batch.job_id,
    runId,
  );
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        source_systems: [crm.source.name, billing.source.name],
        idempotency: { replayed: true, record_id: first.record_id },
        automatic_match: {
          entity_id: match.entity_id,
          decision: match.decision,
          confidence: match.confidence,
          candidate_count: match.explanation.candidate_count,
          algorithm_version: match.algorithm_version,
          email_provenance_record_id: contact.provenance.email.source_record_id,
        },
        review,
        reversal,
        batch: {
          job_id: batch.job_id,
          status: batch.status,
          decisions: [duplicate.decision, newContact.decision],
        },
        tenant_isolation: isolation,
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
