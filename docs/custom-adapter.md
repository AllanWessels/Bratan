# Writing a custom vector-DB adapter

Bratan ships with five built-in adapters (Chroma, Qdrant, Pinecone, Weaviate,
pgvector). If your vector store isn't one of those — Milvus, LanceDB, Vespa,
Redis, your own KV-and-numpy thing — you can plug it in by subclassing the
`VectorDBAdapter` ABC and pointing the setup wizard at your class.

You don't fork Bratan. You publish (or just import-locally) a module with
one class, and Bratan loads it at runtime.

## The contract

Every adapter implements `pipeline.adapters.base.VectorDBAdapter`:

```python
class VectorDBAdapter(ABC):
    @abstractmethod
    def upsert(self, items: list[ChunkRecord]) -> None: ...

    @abstractmethod
    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]: ...

    @abstractmethod
    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None: ...

    @abstractmethod
    def delete(self, ids: list[str]) -> None: ...

    @abstractmethod
    def count(self) -> int: ...

    @abstractmethod
    def health_check(self) -> ConnectionTest: ...
```

`ChunkRecord` and `QueryHit` are tiny pydantic models in the same file. The
only metadata fields the rest of the pipeline relies on are `path`,
`start_line`, and `end_line` — preserve those on the round trip and your
adapter is interoperable with everything above the line.

`hybrid_query_if_supported` returns `None` when your store has no native
BM25; the caller stitches together its own hybrid path in that case. Return
real hits only when your backend actually fuses sparse + dense for you
(Weaviate is the bundled example).

## A worked example: Milvus

```python
# myproject/adapters/milvus.py
from __future__ import annotations

import time
from typing import Any

from pymilvus import MilvusClient

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest


class MilvusAdapter(VectorDBAdapter):
    """Milvus-backed VectorDBAdapter.

    Constructor accepts the full vector-DB config as keyword arguments —
    Bratan calls `MilvusAdapter(**cfg.vector_db.model_dump())` so you can
    cherry-pick whichever fields you care about. Anything you don't
    declare on the wizard's "Other" panel can be threaded in via
    environment variables or your own config file.
    """

    def __init__(self, *, pgvector_dsn: str | None = None, **_: Any) -> None:
        # Hijack `pgvector_dsn` as a Milvus URI to avoid adding a UI field.
        # Or read MILVUS_URI from the environment — your call.
        uri = pgvector_dsn or "http://localhost:19530"
        self._client = MilvusClient(uri=uri)
        self._collection = "bratan"
        self._ready = self._client.has_collection(self._collection)

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
        if not self._ready:
            self._client.create_collection(
                collection_name=self._collection,
                dimension=len(items[0].embedding),
                metric_type="COSINE",
            )
            self._ready = True
        rows = [
            {"id": it.id, "vector": it.embedding, "text": it.text, **it.metadata}
            for it in items
        ]
        self._client.upsert(collection_name=self._collection, data=rows)

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        if not self._ready:
            return []
        res = self._client.search(
            collection_name=self._collection,
            data=[embedding],
            limit=max(1, k),
            output_fields=["text", "path", "start_line", "end_line"],
        )
        return [
            QueryHit(
                id=str(hit["id"]),
                text=hit["entity"].get("text", ""),
                score=float(hit["distance"]),
                metadata={k: v for k, v in hit["entity"].items() if k != "text"},
            )
            for hit in res[0]
        ]

    def hybrid_query_if_supported(self, text, embedding, k):
        # Milvus 2.4+ supports sparse + dense fusion via WeightedRanker,
        # but requires declaring sparse vectors at collection-create time.
        # Return None for now and let Bratan stitch the hybrid path.
        return None

    def delete(self, ids: list[str]) -> None:
        if ids and self._ready:
            self._client.delete(collection_name=self._collection, ids=ids)

    def count(self) -> int:
        if not self._ready:
            return 0
        stats = self._client.get_collection_stats(self._collection)
        return int(stats.get("row_count", 0))

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            cols = self._client.list_collections()
            return ConnectionTest(
                ok=True,
                latency_ms=(time.perf_counter() - t0) * 1000.0,
                detail={"collections": cols, "ready": self._ready},
            )
        except Exception as exc:
            return ConnectionTest(ok=False, error=str(exc))
```

## Wiring it in

1. Make sure your module is importable from wherever Bratan runs
   (install your package with `uv pip install -e ./myproject`, or put
   it on `PYTHONPATH`).
2. In the setup wizard's Step 2, pick **Other / custom**.
3. Fill in:
   - **Module path**: `myproject.adapters.milvus`
   - **Class name**: `MilvusAdapter`
4. Click **Test connection** — Bratan will import your class, instantiate
   it with the vector-DB config kwargs, and call `health_check()`.

If you'd rather not accept the vector-DB config kwargs, define a zero-arg
constructor — Bratan falls back to `cls()` if `cls(**cfg.vector_db.model_dump())`
raises `TypeError`. In that case, your adapter is responsible for reading
its own configuration from environment variables or a config file.

## Things the loop expects from your adapter

- **Idempotent upsert.** Re-upserting the same `id` must replace, not
  duplicate. The blue team relies on this for ablation studies.
- **Stable ordering by score.** Higher score = more similar. Map cosine
  distance to `1 - distance` so scores line up with the other adapters.
- **`count()` cheap.** It's called once per iteration to detect ingest
  drift. Don't scan the table.
- **`health_check()` never raises.** Catch exceptions and return
  `ConnectionTest(ok=False, error=str(exc))` so the wizard can show a
  red badge instead of crashing.

If your backend supports native hybrid (BM25 + vector) fusion, implement
`hybrid_query_if_supported` to return real hits — Bratan will use those
instead of stitching together its own hybrid pipeline, and your retrieval
will be measurably faster.
