import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { syncWriteOptionsFromReq } from '../../utils/device-id-from-req.js';
import {
  WardrobeError,
  bootstrapWardrobe,
  countItems,
  createCategory,
  createCloset,
  createItem,
  createOccasion,
  createOutfit,
  deleteCategory,
  deleteCloset,
  deleteItem,
  deleteOccasion,
  deleteOutfit,
  createOption,
  deleteOption,
  deleteWearLog,
  getBodyProfile,
  getItemDetail,
  getItemWearHistory,
  getOutfitDetail,
  getStatsSummary,
  getWearWeek,
  listCategories,
  listCategoriesWithItems,
  listClosets,
  listItems,
  listOccasions,
  listOptions,
  listOutfits,
  updateCategory,
  updateCloset,
  updateItem,
  updateOccasion,
  updateOption,
  updateOutfit,
  upsertBodyProfile,
  wearItem,
  wearOutfit,
} from '../../services/wardrobe.js';

const router = Router();

router.use(requireAuth);

const handleWardrobeError = createDomainErrorHandler(WardrobeError);

/** GET /wardrobe/bootstrap — 首屏聚合 */
router.get('/wardrobe/bootstrap', async (req, res, next) => {
  try {
    const data = await bootstrapWardrobe(req.query.closet_id);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/closets */
router.get('/wardrobe/closets', async (_req, res, next) => {
  try {
    const data = await listClosets();
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/closets */
router.post('/wardrobe/closets', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createCloset(
      {
        id: body.id,
        name: body.name,
        sort_order: body.sort_order,
        is_default: body.is_default,
        note: body.note,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '创建成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PATCH /wardrobe/closets/:id */
router.patch('/wardrobe/closets/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateCloset(
      String(req.params.id ?? ''),
      {
        name: body.name,
        sort_order: body.sort_order,
        is_default: body.is_default,
        note: body.note,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** DELETE /wardrobe/closets/:id */
router.delete('/wardrobe/closets/:id', async (req, res, next) => {
  try {
    const data = await deleteCloset(String(req.params.id ?? ''), syncWriteOptionsFromReq(req));
    success(res, data, '删除成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/categories */
router.get('/wardrobe/categories', async (req, res, next) => {
  try {
    const data = await listCategories(req.query.closet_id);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/categories/with-items */
router.get('/wardrobe/categories/with-items', async (req, res, next) => {
  try {
    const data = await listCategoriesWithItems(req.query.closet_id);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/categories */
router.post('/wardrobe/categories', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createCategory(
      {
        id: body.id,
        closet_id: body.closet_id,
        name: body.name,
        sort_order: body.sort_order,
        tint: body.tint,
        tint2: body.tint2,
        tone: body.tone,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '创建成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PATCH /wardrobe/categories/:id */
router.patch('/wardrobe/categories/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateCategory(
      String(req.params.id ?? ''),
      {
        name: body.name,
        sort_order: body.sort_order,
        tint: body.tint,
        tint2: body.tint2,
        tone: body.tone,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** DELETE /wardrobe/categories/:id — 单品迁入未分类 */
router.delete('/wardrobe/categories/:id', async (req, res, next) => {
  try {
    const data = await deleteCategory(String(req.params.id ?? ''), syncWriteOptionsFromReq(req));
    success(res, data, '删除成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/items/count — 须在 /:id 之前 */
router.get('/wardrobe/items/count', async (req, res, next) => {
  try {
    const data = await countItems(req.query.closet_id, req.query.status);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/items */
router.get('/wardrobe/items', async (req, res, next) => {
  try {
    const data = await listItems({
      closet_id: req.query.closet_id,
      category_id: req.query.category_id,
      season: req.query.season,
      status: req.query.status,
      updatedSince: req.query.updatedSince ?? req.query.updated_since,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/items/:id */
router.get('/wardrobe/items/:id', async (req, res, next) => {
  try {
    const includeHistory = String(req.query.history ?? '1') !== '0';
    const data = await getItemDetail(String(req.params.id ?? ''), includeHistory);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/items */
router.post('/wardrobe/items', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createItem(body, syncWriteOptionsFromReq(req));
    success(res, data, '创建成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PUT /wardrobe/items/:id */
router.put('/wardrobe/items/:id', async (req, res, next) => {
  try {
    const data = await updateItem(
      String(req.params.id ?? ''),
      req.body ?? {},
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PATCH /wardrobe/items/:id */
router.patch('/wardrobe/items/:id', async (req, res, next) => {
  try {
    const data = await updateItem(
      String(req.params.id ?? ''),
      req.body ?? {},
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** DELETE /wardrobe/items/:id */
router.delete('/wardrobe/items/:id', async (req, res, next) => {
  try {
    const data = await deleteItem(String(req.params.id ?? ''), syncWriteOptionsFromReq(req));
    success(res, data, '删除成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/occasions */
router.get('/wardrobe/occasions', async (_req, res, next) => {
  try {
    const data = await listOccasions();
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/occasions */
router.post('/wardrobe/occasions', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createOccasion(
      { id: body.id, name: body.name, sort_order: body.sort_order },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '创建成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PATCH /wardrobe/occasions/:id */
router.patch('/wardrobe/occasions/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateOccasion(
      String(req.params.id ?? ''),
      { name: body.name, sort_order: body.sort_order },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** DELETE /wardrobe/occasions/:id */
router.delete('/wardrobe/occasions/:id', async (req, res, next) => {
  try {
    const data = await deleteOccasion(String(req.params.id ?? ''), syncWriteOptionsFromReq(req));
    success(res, data, '删除成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/outfits */
router.get('/wardrobe/outfits', async (req, res, next) => {
  try {
    const data = await listOutfits({
      closet_id: req.query.closet_id,
      occasion_id: req.query.occasion_id,
      status: req.query.status,
    });
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/outfits/:id */
router.get('/wardrobe/outfits/:id', async (req, res, next) => {
  try {
    const data = await getOutfitDetail(String(req.params.id ?? ''));
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/outfits */
router.post('/wardrobe/outfits', async (req, res, next) => {
  try {
    const data = await createOutfit(req.body ?? {}, syncWriteOptionsFromReq(req));
    success(res, data, '创建成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PUT /wardrobe/outfits/:id */
router.put('/wardrobe/outfits/:id', async (req, res, next) => {
  try {
    const data = await updateOutfit(
      String(req.params.id ?? ''),
      req.body ?? {},
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PATCH /wardrobe/outfits/:id */
router.patch('/wardrobe/outfits/:id', async (req, res, next) => {
  try {
    const data = await updateOutfit(
      String(req.params.id ?? ''),
      req.body ?? {},
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** DELETE /wardrobe/outfits/:id */
router.delete('/wardrobe/outfits/:id', async (req, res, next) => {
  try {
    const data = await deleteOutfit(String(req.params.id ?? ''), syncWriteOptionsFromReq(req));
    success(res, data, '删除成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/wear/item */
router.post('/wardrobe/wear/item', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await wearItem(
      { item_id: body.item_id, worn_on: body.worn_on, note: body.note },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, data.created ? '已记录穿着' : '当日已记录');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/wear/outfit */
router.post('/wardrobe/wear/outfit', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await wearOutfit(
      { outfit_id: body.outfit_id, worn_on: body.worn_on, note: body.note },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, data.created ? '已记录穿着' : '当日已记录');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** DELETE /wardrobe/wear/logs/:id */
router.delete('/wardrobe/wear/logs/:id', async (req, res, next) => {
  try {
    const data = await deleteWearLog(String(req.params.id ?? ''), syncWriteOptionsFromReq(req));
    success(res, data, '已撤销');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/wear/week */
router.get('/wardrobe/wear/week', async (req, res, next) => {
  try {
    const data = await getWearWeek(req.query.closet_id, req.query.anchor);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/wear/item/:id/history */
router.get('/wardrobe/wear/item/:id/history', async (req, res, next) => {
  try {
    const days = req.query.days == null ? 28 : Number(req.query.days);
    const data = await getItemWearHistory(
      String(req.params.id ?? ''),
      Number.isFinite(days) ? days : 28,
    );
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/options */
router.get('/wardrobe/options', async (req, res, next) => {
  try {
    const data = await listOptions({
      closet_id: req.query.closet_id,
      kind: req.query.kind,
    });
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** POST /wardrobe/options */
router.post('/wardrobe/options', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createOption(
      {
        id: body.id,
        closet_id: body.closet_id,
        kind: body.kind,
        value: body.value,
        sort_order: body.sort_order,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '创建成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PATCH /wardrobe/options/:id */
router.patch('/wardrobe/options/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateOption(
      String(req.params.id ?? ''),
      {
        value: body.value,
        sort_order: body.sort_order,
        kind: body.kind,
        closet_id: body.closet_id,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** DELETE /wardrobe/options/:id */
router.delete('/wardrobe/options/:id', async (req, res, next) => {
  try {
    const data = await deleteOption(String(req.params.id ?? ''), syncWriteOptionsFromReq(req));
    success(res, data, '删除成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/body-profile */
router.get('/wardrobe/body-profile', async (req, res, next) => {
  try {
    const data = await getBodyProfile(req.query.closet_id);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** PUT /wardrobe/body-profile */
router.put('/wardrobe/body-profile', async (req, res, next) => {
  try {
    const data = await upsertBodyProfile(req.body ?? {}, syncWriteOptionsFromReq(req));
    success(res, data, '保存成功');
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

/** GET /wardrobe/stats/summary */
router.get('/wardrobe/stats/summary', async (req, res, next) => {
  try {
    const data = await getStatsSummary(req.query.closet_id);
    success(res, data);
  } catch (err) {
    handleWardrobeError(err, res, next);
  }
});

export default router;
