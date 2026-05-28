"""Low-level helpers for NEMWEB: directory listing, ZIP download, AEMO MMS CSV parsing.

AEMO MMS CSV row markers:
    C - comment / header / footer
    I - column header for the following D rows
    D - data row

A single CSV often contains multiple logical tables, each introduced by its own
I row. We group D rows by their preceding I row to reconstruct each table.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Iterable

import pandas as pd
import requests


log = logging.getLogger(__name__)

# AEMO publishes timestamps in AEST (UTC+10), no DST. We mirror that.
AEST = timezone(timedelta(hours=10))

# NEMWEB filenames embed a 12- or 14-digit timestamp like 202605271600 or
# 20260527160000. We accept either.
_TS_RE = re.compile(r"(\d{12,14})")

# Apache directory index <a href="filename"> capture.
_HREF_RE = re.compile(r'<a\s+href="([^"?][^"]*)"', re.IGNORECASE)

USER_AGENT = "nemweb-forecast-tracker/0.1 (+https://github.com/c-hat/nemweb)"


@dataclass(frozen=True)
class DirectoryEntry:
    filename: str
    url: str
    timestamp: datetime | None  # parsed from filename, AEST


def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def parse_filename_timestamp(filename: str) -> datetime | None:
    """Extract the embedded YYYYMMDDHHMM[SS] timestamp from a NEMWEB filename."""
    m = _TS_RE.search(filename)
    if not m:
        return None
    s = m.group(1)
    try:
        if len(s) == 14:
            dt = datetime.strptime(s, "%Y%m%d%H%M%S")
        else:
            dt = datetime.strptime(s[:12], "%Y%m%d%H%M")
        return dt.replace(tzinfo=AEST)
    except ValueError:
        return None


def list_directory(url: str, session: requests.Session | None = None) -> list[DirectoryEntry]:
    """List a NEMWEB Apache-style directory index.

    Returns entries whose filenames look like data files (currently: end in .zip
    or .ZIP). Subdirectories and the parent link are filtered out.
    """
    s = session or _session()
    if not url.endswith("/"):
        url = url + "/"
    resp = s.get(url, timeout=60)
    resp.raise_for_status()
    entries: list[DirectoryEntry] = []
    seen: set[str] = set()
    for href in _HREF_RE.findall(resp.text):
        if href in seen:
            continue
        seen.add(href)
        if href.endswith("/") or href.startswith("?") or href.startswith("/"):
            continue
        if not href.lower().endswith(".zip"):
            continue
        entries.append(
            DirectoryEntry(
                filename=href,
                url=url + href,
                timestamp=parse_filename_timestamp(href),
            )
        )
    return entries


def download_zip(url: str, session: requests.Session | None = None) -> bytes:
    s = session or _session()
    resp = s.get(url, timeout=180)
    resp.raise_for_status()
    return resp.content


def _iter_csv_rows(text: str) -> Iterable[list[str]]:
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if row:
            yield row


def parse_aemo_csv(csv_text: str) -> dict[str, pd.DataFrame]:
    """Parse one AEMO MMS-format CSV into a dict of table_name -> DataFrame.

    Table name is derived from the I row's (REPORT_TYPE, TABLE_NAME) columns,
    joined as "REPORT_TYPE_TABLE_NAME" (matches how AEMO docs refer to them,
    e.g. "OPERATIONAL_DEMAND_ACTUAL_HH").
    """
    tables: dict[str, list[list[str]]] = {}
    headers: dict[str, list[str]] = {}
    current: str | None = None
    for row in _iter_csv_rows(csv_text):
        marker = row[0]
        if marker == "I":
            # I,REPORT_TYPE,TABLE_NAME,VERSION,col1,col2,...
            if len(row) < 5:
                current = None
                continue
            report_type = row[1].strip()
            table_name = row[2].strip()
            key = f"{report_type}_{table_name}" if table_name else report_type
            current = key
            headers[key] = row[4:]
            tables.setdefault(key, [])
        elif marker == "D" and current is not None:
            # D rows mirror the I row layout
            tables[current].append(row[4:])
        # C rows ignored.

    result: dict[str, pd.DataFrame] = {}
    for key, rows in tables.items():
        if not rows:
            continue
        cols = headers[key]
        # Some rows may have trailing empty cells trimmed by csv; pad to header width.
        width = len(cols)
        padded = [r + [""] * (width - len(r)) if len(r) < width else r[:width] for r in rows]
        df = pd.DataFrame(padded, columns=cols)
        result[key] = df
    return result


def read_aemo_zip(zip_bytes: bytes) -> dict[str, pd.DataFrame]:
    """Open a NEMWEB ZIP and return parsed tables.

    NEMWEB ZIPs may contain a single CSV directly, or nested ZIPs each with one
    CSV (common for the ACTUAL_HH and ROOFTOP report families). We recurse one
    level into nested ZIPs and merge tables across all CSVs found.
    """
    merged: dict[str, list[pd.DataFrame]] = {}

    def _ingest_csv_bytes(data: bytes) -> None:
        text = data.decode("utf-8", errors="replace")
        for k, df in parse_aemo_csv(text).items():
            merged.setdefault(k, []).append(df)

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = info.filename.lower()
            if name.endswith(".csv"):
                _ingest_csv_bytes(zf.read(info))
            elif name.endswith(".zip"):
                inner = zf.read(info)
                with zipfile.ZipFile(io.BytesIO(inner)) as zf2:
                    for info2 in zf2.infolist():
                        if info2.filename.lower().endswith(".csv"):
                            _ingest_csv_bytes(zf2.read(info2))

    return {k: pd.concat(dfs, ignore_index=True) for k, dfs in merged.items()}


def pick_snapshot_at_or_before(
    entries: list[DirectoryEntry], cutoff: datetime
) -> DirectoryEntry | None:
    """Return the entry with the largest timestamp <= cutoff, or None."""
    candidates = [e for e in entries if e.timestamp is not None and e.timestamp <= cutoff]
    if not candidates:
        return None
    return max(candidates, key=lambda e: e.timestamp)  # type: ignore[arg-type]


def entries_in_range(
    entries: list[DirectoryEntry], start: datetime, end: datetime
) -> list[DirectoryEntry]:
    """Entries whose filename timestamp falls within [start, end)."""
    return sorted(
        (e for e in entries if e.timestamp is not None and start <= e.timestamp < end),
        key=lambda e: e.timestamp,  # type: ignore[arg-type]
    )
