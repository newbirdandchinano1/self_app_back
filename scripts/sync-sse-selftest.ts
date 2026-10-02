/**
 * Phase 3 SSE Hub 自测（无需连库）
 * 运行：npx tsx scripts/sync-sse-selftest.ts
 */
import { EventEmitter } from 'events';
import {
  registerSyncSseConnection,
  unregisterSyncSseConnection,
  publishSyncSignal,
  countSyncSseConnections,
  resetSyncSseHubForTests,
} from '../src/services/sync-sse-hub.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

type FakeRes = EventEmitter & {
  writableEnded: boolean;
  destroyed: boolean;
  chunks: string[];
  write: (chunk: string) => boolean;
  end: () => void;
};

function createFakeRes(): FakeRes {
  const ee = new EventEmitter() as FakeRes;
  ee.writableEnded = false;
  ee.destroyed = false;
  ee.chunks = [];
  ee.write = (chunk: string) => {
    if (ee.writableEnded || ee.destroyed) return false;
    ee.chunks.push(chunk);
    return true;
  };
  ee.end = () => {
    ee.writableEnded = true;
  };
  return ee;
}

function main() {
  console.log('=== Phase 3: SSE Hub ===\n');
  resetSyncSseHubForTests();

  const resA = createFakeRes();
  const resB = createFakeRes();
  const resC = createFakeRes();

  const connA = registerSyncSseConnection({
    userId: 'default',
    deviceId: 'device-a',
    res: resA as unknown as import('express').Response,
  });
  const connB = registerSyncSseConnection({
    userId: 'default',
    deviceId: 'device-b',
    res: resB as unknown as import('express').Response,
  });
  registerSyncSseConnection({
    userId: 'default',
    deviceId: 'device-c',
    res: resC as unknown as import('express').Response,
  });

  check('注册后在线数=3', countSyncSseConnections('default') === 3);
  check(
    'ready 事件已写出',
    resA.chunks.some((c) => c.includes('event: ready')) &&
      resB.chunks.some((c) => c.includes('event: ready')),
  );

  resA.chunks = [];
  resB.chunks = [];
  resC.chunks = [];

  const sent = publishSyncSignal({
    userId: 'default',
    skipDeviceId: 'device-a',
    cursor: 42,
    dirtyTables: ['tasks', 'habits'],
  });

  check('跳过写入端后送达 2 端', sent === 2);
  check('device-a 未收到 changes', !resA.chunks.some((c) => c.includes('event: changes')));
  check('device-b 收到 changes', resB.chunks.some((c) => c.includes('event: changes')));
  check('device-c 收到 changes', resC.chunks.some((c) => c.includes('event: changes')));
  check(
    '载荷含 cursor 与 dirtyTables',
    resB.chunks.some((c) => c.includes('"cursor":42') && c.includes('habits')),
  );

  unregisterSyncSseConnection(connA);
  unregisterSyncSseConnection(connB);
  check('注销后仍有 1 连接', countSyncSseConnections('default') === 1);

  resetSyncSseHubForTests();
  check('reset 后归零', countSyncSseConnections() === 0);

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
