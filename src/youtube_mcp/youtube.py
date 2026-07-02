"""YouTube search and transcript helpers.

Both features work without an official YouTube Data API key:

* Search uses ``yt-dlp``'s ``ytsearch`` provider, which reads the same public
  data the website serves.
* Transcripts use ``youtube-transcript-api``, which fetches the caption tracks
  YouTube exposes for a video.
"""

from __future__ import annotations

import re
from typing import Any

from yt_dlp import YoutubeDL
from youtube_transcript_api import (
    NoTranscriptFound,
    TranscriptsDisabled,
    YouTubeTranscriptApi,
)
from youtube_transcript_api._errors import CouldNotRetrieveTranscript

_YOUTUBE_ID_RE = re.compile(r"^[0-9A-Za-z_-]{11}$")


def extract_video_id(url_or_id: str) -> str:
    """Return the 11-character video id from a URL or a bare id.

    Accepts the common URL shapes (``watch?v=``, ``youtu.be/``, ``/shorts/``,
    ``/embed/``) as well as an id passed directly. Raises ``ValueError`` when no
    id can be recovered.
    """

    candidate = url_or_id.strip()
    if _YOUTUBE_ID_RE.match(candidate):
        return candidate

    patterns = (
        r"(?:v=|/shorts/|/embed/|/v/|youtu\.be/)([0-9A-Za-z_-]{11})",
        r"^([0-9A-Za-z_-]{11})$",
    )
    for pattern in patterns:
        match = re.search(pattern, candidate)
        if match:
            return match.group(1)

    raise ValueError(f"Could not extract a YouTube video id from: {url_or_id!r}")


def search_videos(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search YouTube and return a list of video metadata dictionaries."""

    max_results = max(1, min(int(max_results), 50))
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "default_search": "ytsearch",
    }

    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch{max_results}:{query}", download=False)

    entries = (info or {}).get("entries") or []
    results: list[dict[str, Any]] = []
    for entry in entries:
        if not entry:
            continue
        video_id = entry.get("id")
        results.append(
            {
                "video_id": video_id,
                "title": entry.get("title"),
                "url": entry.get("url") or f"https://www.youtube.com/watch?v={video_id}",
                "channel": entry.get("channel") or entry.get("uploader"),
                "duration": entry.get("duration"),
                "view_count": entry.get("view_count"),
            }
        )
    return results


def get_transcript(url_or_id: str, languages: list[str] | None = None) -> dict[str, Any]:
    """Fetch the transcript for a video.

    Returns a dict with the resolved ``video_id``, the joined ``text`` and the
    raw timed ``segments``. Raises ``ValueError`` with a friendly message when
    no transcript is available.
    """

    video_id = extract_video_id(url_or_id)
    languages = languages or ["en"]

    api = YouTubeTranscriptApi()
    try:
        fetched = api.fetch(video_id, languages=languages)
    except (TranscriptsDisabled, NoTranscriptFound):
        # Preferred languages missing: fall back to whatever the video offers.
        try:
            transcript_list = api.list(video_id)
            transcript = next(iter(transcript_list))
            fetched = transcript.fetch()
        except CouldNotRetrieveTranscript as exc:
            raise ValueError(
                f"No transcript available for video {video_id}: {exc}"
            ) from exc
    except CouldNotRetrieveTranscript as exc:
        raise ValueError(
            f"No transcript available for video {video_id}: {exc}"
        ) from exc

    segments = fetched.to_raw_data()
    text = " ".join(
        segment["text"].strip() for segment in segments if segment.get("text")
    )
    return {"video_id": video_id, "text": text, "segments": segments}
