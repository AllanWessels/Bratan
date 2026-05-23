"""Local sentence-transformers embedder, GPU-preferred.

BGE convention: passages are embedded raw; queries are prefixed with a fixed
instruction string. Use `embed()` for documents and `embed_query()` for the
search-side question.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)

_BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
_DEFAULT_MODEL = "BAAI/bge-large-en-v1.5"
_DEFAULT_BATCH = 32


class LocalEmbedder:
    """Wraps a sentence-transformers model with batching + device selection."""

    def __init__(self, model_name: str = _DEFAULT_MODEL, batch_size: int = _DEFAULT_BATCH) -> None:
        self.model_name = model_name
        self.batch_size = batch_size
        self._device = _pick_device()
        self._model: Any | None = None
        self._lock = threading.Lock()

    def _ensure_loaded(self) -> Any:
        if self._model is None:
            with self._lock:
                if self._model is None:
                    from sentence_transformers import SentenceTransformer

                    logger.info(
                        "Loading embedder %s on %s", self.model_name, self._device
                    )
                    self._model = SentenceTransformer(self.model_name, device=self._device)
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._ensure_loaded()
        vectors = model.encode(
            texts,
            batch_size=self.batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return [v.tolist() for v in vectors]

    def embed_one(self, text: str) -> list[float]:
        return self.embed([text])[0]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_one(_BGE_QUERY_PREFIX + text)

    @property
    def device(self) -> str:
        return self._device


def _pick_device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception as exc:
        logger.warning("torch device detection failed: %s", exc)
    return "cpu"


_singleton_lock = threading.Lock()
_singleton: LocalEmbedder | None = None
_singleton_model_name: str | None = None


def get_embedder(model: str | None = None) -> LocalEmbedder:
    """Process-wide cached embedder. Re-instantiates if the model name changes."""
    global _singleton, _singleton_model_name
    requested = model or _DEFAULT_MODEL
    with _singleton_lock:
        if _singleton is None or _singleton_model_name != requested:
            _singleton = LocalEmbedder(model_name=requested)
            _singleton_model_name = requested
        return _singleton
