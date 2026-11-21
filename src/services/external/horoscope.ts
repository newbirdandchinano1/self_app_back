/**
 * 万维易源 ShowAPI 星座运势（872-1）。
 * day 始终返回；tomorrow/week/month/year 需 needX=1。
 * Key 仅来自环境变量，不落响应。
 */

import { showapiConfig } from '../../config/index.js';
import { ExternalApiError } from './errors.js';

export type HoroscopeScope = 'day' | 'tomorrow' | 'week' | 'month' | 'year';

export type HoroscopeSign = {
  code: string;
  name: string;
};

/** 日 / 明日共用精简结构 */
export type HoroscopeDayLike = {
  time: string | null;
  summaryStar: number | null;
  loveStar: number | null;
  workStar: number | null;
  moneyStar: number | null;
  luckyNum: string | null;
  luckyColor: string | null;
  luckyDirection: string | null;
  luckyTime: string | null;
  notice: string | null;
  nobleSign: string | null;
  general: string | null;
  love: string | null;
  work: string | null;
  money: string | null;
};

export type HoroscopeWeek = HoroscopeDayLike & {
  luckyDay: string | null;
  rivalSign: string | null;
  weekNotice: string | null;
  health: string | null;
};

export type HoroscopeMonth = HoroscopeDayLike & {
  matchSign: string | null;
  rivalSign: string | null;
  advantage: string | null;
  weakness: string | null;
};

export type HoroscopeYear = {
  time: string | null;
  oneword: string | null;
  generalIndex: number | null;
  loveIndex: number | null;
  workIndex: number | null;
  moneyIndex: number | null;
  general: string | null;
  love: string | null;
  work: string | null;
  money: string | null;
  health: string | null;
};

export type HoroscopeResult = {
  sign: HoroscopeSign;
  day: HoroscopeDayLike | null;
  tomorrow: HoroscopeDayLike | null;
  week: HoroscopeWeek | null;
  month: HoroscopeMonth | null;
  year: HoroscopeYear | null;
};

const SIGNS: HoroscopeSign[] = [
  { code: 'baiyang', name: '白羊座' },
  { code: 'jinniu', name: '金牛座' },
  { code: 'shuangzi', name: '双子座' },
  { code: 'juxie', name: '巨蟹座' },
  { code: 'shizi', name: '狮子座' },
  { code: 'chunv', name: '处女座' },
  { code: 'tiancheng', name: '天秤座' },
  { code: 'tianxie', name: '天蝎座' },
  { code: 'sheshou', name: '射手座' },
  { code: 'mojie', name: '摩羯座' },
  { code: 'shuiping', name: '水瓶座' },
  { code: 'shuangyu', name: '双鱼座' },
];

const CODE_BY_ALIAS = new Map<string, string>();
for (const s of SIGNS) {
  CODE_BY_ALIAS.set(s.code, s.code);
  CODE_BY_ALIAS.set(s.name, s.code);
  CODE_BY_ALIAS.set(s.name.replace(/座$/, ''), s.code);
}

const ALL_SCOPES: HoroscopeScope[] = ['day', 'tomorrow', 'week', 'month', 'year'];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/分/g, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function assertConfigured(): void {
  if (!showapiConfig.appKey) {
    throw new ExternalApiError('未配置 SHOWAPI_APP_KEY', 503);
  }
}

export function listHoroscopeSigns(): HoroscopeSign[] {
  return SIGNS.map((s) => ({ ...s }));
}

export function resolveHoroscopeStar(input: string | null | undefined): HoroscopeSign {
  const raw = input?.trim();
  if (!raw) {
    throw new ExternalApiError('请传 star（如 shuiping / 水瓶座）', 400);
  }
  const code = CODE_BY_ALIAS.get(raw) ?? CODE_BY_ALIAS.get(raw.toLowerCase());
  if (!code) {
    throw new ExternalApiError(
      `不支持的星座：${raw}（可用拼音码或中文名，如 shuiping / 水瓶座）`,
      400,
    );
  }
  const sign = SIGNS.find((s) => s.code === code)!;
  return { ...sign };
}

/** scopes=all|day,tomorrow,week…；默认 all */
export function parseHoroscopeScopes(raw: unknown): HoroscopeScope[] {
  if (raw == null || raw === '') return [...ALL_SCOPES];
  if (typeof raw !== 'string') return [...ALL_SCOPES];
  const text = raw.trim().toLowerCase();
  if (!text || text === 'all') return [...ALL_SCOPES];
  const parts = text.split(/[,|+\s]+/).map((p) => p.trim()).filter(Boolean);
  const out: HoroscopeScope[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (!(ALL_SCOPES as string[]).includes(p)) {
      throw new ExternalApiError(
        `不支持的 scopes：${p}（可用 day,tomorrow,week,month,year,all）`,
        400,
      );
    }
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p as HoroscopeScope);
  }
  if (!out.includes('day')) out.unshift('day');
  return out;
}

