import { mkdir, unlink } from 'fs/promises';
import path from 'path';
import { HEALTH_INTAKE_UPLOAD_DIR } from '../config/uploads.js';
import {
  StoredImageError,
  deleteStoredImage,
  isStoredImageUri,
  saveStoredImage,
} from './stored-images.js';

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export type SavedHealthIntakeImage = {
  uri: string;
  filename: string;
};

export async function ensureHealthIntakeUploadDir(): Promise<void> {
  await mkdir(HEALTH_INTAKE_UPLOAD_DIR, { recursive: true });
}

function rethrowAsUploadError(err: unknown): never {
  if (err instanceof StoredImageError) {
    throw new UploadError(err.message, err.status);
  }
  throw err;
}

/**
 * 健康摄入来源图：走统一图片库保存，purpose 固定为 health-intake。
 * 返回仍是 `{ uri, filename }`，兼容旧 admin 调用方；uri 为 `/uploads/images/...`。
 */
export async function saveHealthIntakeImage(input: {
  data?: unknown;
  mime?: unknown;
}): Promise<SavedHealthIntakeImage> {
  try {
    const saved = await saveStoredImage({
      data: input.data,
      mime: input.mime,
      purpose: 'health-intake',
    });
    return { uri: saved.uri, filename: saved.filename };
  } catch (err) {
    rethrowAsUploadError(err);
  }
}

const HEALTH_INTAKE_URI_RE = /^\/uploads\/health-intake\/([A-Za-z0-9._-]+)$/;

function resolveHealthIntakeFile(uri: unknown): { filename: string; absPath: string } | null {
  if (typeof uri !== 'string') return null;
  const match = uri.trim().match(HEALTH_INTAKE_URI_RE);
  if (!match) return null;
  const filename = match[1];
  const absPath = path.resolve(HEALTH_INTAKE_UPLOAD_DIR, filename);
  const root = path.resolve(HEALTH_INTAKE_UPLOAD_DIR) + path.sep;
  if (!absPath.startsWith(root) && absPath !== path.resolve(HEALTH_INTAKE_UPLOAD_DIR)) {
    return null;
  }
  return { filename, absPath };
}

/**
 * 删除健康摄入来源图：
 * - `/uploads/images/...` → 统一登记表删除
 * - `/uploads/health-intake/...` → 旧目录按文件名删除（兼容历史文件）
 */
export async function deleteHealthIntakeImage(
  uri: unknown,
): Promise<{ deleted: boolean; filename: string | null }> {
  if (isStoredImageUri(uri)) {
    try {
      const result = await deleteStoredImage({ uri });
      return { deleted: result.deleted, filename: result.filename };
    } catch (err) {
      rethrowAsUploadError(err);
    }
  }

  const resolved = resolveHealthIntakeFile(uri);
  if (!resolved) {
    throw new UploadError('只能删除系统上传的来源图片');
  }
  try {
    await unlink(resolved.absPath);
    return { deleted: true, filename: resolved.filename };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { deleted: false, filename: resolved.filename };
    }
    throw err;
  }
}
