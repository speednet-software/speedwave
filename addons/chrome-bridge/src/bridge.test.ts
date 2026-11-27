import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { AUTH_HEADER, BridgeClient, BridgeError } from './bridge.js';

type Peer = (message: { id: string; method: string; params: unknown }, socket: WebSocket) => void;

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      for (const socket of server.clients) socket.terminate();
      return new Promise((resolve) => server.close(resolve));
    })
  );
});

async function fakeExtension(peer: Peer | null): Promise<{ url: string; headers: string[] }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  const headers: string[] = [];
  server.on('connection', (socket, request) => {
    headers.push(String(request.headers[AUTH_HEADER]));
    socket.on('message', (raw) => peer?.(JSON.parse(raw.toString()), socket));
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return { url: `ws://127.0.0.1:${address.port}/`, headers };
}

const answering: Peer = (message, socket) => {
  if (message.method === 'boom') {
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { message: 'page said no' } })
    );
  } else {
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { method: message.method, params: message.params },
      })
    );
  }
};

describe('BridgeClient', () => {
  it('sends the token header, pairs with hello and returns the result of a call', async () => {
    const { url, headers } = await fakeExtension(answering);
    const client = new BridgeClient(url, 'secret');

    const result = await client.call('listTabs', { a: 1 });

    expect(result).toEqual({ method: 'listTabs', params: { a: 1 } });
    expect(headers).toEqual(['secret']);
  });

  it('reuses one connection for consecutive calls', async () => {
    const { url, headers } = await fakeExtension(answering);
    const client = new BridgeClient(url, 'secret');

    await client.call('listTabs');
    await client.call('readPage', { tabId: 3 });

    expect(headers).toHaveLength(1);
  });

  it('rejects with NOT_CONFIGURED when the env is missing', async () => {
    const client = new BridgeClient(undefined, undefined);

    await expect(client.call('listTabs')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('rejects with NOT_CONNECTED when nothing listens', async () => {
    const client = new BridgeClient('ws://127.0.0.1:1/', 'secret');

    await expect(client.call('listTabs')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('rejects with NOT_CONNECTED when the extension never answers hello', async () => {
    const { url } = await fakeExtension(null);
    const client = new BridgeClient(url, 'secret', 300);

    await expect(client.call('listTabs')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('passes an extension error through as REMOTE', async () => {
    const { url } = await fakeExtension(answering);
    const client = new BridgeClient(url, 'secret');

    const error = await client.call('boom').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'REMOTE', message: 'page said no' });
  });

  it('fails the pending call and reconnects after the socket closes', async () => {
    let closeNext = true;
    const { url, headers } = await fakeExtension((message, socket) => {
      if (message.method === 'slow' && closeNext) {
        closeNext = false;
        socket.close();
        return;
      }
      answering(message, socket);
    });
    const client = new BridgeClient(url, 'secret');

    await expect(client.call('slow')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(client.call('slow')).resolves.toEqual({ method: 'slow', params: {} });
    expect(headers).toHaveLength(2);
  });
});
