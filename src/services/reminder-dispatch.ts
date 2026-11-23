/**
 * 到点派发：先写 reminder_inbox，再 Expo Push，再标 job sent。
 * 强提醒：主波派发后插入 +5 / +15 分钟 follow-up job。
 */

import {
  deletePushToken,
  listPushTokensForUser,
} from './device-push-tokens.js';
import {
  formatJobFireAtIso,
  insertFollowUpReminderJob,
  listDueReminderJobs,
  markReminderJobStatus,
  type DueReminderJobRow,
} from './reminder-jobs.js';
import { upsertReminderInboxFromDispatch } from './reminder-inbox.js';

const STRONG_ESCALATION_OFFSET_MINUTES = [5, 15] as const;
const DISPATCH_BATCH = 40;

function parsePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

async function sendExpoPush(params: {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, unknown>;
  strong: boolean;
}): Promise<void> {
  if (params.tokens.length === 0) return;

  const messages = params.tokens.map(to => ({
    to,
    title: params.title,
    body: params.body,
    data: params.data,
    sound: 'default' as const,
    priority: 'high' as const,
    ...(params.strong
      ? {
          // iOS Time Sensitive 需 entitlement；无权限时 Expo 会降级
          interruptionLevel: 'timeSensitive' as const,
        }
      : {}),
    channelId:
      typeof params.data.channelId === 'string' && params.data.channelId
        ? params.data.channelId
        : undefined,
  }));

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: Array<{ status?: string; details?: { error?: string }; message?: string }>;
    } | null;
    const results = Array.isArray(json?.data) ? json.data : [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
        const token = params.tokens[i];
        if (token) {
          void deletePushToken(token).catch(() => undefined);
        }
      }
    }
  } catch (e) {
    console.warn('[reminder-dispatch] Expo Push 失败', e);
  }
}

async function maybeEnqueueEscalations(job: DueReminderJobRow, payload: Record<string, unknown>): Promise<void> {
  if (!job.strong) return;
  const wave = Number(payload.escalationWave ?? 0);
  if (!Number.isFinite(wave) || wave > 0) return; // 仅主波挂升级链

  const baseMs = Date.parse(formatJobFireAtIso(job.fire_at));
  const originMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  const now = Date.now();

  for (let i = 0; i < STRONG_ESCALATION_OFFSET_MINUTES.length; i++) {
    const offsetMin = STRONG_ESCALATION_OFFSET_MINUTES[i]!;
    const nextWave = i + 1;
    const fireAt = new Date(originMs + offsetMin * 60_000);
    if (fireAt.getTime() <= now + 2000) continue;
    const escBody =
      typeof payload.disposeBody === 'string' && payload.disposeBody
        ? `还没处理：${payload.disposeBody}`
        : `还没处理：${job.body || job.title}`;
    await insertFollowUpReminderJob({
      userId: job.user_id,
      dedupeKey: job.dedupe_key,
      category: job.category,
      fireAt,
      title: job.title,
      body: escBody,
      strong: true,
      payload: {
        ...payload,
        escalationWave: nextWave,
        disposeBody: escBody,
        baseIdentifier: job.dedupe_key,
        strong: true,
      },
    });
  }
}

export async function dispatchDueReminderJobs(): Promise<{
  processed: number;
  inboxWritten: number;
  pushed: number;
}> {
  const due = await listDueReminderJobs(DISPATCH_BATCH);
  let inboxWritten = 0;
  let pushed = 0;

  for (const job of due) {
    const payload = parsePayload(job.payload_json);
    const data: Record<string, unknown> = {
      ...payload,
      type: payload.type ?? job.category,
      category: job.category,
      baseIdentifier: job.dedupe_key,
      dedupeKey: job.dedupe_key,
      strong: Boolean(job.strong) || payload.strong === true,
    };

    try {
      const row = await upsertReminderInboxFromDispatch({
        userId: job.user_id,
        dedupeKey: job.dedupe_key,
        category: job.category,
        title: job.title,
        body: job.body,
        payload: data,
      });
      if (row) inboxWritten += 1;

      const tokens = await listPushTokensForUser(job.user_id);
      if (tokens.length > 0) {
        await sendExpoPush({
          tokens,
          title: job.title,
          body: job.body,
          data,
          strong: Boolean(job.strong),
        });
        pushed += 1;
      }

      await maybeEnqueueEscalations(job, data);
      await markReminderJobStatus(job.id, 'sent');
    } catch (e) {
      console.warn('[reminder-dispatch] job 失败', job.id, e);
    }
  }

  return { processed: due.length, inboxWritten, pushed };
}

const DEFAULT_INTERVAL_MS = 45_000;
const DEFAULT_FIRST_DELAY_MS = 15_000;

let dispatchTimer: ReturnType<typeof setInterval> | null = null;
let dispatchStarted = false;

export function startReminderDispatchScheduler(opts?: {
  intervalMs?: number;
  firstDelayMs?: number;
}): void {
  if (dispatchStarted) return;
  dispatchStarted = true;

  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const firstDelayMs = opts?.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS;

  const run = () => {
    void dispatchDueReminderJobs().catch(err => {
      console.warn('[reminder-dispatch] 调度失败', err);
    });
  };

  setTimeout(run, firstDelayMs);
  dispatchTimer = setInterval(run, intervalMs);
  if (dispatchTimer && typeof dispatchTimer === 'object' && 'unref' in dispatchTimer) {
    dispatchTimer.unref();
  }
  console.log(
    `[reminder-dispatch] 已调度：首跑 ${firstDelayMs}ms 后，此后每 ${intervalMs}ms`,
  );
}

/** 测试用 */
export function stopReminderDispatchSchedulerForTests(): void {
  if (dispatchTimer) {
    clearInterval(dispatchTimer);
    dispatchTimer = null;
  }
  dispatchStarted = false;
}
