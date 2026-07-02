"""Tests that do not require network access."""

import pytest

from youtube_mcp import youtube


@pytest.mark.parametrize(
    "value",
    [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc&index=2",
        "dQw4w9WgXcQ",
    ],
)
def test_extract_video_id(value):
    assert youtube.extract_video_id(value) == "dQw4w9WgXcQ"


def test_extract_video_id_invalid():
    with pytest.raises(ValueError):
        youtube.extract_video_id("not a youtube link")


def test_chunking_roundtrip():
    from youtube_mcp.store import _chunk_text

    assert _chunk_text("") == []
    assert _chunk_text("short text") == ["short text"]

    long_text = "word " * 1000  # ~5000 chars -> multiple chunks
    chunks = _chunk_text(long_text)
    assert len(chunks) > 1
    # Chunks overlap, so the concatenated length exceeds the original.
    assert sum(len(c) for c in chunks) >= len(long_text.strip())
