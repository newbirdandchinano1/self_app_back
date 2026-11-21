/**
 * 和风天气（QWeather）客户端：调用官方 v1 API，整理成 App / Agent 可用的精简结构。
 * Key / Host 仅来自环境变量，不落响应。
 */

import { qweatherConfig } from '../../config/index.js';
import { ExternalApiError } from './errors.js';

export type WeatherLocation = {
  lat: number;
  lng: number;
  label: string | null;
};

export type WeatherNow = {
  time: string | null;
  text: string | null;
  icon: string | null;
  temp: number | null;
  feelsLike: number | null;
  humidityPct: number | null;
  windDir: string | null;
  windScale: number | null;
  windSpeed: number | null;
  precipMm: number | null;
  pressure: number | null;
  visibilityKm: number | null;
  uvIndex: number | null;
  cloudCoverPct: number | null;
};

export type WeatherDailyItem = {
  date: string | null;
  sunrise: string | null;
  sunset: string | null;
  tempMax: number | null;
  tempMin: number | null;
  textDay: string | null;
  iconDay: string | null;
  textNight: string | null;
  iconNight: string | null;
  precipMm: number | null;
  precipProb: number | null;
  uvIndexMax: number | null;
  humidityPct: number | null;
  windDir: string | null;
  windScale: number | null;
};

export type WeatherHourlyItem = {
  time: string | null;
  text: string | null;
  icon: string | null;
  temp: number | null;
  feelsLike: number | null;
  humidityPct: number | null;
  windDir: string | null;
  windScale: number | null;
  precipMm: number | null;
  precipProb: number | null;
  uvIndex: number | null;
};

export type WeatherAir = {
  aqi: number | null;
  aqiDisplay: string | null;
  level: string | null;
  category: string | null;
  primaryPollutant: string | null;
  healthEffect: string | null;
  adviceGeneral: string | null;
  adviceSensitive: string | null;
  pollutants: Array<{
    code: string;
    name: string;
    value: number | null;
    unit: string | null;
  }>;
};

export type WeatherSummary = {
  location: WeatherLocation;
  now: WeatherNow;
  daily: WeatherDailyItem[];
  hourly: WeatherHourlyItem[];
  air: WeatherAir;
};

type LocInput = { lat?: number; lng?: number; label?: string | null };

const COMPASS_ZH: Record<string, string> = {
  n: '北',
  nne: '东北偏北',
  ne: '东北',
  ene: '东北偏东',
  e: '东',
  ese: '东南偏东',
  se: '东南',
  sse: '东南偏南',
  s: '南',
  ssw: '西南偏南',
  sw: '西南',
  wsw: '西南偏西',
  w: '西',
  wnw: '西北偏西',
  nw: '西北',
  nnw: '西北偏北',
  vrb: '变向',
  none: '',
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function valueOf(obj: unknown): number | null {
  const r = asRecord(obj);
  return r ? num(r.value) : null;
}

function unitOf(obj: unknown): string | null {
  const r = asRecord(obj);
  return r ? str(r.unit) : null;
}

function pct01(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  return Math.round(n * 100);
}

function compassZh(code: unknown): string | null {
  const c = str(code)?.toLowerCase();
  if (!c) return null;
  return COMPASS_ZH[c] ?? c.toUpperCase();
}

function conditionText(obj: unknown): string | null {
  return str(asRecord(obj)?.text);
}

function conditionCode(obj: unknown): string | null {
  return str(asRecord(obj)?.code);
}

function dateOnly(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : iso;
}

function resolveLocation(input: LocInput = {}): WeatherLocation {
  const lat = input.lat ?? qweatherConfig.defaultLat;
  const lng = input.lng ?? qweatherConfig.defaultLng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new ExternalApiError('经纬度无效', 400);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new ExternalApiError('经纬度超出范围', 400);
  }
  const usingDefault =
    input.lat == null && input.lng == null;
  const label =
    input.label?.trim() ||
    (usingDefault ? qweatherConfig.defaultLabel : null);
  return {
    lat: Math.round(lat * 100) / 100,
    lng: Math.round(lng * 100) / 100,
    label,
  };
}

