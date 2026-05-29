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
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterable, Protocol
from urllib.parse import urljoin

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


log = logging.getLogger(__name__)

# AEMO publishes timestamps in AEST (UTC+10), no DST. We mirror that.
AEST = timezone(timedelta(hours=10))

# NEMWEB filenames embed a 12- or 14-digit timestamp like 202605271600 or
# 20260527160000. We accept either.
_TS_RE = re.compile(r"(\d{12,14})")

# Apache directory index <a href="filename"> capture.
_HREF_RE = re.compile(r'<a\s+href="([^"?][^"]*)"', re.IGNORECASE)

USER_AGENT = "nemweb-forecast-tracker/0.1 (+https://github.com/c-hat/nemweb)"

# A full day's backfill is ~150-200 small requests against NEMWEB; running
# several days back-to-back trips the site's sliding-window rate limit, which
# surfaces as a 403 (escalating to 403 even on directory listings). We stay
# under it with a small inter-request delay and recover from any limiting we do
# hit with bounded exponential backoff. Both are tunable via env vars so the
# fixture-driven tests (which never touch the network) are unaffected.
THROTTLE_SECONDS = float(os.environ.get("NEMWEB_THROTTLE_SECONDS", "0.3"))
MAX_RETRIES = int(os.environ.get("NEMWEB_MAX_RETRIES", "6"))
_RETRY_STATUSES = frozenset({403, 429, 500, 502, 503, 504})


@dataclass(frozen=True)
class DirectoryEntry:
    filename: str
    url: str
    timestamp: datetime | None  # parsed from filename, AEST


def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    retry = Retry(
        total=MAX_RETRIES,
        backoff_factor=1.0,  # waits ~0.5, 1, 2, 4, 8, 16s between attempts
        status_forcelist=sorted(_RETRY_STATUSES),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def _get(session: requests.Session, url: str, timeout: int) -> requests.Response:
    """GET with a polite inter-request delay; retries/backoff live on the adapter."""
    if THROTTLE_SECONDS:
        time.sleep(THROTTLE_SECONDS)
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp


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


def parse_directory_listing(html: str, base_url: str) -> list[DirectoryEntry]:
    """Parse an Apache-style directory index into data-file entries.

    NEMWEB links files by *absolute* path with mixed casing, e.g.
    ``<A HREF="/Reports/CURRENT/.../FILE.zip">``. We resolve each href against
    ``base_url`` and take the basename as the filename. Subdirectory links,
    column-sort links (``?C=...``) and non-zip files are skipped. This is the
    pure, network-free core of :func:`list_directory`.
    """
    if not base_url.endswith("/"):
        base_url = base_url + "/"
    entries: list[DirectoryEntry] = []
    seen: set[str] = set()
    for href in _HREF_RE.findall(html):
        if href in seen:
            continue
        seen.add(href)
        if href.endswith("/") or href.startswith("?"):
            continue
        filename = href.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
        if not filename.lower().endswith(".zip"):
            continue
        entries.append(
            DirectoryEntry(
                filename=filename,
                url=urljoin(base_url, href),
                timestamp=parse_filename_timestamp(filename),
            )
        )
    return entries


def list_directory(url: str, session: requests.Session | None = None) -> list[DirectoryEntry]:
    """List a NEMWEB Apache-style directory index.

    Returns entries whose filenames look like data files (currently: end in
    .zip or .ZIP). Subdirectories and the parent link are filtered out.
    """
    s = session or _session()
    if not url.endswith("/"):
        url = url + "/"
    resp = _get(s, url, timeout=60)
    return parse_directory_listing(resp.text, url)


def download_zip(url: str, session: requests.Session | None = None) -> bytes:
    s = session or _session()
    resp = _get(s, url, timeout=180)
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
