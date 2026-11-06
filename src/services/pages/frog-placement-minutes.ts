/**
 * 阶段 E：schedule_placements 分钟字段解析 / 校验（无 DB 依赖，可供自测）
 *
 * - 旧客户端不传字段 → present=false → UPDATE 时保留库内原值
 * - 显式 null → 可写入 NULL
 * - 半开区间：若起止均有限，要求 end > start
 */

export type OptionalNullableInt = {
  present: boolean;
  value: number | null;
};

export function parseOptionalNullableInt(
  obj: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): OptionalNullableInt {
  const hasCamel = Object.prototype.hasOwnProperty.call(obj, camelKey);
  const hasSnake = Object.prototype.hasOwnProperty.call(obj, snakeKey);
  if (!hasCamel && !hasSnake) {
    return { present: false, value: null };
  }
  const raw = hasCamel ? obj[camelKey] : obj[snakeKey];
  if (raw == null || raw === '') {
    return { present: true, value: null };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return { present: true, value: null };
  }
  return { present: true, value: Math.trunc(n) };
}

export function parsePlacementMinuteFields(p: Record<string, unknown>): {
  startMinutes: OptionalNullableInt;
  endMinutes: OptionalNullableInt;
  allDay: OptionalNullableInt;
} {
  return {
    startMinutes: parseOptionalNullableInt(p, 'startMinutes', 'start_minutes'),
    endMinutes: parseOptionalNullableInt(p, 'endMinutes', 'end_minutes'),
    allDay: parseOptionalNullableInt(p, 'allDay', 'all_day'),
  };
}

/** 起止均有限时校验半开；缺一边或全 null 放行（兼容旧客户端） */
export function assertPlacementMinutePair(
  startMinutes: number | null,
  endMinutes: number | null,
): void {
  if (startMinutes == null || endMinutes == null) return;
  if (!(endMinutes > startMinutes)) {
    throw new Error('结束分钟必须大于开始分钟（半开区间）');
  }
}

/**
 * 映射 GET 行 → API 字段（缺列/NULL → null，旧库热更新前也安全）
 * 接受普通对象或 mysql2 RowDataPacket（仅含可选字段时会被 TS 判为 weak type 而拒绝 RowDataPacket）
 */
export function mapPlacementMinutesFromDbRow(row: {
  start_minutes?: unknown;
  end_minutes?: unknown;
  all_day?: unknown;
  [key: string]: unknown;
}): {
  startMinutes: number | null;
  endMinutes: number | null;
  allDay: number | null;
} {
  const asInt = (raw: unknown): number | null => {
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  return {
    startMinutes: asInt(row.start_minutes),
    endMinutes: asInt(row.end_minutes),
    allDay: asInt(row.all_day),
  };
}
