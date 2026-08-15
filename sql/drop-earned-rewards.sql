-- 方案 B：下线「完成奖励」整功能
-- 删除 earned_rewards 表；清洗 habits / tasks / projects 的 extra_data.completion_reward
-- 保留 wish_items（心愿清单独立功能）

DROP TABLE IF EXISTS earned_rewards;

UPDATE habits
SET extra_data = JSON_REMOVE(extra_data, '$.completion_reward')
WHERE extra_data IS NOT NULL
  AND JSON_VALID(extra_data)
  AND JSON_CONTAINS_PATH(extra_data, 'one', '$.completion_reward');

UPDATE tasks
SET extra_data = JSON_REMOVE(extra_data, '$.completion_reward')
WHERE extra_data IS NOT NULL
  AND JSON_VALID(extra_data)
  AND JSON_CONTAINS_PATH(extra_data, 'one', '$.completion_reward');

UPDATE projects
SET extra_data = JSON_REMOVE(extra_data, '$.completion_reward')
WHERE extra_data IS NOT NULL
  AND JSON_VALID(extra_data)
  AND JSON_CONTAINS_PATH(extra_data, 'one', '$.completion_reward');
