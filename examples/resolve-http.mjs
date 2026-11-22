/* global AbortSignal, URL, fetch */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export function createResolveClient(baseUrl, apiKey) {
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
        throw new Error(
          'Batch ' + jobId + ' failed (' + (body.error?.code ?? 'unknown error') + ')',
        );
      }
      await delay(300);
    }
    throw new Error('Batch ' + jobId + ' did not finish within 60 seconds.');
  }

  return { call, waitForJob };
}
