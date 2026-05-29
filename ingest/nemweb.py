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
import os
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterable, Protocol

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

# NEMWEB sits behind a WAF that 403s requests lacking a browser-like
# User-Agent, so we present one (plus matching Accept headers). The data is
# public; this is just to get past the bot filter.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
}


@dataclass(frozen=True)
class DirectoryEntry:
    filename: str
    url: str
    timestamp: datetime | None  # parsed from filename, AEST


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update(_DEFAULT_HEADERS)
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


# --- Sources -------------------------------------------------------------
#
# A Source abstracts "where the report files live". The ingestion code only
# ever talks to a Source, so the exact same code path runs whether the data
# comes from the live NEMWEB site (HttpSource) or from local synthetic
# fixtures (LocalSource). This is what lets the tests exercise the real
# ingest pipeline without network access.

DEFAULT_BASE_URL = "https://nemweb.com.au"


class Source(Protocol):
    """A place report files can be listed and read from."""

    def list_directory(self, rel_path: str) -> list[DirectoryEntry]:
        """List data-file entries under a report directory (relative path)."""
        ...

    def read_tables(self, entry: DirectoryEntry) -> dict[str, pd.DataFrame]:
        """Read one entry and return its parsed AEMO MMS tables."""
        ...


class HttpSource:
    """Reads from a live NEMWEB-style Apache index over HTTP(S)."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, session: requests.Session | None = None):
        self.base = base_url.rstrip("/")
        self.session = session or _session()

    def list_directory(self, rel_path: str) -> list[DirectoryEntry]:
        url = f"{self.base}/{rel_path.strip('/')}/"
        return list_directory(url, session=self.session)

    def read_tables(self, entry: DirectoryEntry) -> dict[str, pd.DataFrame]:
        return read_aemo_zip(download_zip(entry.url, session=self.session))

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"HttpSource(base={self.base!r})"


class LocalSource:
    """Reads fixtures from a local directory tree mirroring NEMWEB paths.

    Fixture files may be either ``.zip`` (read exactly like production via
    ``read_aemo_zip``) or plain ``.csv`` (parsed directly via
    ``parse_aemo_csv``). Plain CSVs keep the fixtures human-reviewable in git
    while still flowing through the same ``parse_aemo_csv`` used for live data.

    The directory layout under ``base_dir`` mirrors the live site, e.g.::

        <base_dir>/Reports/Current/Operational_Demand/FORECAST_HH/<file>.csv
    """

    def __init__(self, base_dir: str | Path):
        self.base = Path(base_dir)

    def list_directory(self, rel_path: str) -> list[DirectoryEntry]:
        d = self.base / rel_path.strip("/")
        if not d.is_dir():
            return []
        entries: list[DirectoryEntry] = []
        for p in sorted(d.iterdir()):
            if p.suffix.lower() not in (".zip", ".csv"):
                continue
            entries.append(
                DirectoryEntry(
                    filename=p.name,
                    url=str(p),
                    timestamp=parse_filename_timestamp(p.name),
                )
            )
        return entries

    def read_tables(self, entry: DirectoryEntry) -> dict[str, pd.DataFrame]:
        p = Path(entry.url)
        data = p.read_bytes()
        if p.suffix.lower() == ".zip":
            return read_aemo_zip(data)
        return parse_aemo_csv(data.decode("utf-8", errors="replace"))

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"LocalSource(base={self.base!r})"


def make_source(spec: str | None = None, session: requests.Session | None = None) -> Source:
    """Build a Source from a spec string.

    Resolution order: explicit ``spec`` arg, then ``$NEMWEB_SOURCE``, then the
    live site. A spec starting with ``http://`` or ``https://`` yields an
    HttpSource; anything else is treated as a local fixture directory.
    """
    spec = spec or os.environ.get("NEMWEB_SOURCE") or DEFAULT_BASE_URL
    if spec.startswith("http://") or spec.startswith("https://"):
        return HttpSource(spec, session=session)
    return LocalSource(spec)
