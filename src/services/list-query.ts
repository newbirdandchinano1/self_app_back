import type { AllowedTable } from '../config/tables.js';
import { isValidYmd } from '../utils/ymd.js';
import { normalizeDbDateTimeForStorage } from './calendar/logical-day.js';

export interface ListQueryParams {
  page?: number;
  limit?: number;
  fields?: string[];
  updatedSince?: string;
  startDate?: string;
  endDate?: string;
  dueDateGte?: string;
  dueDateLte?: string;
  frogAssignedOnGte?: string;
  frogAssignedOnLte?: string;
  createdAtGte?: string;
  createdAtLte?: string;
  assignedYmdGte?: string;
  assignedYmdLte?: string;
  calendarRelevant?: boolean;
  excludeArchived?: boolean;
}

export interface BuiltListQuery {
  whereClauses: string[];
  whereValues: unknown[];
  maxLimit: number;
  selectFields: string[] | null;
}

export interface BuildListQueryContext {
  hasFrogAssignedOnColumn?: boolean;
}

function pushYmdRange(
  clauses: string[],
  values: unknown[],
  columnExpr: string,
  gte?: string,
  lte?: string,
): void {
  if (gte && isValidYmd(gte)) {
    clauses.push(`${columnExpr} >= ?`);
    values.push(gte);
  }
  if (lte && isValidYmd(lte)) {
    clauses.push(`${columnExpr} <= ?`);
    values.push(lte);
  }
}

const FROG_ASSIGNED_YMD_RE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

function pushFrogAssignedOnRange(
  clauses: string[],
  values: unknown[],
  hasFrogAssignedOnColumn: boolean,
  gte?: string,
  lte?: string,
): void {
  const hasGte = Boolean(gte && isValidYmd(gte));
  const hasLte = Boolean(lte && isValidYmd(lte));
  if (!hasGte && !hasLte) return;

  if (hasFrogAssignedOnColumn) {
    clauses.push('frog_assigned_on IS NOT NULL');
    pushYmdRange(clauses, values, 'frog_assigned_on', gte, lte);
    return;
  }

  const jsonExpr = 'JSON_UNQUOTE(JSON_EXTRACT(extra_data, \'$.frogAssignedOn\'))';
  clauses.push(`JSON_EXTRACT(extra_data, '$.frogAssignedOn') IS NOT NULL`);
  clauses.push(`${jsonExpr} != ''`);
  clauses.push(`${jsonExpr} REGEXP ?`);
  values.push(FROG_ASSIGNED_YMD_RE);
  pushYmdRange(clauses, values, jsonExpr, gte, lte);
}

function normalizeDateTimeBound(raw: string, edge: 'start' | 'end'): string {
  const trimmed = raw.trim();
  if (isValidYmd(trimmed)) {
    return edge === 'start' ? `${trimmed} 00:00:00` : `${trimmed} 23:59:59`;
  }
  return trimmed;
}

function pushDateTimeRange(
  clauses: string[],
  values: unknown[],
  columnExpr: string,
  gte?: string,
  lte?: string,
): void {
  if (gte?.trim()) {
    clauses.push(`${columnExpr} >= ?`);
    values.push(normalizeDateTimeBound(gte, 'start'));
  }
  if (lte?.trim()) {
    clauses.push(`${columnExpr} <= ?`);
    values.push(normalizeDateTimeBound(lte, 'end'));
  }
}

function parseFieldsParam(fields: string[] | undefined, allowed: string[]): string[] | null {
  if (!fields || fields.length === 0) return null;
  const allowedSet = new Set(allowed);
  const picked = fields.filter((f) => allowedSet.has(f));
  return picked.length > 0 ? picked : null;
}

