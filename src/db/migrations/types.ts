export type Migration = {
  /** 稳定版本号，写入 schema_migrations；勿改已发布 id */
  id: string;
  up: () => Promise<void>;
};
