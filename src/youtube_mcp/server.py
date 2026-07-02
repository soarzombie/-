"""YouTube MCP server.

Exposes four tools over the Model Context Protocol:

* ``search_youtube`` – search YouTube for videos.
* ``get_transcript`` – fetch a video's transcript.
* ``store_video_info`` – persist a transcript into the vector store.
* ``search_transcripts`` – semantic search across stored transcripts.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from . import youtube
from .store import TranscriptStore

mcp = FastMCP("youtube-mcp")

# The store lazily initialises Chroma (and downloads the local embedding model
# on first use), so build it on demand rather than at import time.
_store: TranscriptStore | None = None


def _get_store() -> TranscriptStore:
    global _store
    if _store is None:
        _store = TranscriptStore()
    return _store


def _dump(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool()
def search_youtube(query: str, max_results: int = 5) -> str:
    """Search YouTube for videos matching a query.

    Args:
        query: The search text.
        max_results: How many videos to return (1-50, default 5).

    Returns a JSON list of videos with id, title, url, channel, duration and
    view count.
    """

    videos = youtube.search_videos(query, max_results)
    return _dump({"query": query, "count": len(videos), "results": videos})


@mcp.tool()
def get_transcript(url: str, languages: list[str] | None = None) -> str:
    """Fetch the transcript for a YouTube video.

    Args:
        url: A YouTube video URL or bare 11-character video id.
        languages: Preferred transcript language codes, e.g. ["en", "es"].
            Falls back to any available transcript when the preferred ones are
            missing.

    Returns JSON with the video id and the full transcript text.
    """

    try:
        result = youtube.get_transcript(url, languages)
    except ValueError as exc:
        return _dump({"error": str(exc)})

    return _dump(
        {
            "video_id": result["video_id"],
            "text": result["text"],
            "segment_count": len(result["segments"]),
        }
    )


@mcp.tool()
def store_video_info(
    url: str,
    title: str | None = None,
    transcript: str | None = None,
    languages: list[str] | None = None,
) -> str:
    """Store a video's transcript in the vector database for later search.

    Args:
        url: A YouTube video URL or bare video id.
        title: Optional human-readable title stored as metadata.
        transcript: Optional transcript text. When omitted the transcript is
            fetched automatically.
        languages: Preferred languages used when the transcript is fetched.

    Returns JSON describing how many chunks were stored.
    """

    try:
        video_id = youtube.extract_video_id(url)
        if transcript is None:
            transcript = youtube.get_transcript(url, languages)["text"]
        metadata = {"title": title, "url": f"https://www.youtube.com/watch?v={video_id}"}
        chunks = _get_store().store(video_id, transcript, metadata)
    except ValueError as exc:
        return _dump({"error": str(exc)})

    return _dump(
        {
            "video_id": video_id,
            "stored_chunks": chunks,
            "total_chunks_in_store": _get_store().count(),
        }
    )


@mcp.tool()
def search_transcripts(query: str, max_results: int = 5) -> str:
    """Semantic search across transcripts stored via ``store_video_info``.

    Args:
        query: Natural-language search text.
        max_results: How many matches to return (1-50, default 5).

    Returns JSON with the best-matching transcript chunks and similarity scores.
    """

    results = _get_store().search(query, max_results)
    return _dump({"query": query, "count": len(results), "results": results})


def main() -> None:
    """Console-script entry point: run the server over stdio."""

    mcp.run()


if __name__ == "__main__":
    main()
