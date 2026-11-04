/**
 * 阶段 E：placement 分钟字段解析契约（无 DB）
 * 运行：npm run test:frog-placement-minutes
 */
import assert from 'node:assert/strict';
import {
  assertPlacementMinutePair,
  mapPlacementMinutesFromDbRow,
  parseOptionalNullableInt,
  parsePlacementMinuteFields,
} from '../src/services/pages/frog-placement-minutes.ts';

// 旧客户端：不传分钟键 → present=false（UPDATE 不覆盖）
{
  const fields = parsePlacementMinuteFields({
    id: 'scp_old',
    weekStartYmd: '2026-11-03',
    weekday: 1,
    startSlotIndex: 0,
    spanSlots: 1,
    subjectKind: 'task',
    subjectId: 't1',
    orphaned: 0,
  });
  assert.equal(fields.startMinutes.present, false);
  assert.equal(fields.endMinutes.present, false);
  assert.equal(fields.allDay.present, false);
}

// 新客户端：带分钟
{
  const fields = parsePlacementMinuteFields({
    id: 'scp_new',
    startMinutes: 480,
    endMinutes: 600,
    allDay: 0,
  });
  assert.equal(fields.startMinutes.present, true);
  assert.equal(fields.startMinutes.value, 480);
  assert.equal(fields.endMinutes.value, 600);
  assert.equal(fields.allDay.value, 0);
}

// snake_case 兼容
{
  const fields = parsePlacementMinuteFields({
    start_minutes: 900,
    end_minutes: 960,
    all_day: 1,
  });
  assert.equal(fields.startMinutes.value, 900);
  assert.equal(fields.endMinutes.value, 960);
  assert.equal(fields.allDay.value, 1);
}

// 显式 null 仍算 present（允许清空）
{
  const start = parseOptionalNullableInt({ startMinutes: null }, 'startMinutes', 'start_minutes');
  assert.equal(start.present, true);
  assert.equal(start.value, null);
}

// 半开校验
{
  assert.doesNotThrow(() => assertPlacementMinutePair(480, 600));
  assert.doesNotThrow(() => assertPlacementMinutePair(null, 600));
  assert.throws(() => assertPlacementMinutePair(600, 600));
  assert.throws(() => assertPlacementMinutePair(700, 600));
}

// DB 行映射
{
  const mapped = mapPlacementMinutesFromDbRow({
    start_minutes: '480',
    end_minutes: 600,
    all_day: null,
  });
  assert.equal(mapped.startMinutes, 480);
  assert.equal(mapped.endMinutes, 600);
  assert.equal(mapped.allDay, null);
}

console.log('ok: frog-placement-minutes selftest');
