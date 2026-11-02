export const API_SCOPES = [
  'sources:write',
  'records:write',
  'entities:read',
  'entities:merge',
  'entities:split',
  'reviews:read',
  'reviews:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];