function mapDayLike(raw: unknown): HoroscopeDayLike | null {
  const o = asRecord(raw);
  if (!o) return null;
  return {
    time: str(o.time),
    summaryStar: num(o.summary_star),
    loveStar: num(o.love_star),
    workStar: num(o.work_star),
    moneyStar: num(o.money_star),
    luckyNum: str(o.lucky_num),
    luckyColor: str(o.lucky_color),
    luckyDirection: str(o.lucky_direction),
    luckyTime: str(o.lucky_time),
    notice: str(o.day_notice),
    nobleSign: str(o.grxz),
    general: str(o.general_txt),
    love: str(o.love_txt),
    work: str(o.work_txt),
    money: str(o.money_txt),
  };
}

function mapWeek(raw: unknown): HoroscopeWeek | null {
  const base = mapDayLike(raw);
  const o = asRecord(raw);
  if (!base || !o) return null;
  return {
    ...base,
    luckyDay: str(o.lucky_day),
    rivalSign: str(o.xrxz),
    weekNotice: str(o.week_notice),
    health: str(o.health_txt),
  };
}

function mapMonth(raw: unknown): HoroscopeMonth | null {
  const base = mapDayLike(raw);
  const o = asRecord(raw);
  if (!base || !o) return null;
  return {
    ...base,
    matchSign: str(o.yfxz),
    rivalSign: str(o.xrxz),
    advantage: str(o.month_advantage),
    weakness: str(o.month_weakness),
  };
}

function mapYear(raw: unknown): HoroscopeYear | null {
  const o = asRecord(raw);
  if (!o) return null;
  return {
    time: str(o.time),
    oneword: str(o.oneword),
    generalIndex: num(o.general_index),
    loveIndex: num(o.love_index),
    workIndex: num(o.work_index),
    moneyIndex: num(o.money_index),
    general: str(o.general_txt),
    love: str(o.love_txt),
    work: str(o.work_txt),
    money: str(o.money_txt),
    health: str(o.health_txt),
  };
}

async function showapiGet(path: string, query: Record<string, string>): Promise<unknown> {
  assertConfigured();
  const url = new URL(
    `${showapiConfig.baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
  );
  url.searchParams.set('appKey', showapiConfig.appKey);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(showapiConfig.timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExternalApiError(`星座运势服务不可达：${message}`, 503);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ExternalApiError(`星座运势响应非 JSON：HTTP ${response.status}`, 502);
    }
  }

  if (!response.ok) {
    throw new ExternalApiError(
      `星座运势请求失败：HTTP ${response.status}`,
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }

  return parsed;
}

export async function getHoroscope(opts: {
  star: string;
  scopes?: HoroscopeScope[];
  /** MMdd；无 star 时上游可用，本服务仍要求 star */
  date?: string;
}): Promise<HoroscopeResult> {
  const sign = resolveHoroscopeStar(opts.star);
  const scopes = opts.scopes?.length ? opts.scopes : [...ALL_SCOPES];

  const query: Record<string, string> = { star: sign.code };
  if (opts.date?.trim()) query.date = opts.date.trim();
  if (scopes.includes('tomorrow')) query.needTomorrow = '1';
  if (scopes.includes('week')) query.needWeek = '1';
  if (scopes.includes('month')) query.needMonth = '1';
  if (scopes.includes('year')) query.needYear = '1';

  const envelope = asRecord(await showapiGet(showapiConfig.horoscopePath, query)) ?? {};
  const sysCode = num(envelope.showapi_res_code);
  if (sysCode !== 0) {
    throw new ExternalApiError(
      str(envelope.showapi_res_error) || `星座运势系统错误：code=${sysCode ?? '?'}`,
      502,
    );
  }

  const body = asRecord(envelope.showapi_res_body) ?? {};
  const ret = num(body.ret_code);
  if (ret !== 0) {
    throw new ExternalApiError(str(body.remark) || `星座运势业务错误：ret_code=${ret ?? '?'}`, 400);
  }

  const want = new Set(scopes);
  return {
    sign,
    day: want.has('day') ? mapDayLike(body.day) : null,
    tomorrow: want.has('tomorrow') ? mapDayLike(body.tomorrow) : null,
    week: want.has('week') ? mapWeek(body.week) : null,
    month: want.has('month') ? mapMonth(body.month) : null,
    year: want.has('year') ? mapYear(body.year) : null,
  };
}
