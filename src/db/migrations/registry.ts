import { ensureDropDeletedAtVersion } from '../ensure-drop-deleted-at-version.js';
import { ensureDropEarnedRewards } from '../ensure-drop-earned-rewards.js';
import { ensureDropProfileFeatures } from '../ensure-drop-profile-features.js';
import { ensureFrogScheduleTables } from '../ensure-frog-schedule.js';
import { ensureHealthDropUserId } from '../ensure-health-drop-user-id.js';
import { ensureMemosBodyMediumText } from '../ensure-memos-body-mediumtext.js';
import { ensureMemosPinnedColumn } from '../ensure-memos-pinned.js';
import { ensurePointsTables } from '../ensure-points.js';
import { ensureProjectTagsTables } from '../ensure-project-tags.js';
import { ensureProjectsPriorityColumn } from '../ensure-projects-priority.js';
import { ensureSyncChangeLogTable } from '../ensure-sync-change-log.js';
import { ensureSyncRevisionSchema } from '../ensure-sync-revision.js';
import { ensureUsersPersonaPortraitColumn } from '../ensure-users-persona-portrait.js';
import { ensureWishBoardTables } from '../ensure-wish-board.js';
import { ensureLifeRoadTables } from '../ensure-life-road.js';
import { ensureLifeRoadNodesTables } from '../ensure-life-road-nodes.js';
import { ensureTrendRadarSyncColumns, ensureTrendRadarTables } from '../ensure-trendradar.js';
import { ensureAppInboxTable } from '../ensure-app-inbox.js';
import { ensureStoredImagesTable } from '../ensure-stored-images.js';
import { ensureWishBoardDescriptionText } from '../ensure-wish-board-description-text.js';
import { ensureWardrobeTables } from '../ensure-wardrobe.js';
import { ensureRecipeCookStatsColumns } from '../ensure-recipe-cook-stats.js';
import type { Migration } from './types.js';

/**
 * 有序迁移清单。新 schema 变更只追加条目，勿改已有 id。
 * 实现仍放在 ensure-*（CRUD 热补丁可复用 tags / frog）。
 */
export const MIGRATIONS: readonly Migration[] = [
  { id: '001_drop_deleted_at_version', up: ensureDropDeletedAtVersion },
  { id: '002_projects_priority', up: ensureProjectsPriorityColumn },
  { id: '003_memos_pinned', up: ensureMemosPinnedColumn },
  { id: '004_users_persona_portrait', up: ensureUsersPersonaPortraitColumn },
  { id: '005_drop_profile_features', up: ensureDropProfileFeatures },
  { id: '006_drop_earned_rewards', up: ensureDropEarnedRewards },
  { id: '007_health_drop_user_id', up: ensureHealthDropUserId },
  { id: '008_points_tables', up: ensurePointsTables },
  { id: '009_wish_board_tables', up: ensureWishBoardTables },
  { id: '010_project_tags', up: ensureProjectTagsTables },
  { id: '011_frog_schedule', up: ensureFrogScheduleTables },
  { id: '012_sync_change_log', up: ensureSyncChangeLogTable },
  { id: '013_sync_revision', up: ensureSyncRevisionSchema },
  { id: '014_life_road', up: ensureLifeRoadTables },
  { id: '015_memos_body_mediumtext', up: ensureMemosBodyMediumText },
  { id: '016_app_inbox', up: ensureAppInboxTable },
  { id: '017_stored_images', up: ensureStoredImagesTable },
  { id: '018_wish_board_description_text', up: ensureWishBoardDescriptionText },
  { id: '019_wardrobe', up: ensureWardrobeTables },
  /** 补齐文档 §3.8/3.9；019 已跑过的环境靠本条幂等补表 */
  { id: '020_wardrobe_option_body', up: ensureWardrobeTables },
  { id: '021_life_road_nodes', up: ensureLifeRoadNodesTables },
  { id: '022_trendradar', up: ensureTrendRadarTables },
  { id: '023_trendradar_sync_columns', up: ensureTrendRadarSyncColumns },
  { id: '024_recipe_items_cook_stats', up: ensureRecipeCookStatsColumns },
  /** 日级去重：规范化 url_hash + uk_trendradar_news_day（幂等，可重复调用） */
  { id: '025_trendradar_day_dedupe', up: ensureTrendRadarSyncColumns },
];
