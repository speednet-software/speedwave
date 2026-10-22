import { createInterface } from 'node:readline';

const stats = { initializeCount: 0, initializedCount: 0, cancelled: [] };
let failedOnce = false;
const waiting = new Map();
let serverRequestId = 0;

function send(message, ending = '\n') {
  process.stdout.write(JSON.stringify(message) + ending);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function text(id, value) {
  reply(id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
}

async function callTool(id, name, args) {
  switch (name) {
    case 'echo':
      setTimeout(() => text(id, args), args.delayMs ?? 0);
      return;
    case 'env':
      text(id, { value: process.env[args.key] ?? null });
      return;
    case 'envkeys':
      text(id, Object.keys(process.env).sort());
      return;
    case 'ask': {
      const requestId = `srv-${++serverRequestId}`;
      waiting.set(requestId, (answer) => text(id, answer));
      send({ jsonrpc: '2.0', id: requestId, method: args.method, params: {} });
      return;
    }
    case 'die':
      process.exit(args.code ?? 3);
      return;
    case 'noise':
      process.stdout.write('not json at all\n');
      process.stdout.write('[1,2]\n');
      process.stdout.write('\n');
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
      send({ jsonrpc: '2.0', id: 99999, result: {} });
      send({ jsonrpc: '2.0', id: 'string-id', result: {} });
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'after noise' }] } }, '\r\n');
      return;
    case 'split': {
      const line = JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'zażółć 😀' }] } }) + '\n';
      const bytes = Buffer.from(line, 'utf8');
      const cut = bytes.indexOf(Buffer.from('😀', 'utf8')) + 2;
      process.stdout.write(bytes.subarray(0, cut));
      setTimeout(() => process.stdout.write(bytes.subarray(cut)), 20);
      return;
    }
    case 'long':
      process.stdout.write('x'.repeat(args.size));
      return;
    case 'stats':
      text(id, stats);
      return;
    case 'hang':
      return;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
    return;
  }
  if (message.id === undefined) {
    if (message.method === 'notifications/initialized') stats.initializedCount++;
    if (message.method === 'notifications/cancelled') stats.cancelled.push(message.params.requestId);
    return;
  }
  switch (message.method) {
    case 'initialize':
      if (message.params.protocolVersion === 'fail-once' && !failedOnce) {
        failedOnce = true;
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unsupported version' } });
        return;
      }
      stats.initializeCount++;
      if (stats.initializeCount > 1) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'already initialized' } });
        return;
      }
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      });
      return;
    case 'tools/list':
      reply(message.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });
      return;
    case 'tools/call':
      void callTool(message.id, message.params.name, message.params.arguments ?? {});
      return;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
rl.on('close', () => process.exit(0));
