import path from 'path';

/** 上传文件根目录（项目下独立文件夹，不混入 public） */
export const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');

/** 健康摄入来源图片子目录 */
export const HEALTH_INTAKE_DIR_NAME = 'health-intake';

export const HEALTH_INTAKE_UPLOAD_DIR = path.join(UPLOAD_ROOT, HEALTH_INTAKE_DIR_NAME);

/** 入库与对外访问的 URL 前缀 */
export const HEALTH_INTAKE_PUBLIC_PREFIX = `/uploads/${HEALTH_INTAKE_DIR_NAME}`;

export const HEALTH_INTAKE_MAX_BYTES = 8 * 1024 * 1024;

export const HEALTH_INTAKE_MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
