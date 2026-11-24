import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import path from 'path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import {
  IMAGES_MAX_BYTES,
  IMAGES_MIME_EXT,
  IMAGES_MISC_MODULE,
  IMAGES_PUBLIC_PREFIX,
  IMAGES_UPLOAD_DIR,
} from '../config/uploads.js';
import { db } from '../db/index.js';
import { formatMySQLWallClockDateTime } from './calendar/logical-day.js';

export class StoredImageError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'StoredImageError';
  }
}

/** 给路由和业务调用方。filename 只留在服务内部。 */
export type StoredImage = {
  id: string;
  uri: string;
  mime: string;
  byte_size: number;
  purpose: string | null;
  owner_table: string | null;
  owner_id: string | null;
  owner_field: string | null;
  created_at: string;
  updated_at: string;
};

/** 健康摄入旧接口还要文件名；统一图片接口不带出。 */
export type SavedStoredImage = StoredImage & { filename: string };

type ImageRow = SavedStoredImage;

const SELECT_COLUMNS = `id, uri, filename, mime, byte_size, purpose,
  owner_table, owner_id, owner_field, created_at, updated_at`;

const CANONICAL_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 匹配 `/uploads/images/{uuid}.ext` 或 `/uploads/images/{module}/{uuid}.ext`。 */
export const STORED_IMAGE_URI_RE =
  /^\/uploads\/images\/(?:([a-z0-9_-]+)\/)?([0-9a-f-]{36})\.([a-z0-9]+)$/i;

export function isStoredImageUri(uri: unknown): boolean {
  return typeof uri === 'string' && STORED_IMAGE_URI_RE.test(uri.trim());
}

/** 从统一库 uri 解析图片 id；旧平铺路径与模块子目录都支持。 */
export function storedImageIdFromUri(uri: string): string | null {
  return uri.trim().match(STORED_IMAGE_URI_RE)?.[2] ?? null;
}

export async function saveStoredImage(input: {
  data?: unknown;
  mime?: unknown;
  purpose?: unknown;
  owner_table?: unknown;
  owner_id?: unknown;
  owner_field?: unknown;
}): Promise<SavedStoredImage> {
  const decoded = decodeImagePayload(input.data, input.mime);
  const owners = parseOwners(input, 'optional');
  const purpose = parsePurpose(input.purpose) ?? null;

  const id = randomUUID();
  const moduleDir = moduleDirFromPurpose(purpose);
  // filename = 磁盘相对路径（相对 uploads/images/），与文件名一致
  const basename = `${id}${decoded.ext}`;
  const filename = `${moduleDir}/${basename}`;
  const absPath = resolveImagePath(filename);
  const uri = `${IMAGES_PUBLIC_PREFIX}/${filename}`;
  const now = formatMySQLWallClockDateTime(new Date());

  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, decoded.bytes, { flag: 'wx' });

  try {
    await db.query<ResultSetHeader>(
      `INSERT INTO stored_images (
         id, uri, filename, mime, byte_size, purpose,
         owner_table, owner_id, owner_field, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        uri,
        filename,
        decoded.mime,
        decoded.bytes.length,
        purpose,
        owners.owner_table,
        owners.owner_id,
        owners.owner_field,
        now,
        now,
      ],
    );
  } catch (err) {
    await unlink(absPath).catch(() => undefined);
    throw err;
  }

  return {
    id,
    uri,
    filename,
    mime: decoded.mime,
    byte_size: decoded.bytes.length,
    purpose,
    owner_table: owners.owner_table,
    owner_id: owners.owner_id,
    owner_field: owners.owner_field,
    created_at: now,
    updated_at: now,
  };
}

export async function getStoredImage(id: unknown): Promise<StoredImage | null> {
  const imageId = requireId(id);
  const row = await findRow('id', imageId);
  return row ? toPublic(row) : null;
}

export async function listStoredImages(input: {
  owner_table?: unknown;
  owner_id?: unknown;
}): Promise<StoredImage[]> {
  const ownerTable = optionalBounded(input.owner_table, 'owner_table', 64);
  const ownerId = optionalBounded(input.owner_id, 'owner_id', 255);
  if (!ownerTable || !ownerId) {
    throw new StoredImageError('查询图片需要同时提供 owner_table 和 owner_id');
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLUMNS}
     FROM stored_images
     WHERE owner_table = ? AND owner_id = ?
     ORDER BY created_at DESC, id DESC`,
    [ownerTable, ownerId],
  );
  return rows.map((row) => toPublic(mapRow(row)));
}

