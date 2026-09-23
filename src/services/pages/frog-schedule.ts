import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';

const AXIS_SETTING_KEY = '@selfapp/frog_schedule_axis_v1';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FrogScheduleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FrogScheduleError';
    this.status = status;
  }
}

type AxisRow = {
  startMinutes: number;
  endMinutes: number;
  slotHours: number;
  updatedAt?: string;
};

function parseAxisJson(raw: unknown): AxisRow {
  const defaults = { startMinutes: 8 * 60, endMinutes: 22 * 60, slotHours: 2 };
  if (raw == null) return defaults;
  try {
    const o = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
    const startMinutes = Number(o.startMinutes ?? defaults.startMinutes);
    const endMinutes = Number(o.endMinutes ?? defaults.endMinutes);
    const slotHours = Number(o.slotHours ?? defaults.slotHours);
    return {
      startMinutes: Number.isFinite(startMinutes) ? startMinutes : defaults.startMinutes,
      endMinutes: Number.isFinite(endMinutes) ? endMinutes : defaults.endMinutes,
      slotHours: slotHours === 1 || slotHours === 2 || slotHours === 3 || slotHours === 4 ? slotHours : 2,
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
    };
  } catch {
    return defaults;
  }
}

async function getGlobalAxis(): Promise<AxisRow> {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT value_json FROM app_settings WHERE `key` = ? LIMIT 1',
    [AXIS_SETTING_KEY],
  );
  return parseAxisJson(rows[0]?.value_json);
}

async function getWeekSnapshot(weekStartYmd: string): Promise<AxisRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT start_minutes, end_minutes, slot_hours FROM schedule_week_axis_snapshot
     WHERE week_start_ymd = ? LIMIT 1`,
    [weekStartYmd],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    startMinutes: Number(r.start_minutes),
    endMinutes: Number(r.end_minutes),
    slotHours: Number(r.slot_hours),
  };
}

function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d!, 12, 0, 0);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export async function getFrogScheduleWeek(params: {
  weekStartYmd: string;
  logicalTodayYmd?: string;
}) {
  const weekStartYmd = params.weekStartYmd?.trim();
  if (!YMD_RE.test(weekStartYmd)) {
    throw new FrogScheduleError('weekStartYmd 无效');
  }

  const logicalToday = params.logicalTodayYmd && YMD_RE.test(params.logicalTodayYmd)
    ? params.logicalTodayYmd
    : new Date().toISOString().slice(0, 10);
  const thisMonday = mondayOf(logicalToday);
  const isHistorical = weekStartYmd < thisMonday;

  let axis = await getGlobalAxis();
  let fromSnapshot = false;
  if (isHistorical) {
    const snap = await getWeekSnapshot(weekStartYmd);
    if (snap) {
      axis = snap;
      fromSnapshot = true;
    } else {
      const now = new Date().toISOString();
      await db.query<ResultSetHeader>(
        `INSERT IGNORE INTO schedule_week_axis_snapshot
          (week_start_ymd, start_minutes, end_minutes, slot_hours, created_at, sync_status)
         VALUES (?, ?, ?, ?, ?, 'synced')`,
        [weekStartYmd, axis.startMinutes, axis.endMinutes, axis.slotHours, now],
      );
      fromSnapshot = true;
    }
  }

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, week_start_ymd, weekday, start_slot_index, span_slots,
            subject_kind, subject_id, orphaned, created_at, updated_at, sync_status
     FROM schedule_placements
     WHERE week_start_ymd = ? AND sync_status != 'pending_delete'
     ORDER BY weekday ASC, orphaned ASC, start_slot_index ASC`,
    [weekStartYmd],
  );

  return {
    weekStartYmd,
    axis: {
      startMinutes: axis.startMinutes,
      endMinutes: axis.endMinutes,
      slotHours: axis.slotHours,
      fromSnapshot,
    },
    placements: rows.map((r) => ({
      id: String(r.id),
      weekStartYmd: String(r.week_start_ymd),
      weekday: Number(r.weekday),
      startSlotIndex: r.start_slot_index == null ? null : Number(r.start_slot_index),
      spanSlots: Number(r.span_slots) || 1,
      subjectKind: r.subject_kind === 'project' ? 'project' : 'task',
      subjectId: String(r.subject_id),
      orphaned: Number(r.orphaned) ? 1 : 0,
    })),
  };
}

export async function saveFrogScheduleAxis(body: {
  startMinutes: number;
  endMinutes: number;
  slotHours: number;
  updatedAt?: string;
}) {
  const startMinutes = Math.round(Number(body.startMinutes));
  const endMinutes = Math.round(Number(body.endMinutes));
  const slotHours = Number(body.slotHours);
  if (![1, 2, 3, 4].includes(slotHours)) {
    throw new FrogScheduleError('格宽仅允许 1–4 小时');
  }
  if (!(endMinutes > startMinutes)) {
    throw new FrogScheduleError('日结束时间必须晚于日开始时间');
  }
  const payload = JSON.stringify({
    startMinutes,
    endMinutes,
    slotHours,
    updatedAt: body.updatedAt || new Date().toISOString(),
  });
  const now = new Date().toISOString();
  await db.query<ResultSetHeader>(
    `INSERT INTO app_settings (\`key\`, value_json, updated_at, sync_status)
     VALUES (?, ?, ?, 'synced')
     ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at), sync_status = 'synced'`,
    [AXIS_SETTING_KEY, payload, now],
  );
  return { startMinutes, endMinutes, slotHours, updatedAt: now };
}

export async function upsertFrogSchedulePlacement(body: {
  id: string;
  weekStartYmd: string;
  weekday: number;
  startSlotIndex: number | null;
  spanSlots: number;
  subjectKind: 'task' | 'project';
  subjectId: string;
  orphaned?: number;
  createdAt?: string;
  updatedAt?: string;
}) {
  if (!body.id || !YMD_RE.test(body.weekStartYmd)) {
    throw new FrogScheduleError('placement 参数无效');
  }
  const now = new Date().toISOString();
  await db.query<ResultSetHeader>(
    `INSERT INTO schedule_placements (
      id, week_start_ymd, weekday, start_slot_index, span_slots,
      subject_kind, subject_id, orphaned, created_at, updated_at, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
    ON DUPLICATE KEY UPDATE
      week_start_ymd = VALUES(week_start_ymd),
      weekday = VALUES(weekday),
      start_slot_index = VALUES(start_slot_index),
      span_slots = VALUES(span_slots),
      subject_kind = VALUES(subject_kind),
      subject_id = VALUES(subject_id),
      orphaned = VALUES(orphaned),
      updated_at = VALUES(updated_at),
      sync_status = 'synced'`,
    [
      body.id,
      body.weekStartYmd,
      body.weekday,
      body.startSlotIndex,
      Math.max(1, body.spanSlots || 1),
      body.subjectKind,
      body.subjectId,
      body.orphaned ? 1 : 0,
      body.createdAt || now,
      body.updatedAt || now,
    ],
  );
  return { id: body.id };
}

export async function deleteFrogSchedulePlacement(id: string) {
  if (!id) throw new FrogScheduleError('id 无效');
  await db.query<ResultSetHeader>(`DELETE FROM schedule_placements WHERE id = ?`, [id]);
  return { id };
}
