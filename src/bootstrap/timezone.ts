import { APP_TIME_ZONE } from '../config/timezone.js';

/**
 * 进程级时区：必须在任何 Date 逻辑之前加载（见 src/index.ts 首行 import）。
 * Docker / compose 亦应设置 TZ=Asia/Shanghai；此处兜底本地开发未配置的情况。
 */
if (!process.env.TZ) {
  process.env.TZ = APP_TIME_ZONE;
}
