import { ensureDropDeletedAtVersion } from '../ensure-drop-deleted-at-version.js';
import { ensureDropEarnedRewards } from '../ensure-drop-earned-rewards.js';
import { ensureDropProfileFeatures } from '../ensure-drop-profile-features.js';
import { ensureFrogScheduleTables } from '../ensure-frog-schedule.js';
import { ensureHealthDropUserId } from '../ensure-health-drop-user-id.js';
import { ensureMemosPinnedColumn } from '../ensure-memos-pinned.js';
import { ensurePointsTables } from '../ensure-points.js';
import { ensureProjectTagsTables } from '../ensure-project-tags.js';
import { ensureProjectsPriorityColumn } from '../ensure-projects-priority.js';
import { ensureUsersPersonaPortraitColumn } from '../ensure-users-persona-portrait.js';
import { ensureWishBoardTables } from '../ensure-wish-board.js';
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
];
