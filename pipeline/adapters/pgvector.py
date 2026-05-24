"""pgvector adapter — Postgres with the pgvector extension.

A thin wrapper over ``psycopg`` v3 (sync) using the ``pgvector`` adapter to
let us bind ``list[float]`` as a ``vector`` value directly. The table is
created on the first ``upsert`` once we know the embedding dim; cosine
distance (``<=>``) is used for ordering, matching the rest of the pipeline.

Native hybrid retrieval would require Postgres full-text search (tsvector)
indexed alongside the vector column — a separate schema decision deferred
to the caller for now.
"""

from __future__ import annotations

import contextlib
import json
import logging
import time
from typing import Any

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)


class PgvectorAdapter(VectorDBAdapter):
    """psycopg + pgvector backed adapter.

    DSN parsing is delegated to ``psycopg.connect``; anything libpq accepts
    will work (``postgresql://user:pw@host:port/db`` or key=value).
    """

    def __init__(self, dsn: str, table: str = "bratan_chunks") -> None:
        if not dsn:
            raise ValueError("pgvector dsn is required.")
        if not _is_valid_identifier(table):
            raise ValueError(
                f"Invalid table name {table!r}; must be a simple SQL identifier."
            )
        # Local import keeps the optional deps truly optional at module level.
        import psycopg
        from pgvector.psycopg import register_vector

        self._dsn = dsn
        self._table = table
        self._conn = psycopg.connect(dsn, autocommit=True)
        # CREATE EXTENSION must run before vector type lookup; tolerate the
        # caller having already created it (the more common case in prod).
        try:
            with self._conn.cursor() as cur:
                cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        except Exception as exc:
            logger.warning("CREATE EXTENSION vector failed (continuing): %s", exc)
        register_vector(self._conn)
        self._table_ready = self._table_exists()

    # ------------------------------------------------------------------ writes

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
        if not self._table_ready:
            self._ensure_table(vector_size=len(items[0].embedding))
        rows = [
            (it.id, it.text, it.embedding, json.dumps(_flatten_metadata(it.metadata)))
            for it in items
        ]
        sql = (
            f"INSERT INTO {self._table} (id, text, embedding, metadata) "
            "VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "text = EXCLUDED.text, "
            "embedding = EXCLUDED.embedding, "
            "metadata = EXCLUDED.metadata"
        )
        with self._conn.cursor() as cur:
            cur.executemany(sql, rows)

    def delete(self, ids: list[str]) -> None:
        if not ids:
            return
        if not self._table_ready:
            return
        with self._conn.cursor() as cur:
            cur.execute(
                f"DELETE FROM {self._table} WHERE id = ANY(%s)",
                (list(ids),),
            )

    # ------------------------------------------------------------------ reads

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        if not self._table_ready:
            return []
        sql = (
            f"SELECT id, text, metadata, 1 - (embedding <=> %s::vector) AS score "
            f"FROM {self._table} "
            f"ORDER BY embedding <=> %s::vector "
            f"LIMIT %s"
        )
        with self._conn.cursor() as cur:
            cur.execute(sql, (embedding, embedding, max(1, k)))
            rows = cur.fetchall()
        return [
            QueryHit(
                id=row[0],
                text=row[1] or "",
                score=float(row[3]),
                metadata=_coerce_metadata(row[2]),
            )
            for row in rows
        ]

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        # Postgres has full-text search but it's a separate index from
        # pgvector; punt the schema decision back to the caller.
        return None

    def count(self) -> int:
        if not self._table_ready:
            return 0
        with self._conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) FROM {self._table}")
            row = cur.fetchone()
        return int(row[0]) if row else 0

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            latency_ms = (time.perf_counter() - t0) * 1000.0
            detail: dict[str, Any] = {
                "table": self._table,
                "table_ready": self._table_ready,
            }
            if self._table_ready:
                detail["count"] = self.count()
            return ConnectionTest(ok=True, latency_ms=latency_ms, detail=detail)
        except Exception as exc:
            return ConnectionTest(ok=False, error=str(exc))

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._conn.close()

    # ----------------------------------------------------------------- helpers

    def _table_exists(self) -> bool:
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT to_regclass(%s)", (self._table,))
                row = cur.fetchone()
            return row is not None and row[0] is not None
        except Exception as exc:
            logger.warning("table existence probe failed: %s", exc)
            return False

    def _ensure_table(self, vector_size: int) -> None:
        if self._table_exists():
            self._table_ready = True
            return
        logger.info(
            "Creating pgvector table %s (dim=%d, cosine)", self._table, vector_size
        )
        with self._conn.cursor() as cur:
            cur.execute(
                f"CREATE TABLE IF NOT EXISTS {self._table} ("
                "id TEXT PRIMARY KEY, "
                "text TEXT, "
                f"embedding vector({vector_size}), "
                "metadata JSONB"
                ")"
            )
        self._table_ready = True


def _is_valid_identifier(name: str) -> bool:
    """Cheap allow-list for an unquoted SQL identifier (used for the table name)."""
    if not name:
        return False
    head, *rest = name
    if not (head.isalpha() or head == "_"):
        return False
    return all(c.isalnum() or c == "_" for c in rest)


def _flatten_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """JSONB can hold rich structures, but we mirror the scalar discipline of
    the other adapters so metadata round-trips identically regardless of
    backend.
    """
    out: dict[str, Any] = {}
    for k, v in meta.items():
        if v is None or isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def _coerce_metadata(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, (str, bytes)):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}
