import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Injectable, Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DURATION = 'resolve_http_request_duration_seconds';
const ERRORS = 'resolve_http_errors_total';
const RATE_LIMITED = 'resolve_http_rate_limited_total';
const REQUESTS = 'resolve_http_requests_total';

interface DurationHistogram {
  buckets: { upperBound: number; count: number }[];
  count: number;
  sum: number;
}

@Injectable()
export class HttpObservabilityService {
  private readonly logger = new Logger(HttpObservabilityService.name);
  private readonly requestCounts = new Map<string, number>();
  private readonly durations = new Map<string, DurationHistogram>();
  private errors = 0;
  private rateLimited = 0;

  readonly observe: RequestHandler = (request, response, next): void => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const method = HTTP_METHODS.has(request.method) ? request.method : 'OTHER';
    response.setHeader('X-Request-Id', requestId);
    // The response status is final here, including failures before Nest invokes a controller.
    response.once('finish', () => {
      const status = response.statusCode;
      const durationMs = performance.now() - startedAt;
      const routePath = (request.route as { path?: unknown } | undefined)?.path;

      this.record(method, status, durationMs / 1_000);
      this.logger.log({
        event: 'http.request.completed',
        requestId,
        method,
        route: typeof routePath === 'string' ? routePath : 'unmatched',
        status,
        durationMs,
      });
    });
    next();
  };

  renderMetrics(): string {
    const lines = [
      `# HELP ${REQUESTS} Completed HTTP requests by method and status.`,
      `# TYPE ${REQUESTS} counter`,
      ...Array.from(this.requestCounts, ([labels, count]) => `${REQUESTS}{${labels}} ${count}`),
      `# HELP ${ERRORS} Completed HTTP requests with a 4xx or 5xx response.`,
      `# TYPE ${ERRORS} counter`,
      `${ERRORS} ${this.errors}`,
      `# HELP ${RATE_LIMITED} Completed HTTP requests with a 429 response.`,
      `# TYPE ${RATE_LIMITED} counter`,
      `${RATE_LIMITED} ${this.rateLimited}`,
      `# HELP ${DURATION} Completed HTTP request duration in seconds.`,
      `# TYPE ${DURATION} histogram`,
    ];

    for (const [method, histogram] of this.durations) {
      const label = `method="${method}"`;
      for (const { upperBound, count } of histogram.buckets) {
        lines.push(`${DURATION}_bucket{${label},le="${upperBound}"} ${count}`);
      }
      lines.push(
        `${DURATION}_bucket{${label},le="+Inf"} ${histogram.count}`,
        `${DURATION}_sum{${label}} ${histogram.sum}`,
        `${DURATION}_count{${label}} ${histogram.count}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  private record(method: string, status: number, durationSeconds: number): void {
    const statusLabel = status >= 100 && status <= 599 ? String(status) : 'OTHER';
    const labels = `method="${method}",status="${statusLabel}"`;
    this.requestCounts.set(labels, (this.requestCounts.get(labels) ?? 0) + 1);
    if (status >= 400 && status <= 599) this.errors++;
    if (status === 429) this.rateLimited++;

    let histogram = this.durations.get(method);
    if (!histogram) {
      histogram = {
        buckets: DURATION_BUCKETS.map((upperBound) => ({ upperBound, count: 0 })),
        count: 0,
        sum: 0,
      };
      this.durations.set(method, histogram);
    }
    histogram.count++;
    histogram.sum += durationSeconds;
    for (const bucket of histogram.buckets) {
      if (durationSeconds <= bucket.upperBound) bucket.count++;
    }
  }
}
