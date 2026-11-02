import { parseBootstrapArguments } from './bootstrap-api-key.js';

describe('API-key bootstrap arguments', () => {
  it('defaults to all five supported scopes', () => {
    expect(
      parseBootstrapArguments(['--tenant-name', 'Local Demo', '--environment', 'test']),
    ).toEqual({
      environment: 'test',
      keyName: 'Bootstrap key',
      scopes: [
        'sources:write',
        'records:write',
        'entities:read',
        'entities:merge',
        'entities:split',
      ],
      tenantName: 'Local Demo',
    });
  });

  it('accepts an explicit key name and supported scope subset', () => {
    expect(
      parseBootstrapArguments([
        '--tenant-name',
        'Local Demo',
        '--environment',
        'live',
        '--key-name',
        'Ingestion',
        '--scopes',
        'records:write',
      ]),
    ).toMatchObject({ environment: 'live', keyName: 'Ingestion', scopes: ['records:write'] });
  });

  it('rejects missing tenant names and unsupported scopes', () => {
    expect(() => parseBootstrapArguments(['--environment', 'test'])).toThrow('tenant-name');
    expect(() =>
      parseBootstrapArguments([
        '--tenant-name',
        'Local Demo',
        '--environment',
        'test',
        '--scopes',
        'admin:*',
      ]),
    ).toThrow('scope');
  });
});
