export const API_SCOPES = ['sources:write', 'records:write', 'entities:read'] as const;

export type ApiScope = (typeof API_SCOPES)[number];