export function buildListQuery(
  table: AllowedTable,
  metaColumns: string[],
  params: ListQueryParams,
  context: BuildListQueryContext = {},
): BuiltListQuery {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let maxLimit = 200;

  const hasDateRange =
    (params.startDate && isValidYmd(params.startDate)) ||
    (params.endDate && isValidYmd(params.endDate)) ||
    (params.dueDateGte && isValidYmd(params.dueDateGte)) ||
    (params.dueDateLte && isValidYmd(params.dueDateLte)) ||
    params.createdAtGte?.trim() ||
    params.createdAtLte?.trim() ||
    (params.assignedYmdGte && isValidYmd(params.assignedYmdGte)) ||
    (params.assignedYmdLte && isValidYmd(params.assignedYmdLte));

  if (hasDateRange) {
    maxLimit = 2000;
  }

  if (params.updatedSince?.trim()) {
    const since =
      normalizeDbDateTimeForStorage(params.updatedSince.trim()) ?? params.updatedSince.trim();
    clauses.push('updated_at > ?');
    values.push(since);
  }

  if (table === 'habit_check_ins') {
    pushYmdRange(clauses, values, 'record_date', params.startDate, params.endDate);
  }

  if (table === 'task_execution_events') {
    pushDateTimeRange(clauses, values, 'created_at', params.createdAtGte, params.createdAtLte);
  }

  if (table === 'frog_completion_events') {
    pushYmdRange(clauses, values, 'assigned_ymd', params.assignedYmdGte, params.assignedYmdLte);
  }

  if (table === 'projects') {
    const dueGte = params.dueDateGte ?? (params.startDate && isValidYmd(params.startDate) ? params.startDate : undefined);
    const dueLte = params.dueDateLte ?? (params.endDate && isValidYmd(params.endDate) ? params.endDate : undefined);
    pushYmdRange(clauses, values, 'LEFT(COALESCE(due_date, \'\'), 10)', dueGte, dueLte);
    if (params.excludeArchived || dueGte || dueLte) {
      clauses.push('status != ?');
      values.push('archived');
    }
  }

  if (table === 'tasks') {
    if (params.calendarRelevant) {
      const start = params.startDate;
      const end = params.endDate;
      if (start && end && isValidYmd(start) && isValidYmd(end)) {
        const frogClause = context.hasFrogAssignedOnColumn
          ? '(frog_assigned_on BETWEEN ? AND ?)'
          : '(JSON_UNQUOTE(JSON_EXTRACT(extra_data, \'$.frogAssignedOn\')) BETWEEN ? AND ?)';
        const parts: string[] = [
          '(LEFT(COALESCE(due_date, \'\'), 10) BETWEEN ? AND ?)',
          frogClause,
          'status NOT IN (?, ?)',
        ];
        values.push(start, end, start, end, 'done', 'cancelled');
        clauses.push(`(${parts.join(' OR ')})`);
        maxLimit = 2000;
      }
    } else {
      pushYmdRange(
        clauses,
        values,
        'LEFT(COALESCE(due_date, \'\'), 10)',
        params.dueDateGte,
        params.dueDateLte,
      );
      pushFrogAssignedOnRange(
        clauses,
        values,
        Boolean(context.hasFrogAssignedOnColumn),
        params.frogAssignedOnGte,
        params.frogAssignedOnLte,
      );
    }
  }

  const selectFields = parseFieldsParam(params.fields, metaColumns);

  return {
    whereClauses: clauses,
    whereValues: values,
    maxLimit,
    selectFields,
  };
}

export function parseListQueryFromRequest(query: Record<string, unknown>): ListQueryParams {
  const page = query.page ? parseInt(String(query.page), 10) : undefined;
  const limit = query.limit ? parseInt(String(query.limit), 10) : undefined;

  const fieldsRaw = query.fields;
  let fields: string[] | undefined;
  if (typeof fieldsRaw === 'string' && fieldsRaw.trim()) {
    fields = fieldsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  return {
    page,
    limit,
    fields,
    updatedSince: typeof query.updatedSince === 'string' ? query.updatedSince : undefined,
    startDate: typeof query.startDate === 'string' ? query.startDate : undefined,
    endDate: typeof query.endDate === 'string' ? query.endDate : undefined,
    dueDateGte: typeof query.dueDateGte === 'string' ? query.dueDateGte : undefined,
    dueDateLte: typeof query.dueDateLte === 'string' ? query.dueDateLte : undefined,
    frogAssignedOnGte: typeof query.frogAssignedOnGte === 'string' ? query.frogAssignedOnGte : undefined,
    frogAssignedOnLte: typeof query.frogAssignedOnLte === 'string' ? query.frogAssignedOnLte : undefined,
    createdAtGte: typeof query.createdAtGte === 'string' ? query.createdAtGte : undefined,
    createdAtLte: typeof query.createdAtLte === 'string' ? query.createdAtLte : undefined,
    assignedYmdGte: typeof query.assignedYmdGte === 'string' ? query.assignedYmdGte : undefined,
    assignedYmdLte: typeof query.assignedYmdLte === 'string' ? query.assignedYmdLte : undefined,
    calendarRelevant: query.calendarRelevant === 'true' || query.calendarRelevant === '1',
    excludeArchived: query.excludeArchived === 'true' || query.excludeArchived === '1',
  };
}
