"""Turning caller-supplied image references into files on disk, under bounds.

Every limit here had no counterpart before. `/exec` accepted an unbounded list
of images; each data URL was base64-decoded into memory in full before anything
looked at its size; the only cap was 10 MiB *per remote download*, with no
aggregate; nothing checked that the bytes were an image at all, so the runner
would happily write an attacker-chosen blob into the CLI's home directory with
a `.png` name derived from an attacker-chosen MIME type.

The bounds are read from the environment so an operator can tighten them, and
they fail closed: an unparseable override is a startup error rather than a
silent return to the default.
"""

from __future__ import annotations

import base64
import binascii
import os
import re
from dataclasses import dataclass
from typing import Callable, Optional

from network_policy import UrlPolicyError, fetch

DATA_URL_RE = re.compile(
    r"^data:(?P<mime>[-\w.+/]+)?(?:;charset=[^;,]+)?;base64,(?P<data>.+)$",
    re.IGNORECASE | re.DOTALL,
)


class ImagePolicyError(ValueError):
    """The image reference is not one this runner is willing to materialize."""


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    raw = (os.getenv(name) or "").strip()
    if raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}, got {value}")
    return value


@dataclass(frozen=True)
class ImageLimits:
    max_images: int
    max_image_bytes: int
    max_total_bytes: int

    @classmethod
    def from_environment(cls) -> "ImageLimits":
        return cls(
            max_images=_int_env("RUNNER_MAX_IMAGES", 8),
            max_image_bytes=_int_env("RUNNER_MAX_IMAGE_BYTES", 10 * 1024 * 1024),
            max_total_bytes=_int_env("RUNNER_MAX_IMAGE_TOTAL_BYTES", 32 * 1024 * 1024),
        )


#: MIME types the engines can actually read, mapped to their canonical suffix.
#: An allowlist rather than `mimetypes.guess_extension`, which will happily
#: invent a suffix for `application/x-sh`.
ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

#: Leading bytes each format must start with. The declared MIME type is a claim
#: by the caller; this is the file itself answering.
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def sniff_image_type(raw: bytes) -> Optional[str]:
    """The image type the bytes actually are, or None."""
    for prefix, mime in _MAGIC:
        if raw.startswith(prefix):
            return mime
    # WebP is a RIFF container: "RIFF" <4 byte size> "WEBP".
    if len(raw) >= 12 and raw[0:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def _validated_suffix(raw: bytes, declared: Optional[str]) -> str:
    """Suffix for content that is genuinely an allowed image type.

    The sniffed type wins over the declared one, and a declared type that
    contradicts the bytes is rejected outright rather than quietly corrected —
    the mismatch is the interesting signal, not something to paper over.
    """
    sniffed = sniff_image_type(raw)
    if sniffed is None:
        raise ImagePolicyError(
            "image content is not a supported image (png, jpeg, gif, webp)"
        )
    normalized = (declared or "").split(";", 1)[0].strip().lower()
    if normalized and normalized != sniffed:
        raise ImagePolicyError(
            f"image declares {normalized} but its content is {sniffed}"
        )
    return ALLOWED_IMAGE_TYPES[sniffed]


def decode_data_url(url: str, limits: ImageLimits) -> tuple[bytes, Optional[str]]:
    """Decode a base64 data URL, refusing over-size input before decoding it.

    base64 inflates by 4/3, so the encoded length gives an exact lower bound on
    the decoded size. Checking it first means a 900 MB data URL is rejected
    without ever being materialized in memory, which the previous
    decode-then-look-at-it order could not do.
    """
    match = DATA_URL_RE.match(url.strip())
    if not match:
        raise ImagePolicyError("invalid base64 image data URL")

    encoded = match.group("data")
    approx_decoded = (len(encoded) * 3) // 4
    if approx_decoded > limits.max_image_bytes:
        raise ImagePolicyError(
            f"image data URL exceeds the maximum of {limits.max_image_bytes} bytes"
        )

    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImagePolicyError(f"invalid base64 image data URL: {exc}") from exc

    if not raw:
        raise ImagePolicyError("image data URL is empty")
    if len(raw) > limits.max_image_bytes:
        raise ImagePolicyError(
            f"image data URL exceeds the maximum of {limits.max_image_bytes} bytes"
        )
    return raw, match.group("mime")


def fetch_remote_image(
    url: str,
    limits: ImageLimits,
    *,
    fetcher: Callable[..., object] = fetch,
) -> tuple[bytes, Optional[str]]:
    """Download one image under the full outbound policy."""
    from urllib import parse as urllib_parse

    parsed = urllib_parse.urlparse(url)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    try:
        result = fetcher(
            parsed.scheme,
            parsed.hostname,
            parsed.port,
            path,
            max_bytes=limits.max_image_bytes,
        )
    except UrlPolicyError as exc:
        raise ImagePolicyError(str(exc)) from exc

    body = getattr(result, "body", b"")
    if not body:
        raise ImagePolicyError("downloaded image is empty")
    return body, getattr(result, "content_type", None)


def materialize_images(
    urls: list[str],
    image_dir: str,
    limits: ImageLimits,
    *,
    fetcher: Callable[..., object] = fetch,
) -> list[str]:
    """Write every referenced image into `image_dir`, or raise before writing.

    The aggregate cap is enforced as the files accumulate, so a caller cannot
    slip past a per-image limit by sending many images that are each just under
    it. Partial output is cleaned up by the caller's temporary-home teardown;
    nothing here leaves a half-written set behind on its own error path.
    """
    if len(urls) > limits.max_images:
        raise ImagePolicyError(
            f"too many images: {len(urls)} exceeds the maximum of {limits.max_images}"
        )

    os.makedirs(image_dir, exist_ok=True)
    paths: list[str] = []
    total = 0

    for index, url in enumerate(urls, start=1):
        stripped = (url or "").strip()
        if not stripped:
            raise ImagePolicyError("image URL is empty")

        if stripped.lower().startswith("data:"):
            raw, declared = decode_data_url(stripped, limits)
        elif stripped.lower().startswith(("http://", "https://")):
            raw, declared = fetch_remote_image(stripped, limits, fetcher=fetcher)
        else:
            raise ImagePolicyError("image URLs must use http, https, or data")

        total += len(raw)
        if total > limits.max_total_bytes:
            raise ImagePolicyError(
                f"images total {total} bytes, over the maximum of {limits.max_total_bytes}"
            )

        suffix = _validated_suffix(raw, declared)
        path = os.path.join(image_dir, f"image-{index}{suffix}")
        with open(path, "wb") as fh:
            fh.write(raw)
        paths.append(path)

    return paths
