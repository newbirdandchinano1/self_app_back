/**
 * 「我的」子页聚合：只编排源 domain service，禁止在此复制排序/筛选/格式化规则。
 * 口径变更请改 memos / points / wish-board / recipes，并由 profile-page-selftest 断言一致。
 */
import { listMemos, listTagLinks, listTags } from '../memos.js';
import { getOrCreateDefaultWallet, listPointsLedgerRows } from '../points.js';
import { listAllRecipeItems, listRecipeCategories } from '../recipes.js';
import { listActiveWishBoardItems } from '../wish-board.js';

export class ProfilePageError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ProfilePageError';
  }
}

function serverNowIso(): string {
  return new Date().toISOString();
}

/** 备忘列表拼盘：memos + tags + tag_links 均走源 service */
export async function getProfileMemoList() {
  const [memos, tags, tagLinks] = await Promise.all([listMemos(), listTags(), listTagLinks()]);
  return {
    memos,
    tags,
    tagLinks,
    meta: { serverTime: serverNowIso() },
  };
}

/** 积分钱包/流水：钱包 ensure + 流水表行同源 points service */
export async function getProfilePoints() {
  const [wallet, pointsLedger] = await Promise.all([
    getOrCreateDefaultWallet(),
    listPointsLedgerRows(),
  ]);
  return {
    pointsWallet: [wallet],
    pointsLedger,
    meta: { serverTime: serverNowIso() },
  };
}

/** 心愿板：active 列表 + 钱包 + 流水，均走源 service */
export async function getProfileWishBoard() {
  const [wallet, items, pointsLedger] = await Promise.all([
    getOrCreateDefaultWallet(),
    listActiveWishBoardItems(),
    listPointsLedgerRows(),
  ]);
  return {
    pointsWallet: [wallet],
    items,
    pointsLedger,
    meta: { serverTime: serverNowIso() },
  };
}

/** 菜谱：分类 + 扁平 items，与 /recipes 领域列表同源 */
export async function getProfileRecipes() {
  const [categories, items] = await Promise.all([
    listRecipeCategories(),
    // 灌库保持 JSON 文本，与 SQLite TEXT 列及旧聚合行为一致
    listAllRecipeItems({ parseJson: false }),
  ]);
  return {
    categories,
    items,
    meta: { serverTime: serverNowIso() },
  };
}
