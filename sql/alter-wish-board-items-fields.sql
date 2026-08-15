-- 心愿板条目增量字段（表已按初版建好时执行）
-- 新环境请直接使用 add-wish-board.sql（已含下列列）

ALTER TABLE wish_board_items
  ADD COLUMN description VARCHAR(500) NULL
    COMMENT '描述（可选），对应添加弹层「描述」'
    AFTER title,
  ADD COLUMN icon_key VARCHAR(64) NULL
    COMMENT '图标 key，如 card-giftcard / movie'
    AFTER note,
  ADD COLUMN wish_type VARCHAR(16) NOT NULL DEFAULT 'once'
    COMMENT 'once=一次性，repeat=重复性'
    AFTER icon_key;

UPDATE wish_board_items
SET description = note
WHERE (description IS NULL OR TRIM(description) = '')
  AND note IS NOT NULL
  AND TRIM(note) != '';

UPDATE wish_board_items
SET icon_key = 'card-giftcard'
WHERE icon_key IS NULL OR TRIM(icon_key) = '';

UPDATE wish_board_items
SET wish_type = 'once'
WHERE wish_type IS NULL
   OR TRIM(wish_type) = ''
   OR wish_type NOT IN ('once', 'repeat');

ALTER TABLE wish_board_items
  ADD CONSTRAINT chk_wish_board_wish_type
  CHECK (wish_type IN ('once', 'repeat'));

CREATE INDEX idx_wish_board_items_wish_type
  ON wish_board_items (wish_type);
