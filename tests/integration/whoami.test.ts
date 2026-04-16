import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestServer, type TestServer } from './_helpers/server.ts';

describe('whoami integration', { timeout: 120_000 }, () => {
  let server: TestServer;
  let client: Client;

  before(async () => {
    server = await startTestServer();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${server.apiKey}` } },
      }),
    );
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it('lists tools including whoami', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('whoami'), `expected 'whoami' in ${names.join(', ')}`);
  });

  it('returns key info from whoami', async () => {
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    assert.equal(result.isError, undefined);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    assert.ok(text);
    const payload = JSON.parse(text);
    assert.ok(payload.id);
    assert.ok(payload.prefix.startsWith('mcp_test'));
    assert.equal(payload.name, 'integration test key');
    assert.ok(payload.request_id);
  });

  it('rejects requests with invalid credentials', async () => {
    const badClient = new Client({ name: 'bad', version: '1.0.0' });
    await assert.rejects(
      badClient.connect(
        new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
          requestInit: {
            headers: {
              Authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        }),
      ),
    );
  });

  it('rejects requests with bad Origin', async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.apiKey}`,
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 403);
  });
});
