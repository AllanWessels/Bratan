"""Tests for the pgvector adapter.

There's no embedded Postgres; for hermetic unit tests we drive the adapter
against a recording mock of ``psycopg.connect`` and assert on the SQL
shapes emitted. That gives us a cheap, fast guard against accidental SQL
drift without requiring a database in CI.

Skipped cleanly when the optional ``psycopg`` / ``pgvector`` deps aren't
installed.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("psycopg")
pytest.importorskip("pgvector")

from pipeline.adapters.base import ChunkRecord
from pipeline.adapters.pgvector import (
    PgvectorAdapter,
    _coerce_metadata,
    _flatten_metadata,
    _is_valid_identifier,
)


def _chunk(id_: str, vec: list[float], **meta) -> ChunkRecord:
    return ChunkRecord(
        id=id_,
        text=meta.pop("text", f"chunk-{id_}"),
        embedding=vec,
        metadata={"path": "a.md", "start_line": 1, "end_line": 5, **meta},
    )


class _FakeCursor:
    """Records SQL queries and lets tests prime fetchone/fetchall results."""

    def __init__(self, fake_conn):
        self._conn = fake_conn
        self._last_sql: str | None = None
        self._last_params: tuple | None = None
        self._result: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._last_sql = sql
        self._last_params = params
        self._conn.queries.append({"sql": sql, "params": params})
        self._compute_result(sql, params)

    def executemany(self, sql, rows):
        self._last_sql = sql
        self._last_params = None
        for row in rows:
            self._conn.queries.append({"sql": sql, "params": row})
            self._compute_result(sql, row)

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)

    def _compute_result(self, sql: str, params):
        s = (sql or "").strip().lower()
        store = self._conn.store
        if s.startswith("select to_regclass"):
            self._result = [(self._conn.table_name,)] if self._conn.table_exists else [(None,)]
        elif s.startswith("create table"):
            self._conn.table_exists = True
            self._result = []
        elif s.startswith("insert into"):
            (rid, text, embedding, meta) = params
            store[rid] = {"text": text, "embedding": embedding, "metadata": meta}
            self._result = []
        elif s.startswith("delete from"):
            (ids,) = params
            for cid in ids:
                store.pop(cid, None)
            self._result = []
        elif s.startswith("select count(*)"):
            self._result = [(len(store),)]
        elif s.startswith("select id, text, metadata"):
            (vec, _vec2, limit) = params

            def _cos(a, b):
                num = sum(x * y for x, y in zip(a, b, strict=False))
                da = sum(x * x for x in a) ** 0.5 or 1.0
                db = sum(y * y for y in b) ** 0.5 or 1.0
                return num / (da * db)

            rows = [
                (rid, row["text"], row["metadata"], _cos(vec, row["embedding"]))
                for rid, row in store.items()
            ]
            # Cosine distance ordering: smaller distance == better == higher score
            rows.sort(key=lambda r: r[3], reverse=True)
            self._result = rows[:limit]
        elif s.startswith("select 1"):
            self._result = [(1,)]
        elif s.startswith("create extension"):
            self._result = []
        else:
            self._result = []


class _FakeConn:
    def __init__(self, *, table_exists: bool = False, table_name: str = "bratan_chunks") -> None:
        self.queries: list[dict] = []
        self.store: dict[str, dict] = {}
        self.table_exists = table_exists
        self.table_name = table_name
        self.closed = False

    def cursor(self):
        return _FakeCursor(self)

    def close(self):
        self.closed = True


@pytest.fixture
def fake_conn():
    return _FakeConn()


@pytest.fixture
def adapter(fake_conn):
    with patch("psycopg.connect", return_value=fake_conn), patch(
        "pgvector.psycopg.register_vector"
    ):
        yield PgvectorAdapter(dsn="postgresql://x", table="bratan_chunks")


def test_constructor_requires_dsn():
    with pytest.raises(ValueError, match="dsn"):
        PgvectorAdapter(dsn="")


def test_constructor_rejects_invalid_table_name():
    with pytest.raises(ValueError, match="Invalid table name"):
        PgvectorAdapter(dsn="postgresql://x", table="bad table; drop;")


def test_init_runs_create_extension(fake_conn):
    with patch("psycopg.connect", return_value=fake_conn), patch(
        "pgvector.psycopg.register_vector"
    ):
        PgvectorAdapter(dsn="postgresql://x")
    sqls = [q["sql"].lower() for q in fake_conn.queries]
    assert any("create extension if not exists vector" in s for s in sqls)


def test_upsert_creates_table_on_first_write(adapter, fake_conn):
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    creates = [q for q in fake_conn.queries if q["sql"].lower().lstrip().startswith("create table")]
    assert len(creates) == 1
    sql = creates[0]["sql"]
    assert "id TEXT PRIMARY KEY" in sql
    assert "vector(2)" in sql
    assert "metadata JSONB" in sql


def test_upsert_emits_on_conflict(adapter, fake_conn):
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    inserts = [q for q in fake_conn.queries if q["sql"].lstrip().lower().startswith("insert")]
    assert inserts
    assert "ON CONFLICT (id) DO UPDATE" in inserts[0]["sql"]


def test_upsert_idempotent(adapter, fake_conn):
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    assert adapter.count() == 1


def test_vector_query_returns_rows_in_similarity_order(adapter):
    adapter.upsert(
        [_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0]), _chunk("c", [-1.0, 0.0])]
    )
    hits = adapter.vector_query([1.0, 0.0], k=3)
    assert [h.id for h in hits] == ["a", "b", "c"]
    assert hits[0].score == pytest.approx(1.0, abs=1e-5)


def test_vector_query_uses_cosine_operator(adapter, fake_conn):
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    adapter.vector_query([1.0, 0.0], k=1)
    selects = [
        q for q in fake_conn.queries
        if q["sql"].lstrip().lower().startswith("select id, text")
    ]
    assert selects
    sql = selects[-1]["sql"]
    # <=> is pgvector's cosine distance operator.
    assert "<=>" in sql
    assert "::vector" in sql


def test_vector_query_metadata_round_trips(adapter):
    adapter.upsert([_chunk("a", [1.0, 0.0], path="doc.md", start_line=42)])
    hit = adapter.vector_query([1.0, 0.0], k=1)[0]
    assert hit.metadata["path"] == "doc.md"
    assert hit.metadata["start_line"] == 42


def test_hybrid_query_returns_none(adapter):
    assert adapter.hybrid_query_if_supported("anything", [1.0, 0.0], 5) is None


def test_delete_removes_specified(adapter):
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    adapter.delete(["a"])
    assert adapter.count() == 1


def test_delete_uses_any_array_arg(adapter, fake_conn):
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    adapter.delete(["a"])
    deletes = [q for q in fake_conn.queries if q["sql"].lstrip().lower().startswith("delete")]
    assert deletes
    assert "ANY(%s)" in deletes[-1]["sql"]


def test_delete_noop_before_table_exists():
    fake_conn = _FakeConn(table_exists=False)
    with patch("psycopg.connect", return_value=fake_conn), patch(
        "pgvector.psycopg.register_vector"
    ):
        a = PgvectorAdapter(dsn="postgresql://x")
        a.delete(["a", "b"])
    deletes = [q for q in fake_conn.queries if q["sql"].lstrip().lower().startswith("delete")]
    assert deletes == []


def test_count_zero_before_first_upsert(adapter):
    assert adapter.count() == 0


def test_count_after_upsert(adapter):
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    assert adapter.count() == 2


def test_health_check_ok(adapter):
    out = adapter.health_check()
    assert out.ok is True
    assert out.latency_ms is not None and out.latency_ms >= 0
    assert out.detail["table"] == "bratan_chunks"


def test_health_check_handles_sql_error():
    fake_conn = MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value.execute.side_effect = RuntimeError(
        "boom"
    )
    with patch("psycopg.connect", return_value=fake_conn), patch(
        "pgvector.psycopg.register_vector"
    ):
        a = PgvectorAdapter(dsn="postgresql://x")
        out = a.health_check()
    assert out.ok is False
    assert "boom" in (out.error or "")


def test_close_releases_conn(adapter, fake_conn):
    adapter.close()
    assert fake_conn.closed is True


def test_is_valid_identifier():
    assert _is_valid_identifier("good_name")
    assert _is_valid_identifier("_x")
    assert not _is_valid_identifier("")
    assert not _is_valid_identifier("1bad")
    assert not _is_valid_identifier("a; drop")
    assert not _is_valid_identifier("a-b")


def test_flatten_metadata_coerces_non_scalars():
    flat = _flatten_metadata({"s": "x", "n": 1, "b": True, "lst": [1, 2], "none": None})
    assert flat["s"] == "x"
    assert flat["n"] == 1
    assert flat["b"] is True
    assert flat["none"] is None
    assert isinstance(flat["lst"], str)


def test_coerce_metadata_handles_dict_and_json_string():
    assert _coerce_metadata({"a": 1}) == {"a": 1}
    assert _coerce_metadata('{"a": 1}') == {"a": 1}
    assert _coerce_metadata(None) == {}
    assert _coerce_metadata("nonsense") == {}
