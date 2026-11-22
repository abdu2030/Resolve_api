export const API_SCOPES = [
  'sources:write',
  'records:write',
  'jobs:read',
  'entities:read',
  'entities:merge',
  'entities:split',
  'reviews:read',
  'reviews:write',
  'webhooks:manage',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];
