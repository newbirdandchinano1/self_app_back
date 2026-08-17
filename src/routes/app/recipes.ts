import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
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

const router = Router();

router.use(requireAuth);

function handleRecipeError(
  err: unknown,
  res: Parameters<typeof fail>[0],
  next: (err: unknown) => void,
) {
  if (err instanceof RecipeError) {
    return fail(res, err.message, -1, err.status);
  }
  next(err);
}

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
    const data = await createRecipeCategory({
      id: body.id,
      name: body.name,
    });
    success(res, data, '创建成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** PATCH /recipes/categories/:id — 修改分类名称 */
router.patch('/recipes/categories/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await renameRecipeCategory(String(req.params.id ?? ''), body.name);
    success(res, data, '更新成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/categories/:id — 删除分类（软删，级联软删菜谱） */
router.delete('/recipes/categories/:id', async (req, res, next) => {
  try {
    const data = await deleteRecipeCategory(String(req.params.id ?? ''));
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
    const data = await createRecipe({
      id: body.id,
      category_id: body.category_id,
      title: body.title,
      ingredients_json: body.ingredients_json,
      steps_json: body.steps_json,
      notes: body.notes,
      finished_image_uri: body.finished_image_uri,
    });
    success(res, data, '创建成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** PUT /recipes/:id — 编辑菜谱 */
router.put('/recipes/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const data = await updateRecipe(String(req.params.id ?? ''), {
      category_id: body.category_id,
      title: body.title,
      ingredients_json: body.ingredients_json,
      steps_json: body.steps_json,
      notes: body.notes,
      finished_image_uri: body.finished_image_uri,
    });
    success(res, data, '更新成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

/** DELETE /recipes/:id — 删除菜谱（软删） */
router.delete('/recipes/:id', async (req, res, next) => {
  try {
    const data = await deleteRecipe(String(req.params.id ?? ''));
    success(res, data, '删除成功');
  } catch (err) {
    handleRecipeError(err, res, next);
  }
});

export default router;
