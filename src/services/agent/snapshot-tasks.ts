/**
 * Agent 只读任务/习惯快照：字段白名单，一次 HTTP 够用。
 * 挂载：GET /api/app/agent/snapshot/tasks
 */
import {
  getFrogCandidates,
  type FrogCandidateItem,
} from '../pages/frog.js';
import {
  getHabitsGrid,
  type TasksBootstrapParams,
} from '../pages/tasks-bootstrap.js';
import { getTasksOverview } from '../pages/tasks-overview.js';

const OPEN_TODO_LIMIT = 12;
const FROG_LIMIT = 8;
const HABIT_GAP_LIMIT = 8;

export type AgentTasksSnapshotParams = TasksBootstrapParams & {
  logicalToday?: string;
};

export class TasksSnapshotError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'TasksSnapshotError';
  }
}

function trimTaskItem(row: FrogCandidateItem) {
  return {
    id: row.id,
    title: row.title || '未命名',
    kind: row.kind,
    priority: row.priority,
    due_ymd: row.dueDate,
    is_overdue: row.isOverdue,
    already_assigned: row.alreadyAssigned,
    project_id: row.projectId,
    project_name: row.projectName,
  };
}

export async function getAgentTasksSnapshot(params: AgentTasksSnapshotParams = {}) {
  const [frogs, habitsGrid, overview] = await Promise.all([
    getFrogCandidates(params),
    getHabitsGrid(params),
    getTasksOverview(params).catch(() => null),
  ]);

  const today = String(frogs.logicalToday || habitsGrid.logicalToday || params.logicalToday || '').trim() || null;

  const allOpen = frogs.items
    .filter((row) => row.kind === 'task' && !row.blockedReason)
    .map(trimTaskItem);

  const overdue = allOpen.filter((row) => row.is_overdue);
  const frogCandidates = frogs.items
    .filter((row) => !row.blockedReason)
    .slice(0, FROG_LIMIT)
    .map(trimTaskItem);

  const openTodos = allOpen
    .filter((row) => !row.is_overdue)
    .slice(0, OPEN_TODO_LIMIT);

  const habitGaps = (habitsGrid.items || [])
    .filter((item) => !item.displayCompleted && !item.hiddenOnViewDay)
    .slice(0, HABIT_GAP_LIMIT)
    .map((item) => ({
      id: item.id,
      name: item.name || '习惯',
      today_count: item.todayCount,
      daily_goal: item.dailyGoal,
      kind: item.kind,
    }));

  const insightCounts = overview?.insightCounts
    ? {
        open: Number(overview.insightCounts.open) || 0,
        done_or_cancelled: Number(overview.insightCounts.doneOrCancelled) || 0,
        total_active: Number(overview.insightCounts.totalActive) || 0,
        recurring: Number(overview.insightCounts.recurring) || 0,
        completed_events: Number(overview.insightCounts.completedEvents) || 0,
        reopened_events: Number(overview.insightCounts.reopenedEvents) || 0,
      }
    : null;

  return {
    domain: 'tasks',
    today_ymd: today,
    overdue_count: overdue.length,
    overdue_todos: overdue.slice(0, OPEN_TODO_LIMIT),
    frog_candidates: frogCandidates,
    open_todos: openTodos,
    habit_gaps: habitGaps,
    insight_counts: insightCounts,
    note: '任务/习惯只读摘要；指派青蛙或打卡需用户在 App 确认，助手不写库。',
    meta: {
      serverTime: habitsGrid.meta?.serverTime ?? null,
      logicalToday: today,
      frogAssignYmd: frogs.assignYmd,
    },
  };
}
