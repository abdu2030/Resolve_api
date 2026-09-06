export const CLOCK = Symbol('CLOCK');
export const DATABASE_HEALTH_INDICATOR = Symbol('DATABASE_HEALTH_INDICATOR');
export const REDIS_HEALTH_INDICATOR = Symbol('REDIS_HEALTH_INDICATOR');

export interface Clock {
  now(): Date;
}

export interface HealthIndicator {
  check(): Promise<void>;
}

export type DependencyStatus = 'down' | 'up';

export interface HealthResponse {
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
  service: 'resolve-api';
  status: 'error' | 'ok';
  timestamp: string;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
};
