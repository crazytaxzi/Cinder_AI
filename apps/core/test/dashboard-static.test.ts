import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { afterEach, describe, expect, it } from 'vitest';

const servers: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('native dashboard static assets', () => {
  it('serves the dashboard shell and assets with the production plugin', async () => {
    const app = Fastify();
    servers.push(app);

    await app.register(fastifyStatic, {
      root: resolve(process.cwd(), '../../dashboard'),
      prefix: '/assets/',
      decorateReply: true,
      wildcard: false,
    });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));

    const shell = await app.inject({ method: 'GET', url: '/' });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain('Cinder');
    expect(shell.body).toContain('OpenAI tokens and estimated cost');

    const script = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain('async function api(');
    expect(script.body).toContain('function renderUsage(');
  });
});
