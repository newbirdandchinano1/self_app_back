/**
 * 业务后端 → selfAPP_AIAgent 场景 AI（备忘点评等需落库前的分析）。
 * 纯场景推理已迁出；本模块仅保留「后端代调 Agent」的薄客户端。
 */

import { agentConfig } from '../config/index.js';

export class AgentAiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus = 502,
  ) {
    super(message);
    this.name = 'AgentAiError';
  }
}

type AgentEnvelope<T> = {
  code: number;
  message: string;
  data: T | null;
};

async function agentAiPost<T>(path: string, body: unknown): Promise<T> {
  const base = agentConfig.baseUrl.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': agentConfig.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(agentConfig.timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentAiError(`Agent 不可达：${message}`, 503);
  }

  let parsed: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new AgentAiError(
        `Agent 响应非 JSON：HTTP ${response.status}`,
        response.status >= 400 ? response.status : 502,
      );
    }
  }

  const envelope = parsed as AgentEnvelope<T> | null;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.code !== 'number' ||
    typeof envelope.message !== 'string'
  ) {
    throw new AgentAiError(`Agent 响应格式异常：HTTP ${response.status}`, 502);
  }

  if (!response.ok || envelope.code !== 0 || envelope.data == null) {
    throw new AgentAiError(
      envelope.message || `Agent AI 失败：HTTP ${response.status}`,
      response.status >= 400 ? response.status : 502,
    );
  }

  return envelope.data;
}

export async function agentAnalyzeMemoReview(memoContextText: string): Promise<{
  evaluation: string;
  suggestions: string;
}> {
  return agentAiPost('/api/v1/ai/memo/review', {
    memo_context_text: memoContextText,
  });
}
