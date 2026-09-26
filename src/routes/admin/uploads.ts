import { Router } from 'express';
import { success } from '../../utils/response.js';
import { createDomainErrorHandler } from '../../utils/domain-error-handler.js';
import {
  deleteHealthIntakeImage,
  saveHealthIntakeImage,
  UploadError,
} from '../../services/health-intake-upload.js';

const router = Router();

const handleUploadError = createDomainErrorHandler(UploadError);

/**
 * POST /uploads/health-intake
 * body: { data: dataURL 或 base64, mime?: string }
 */
router.post('/health-intake', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const saved = await saveHealthIntakeImage({
      data: body.data,
      mime: body.mime,
    });
    success(res, saved, '上传成功');
  } catch (err) {
    handleUploadError(err, res, next);
  }
});

/**
 * DELETE /uploads/health-intake
 * body: { uri: /uploads/health-intake/xxx.jpg }
 */
router.delete('/health-intake', async (req, res, next) => {
  try {
    const uri = (req.body ?? {}).uri ?? req.query.uri;
    const result = await deleteHealthIntakeImage(uri);
    success(res, result, result.deleted ? '已删除文件' : '文件不存在或已删除');
  } catch (err) {
    handleUploadError(err, res, next);
  }
});

export default router;
