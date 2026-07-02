# CLAUDE.md

This file provides guidance to Claude Code (and other AI assistants) when working in this repository.

## Project Overview

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes YouTube capabilities to MCP clients: search, transcript retrieval, and semantic search over a locally-stored transcript library. It is designed to run with no API keys — search uses `yt-dlp`, transcripts use `youtube-transcript-api`, and semantic search uses ChromaDB with a bundled local embedding model.

- **Language / runtime:** Python 3.11+
- **Framework(s):** MCP Python SDK (`mcp`, FastMCP); ChromaDB for vector storage
- **Package manager:** uv

## Repository Structure

```
.
├── src/youtube_mcp/
│   ├── __init__.py
│   ├── server.py      # FastMCP server; defines the four MCP tools
│   ├── youtube.py     # search_videos, get_transcript, extract_video_id
│   └── store.py       # TranscriptStore: ChromaDB vector store + chunking
├── tests/             # offline unit tests (no network)
├── pyproject.toml     # deps + `youtube-mcp` console script entry point
└── README.md
```

## Development Workflow

### Setup

```bash
uv sync
```

### Run

```bash
uv run youtube-mcp            # console script (stdio server)
uv run python -m youtube_mcp.server
```

### Test

```bash
uv run pytest
```

## Tools exposed

- `search_youtube(query, max_results=5)`
- `get_transcript(url, languages=None)`
- `store_video_info(url, title=None, transcript=None, languages=None)`
- `search_transcripts(query, max_results=5)`

Each tool returns a JSON string. Errors surface as `{"error": "..."}` rather than raising through the MCP layer.

## Conventions

- **Code style:** standard library `from __future__ import annotations`; type hints throughout; keep YouTube/network logic in `youtube.py` and `store.py`, keep `server.py` thin (tool registration + JSON serialization).
- **Embeddings:** default to the local ChromaDB model (no key). Google embeddings activate only when `GOOGLE_API_KEY` is set.
- **Config:** all via environment variables (`YT_MCP_STORE_PATH`, `GOOGLE_API_KEY`, `YT_MCP_EMBED_MODEL`); see `.env.example`.
- **Testing:** unit tests must not require network access. Tests that would call YouTube belong behind explicit opt-in, not the default suite.

## Notes for AI Assistants

- `youtube-transcript-api` is v1.x here: use the instance API (`YouTubeTranscriptApi().fetch(...)` / `.list(...)`), not the removed 0.6.x static `get_transcript`.
- Some sandboxed environments block outbound `youtube.com`; search/transcript tools then fail at runtime even though the code is correct. The vector store works offline.
- Develop on feature branches; open a pull request only when explicitly requested.
- When you learn something durable about how this project is built, run, or structured, record it here.
