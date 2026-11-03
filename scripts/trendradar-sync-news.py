#!/usr/bin/env python3
"""把 TrendRadar 的当日 SQLite 快照同步到 self_app_back。

只做三件事：
1. 只读打开 output/news/YYYY-MM-DD.db
2. 组装 JSON
3. POST /api/news/import

不修改 TrendRadar 源码；脚本应放在 TrendRadar 仓库外（如 /opt/trendradar-sync/）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import sqlite3
except ImportError:  # pragma: no cover
    print("需要 Python 标准库 sqlite3", file=sys.stderr)
    sys.exit(2)


DEFAULT_DB_DIR = "/opt/TrendRadar/output/news"
DEFAULT_IMPORT_URL = "http://127.0.0.1:3000/api/news/import"
DEFAULT_PURGE_URL = "http://127.0.0.1:3000/api/news/purge-old"
DEFAULT_TZ = "Asia/Shanghai"
MAX_RETRIES = 3
RETRY_SLEEP_SEC = 2.0


def today_in_tz(tz_name: str) -> str:
    return datetime.now(ZoneInfo(tz_name)).strftime("%Y-%m-%d")


def open_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{db_path.as_posix()}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def load_items(db_path: Path) -> list[dict[str, Any]]:
    con = open_readonly(db_path)
    try:
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        rows = cur.execute(
            """
            SELECT
              n.title AS title,
              n.platform_id AS platformId,
              COALESCE(p.name, n.platform_id) AS platformName,
              n.rank AS rank,
              n.url AS url,
              n.mobile_url AS mobileUrl,
              n.crawl_count AS crawlCount,
              n.first_crawl_time AS firstCrawlTime,
              n.last_crawl_time AS lastCrawlTime
            FROM news_items n
            LEFT JOIN platforms p ON p.id = n.platform_id
            ORDER BY n.platform_id, n.rank, n.id
            """
        ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            items.append(
                {
                    "title": row["title"] or "",
                    "platformId": row["platformId"] or "",
                    "platformName": row["platformName"] or "",
                    "rank": row["rank"],
                    "url": row["url"] or None,
                    "mobileUrl": row["mobileUrl"] or None,
                    "crawlCount": row["crawlCount"],
                    "firstCrawlTime": row["firstCrawlTime"],
                    "lastCrawlTime": row["lastCrawlTime"],
                }
            )
        return items
    finally:
        con.close()


def post_json(
    url: str,
    token: str,
    payload: dict[str, Any],
    timeout: float = 60.0,
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
        data = json.loads(raw) if raw else {}
        if isinstance(data, dict) and data.get("code") not in (None, 0, 200):
            raise RuntimeError(f"业务失败: {data}")
        return data if isinstance(data, dict) else {"data": data}


def post_with_retry(url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    last_err: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return post_json(url, token, payload)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError) as err:
            last_err = err
            if attempt >= MAX_RETRIES:
                break
            print(
                f"[retry {attempt}/{MAX_RETRIES}] {err}; sleep {RETRY_SLEEP_SEC}s",
                file=sys.stderr,
            )
            time.sleep(RETRY_SLEEP_SEC)
    assert last_err is not None
    raise last_err


def cleanup_old_sqlite_files(db_dir: Path, keep_date: str, dry_run: bool) -> int:
    """删除早于 keep_date 的 YYYY-MM-DD.db（不影响 TrendRadar 源码）。"""
    removed = 0
    if not db_dir.is_dir():
        return 0
    for path in sorted(db_dir.glob("????-??-??.db")):
        stem = path.stem
        if len(stem) != 10 or stem[4] != "-" or stem[7] != "-":
            continue
        if stem >= keep_date:
            continue
        if dry_run:
            print(f"dry-run would remove sqlite {path}")
        else:
            path.unlink(missing_ok=True)
            print(f"removed sqlite {path.name}")
        removed += 1
    return removed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync TrendRadar news SQLite -> /api/news/import；也可 --purge-old",
    )
    parser.add_argument(
        "--date",
        help="报告日期 YYYY-MM-DD；默认 Asia/Shanghai 当天",
    )
    parser.add_argument(
        "--db-dir",
        default=os.environ.get("TRENDRADAR_NEWS_DIR", DEFAULT_DB_DIR),
        help=f"news db 目录（默认 {DEFAULT_DB_DIR}）",
    )
    parser.add_argument(
        "--db-file",
        help="直接指定 .db 路径（优先于 --date/--db-dir）",
    )
    parser.add_argument(
        "--import-url",
        default=os.environ.get("NEWS_IMPORT_URL", DEFAULT_IMPORT_URL),
        help=f"导入接口（默认 {DEFAULT_IMPORT_URL}）",
    )
    parser.add_argument(
        "--purge-url",
        default=os.environ.get("NEWS_PURGE_URL", DEFAULT_PURGE_URL),
        help=f"清理接口（默认 {DEFAULT_PURGE_URL}）",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("NEWS_IMPORT_TOKEN", ""),
        help="Authorization Bearer 令牌（或环境变量 NEWS_IMPORT_TOKEN）",
    )
    parser.add_argument(
        "--tz",
        default=os.environ.get("TZ", DEFAULT_TZ),
        help="默认日期时区",
    )
    parser.add_argument(
        "--purge-old",
        action="store_true",
        help="删除 MySQL 中早于 keepDate 的热点；默认 keepDate=当天",
    )
    parser.add_argument(
        "--keep-date",
        help="清理时保留起始日 YYYY-MM-DD（含当天及以后）；默认上海时区今天",
    )
    parser.add_argument(
        "--also-clean-sqlite",
        action="store_true",
        help="同时删除 output/news 下早于 keepDate 的 .db 文件",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只读/预览，不发请求、不删文件",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    keep_date = args.keep_date or args.date or today_in_tz(args.tz)

    if args.purge_old:
        if args.dry_run:
            print(f"dry-run purge keepDate={keep_date}")
            if args.also_clean_sqlite:
                cleanup_old_sqlite_files(Path(args.db_dir), keep_date, dry_run=True)
            return 0
        token = (args.token or "").strip()
        if not token:
            print("缺少 NEWS_IMPORT_TOKEN / --token", file=sys.stderr)
            return 2
        result = post_with_retry(args.purge_url, token, {"keepDate": keep_date})
        data = result.get("data") if isinstance(result.get("data"), dict) else result
        print(
            "purge ok keep={keep} news={news} batches={batches} reports={reports}".format(
                keep=data.get("keepDate", keep_date),
                news=data.get("deletedNews", "?"),
                batches=data.get("deletedBatches", "?"),
                reports=data.get("deletedReports", "?"),
            )
        )
        if args.also_clean_sqlite:
            n = cleanup_old_sqlite_files(Path(args.db_dir), keep_date, dry_run=False)
            print(f"sqlite removed={n}")
        return 0

    report_date = args.date or today_in_tz(args.tz)
    if args.db_file:
        db_path = Path(args.db_file)
        # 文件名若是日期则覆盖 reportDate
        stem = db_path.stem
        if len(stem) == 10 and stem[4] == "-" and stem[7] == "-":
            report_date = stem
    else:
        db_path = Path(args.db_dir) / f"{report_date}.db"

    if not db_path.is_file():
        print(f"数据库不存在: {db_path}", file=sys.stderr)
        return 1

    items = load_items(db_path)
    print(f"read {db_path} -> {len(items)} items (date={report_date})")
    if not items:
        print("无数据，跳过导入", file=sys.stderr)
        return 1

    if args.dry_run:
        print("dry-run ok")
        return 0

    token = (args.token or "").strip()
    if not token:
        print("缺少 NEWS_IMPORT_TOKEN / --token", file=sys.stderr)
        return 2

    payload = {"reportDate": report_date, "items": items}
    result = post_with_retry(args.import_url, token, payload)
    data = result.get("data") if isinstance(result.get("data"), dict) else result
    stored = data.get("itemsStored", data.get("itemsReceived", len(items)))
    received = data.get("itemsReceived", len(items))
    new_items = data.get("newItems", "?")
    print(
        f"sync ok date={report_date} received={received} stored={stored} new={new_items}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 — CLI 顶层统一出口
        print(f"sync failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
