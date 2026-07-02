"""Persistent transcript store backed by ChromaDB.

By default ChromaDB embeds documents locally with the bundled
``all-MiniLM-L6-v2`` model, so semantic search works with no external API key.
Set ``GOOGLE_API_KEY`` (and optionally ``YT_MCP_EMBED_MODEL``) to switch to
Google's embedding models instead.
"""

from __future__ import annotations

import os
from typing import Any

import chromadb
from chromadb.config import Settings
from chromadb.utils import embedding_functions

_COLLECTION_NAME = "youtube_transcripts"
# Chroma keeps a small headroom below the model limit; chunk conservatively.
_CHUNK_CHARS = 2000
_CHUNK_OVERLAP = 200


def _default_store_path() -> str:
    return os.environ.get(
        "YT_MCP_STORE_PATH",
        os.path.join(os.getcwd(), ".youtube_mcp_store"),
    )


def _build_embedding_function():
    """Pick an embedding function based on the environment.

    Uses Google's API when ``GOOGLE_API_KEY`` is present, otherwise falls back
    to Chroma's local sentence-transformer default.
    """

    api_key = os.environ.get("GOOGLE_API_KEY")
    if api_key:
        model = os.environ.get("YT_MCP_EMBED_MODEL", "models/text-embedding-004")
        return embedding_functions.GoogleGenerativeAiEmbeddingFunction(
            api_key=api_key, model_name=model
        )
    return embedding_functions.DefaultEmbeddingFunction()


def _chunk_text(text: str) -> list[str]:
    """Split long transcripts into overlapping character chunks."""

    text = text.strip()
    if len(text) <= _CHUNK_CHARS:
        return [text] if text else []

    chunks: list[str] = []
    start = 0
    step = _CHUNK_CHARS - _CHUNK_OVERLAP
    while start < len(text):
        chunks.append(text[start : start + _CHUNK_CHARS])
        start += step
    return chunks


class TranscriptStore:
    """Thin wrapper around a persistent Chroma collection."""

    def __init__(self, path: str | None = None):
        self._client = chromadb.PersistentClient(
            path=path or _default_store_path(),
            settings=Settings(anonymized_telemetry=False, allow_reset=True),
        )
        self._collection = self._client.get_or_create_collection(
            name=_COLLECTION_NAME,
            embedding_function=_build_embedding_function(),
            metadata={"hnsw:space": "cosine"},
        )

    def store(
        self,
        video_id: str,
        transcript: str,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        """Store a transcript, replacing any prior version for the video.

        Returns the number of chunks written.
        """

        chunks = _chunk_text(transcript)
        if not chunks:
            raise ValueError("Refusing to store an empty transcript.")

        # Drop existing chunks for this video so re-stores stay idempotent.
        self._collection.delete(where={"video_id": video_id})

        base_metadata = {k: v for k, v in (metadata or {}).items() if v is not None}
        ids = [f"{video_id}::{i}" for i in range(len(chunks))]
        metadatas = [
            {**base_metadata, "video_id": video_id, "chunk": i}
            for i in range(len(chunks))
        ]
        self._collection.add(ids=ids, documents=chunks, metadatas=metadatas)
        return len(chunks)

    def search(self, query: str, max_results: int = 5) -> list[dict[str, Any]]:
        """Semantic search across stored transcript chunks."""

        max_results = max(1, min(int(max_results), 50))
        if self._collection.count() == 0:
            return []

        response = self._collection.query(
            query_texts=[query],
            n_results=max_results,
        )

        documents = (response.get("documents") or [[]])[0]
        metadatas = (response.get("metadatas") or [[]])[0]
        distances = (response.get("distances") or [[]])[0]

        results: list[dict[str, Any]] = []
        for document, meta, distance in zip(documents, metadatas, distances):
            meta = meta or {}
            results.append(
                {
                    "video_id": meta.get("video_id"),
                    "text": document,
                    "metadata": {
                        k: v for k, v in meta.items() if k not in {"video_id", "chunk"}
                    },
                    "score": round(1 - distance, 4) if distance is not None else None,
                }
            )
        return results

    def count(self) -> int:
        return self._collection.count()
