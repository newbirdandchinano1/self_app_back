/**
 * Agent 只读资料快照：完整度缺口、画像/身体字段摘要（不含密码等敏感凭证）。
 * 挂载：GET /api/app/agent/snapshot/profile
 */
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/index.js';
import { formatLocalYmdFromDate } from '../calendar/logical-day.js';

export class ProfileSnapshotError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ProfileSnapshotError';
  }
}

export type AgentProfileSnapshotParams = {
  /** 预留；资料完整度不依赖日界 */
  logicalToday?: string;
};

const ACTIVE_SQL = `(deleted_at IS NULL OR deleted_at = '') AND (sync_status IS NULL OR sync_status != 'pending_delete')`;

type FillChipKey = 'persona' | 'dietary' | 'birthday' | 'body';

function asNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function trimStr(v: unknown, max = 200): string {
  return String(v ?? '')
    .trim()
    .slice(0, max);
}

function oneLiner(portrait: string, max = 80): string | null {
  const s = portrait.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

async function loadPrimaryUser(): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, name, gender, lifestyle, goal, birthday, height, weight, age,
            persona_portrait, avatar_uri, workout_days, rest_days
     FROM users
     WHERE ${ACTIVE_SQL}
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function getAgentProfileSnapshot(_params: AgentProfileSnapshotParams = {}) {
  const today = formatLocalYmdFromDate(new Date());
  const user = await loadPrimaryUser();

  if (!user) {
    return {
      domain: 'profile',
      today_ymd: today,
      has_user: false,
      completeness_percent: 0,
      filled_count: 0,
      total_count: 4,
      missing_count: 4,
      fill_chips: [
        { key: 'persona' as FillChipKey, label: '人物画像', filled: false },
        { key: 'birthday' as FillChipKey, label: '生日', filled: false },
        { key: 'body' as FillChipKey, label: '身高体重', filled: false },
        { key: 'dietary' as FillChipKey, label: '饮食偏好', filled: false, note: '客户端本地；后端不可见' },
      ],
      completeness: [
        { key: 'birthday', label: '生日', filled: false },
        { key: 'height', label: '身高', filled: false },
        { key: 'weight', label: '体重', filled: false },
        { key: 'persona', label: '人物画像', filled: false },
      ],
      archive: null,
      note: '无 users 行；资料缺口按全缺返回。饮食偏好在客户端本地，需 brief 或页内查看。',
    };
  }

  const birthday = trimStr(user.birthday, 32);
  const height = asNum(user.height);
  const weight = asNum(user.weight);
  const persona = trimStr(user.persona_portrait, 500);
  const birthdayFilled = Boolean(birthday);
  const heightFilled = height > 0;
  const weightFilled = weight > 0;
  const bodyFilled = heightFilled && weightFilled;
  const personaFilled = Boolean(persona);

  // 饮食偏好仅 App 本地设置，后端不权威；芯片标未填以免误导「已齐」
  const dietaryFilled = false;

  const fillChips = [
    { key: 'persona' as FillChipKey, label: '人物画像', filled: personaFilled },
    {
      key: 'dietary' as FillChipKey,
      label: '饮食偏好',
      filled: dietaryFilled,
      note: '客户端本地；后端不可见，以页内/brief 为准',
    },
    { key: 'birthday' as FillChipKey, label: '生日', filled: birthdayFilled },
    { key: 'body' as FillChipKey, label: '身高体重', filled: bodyFilled },
  ];

  const completeness = [
    { key: 'birthday', label: '生日', filled: birthdayFilled },
    { key: 'height', label: '身高', filled: heightFilled },
    { key: 'weight', label: '体重', filled: weightFilled },
    { key: 'persona', label: '人物画像', filled: personaFilled },
  ];

  // 完整度口径对齐 App：生日/身高/体重/画像/饮食 共 5 项；饮食后端恒未填
  const completenessItems = [
    ...completeness,
    { key: 'dietary', label: '饮食偏好', filled: dietaryFilled },
  ];
  const filledCount = completenessItems.filter((c) => c.filled).length;
  const totalCount = completenessItems.length;
  const completenessPercent =
    totalCount === 0 ? 0 : Math.round((filledCount / totalCount) * 100);

  const lifestyle = trimStr(user.lifestyle, 40);
  const goal = trimStr(user.goal, 20);

  return {
    domain: 'profile',
    today_ymd: today,
    has_user: true,
    completeness_percent: completenessPercent,
    filled_count: filledCount,
    total_count: totalCount,
    missing_count: Math.max(0, totalCount - filledCount),
    fill_chips: fillChips,
    completeness: completenessItems,
    filled_summary: {
      persona: personaFilled,
      birthday: birthdayFilled,
      body: bodyFilled,
      dietary: dietaryFilled,
      lifestyle: lifestyle || null,
      goal: goal || null,
    },
    archive: {
      name: trimStr(user.name, 40) || null,
      gender: trimStr(user.gender, 8) || null,
      lifestyle: lifestyle || null,
      goal: goal || null,
      birthday: birthday || null,
      height_cm: heightFilled ? height : null,
      weight_kg: weightFilled ? weight : null,
      age: asNum(user.age) || null,
      persona_filled: personaFilled,
      persona_char_count: persona.length,
      persona_one_liner: oneLiner(persona),
      // 不回传完整画像正文，避免对话泄露过长隐私文案；草稿润色由客户端/brief 提供
      has_avatar: Boolean(trimStr(user.avatar_uri, 8)),
      workout_days: trimStr(user.workout_days, 40) || null,
      rest_days: trimStr(user.rest_days, 40) || null,
    },
    note:
      '资料只读摘要。饮食偏好在客户端本地。改资料须用户打开资料编辑页确认；助手不写库。',
  };
}