function assertConfigured(): void {
  if (!qweatherConfig.apiHost) {
    throw new ExternalApiError('未配置 QWEATHER_API_HOST', 503);
  }
  if (!qweatherConfig.apiKey) {
    throw new ExternalApiError('未配置 QWEATHER_API_KEY', 503);
  }
}

async function qweatherGet(path: string, query: Record<string, string | number | boolean> = {}): Promise<unknown> {
  assertConfigured();
  const url = new URL(`https://${qweatherConfig.apiHost}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-QW-Api-Key': qweatherConfig.apiKey,
      },
      signal: AbortSignal.timeout(qweatherConfig.timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExternalApiError(`和风天气不可达：${message}`, 503);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ExternalApiError(`和风天气响应非 JSON：HTTP ${response.status}`, 502);
    }
  }

  if (!response.ok) {
    const body = asRecord(parsed);
    const msg =
      str(body?.error) ||
      str(body?.message) ||
      str(body?.title) ||
      `和风天气请求失败：HTTP ${response.status}`;
    throw new ExternalApiError(msg, response.status >= 400 && response.status < 600 ? response.status : 502);
  }

  return parsed;
}

function mapNow(raw: unknown): WeatherNow {
  const o = asRecord(raw) ?? {};
  const wind = asRecord(o.wind);
  const precip = asRecord(o.precipitation);
  const vis = valueOf(o.visibility);
  return {
    time: str(o.validTime),
    text: conditionText(o.condition),
    icon: conditionCode(o.condition),
    temp: valueOf(o.temperature),
    feelsLike: valueOf(o.feelsLike),
    humidityPct: pct01(o.humidity),
    windDir: compassZh(asRecord(wind?.direction)?.compass),
    windScale: num(wind?.scale),
    windSpeed: valueOf(wind?.speed),
    precipMm: valueOf(precip?.amount),
    pressure: valueOf(o.pressure),
    visibilityKm: vis == null ? null : Math.round((vis / 1000) * 10) / 10,
    uvIndex: num(o.uvIndex),
    cloudCoverPct: pct01(o.cloudCover),
  };
}

function mapDailyItem(raw: unknown): WeatherDailyItem {
  const o = asRecord(raw) ?? {};
  const astro = asRecord(o.astro);
  const day = asRecord(o.daytime);
  const night = asRecord(o.nighttime);
  const dayPrecip = asRecord(day?.precipitation);
  const dayWind = asRecord(day?.wind);
  return {
    date: dateOnly(str(o.forecastStartTime)),
    sunrise: str(astro?.sunrise),
    sunset: str(astro?.sunset),
    tempMax: valueOf(o.temperatureMax),
    tempMin: valueOf(o.temperatureMin),
    textDay: conditionText(day?.condition),
    iconDay: conditionCode(day?.condition),
    textNight: conditionText(night?.condition),
    iconNight: conditionCode(night?.condition),
    precipMm: valueOf(dayPrecip?.amount),
    precipProb: num(dayPrecip?.probability),
    uvIndexMax: num(o.uvIndexMax),
    humidityPct: pct01(day?.humidity),
    windDir: compassZh(asRecord(dayWind?.direction)?.compass),
    windScale: num(dayWind?.scale),
  };
}

function mapHourlyItem(raw: unknown): WeatherHourlyItem {
  const o = asRecord(raw) ?? {};
  const wind = asRecord(o.wind);
  const precip = asRecord(o.precipitation);
  return {
    time: str(o.forecastTime),
    text: conditionText(o.condition),
    icon: conditionCode(o.condition),
    temp: valueOf(o.temperature),
    feelsLike: valueOf(o.feelsLike),
    humidityPct: pct01(o.humidity),
    windDir: compassZh(asRecord(wind?.direction)?.compass),
    windScale: num(wind?.scale),
    precipMm: valueOf(precip?.amount),
    precipProb: num(precip?.probability),
    uvIndex: num(o.uvIndex),
  };
}

function pickCnAqi(indexes: unknown[]): Record<string, unknown> | null {
  for (const item of indexes) {
    const r = asRecord(item);
    if (str(r?.code) === 'cn-mee') return r;
  }
  return asRecord(indexes[0]);
}

function mapAir(raw: unknown): WeatherAir {
  const o = asRecord(raw) ?? {};
  const index = pickCnAqi(asArray(o.indexes));
  const primary = asRecord(index?.primaryPollutant);
  const health = asRecord(index?.health);
  const advice = asRecord(health?.advice);
  const pollutants = asArray(o.pollutants).map((p) => {
    const pr = asRecord(p) ?? {};
    const conc = asRecord(pr.concentration);
    return {
      code: str(pr.code) || '',
      name: str(pr.name) || '',
      value: num(conc?.value),
      unit: str(conc?.unit) ?? unitOf(pr.concentration),
    };
  }).filter((p) => p.code);

  return {
    aqi: num(index?.aqi),
    aqiDisplay: str(index?.aqiDisplay),
    level: str(index?.level),
    category: str(index?.category),
    primaryPollutant: str(primary?.name) || str(primary?.fullName),
    healthEffect: str(health?.effect),
    adviceGeneral: str(advice?.generalPopulation),
    adviceSensitive: str(advice?.sensitivePopulation),
    pollutants,
  };
}

export async function getWeatherNow(input: LocInput = {}): Promise<{ location: WeatherLocation; now: WeatherNow }> {
  const location = resolveLocation(input);
  const raw = await qweatherGet(`/weather/v1/current/${location.lat}/${location.lng}`, {
    lang: 'zh',
    localTime: true,
  });
  return { location, now: mapNow(raw) };
}

export async function getWeatherDaily(
  input: LocInput & { days?: number } = {},
): Promise<{ location: WeatherLocation; days: WeatherDailyItem[] }> {
  const location = resolveLocation(input);
  const days = Math.min(10, Math.max(1, Math.floor(input.days ?? 7)));
  const raw = await qweatherGet(`/weather/v1/daily/${location.lat}/${location.lng}`, {
    days,
    lang: 'zh',
    localTime: true,
  });
  const list = asArray(asRecord(raw)?.days).map(mapDailyItem);
  return { location, days: list };
}

export async function getWeatherHourly(
  input: LocInput & { hours?: number } = {},
): Promise<{ location: WeatherLocation; hours: WeatherHourlyItem[] }> {
  const location = resolveLocation(input);
  const hours = Math.min(240, Math.max(1, Math.floor(input.hours ?? 24)));
  const raw = await qweatherGet(`/weather/v1/hourly/${location.lat}/${location.lng}`, {
    hours,
    lang: 'zh',
    localTime: true,
  });
  const list = asArray(asRecord(raw)?.hours).map(mapHourlyItem);
  return { location, hours: list };
}

export async function getWeatherAir(input: LocInput = {}): Promise<{ location: WeatherLocation; air: WeatherAir }> {
  const location = resolveLocation(input);
  const raw = await qweatherGet(`/airquality/v1/current/${location.lat}/${location.lng}`, {
    lang: 'zh',
  });
  return { location, air: mapAir(raw) };
}

export async function getWeatherSummary(
  input: LocInput & { days?: number; hours?: number } = {},
): Promise<WeatherSummary> {
  const location = resolveLocation(input);
  const [nowRes, dailyRes, hourlyRes, airRes] = await Promise.all([
    getWeatherNow(location),
    getWeatherDaily({ ...location, days: input.days }),
    getWeatherHourly({ ...location, hours: input.hours }),
    getWeatherAir(location),
  ]);
  return {
    location,
    now: nowRes.now,
    daily: dailyRes.days,
    hourly: hourlyRes.hours,
    air: airRes.air,
  };
}
