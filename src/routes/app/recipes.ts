import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import { syncWriteOptionsFromReq } from '../../utils/device-id-from-req.js';
import {
  RecipeError,
  countRecipeCategories,
  countRecipes,
  createRecipe,
  createRecipeCategory,
  deleteRecipe,
  deleteRecipeCategory,
  getRecipeDetail,
  listRecipeCategories,
  listRecipesByCategory,
  listRecipesGroupedByCategory,
  renameRecipeCategory,
  updateRecipe,
} from '../../services/recipes.js';
import {
  addBasketItem,
  addCookLog,
  addPlanEntry,
  addShopRecipe,
  basketToPlan,
  basketToShop,
  clearBasket,
  clearShop,
  dismissShopItems,
  getBasket,
  getKitchenStats,
  getRecipeCookSummary,
  getShopState,
  listCookLogs,
  listPlanEntries,
  removeBasketItem,
  removePlanEntry,
  setShopItemStatus,
  updateCookLogNote,
} from '../../services/recipe-kitchen.js';

const router = Router();

router.use(requireAuth);

const handleRecipeError = createDomainErrorHandler(RecipeError);

/** GET /recipes/categories — 获取分类列表 */
router.get('/recipes/categories', async (_req, res, next) => {
  try {
    const data = await listRecipeCategories();
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/categories/count — 获取分类数量 */
router.get('/recipes/categories/count', async (_req, res, next) => {
  try {
    const data = await countRecipeCategories();
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/categories/with-items — 每个分类及其下全部菜谱 */
router.get('/recipes/categories/with-items', async (_req, res, next) => {
  try {
    const data = await listRecipesGroupedByCategory();
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/categories/:categoryId/items — 指定分类下全部菜谱 */
router.get('/recipes/categories/:categoryId/items', async (req, res, next) => {
  try {
    const data = await listRecipesByCategory(String(req.params.categoryId ?? ''));
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/categories — 新建分类 */
router.post('/recipes/categories', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createRecipeCategory(
      {
        id: body.id,
        name: body.name,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '创建成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** PATCH /recipes/categories/:id — 修改分类名称 */
router.patch('/recipes/categories/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await renameRecipeCategory(String(req.params.id ?? ''), body.name, {
      ...syncWriteOptionsFromReq(req),
    });
    success(res, data, '更新成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/categories/:id — 删除分类（软删，级联软删菜谱） */
router.delete('/recipes/categories/:id', async (req, res, next) => {
  try {
    const data = await deleteRecipeCategory(String(req.params.id ?? ''), {
      ...syncWriteOptionsFromReq(req),
    });
    success(res, data, '删除成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/count — 获取菜谱数量 */
router.get('/recipes/count', async (_req, res, next) => {
  try {
    const data = await countRecipes();
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/stats/kitchen — 厨房统计（Agent / 我的页） */
router.get('/recipes/stats/kitchen', async (_req, res, next) => {
  try {
    const data = await getKitchenStats();
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/cook-logs — 制作记录列表（可按 recipe_id 过滤） */
router.get('/recipes/cook-logs', async (req, res, next) => {
  try {
    const data = await listCookLogs({
      recipe_id: req.query.recipe_id != null ? String(req.query.recipe_id) : undefined,
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
    });
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/:id/cook-summary — 某菜制作次数 / 均分 / 记录 */
router.get('/recipes/:id/cook-summary', async (req, res, next) => {
  try {
    const data = await getRecipeCookSummary(String(req.params.id ?? ''));
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/cook-logs — 记录制作与评分 */
router.post('/recipes/cook-logs', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await addCookLog(
      {
        recipe_id: body.recipe_id ?? body.recipeId,
        rating: body.rating,
        note: body.note,
        cooked_at: body.cooked_at ?? body.cookedAt ?? body.cooked_on,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '记录成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** PATCH /recipes/cook-logs/note — 仅改制作备注 */
router.patch('/recipes/cook-logs/note', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateCookLogNote({
      log_id: body.log_id ?? body.id,
      recipe_id: body.recipe_id ?? body.recipeId,
      note: body.note,
    });
    success(res, data, '更新成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/basket — 查看菜单篮 */
router.get('/recipes/basket', async (_req, res, next) => {
  try {
    const data = await getBasket();
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/basket — 加入菜单篮 */
router.post('/recipes/basket', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await addBasketItem({
      recipe_id: body.recipe_id ?? body.recipeId,
      recipe_title: body.recipe_title ?? body.recipeTitle ?? body.title,
      category_name: body.category_name ?? body.categoryName,
    });
    success(res, data, data.already_added ? '已在菜单篮' : '已加入菜单篮');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/basket/:recipeId — 移出菜单篮 */
router.delete('/recipes/basket/:recipeId', async (req, res, next) => {
  try {
    const data = await removeBasketItem(String(req.params.recipeId ?? ''));
    success(res, data, '已移出');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/basket — 清空菜单篮 */
router.delete('/recipes/basket', async (_req, res, next) => {
  try {
    const data = await clearBasket();
    success(res, data, '已清空');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/basket/to-shop — 菜单篮生成采购 */
router.post('/recipes/basket/to-shop', async (_req, res, next) => {
  try {
    const data = await basketToShop();
    success(res, data, '已写入采购清单');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/basket/to-plan — 菜单篮安排到某日餐次 */
router.post('/recipes/basket/to-plan', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await basketToPlan({
      date: body.date,
      slot: body.slot ?? body.meal,
    });
    success(res, data, '已写入用餐计划');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/plan — 查看用餐计划 */
router.get('/recipes/plan', async (req, res, next) => {
  try {
    const data = await listPlanEntries({
      date: req.query.date != null ? String(req.query.date) : undefined,
      from: req.query.from != null ? String(req.query.from) : undefined,
      to: req.query.to != null ? String(req.query.to) : undefined,
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
    });
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/plan — 添加计划 */
router.post('/recipes/plan', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await addPlanEntry({
      date: body.date,
      slot: body.slot ?? body.meal,
      recipe_id: body.recipe_id ?? body.recipeId,
      recipe_title: body.recipe_title ?? body.recipeTitle ?? body.title,
    });
    success(res, data, data.already_added ? '已在计划中' : '已加入计划');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/plan/:id — 移除计划条目 */
router.delete('/recipes/plan/:id', async (req, res, next) => {
  try {
    const data = await removePlanEntry(String(req.params.id ?? ''));
    success(res, data, '已移除');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/shop — 查看采购清单状态 */
router.get('/recipes/shop', async (_req, res, next) => {
  try {
    const data = await getShopState();
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/shop — 加入采购（按菜谱） */
router.post('/recipes/shop', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await addShopRecipe({
      recipe_id: body.recipe_id ?? body.recipeId,
      recipe_title: body.recipe_title ?? body.recipeTitle ?? body.title,
    });
    success(res, data, data.already_added ? '已在采购清单' : '已加入采购');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** PATCH /recipes/shop/status — 标记采购状态 */
router.patch('/recipes/shop/status', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await setShopItemStatus({
      key: body.key,
      keys: body.keys,
      status: body.status,
    });
    success(res, data, '状态已更新');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes/shop/dismiss — 移除采购项 */
router.post('/recipes/shop/dismiss', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await dismissShopItems({
      key: body.key,
      keys: body.keys,
    });
    success(res, data, '已移除');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/shop — 清空采购清单 */
router.delete('/recipes/shop', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await clearShop({
      dismiss_keys: body.dismiss_keys ?? body.dismissKeys,
    });
    success(res, data, '已清空');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** GET /recipes/:id — 菜谱详情 */
router.get('/recipes/:id', async (req, res, next) => {
  try {
    const data = await getRecipeDetail(String(req.params.id ?? ''));
    success(res, data);
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** POST /recipes — 新建菜谱 */
router.post('/recipes', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await createRecipe(
      {
        id: body.id,
        category_id: body.category_id,
        title: body.title,
        ingredients_json: body.ingredients_json,
        steps_json: body.steps_json,
        notes: body.notes,
        finished_image_uri: body.finished_image_uri,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '创建成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** PUT /recipes/:id — 编辑菜谱 */
router.put('/recipes/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateRecipe(
      String(req.params.id ?? ''),
      {
        category_id: body.category_id,
        title: body.title,
        ingredients_json: body.ingredients_json,
        steps_json: body.steps_json,
        notes: body.notes,
        finished_image_uri: body.finished_image_uri,
      },
      syncWriteOptionsFromReq(req),
    );
    success(res, data, '更新成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/:id — 删除菜谱（软删） */
router.delete('/recipes/:id', async (req, res, next) => {
  try {
    const data = await deleteRecipe(String(req.params.id ?? ''), {
      ...syncWriteOptionsFromReq(req),
    });
    success(res, data, '删除成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

export default router;
