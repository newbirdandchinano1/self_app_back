import { Router, type Request } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { success, fail } from '../utils/response.js';
import {
  createRecord,
  CrudError,
  deleteRecord,
  getRecord,
  listRecords,
  listTableNames,
  updateRecord,
} from '../services/crud.js';
import { isAllowedTable } from '../config/tables.js';
import { parseListQueryFromRequest } from '../services/list-query.js';

const router = Router();

function isAdminPanelRequest(req: Request): boolean {
  return req.headers['x-admin-panel'] === '1';
}

router.use(requireAuth);

router.get('/tables', async (_req, res, next) => {
  try {
    const tables = await listTableNames();
    success(res, tables);
  } catch (err) {
    next(err);
  }
});

router.get('/data/:table', async (req, res, next) => {
  try {
    const { table } = req.params;
    if (!isAllowedTable(table)) {
      return fail(res, `表 ${table} 不存在或不允许访问`, -1, 404);
    }

    const listQuery = parseListQueryFromRequest(req.query as Record<string, unknown>);
    const result = await listRecords(table, listQuery);
    success(res, result);
  } catch (err) {
    next(err);
  }
});

router.get('/data/:table/:id', async (req, res, next) => {
  try {
    const { table, id } = req.params;
    if (!isAllowedTable(table)) {
      return fail(res, `表 ${table} 不存在或不允许访问`, -1, 404);
    }

    const record = await getRecord(table, id);
    if (!record) {
      return fail(res, '记录不存在', -1, 404);
    }
    success(res, record);
  } catch (err) {
    next(err);
  }
});

router.post('/data/:table', async (req, res, next) => {
  try {
    const { table } = req.params;
    if (!isAllowedTable(table)) {
      return fail(res, `表 ${table} 不存在或不允许访问`, -1, 404);
    }

    const record = await createRecord(table, req.body ?? {}, {
      adminPanel: isAdminPanelRequest(req),
    });
    success(res, record, '创建成功');
  } catch (err) {
    if (err instanceof CrudError) {
      return fail(res, err.message, err.code, err.status);
    }
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      return fail(res, '唯一字段冲突，记录已存在', -1, 409);
    }
    if ((err as { code?: string }).code === 'ER_NO_REFERENCED_ROW_2') {
      return fail(res, '外键引用不存在，请检查依赖数据是否已先同步', -1, 400);
    }
    next(err);
  }
});

router.put('/data/:table/:id', async (req, res, next) => {
  try {
    const { table, id } = req.params;
    if (!isAllowedTable(table)) {
      return fail(res, `表 ${table} 不存在或不允许访问`, -1, 404);
    }

    const record = await updateRecord(table, id, req.body ?? {}, {
      adminPanel: isAdminPanelRequest(req),
    });
    if (!record) {
      return fail(res, '记录不存在', -1, 404);
    }
    success(res, record, '更新成功');
  } catch (err) {
    if (err instanceof CrudError) {
      return fail(res, err.message, err.code, err.status);
    }
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      return fail(res, '唯一字段冲突', -1, 409);
    }
    if ((err as { code?: string }).code === 'ER_NO_REFERENCED_ROW_2') {
      return fail(res, '外键引用不存在，请检查依赖数据是否已先同步', -1, 400);
    }
    next(err);
  }
});

router.patch('/data/:table/:id', async (req, res, next) => {
  try {
    const { table, id } = req.params;
    if (!isAllowedTable(table)) {
      return fail(res, `表 ${table} 不存在或不允许访问`, -1, 404);
    }

    const record = await updateRecord(table, id, req.body ?? {}, {
      adminPanel: isAdminPanelRequest(req),
    });
    if (!record) {
      return fail(res, '记录不存在', -1, 404);
    }
    success(res, record, '更新成功');
  } catch (err) {
    if (err instanceof CrudError) {
      return fail(res, err.message, err.code, err.status);
    }
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      return fail(res, '唯一字段冲突', -1, 409);
    }
    if ((err as { code?: string }).code === 'ER_NO_REFERENCED_ROW_2') {
      return fail(res, '外键引用不存在，请检查依赖数据是否已先同步', -1, 400);
    }
    next(err);
  }
});

router.delete('/data/:table/:id', async (req, res, next) => {
  try {
    const { table, id } = req.params;
    if (!isAllowedTable(table)) {
      return fail(res, `表 ${table} 不存在或不允许访问`, -1, 404);
    }

    const deleted = await deleteRecord(table, id);
    if (!deleted) {
      return fail(res, '记录不存在', -1, 404);
    }
    success(res, null, '删除成功');
  } catch (err) {
    next(err);
  }
});

export default router;
