/** 外部 API 网关领域错误 */
export class ExternalApiError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'ExternalApiError';
  }
}
