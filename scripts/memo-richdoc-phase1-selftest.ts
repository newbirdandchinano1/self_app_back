/**
 * Phase 1：memos.body MEDIUMTEXT + 后端 body 护栏自测（连库）
 * 运行：npm run test:memo-richdoc-phase1
 */
import '../src/bootstrap/timezone.js';
import { randomUUID } from 'crypto';
import { db } from '../src/db/index.js';
import { columnDataType } from '../src/db/schema-helpers.js';
import { runPendingMigrations } from '../src/db/migrations/index.js';
import {
  MEMO_BODY_MAX_BYTES,
  MemoError,
  createMemo,
  deleteMemo,
  updateMemo,
} from '../src/services/memos.js';

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

const SAMPLE_RICHDOC = JSON.stringify({
  v: 1,
  format: 'selfapp-richdoc',
  doc: {
    blocks: [
      { type: 'heading', level: 1, runs: [{ text: '标题', marks: ['bold'] }] },
      { type: 'paragraph', runs: [{ text: '正文', marks: [] }] },
      { type: 'todo', checked: false, indent: 0, runs: [{ text: '待办', marks: [] }] },
      { type: 'image', uri: 'https://example.com/x.png', width: 0, height: 0 },
    ],
  },
});

async function main() {
  console.log('=== Phase 1: memos MEDIUMTEXT + body 护栏 ===\n');

  await runPendingMigrations();

  const bodyType = await columnDataType('memos', 'body');
  check(
    'memos.body 为 mediumtext（或 longtext）',
    bodyType === 'mediumtext' || bodyType === 'longtext',
    `got ${bodyType}`,
  );

  const ids: string[] = [];
  try {
    console.log('\n--- 合法写入 ---\n');

    const legacyId = makeId('memo_p1_legacy_');
    ids.push(legacyId);
    const legacy = await createMemo({
      id: legacyId,
      title: 'legacy',
      body: '普通正文\n**粗体**\n- 列表',
    });
    check('旧 markup 可创建', legacy.id === legacyId && legacy.body.includes('**粗体**'));

    const richId = makeId('memo_p1_rich_');
    ids.push(richId);
    const rich = await createMemo({
      id: richId,
      title: 'richdoc',
      body: SAMPLE_RICHDOC,
    });
    check('合法 RichDoc JSON 可创建', rich.id === richId && rich.body.includes('selfapp-richdoc'));

    const updated = await updateMemo(richId, {
      body: JSON.stringify({
        v: 1,
        format: 'selfapp-richdoc',
        doc: { blocks: [{ type: 'paragraph', runs: [{ text: '已更新', marks: [] }] }] },
      }),
    });
    check('合法 RichDoc 可更新', updated.body.includes('已更新'));

    console.log('\n--- 护栏拒绝 ---\n');

    const oversize = 'x'.repeat(MEMO_BODY_MAX_BYTES + 1);
    check(
      '超大 body 创建拒绝（明确错误）',
      await expectMemoError(
        () => createMemo({ title: 'oversize', body: oversize }),
        '超过上限',
      ),
    );

    check(
      '超大 body 更新拒绝',
      await expectMemoError(() => updateMemo(richId, { body: oversize }), '超过上限'),
    );

    check(
      '损坏 JSON（以 { 开头）拒绝',
      await expectMemoError(
        () => createMemo({ title: 'bad-json', body: '{not-json' }),
        '格式损坏',
      ),
    );

    check(
      'RichDoc 缺 blocks 拒绝',
      await expectMemoError(
        () =>
          createMemo({
            title: 'no-blocks',
            body: JSON.stringify({ v: 1, format: 'selfapp-richdoc', doc: {} }),
          }),
        '结构异常',
      ),
    );

    check(
      'RichDoc 图片 data-URL 拒绝',
      await expectMemoError(
        () =>
          createMemo({
            title: 'b64',
            body: JSON.stringify({
              v: 1,
              format: 'selfapp-richdoc',
              doc: {
                blocks: [
                  {
                    type: 'image',
                    uri: 'data:image/png;base64,AAAA',
                    width: 0,
                    height: 0,
                  },
                ],
              },
            }),
          }),
        'base64',
      ),
    );

    check(
      '非 RichDoc 的 JSON 对象仍允许（旧客户端兼容）',
      (
        await createMemo({
          id: makeId('memo_p1_plainjson_'),
          title: 'plain-json',
          body: JSON.stringify({ note: 'not-richdoc' }),
        }).then((m) => {
          ids.push(m.id);
          return true;
        })
      ),
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
