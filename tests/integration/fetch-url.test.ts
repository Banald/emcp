import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Worker } from 'bullmq';
import { fetchUrlProcessor } from '../../src/workers/processors/fetch-url.ts';
import { startTestServer, type TestServer } from './_helpers/server.ts';

describe('fetch-url integration', { timeout: 120_000 }, () => {
  let server: TestServer;
  let client: Client;
  let echoServer: ReturnType<typeof createHttpServer>;
  let echoUrl: string;
  let worker: Worker;

  before(async () => {
    server = await startTestServer();

    // A tiny in-process HTTP server for fetch-url to actually fetch
    echoServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello world');
    });
    await new Promise<void>((r) => echoServer.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echoServer.address() as { port: number }).port;
    echoUrl = `http://127.0.0.1:${echoPort}/`;

    // Spin up a worker against the test Redis
    worker = new Worker('fetch', async (job) => fetchUrlProcessor(job, server.workerCtx), {
      connection: server.workerConnection,
      concurrency: 1,
    });

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${server.apiKey}` } },
      }),
    );
  });

  after(async () => {
    await client.close();
    await worker.close();
    await new Promise<void>((r) => echoServer.close(() => r()));
    await server.close();
  });

  it('lists fetch-url in available tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('fetch-url'), `expected 'fetch-url' in ${names.join(', ')}`);
  });

  it('enqueues a job and the worker processes it', async () => {
    const callResult = await client.callTool({
      name: 'fetch-url',
      arguments: { url: echoUrl },
    });
    const payload = JSON.parse(
      (callResult.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.ok(payload.jobId);
    assert.equal(payload.status, 'queued');

    // Wait for the worker to process (poll DB up to 10s)
    let row: Record<string, unknown> | null = null;
    for (let i = 0; i < 50; i++) {
      const result = await server.pool.query('SELECT * FROM fetched_resources WHERE url = $1', [
        echoUrl,
      ]);
      if (result.rows.length > 0) {
        row = result.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(row, 'expected fetched_resources row to be created');
    assert.equal(row.status_code, 200);
    assert.equal(row.body, 'hello world');
    assert.equal(row.content_type, 'text/plain');
    assert.ok(row.fetched_by, 'expected fetched_by to be set');
    assert.ok(row.bytes, 'expected bytes to be recorded');
  });
});
