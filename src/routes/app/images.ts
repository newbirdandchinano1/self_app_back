import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { success, fail } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  StoredImageError,
  bindStoredImage,
  deleteStoredImage,
  getStoredImage,
  listStoredImages,
  saveStoredImage,
  type SavedStoredImage,
  type StoredImage,
} from '../../services/stored-images.js';

/**
 * 统一图片登记 API。
 * 挂载前缀：/api/app
 *
 * 文件字节不走本接口；APP 拿返回的 uri 后走静态 `/uploads/images/...`。
 */
const router = Router();

router.use(requireAuth);

const handleImageError = createDomainErrorHandler(StoredImageError);

function toPublicImage(row: SavedStoredImage | StoredImage): StoredImage {
  return {
    id: row.id,
    uri: row.uri,
    mime: row.mime,
    byte_size: row.byte_size,
    purpose: row.purpose,
    owner_table: row.owner_table,
    owner_id: row.owner_id,
    owner_field: row.owner_field,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** POST /images — 上传并登记；body: data，可选 mime / purpose / owner_* */
router.post('/images', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const saved = await saveStoredImage({
      data: body.data,
      mime: body.mime,
      purpose: body.purpose,
      owner_table: body.owner_table,
      owner_id: body.owner_id,
      owner_field: body.owner_field,
    });
    success(res, toPublicImage(saved), '上传成功');
  } catch (err) {
    handleImageError(err, res, next);
  }
});

/** GET /images?owner_table=&owner_id= — 查某条业务记录绑了哪些图 */
router.get('/images', async (req, res, next) => {
  try {
    const items = await listStoredImages({
      owner_table: req.query.owner_table,
      owner_id: req.query.owner_id,
    });
    success(res, items);
  } catch (err) {
    handleImageError(err, res, next);
  }
});

/** GET /images/:id — 查登记信息，不返回文件字节 */
router.get('/images/:id', async (req, res, next) => {
  try {
    const image = await getStoredImage(req.params.id);
    if (!image) return fail(res, '图片不存在', -1, 404);
    success(res, image);
  } catch (err) {
    handleImageError(err, res, next);
  }
});

/** PATCH /images/:id — 补绑定或改 purpose */
router.patch('/images/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const image = await bindStoredImage({
      id: req.params.id,
      purpose: body.purpose,
      owner_table: body.owner_table,
      owner_id: body.owner_id,
      owner_field: body.owner_field,
    });
    success(res, image, '已更新');
  } catch (err) {
    handleImageError(err, res, next);
  }
});

/** DELETE /images/:id — 删登记和文件 */
router.delete('/images/:id', async (req, res, next) => {
  try {
    const result = await deleteStoredImage({ id: req.params.id });
    success(res, { deleted: result.deleted }, result.deleted ? '已删除' : '文件不存在或已删除');
  } catch (err) {
    handleImageError(err, res, next);
  }
});

export default router;
