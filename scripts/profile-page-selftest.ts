/**
 * P2-09：Profile 聚合与源 service 口径一致自测（连库）
 * 运行：npx tsx scripts/profile-page-selftest.ts
 *
 * 断言：聚合层返回的业务数组与直接调用源 service 的结果 deep equal（忽略 meta.serverTime）。
 */
import '../src/bootstrap/timezone.js';
import { db } from '../src/db/index.js';
import { listMemos, listTagLinks, listTags } from '../src/services/memos.js';
import {
  getProfileMemoList,
  getProfilePoints,
  getProfileRecipes,
  getProfileWishBoard,
} from '../src/services/pages/profile.js';
import { getOrCreateDefaultWallet, listPointsLedgerRows } from '../src/services/points.js';
import { listAllRecipeItems, listRecipeCategories } from '../src/services/recipes.js';
import { listActiveWishBoardItems } from '../src/services/wish-board.js';

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

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function diffHint(a: unknown, b: unknown): string {
  const sa = stableStringify(a);
  const sb = stableStringify(b);
  if (sa === sb) return '';
  const max = 180;
  return `agg=${sa.slice(0, max)}… src=${sb.slice(0, max)}…`;
}

async function main() {
  console.log('=== P2-09 Profile 聚合 ≡ 源 service ===\n');

  console.log('--- memo-list ---');
  {
    const [agg, memos, tags, tagLinks] = await Promise.all([
      getProfileMemoList(),
      listMemos(),
      listTags(),
      listTagLinks(),
    ]);
    check('memos ≡ listMemos()', deepEqual(agg.memos, memos), diffHint(agg.memos, memos));
    check('tags ≡ listTags()', deepEqual(agg.tags, tags), diffHint(agg.tags, tags));
    check(
      'tagLinks ≡ listTagLinks()',
      deepEqual(agg.tagLinks, tagLinks),
      diffHint(agg.tagLinks, tagLinks),
    );
    check('meta.serverTime 存在', typeof agg.meta?.serverTime === 'string');
  }

  console.log('\n--- points ---');
  {
    const [agg, wallet, ledger] = await Promise.all([
      getProfilePoints(),
      getOrCreateDefaultWallet(),
      listPointsLedgerRows(),
    ]);
    check(
      'pointsWallet ≡ [getOrCreateDefaultWallet()]',
      deepEqual(agg.pointsWallet, [wallet]),
      diffHint(agg.pointsWallet, [wallet]),
    );
    check(
      'pointsLedger ≡ listPointsLedgerRows()',
      deepEqual(agg.pointsLedger, ledger),
      diffHint(agg.pointsLedger, ledger),
    );
  }

  console.log('\n--- wish-board ---');
  {
    const [agg, wallet, items, ledger] = await Promise.all([
      getProfileWishBoard(),
      getOrCreateDefaultWallet(),
      listActiveWishBoardItems(),
      listPointsLedgerRows(),
    ]);
    check(
      'pointsWallet ≡ [getOrCreateDefaultWallet()]',
      deepEqual(agg.pointsWallet, [wallet]),
      diffHint(agg.pointsWallet, [wallet]),
    );
    check(
      'items ≡ listActiveWishBoardItems()',
      deepEqual(agg.items, items),
      diffHint(agg.items, items),
    );
    check(
      'pointsLedger ≡ listPointsLedgerRows()',
      deepEqual(agg.pointsLedger, ledger),
      diffHint(agg.pointsLedger, ledger),
    );
  }

  console.log('\n--- recipes ---');
  {
    const [agg, categories, items] = await Promise.all([
      getProfileRecipes(),
      listRecipeCategories(),
      listAllRecipeItems({ parseJson: false }),
    ]);
    check(
      'categories ≡ listRecipeCategories()',
      deepEqual(agg.categories, categories),
      diffHint(agg.categories, categories),
    );
    check(
      'items ≡ listAllRecipeItems({ parseJson: false })',
      deepEqual(agg.items, items),
      diffHint(agg.items, items),
    );
  }

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  try {
    await db.end();
  } catch {
    /* ignore */
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
