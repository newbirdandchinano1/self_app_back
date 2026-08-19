import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import path from 'path';
import {
  HEALTH_INTAKE_MAX_BYTES,
  HEALTH_INTAKE_MIME_EXT,
  HEALTH_INTAKE_PUBLIC_PREFIX,
  HEALTH_INTAKE_UPLOAD_DIR,
} from '../config/uploads.js';

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

function sniffImageExt(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return '.webp';
  }
  return null;
}

function parseImagePayload(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new UploadError('请选择要上传的图片');
  }
  const text = raw.trim();
  const dataUrl = text.match(/^data:([^;,]+);base64,(.+)$/i);
  const base64 = dataUrl ? dataUrl[2] : text.replace(/\s/g, '');
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    throw new UploadError('图片数据无效');
  }
  if (!buf.length) throw new UploadError('图片数据无效');
  if (buf.length > HEALTH_INTAKE_MAX_BYTES) {
    throw new UploadError('图片不能超过 8MB');
  }
  return buf;
}

export async function saveHealthIntakeImage(input: {
  data?: unknown;
  mime?: unknown;
}): Promise<SavedHealthIntakeImage> {
  const buf = parseImagePayload(input.data);
  const sniffed = sniffImageExt(buf);
  const mime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : '';
  const fromMime = HEALTH_INTAKE_MIME_EXT[mime];
  const ext = sniffed ?? fromMime;
  if (!ext) {
    throw new UploadError('仅支持 jpg / png / webp / gif 图片');
  }

  await ensureHealthIntakeUploadDir();
  const filename = `${randomUUID()}${ext}`;
  await writeFile(path.join(HEALTH_INTAKE_UPLOAD_DIR, filename), buf);

  return {
    uri: `${HEALTH_INTAKE_PUBLIC_PREFIX}/${filename}`,
    filename,
  };
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

/** 删除系统目录下的健康摄入来源图片；非本目录路径则忽略 */
export async function deleteHealthIntakeImage(uri: unknown): Promise<{ deleted: boolean; filename: string | null }> {
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