export async function bindStoredImage(input: {
  id?: unknown;
  purpose?: unknown;
  owner_table?: unknown;
  owner_id?: unknown;
  owner_field?: unknown;
}): Promise<StoredImage> {
  const imageId = requireId(input.id);
  const existing = await findRow('id', imageId);
  if (!existing) throw new StoredImageError('图片不存在', 404);

  const owners = parseOwners(input, 'required');
  const purposeUpdate = parsePurpose(input.purpose);
  const purpose = purposeUpdate === undefined ? existing.purpose : purposeUpdate;
  const now = formatMySQLWallClockDateTime(new Date());

  await db.query<ResultSetHeader>(
    `UPDATE stored_images
     SET purpose = ?, owner_table = ?, owner_id = ?, owner_field = ?, updated_at = ?
     WHERE id = ?`,
    [purpose, owners.owner_table, owners.owner_id, owners.owner_field, now, imageId],
  );

  return {
    ...toPublic(existing),
    purpose,
    owner_table: owners.owner_table,
    owner_id: owners.owner_id,
    owner_field: owners.owner_field,
    updated_at: now,
  };
}

export async function deleteStoredImage(input: {
  id?: unknown;
  uri?: unknown;
}): Promise<{ deleted: boolean; filename: string | null }> {
  const id = optionalText(input.id);
  const uri = optionalText(input.uri);
  if (!id && !uri) throw new StoredImageError('缺少图片 id 或 uri');
  if (uri && !isStoredImageUri(uri)) {
    throw new StoredImageError('只能删除统一图片库中的文件');
  }

  const row = id ? await findRow('id', id) : await findRow('uri', uri!);
  if (!row) throw new StoredImageError('图片不存在', 404);
  if (uri && row.uri !== uri) throw new StoredImageError('图片不存在', 404);
  if (!isStoredImageUri(row.uri)) {
    throw new StoredImageError('只能删除统一图片库中的文件');
  }
  // 新数据：uri === /uploads/images/{filename}；旧平铺：filename 仅 basename
  const expectedUri = `${IMAGES_PUBLIC_PREFIX}/${row.filename}`;
  if (row.uri !== expectedUri && path.basename(row.uri) !== path.basename(row.filename)) {
    throw new StoredImageError('只能删除统一图片库中的文件');
  }

  const absPath = resolveImagePathFromRow(row);
  const [result] = await db.query<ResultSetHeader>(`DELETE FROM stored_images WHERE id = ?`, [row.id]);
  if (!result.affectedRows) {
    return { deleted: false, filename: row.filename };
  }

  try {
    await unlink(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  return { deleted: true, filename: row.filename };
}

function toPublic(row: ImageRow): StoredImage {
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

function mapRow(row: RowDataPacket): ImageRow {
  return {
    id: String(row.id),
    uri: String(row.uri),
    filename: String(row.filename),
    mime: String(row.mime),
    byte_size: Number(row.byte_size),
    purpose: row.purpose == null || row.purpose === '' ? null : String(row.purpose),
    owner_table: row.owner_table == null || row.owner_table === '' ? null : String(row.owner_table),
    owner_id: row.owner_id == null || row.owner_id === '' ? null : String(row.owner_id),
    owner_field: row.owner_field == null || row.owner_field === '' ? null : String(row.owner_field),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

async function findRow(column: 'id' | 'uri', value: string): Promise<ImageRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${SELECT_COLUMNS} FROM stored_images WHERE ${column} = ? LIMIT 1`,
    [value],
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** purpose → 模块目录名；无 purpose 归 misc。 */
function moduleDirFromPurpose(purpose: string | null): string {
  if (!purpose) return IMAGES_MISC_MODULE;
  return purpose;
}

function isSafeModuleDir(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name);
}

function isSafeBasename(name: string): boolean {
  return /^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(name);
}

/**
 * 解析磁盘路径。filename 可为：
 * - `{uuid}.ext`（旧平铺）
 * - `{module}/{uuid}.ext`（按模块分类）
 */
function resolveImagePath(filename: string): string {
  const normalized = filename.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new StoredImageError('图片路径无效');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 1) {
    const base = parts[0]!;
    if (!isSafeBasename(base)) throw new StoredImageError('图片路径无效');
    return assertUnderImagesRoot(path.resolve(IMAGES_UPLOAD_DIR, base));
  }
  if (parts.length === 2) {
    const [mod, base] = parts as [string, string];
    if (!isSafeModuleDir(mod) || !isSafeBasename(base)) {
      throw new StoredImageError('图片路径无效');
    }
    return assertUnderImagesRoot(path.resolve(IMAGES_UPLOAD_DIR, mod, base));
  }
  throw new StoredImageError('图片路径无效');
}

/** 优先用库里的 filename；旧行若 uri 含模块而 filename 只有 basename，从 uri 补全。 */
function resolveImagePathFromRow(row: ImageRow): string {
  try {
    return resolveImagePath(row.filename);
  } catch {
    const match = row.uri.trim().match(STORED_IMAGE_URI_RE);
    if (!match) throw new StoredImageError('图片路径无效');
    const moduleDir = match[1];
    const id = match[2]!;
    const ext = match[3]!;
    const relative = moduleDir ? `${moduleDir}/${id}.${ext}` : `${id}.${ext}`;
    return resolveImagePath(relative);
  }
}

function assertUnderImagesRoot(absPath: string): string {
  const root = path.resolve(IMAGES_UPLOAD_DIR) + path.sep;
  if (!absPath.startsWith(root) && absPath !== path.resolve(IMAGES_UPLOAD_DIR)) {
    throw new StoredImageError('图片路径无效');
  }
  return absPath;
}

function decodeImagePayload(data: unknown, declaredMime: unknown): { bytes: Buffer; mime: string; ext: string } {
  if (typeof data !== 'string' || !data.trim()) {
    throw new StoredImageError('缺少图片数据');
  }

  const extracted = extractBase64(data.trim());
  const bodyMime = normalizeMime(declaredMime);
  const declared = [bodyMime, extracted.mime].filter((item): item is string => Boolean(item));
  for (const mime of declared) {
    if (!IMAGES_MIME_EXT[mime]) {
      throw new StoredImageError('只接受 jpg、png、webp、gif');
    }
  }
  if (declared.length === 2 && IMAGES_MIME_EXT[declared[0]] !== IMAGES_MIME_EXT[declared[1]]) {
    throw new StoredImageError('声明的类型不一致');
  }

  const bytes = decodeBase64(extracted.base64);
  if (bytes.length > IMAGES_MAX_BYTES) {
    throw new StoredImageError('图片超过 8MB', 413);
  }

  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new StoredImageError('只接受 jpg、png、webp、gif');
  if (declared.some((mime) => IMAGES_MIME_EXT[mime] !== sniffed.ext)) {
    throw new StoredImageError('声明的类型与文件内容不一致');
  }
  return { bytes, mime: sniffed.mime, ext: sniffed.ext };
}

function extractBase64(raw: string): { base64: string; mime: string | null } {
  if (!raw.toLowerCase().startsWith('data:')) {
    return { base64: raw, mime: null };
  }
  const comma = raw.indexOf(',');
  if (comma < 0) throw new StoredImageError('图片数据无法解析');
  const meta = raw.slice(5, comma).trim().toLowerCase();
  if (!meta.split(';').includes('base64')) {
    throw new StoredImageError('图片数据无法解析');
  }
  const mime = meta.split(';')[0]?.trim() || null;
  return { base64: raw.slice(comma + 1), mime };
}

function decodeBase64(raw: string): Buffer {
  const compact = raw.replace(/\s/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new StoredImageError('图片数据无法解析');
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const estimated = Math.floor((compact.length * 3) / 4) - padding;
  if (estimated > IMAGES_MAX_BYTES) {
    throw new StoredImageError('图片超过 8MB', 413);
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0) throw new StoredImageError('图片数据无法解析');
  const roundTrip = bytes.toString('base64').replace(/=+$/, '');
  if (roundTrip !== compact.replace(/=+$/, '')) {
    throw new StoredImageError('图片数据无法解析');
  }
  return bytes;
}

function sniffImage(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: CANONICAL_MIME_BY_EXT['.jpg'], ext: '.jpg' };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: CANONICAL_MIME_BY_EXT['.png'], ext: '.png' };
  }
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF87a') {
    return { mime: CANONICAL_MIME_BY_EXT['.gif'], ext: '.gif' };
  }
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF89a') {
    return { mime: CANONICAL_MIME_BY_EXT['.gif'], ext: '.gif' };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: CANONICAL_MIME_BY_EXT['.webp'], ext: '.webp' };
  }
  return null;
}

function normalizeMime(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new StoredImageError('mime 无效');
  const mime = value.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  return mime || null;
}

function parsePurpose(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new StoredImageError('purpose 无效');
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text.length > 32) throw new StoredImageError('purpose 过长');
  // 同时作为磁盘子目录名，限制字符集
  if (!isSafeModuleDir(text)) throw new StoredImageError('purpose 无效');
  return text;
}

function parseOwners(
  input: { owner_table?: unknown; owner_id?: unknown; owner_field?: unknown },
  mode: 'optional' | 'required',
): { owner_table: string | null; owner_id: string | null; owner_field: string | null } {
  const owner_table = optionalBounded(input.owner_table, 'owner_table', 64);
  const owner_id = optionalBounded(input.owner_id, 'owner_id', 255);
  const owner_field = optionalBounded(input.owner_field, 'owner_field', 64);
  const filled = [owner_table, owner_id, owner_field].filter((item) => item != null).length;
  if (filled !== 0 && filled !== 3) {
    throw new StoredImageError('owner_table、owner_id、owner_field 必须同时提供或同时省略');
  }
  if (mode === 'required' && filled !== 3) {
    throw new StoredImageError('owner_table、owner_id、owner_field 必须同时提供');
  }
  return { owner_table, owner_id, owner_field };
}

function optionalBounded(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new StoredImageError(`${field} 无效`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new StoredImageError(`${field} 过长`);
  return text;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function requireId(value: unknown): string {
  const id = optionalText(value);
  if (!id) throw new StoredImageError('缺少图片 id');
  return id;
}
