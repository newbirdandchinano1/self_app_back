/**
 * Phase 5：备忘录 RichDoc 同步与边界回归（连库）
 * 运行：npm run test:memo-richdoc-phase5
 *
 * 覆盖：OCC 冲突、大文档 push/pull、图片/待办/多级列表往返、
 * 旧 markup 可读与新客户端升级、AI 入参纯文本。
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import type { RowDataPacket } from 'mysql2';
import { db } from '../src/db/index.js';
import { runPendingMigrations } from '../src/db/migrations/index.js';
import { plainTextFromMemoBody } from '../src/services/memo-plain-text.js';
import {
  MEMO_BODY_MAX_BYTES,
  MemoError,
  buildMemoContextText,
  createMemo,
  deleteMemo,
  getMemoDetail,
  updateMemo,
} from '../src/services/memos.js';
import { SyncOccConflictError } from '../src/services/sync-revision.js';

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

function makeId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

async function expectMemoError(fn: () => Promise<unknown>, includes: string): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    if (!(err instanceof MemoError)) return false;
    return err.message.includes(includes);
  }
}

async function liveRev(id: string): Promise<number | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT server_rev AS serverRev FROM memos WHERE id = ? LIMIT 1`,
    [id],
  );
  const v = rows[0]?.serverRev;
  return v == null ? null : Number(v);
}

function makeRichDocBody(opts?: {
  text?: string;
  checked?: boolean;
  indent?: number;
  uri?: string;
  nested?: boolean;
}): string {
  const text = opts?.text ?? '正文';
  const blocks: unknown[] = [
    { type: 'heading', level: 1, runs: [{ text: '阶段5标题', marks: ['bold'] }] },
    { type: 'paragraph', runs: [{ text, marks: [] }] },
    {
      type: 'todo',
      checked: opts?.checked ?? true,
      indent: opts?.indent ?? 1,
      runs: [{ text: '待办项', marks: [] }],
    },
    {
      type: 'image',
      uri: opts?.uri ?? 'https://example.com/phase5.png',
      width: 10,
      height: 20,
    },
  ];
  if (opts?.nested !== false) {
    blocks.push({
      type: 'bullet_list',
      items: [
        { indent: 0, runs: [{ text: '一级', marks: [] }] },
        { indent: 1, runs: [{ text: '二级', marks: [] }] },
        { indent: 2, runs: [{ text: '三级', marks: [] }] },
      ],
    });
  }
  return JSON.stringify({
    v: 1,
    format: 'selfapp-richdoc',
    doc: { blocks },
  });
}

/** 构造接近但不超过上限的 RichDoc（UTF-8 中文） */
function makeNearLimitBody(targetBytes: number): string {
  const base = {
    v: 1,
    format: 'selfapp-richdoc',
    doc: { blocks: [{ type: 'paragraph', runs: [{ text: '', marks: [] as string[] }] }] },
  };
  // 每个「字」3 字节；预留 JSON 外壳约 120 字节
  const overhead = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const chars = Math.max(1, Math.floor((targetBytes - overhead) / 3));
  (base.doc.blocks[0] as { runs: { text: string }[] }).runs[0]!.text = '字'.repeat(chars);
  let body = JSON.stringify(base);
  // 微调到不超过 target
  while (Buffer.byteLength(body, 'utf8') > targetBytes && chars > 0) {
    const cur = (base.doc.blocks[0] as { runs: { text: string }[] }).runs[0]!.text;
    (base.doc.blocks[0] as { runs: { text: string }[] }).runs[0]!.text = cur.slice(0, -100);
    body = JSON.stringify(base);
  }
  return body;
}

