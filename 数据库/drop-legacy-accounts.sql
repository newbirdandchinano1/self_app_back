-- P1-02：下线遗留账本 accounts / account_transactions
-- 权威账本为 finance_accounts / finance_transactions（及 finance_* 卫星列）。
-- 幂等；执行前请确认库中无业务依赖这两张表（APP / 专口均已不读写）。

DROP TABLE IF EXISTS `account_transactions`;
DROP TABLE IF EXISTS `accounts`;