async function main() {
  console.log('=== Phase 5: memos RichDoc 同步与边界 ===\n');

  await runPendingMigrations();

  const ids: string[] = [];
  try {
    // --- 往返：图片 / 待办 / 多级列表 ---
    console.log('--- 往返：image / todo / 多级列表 ---\n');
    const roundId = makeId('memo_p5_round_');
    ids.push(roundId);
    const roundBody = makeRichDocBody({
      text: '往返正文',
      checked: true,
      indent: 1,
      uri: 'https://cdn.example.com/p5.png',
    });
    const created = await createMemo({ id: roundId, title: 'round', body: roundBody });
    const detail = await getMemoDetail(roundId);
    check('创建后 body 整段保留', detail.body === roundBody);
    const parsed = JSON.parse(detail.body) as {
      format: string;
      doc: { blocks: Array<Record<string, unknown>> };
    };
    check('往返仍是 RichDoc', parsed.format === 'selfapp-richdoc');
    check(
      '往返保留 todo checked/indent',
      parsed.doc.blocks.some(
        (b) => b.type === 'todo' && b.checked === true && b.indent === 1,
      ),
    );
    check(
      '往返保留 image URI',
      parsed.doc.blocks.some(
        (b) => b.type === 'image' && b.uri === 'https://cdn.example.com/p5.png',
      ),
    );
    check(
      '往返保留多级列表 indent',
      parsed.doc.blocks.some((b) => {
        if (b.type !== 'bullet_list' || !Array.isArray(b.items)) return false;
        const items = b.items as Array<{ indent: number; runs: Array<{ text: string }> }>;
        return (
          items.some((it) => it.indent === 0 && it.runs[0]?.text === '一级') &&
          items.some((it) => it.indent === 2 && it.runs[0]?.text === '三级')
        );
      }),
    );
    check('create 返回 body 一致', created.body === roundBody);

    // --- 大文档 ---
    console.log('\n--- 大文档（接近 512KB） / 超限 ---\n');
    const nearBody = makeNearLimitBody(MEMO_BODY_MAX_BYTES - 2048);
    const nearBytes = Buffer.byteLength(nearBody, 'utf8');
    check(
      '近上限样本 < 512KB',
      nearBytes < MEMO_BODY_MAX_BYTES && nearBytes > MEMO_BODY_MAX_BYTES * 0.9,
      `bytes=${nearBytes}`,
    );
    const bigId = makeId('memo_p5_big_');
    ids.push(bigId);
    const big = await createMemo({ id: bigId, title: 'big', body: nearBody });
    check('近上限文档可创建', big.id === bigId);
    const bigRead = await getMemoDetail(bigId);
    check(
      '近上限 pull 后长度一致',
      Buffer.byteLength(bigRead.body, 'utf8') === nearBytes,
    );

    const oversize = 'x'.repeat(MEMO_BODY_MAX_BYTES + 1);
    check(
      '超限创建拒绝且文案可读',
      await expectMemoError(
        () => createMemo({ title: 'over', body: oversize }),
        '超过上限',
      ),
    );
    check(
      '超限更新拒绝且文案可读',
      await expectMemoError(() => updateMemo(bigId, { body: oversize }), '超过上限'),
    );

    // --- OCC：双端冲突表现（整行 server-wins） ---
    console.log('\n--- OCC 冲突（expected_rev） ---\n');
    const occId = makeId('memo_p5_occ_');
    ids.push(occId);
    const bodyA = makeRichDocBody({ text: '设备A', nested: false });
    await createMemo(
      { id: occId, title: 'occ', body: bodyA },
      { mutationId: randomUUID().slice(0, 36), deviceId: 'device_a' },
    );
    const rev1 = await liveRev(occId);
    check('创建后 rev=1', rev1 === 1, `rev=${rev1}`);

    const bodyB = makeRichDocBody({ text: '设备B获胜', nested: false });
    await updateMemo(
      occId,
      { body: bodyB },
      {
        expectedRev: 1,
        mutationId: randomUUID().slice(0, 36),
        deviceId: 'device_b',
      },
    );
    const rev2 = await liveRev(occId);
    check('合法更新后 rev=2', rev2 === 2, `rev=${rev2}`);

    let staleErr: unknown = null;
    try {
      await updateMemo(
        occId,
        { body: makeRichDocBody({ text: '设备A过期', nested: false }) },
        {
          expectedRev: 1,
          mutationId: randomUUID().slice(0, 36),
          deviceId: 'device_a',
        },
      );
    } catch (err) {
      staleErr = err;
    }
    check('过期 expected_rev → SyncOccConflictError', staleErr instanceof SyncOccConflictError);
    if (staleErr instanceof SyncOccConflictError) {
      check('409 kind=row', staleErr.payload.kind === 'row');
      check('409 serverRev=2', staleErr.payload.serverRev === 2);
    }
    const afterConflict = await getMemoDetail(occId);
    check(
      '冲突后 body 仍为胜者（整行 server-wins）',
      afterConflict.body.includes('设备B获胜') && !afterConflict.body.includes('设备A过期'),
    );
    check('冲突后 rev 仍为 2', (await liveRev(occId)) === 2);

    // --- 旧 markup → 新客户端升级 ---
    console.log('\n--- 旧 markup 可读；新客户端保存升级 ---\n');
    const legacyId = makeId('memo_p5_legacy_');
    ids.push(legacyId);
    const markup = '# 旧标题\n正文有**粗体**\n- [x] 已办\n- 列表';
    await createMemo({ id: legacyId, title: 'legacy', body: markup });
    const legacyRead = await getMemoDetail(legacyId);
    check('旧 markup 可入库可读', legacyRead.body === markup);

    const upgraded = makeRichDocBody({ text: '升级后正文', checked: true });
    await updateMemo(legacyId, { body: upgraded, title: 'upgraded' });
    const upgradedRead = await getMemoDetail(legacyId);
    check(
      '新客户端保存后升级为 RichDoc',
      upgradedRead.body.includes('selfapp-richdoc') && upgradedRead.body.includes('升级后正文'),
    );

    // --- AI 纯文本 ---
    console.log('\n--- AI 入参纯文本 ---\n');
    const aiBody = makeRichDocBody({ text: 'AI可见正文', uri: 'https://example.com/ai.png' });
    const plain = plainTextFromMemoBody(aiBody);
    check(
      'plainText 不含 JSON 契约键',
      !plain.includes('selfapp-richdoc') &&
        !plain.includes('"blocks"') &&
        !plain.includes('"format"') &&
        plain.includes('AI可见正文') &&
        plain.includes('[图片]'),
    );
    const ctx = buildMemoContextText({ title: 'AI测', body: aiBody });
    check(
      'buildMemoContextText 不含 JSON 噪声',
      !ctx.includes('selfapp-richdoc') &&
        !ctx.includes('"blocks"') &&
        ctx.includes('AI可见正文') &&
        ctx.includes('AI测'),
    );
    check(
      '旧 markup AI 仍可读原文',
      plainTextFromMemoBody('普通 **粗体**').includes('**粗体**'),
    );
  } finally {
    for (const id of ids) {
      try {
        await deleteMemo(id);
      } catch {
        /* ignore */
      }
    }
    await db.end();
  }

  console.log(`\n=== ${failed === 0 ? 'ALL PASSED' : 'FAILED'} (${passed} ok / ${failed} fail) ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
