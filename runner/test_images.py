"""Bounds on what an /exec caller can make the runner write to disk.

None of these limits existed. The image list was unbounded, each data URL was
base64-decoded in full before anything looked at its size, the only cap was
10 MiB per *remote* download with no aggregate, and nothing checked the bytes
were an image — so a caller could name `image/png` and have arbitrary content
written into the CLI's home directory under a `.png` name.
"""

import base64
import os
import shutil
import tempfile
import unittest

import images
from images import ImageLimits, ImagePolicyError

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
GIF = b"GIF89a" + b"\x00" * 32
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 16


def data_url(raw: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def limits(**overrides) -> ImageLimits:
    base = {"max_images": 4, "max_image_bytes": 4096, "max_total_bytes": 8192}
    base.update(overrides)
    return ImageLimits(**base)


class FakeFetch:
    """Stand-in for `network_policy.fetch`, recording what it was asked for."""

    def __init__(self, body=PNG, content_type="image/png"):
        self.body = body
        self.content_type = content_type
        self.calls = []

    def __call__(self, scheme, hostname, port, path, *, max_bytes, **kwargs):
        self.calls.append((scheme, hostname, port, path, max_bytes))

        class _Result:
            pass

        result = _Result()
        result.body = self.body
        result.content_type = self.content_type
        return result


class SniffTest(unittest.TestCase):
    def test_recognises_each_supported_format(self):
        self.assertEqual("image/png", images.sniff_image_type(PNG))
        self.assertEqual("image/jpeg", images.sniff_image_type(JPEG))
        self.assertEqual("image/gif", images.sniff_image_type(GIF))
        self.assertEqual("image/webp", images.sniff_image_type(WEBP))

    def test_returns_none_for_anything_else(self):
        for raw in (b"", b"#!/bin/sh\n", b"%PDF-1.7", b"RIFF\x00\x00\x00\x00AVI "):
            with self.subTest(raw=raw[:8]):
                self.assertIsNone(images.sniff_image_type(raw))


class DataUrlTest(unittest.TestCase):
    def test_decodes_a_well_formed_data_url(self):
        raw, mime = images.decode_data_url(data_url(PNG), limits())
        self.assertEqual(PNG, raw)
        self.assertEqual("image/png", mime)

    def test_rejects_a_malformed_data_url(self):
        for url in ("data:image/png,notbase64", "data:;base64,", "notadata:url", "data:image/png;base64,"):
            with self.subTest(url=url):
                with self.assertRaises(ImagePolicyError):
                    images.decode_data_url(url, limits())

    def test_rejects_invalid_base64(self):
        with self.assertRaises(ImagePolicyError):
            images.decode_data_url("data:image/png;base64,!!!!not-base64!!!!", limits())

    def test_rejects_an_empty_payload(self):
        with self.assertRaises(ImagePolicyError):
            images.decode_data_url(data_url(b""), limits())

    def test_refuses_an_oversized_data_url_before_decoding_it(self):
        # The encoded length bounds the decoded size, so the refusal happens
        # without ever materializing the payload in memory.
        encoded = "A" * (4096 * 4)
        with self.assertRaises(ImagePolicyError) as caught:
            images.decode_data_url(f"data:image/png;base64,{encoded}", limits(max_image_bytes=1024))
        self.assertIn("maximum", str(caught.exception))


class MaterializeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_writes_each_image_with_the_suffix_its_content_earns(self):
        paths = images.materialize_images(
            [data_url(PNG), data_url(JPEG, "image/jpeg"), data_url(GIF, "image/gif")],
            self.dir,
            limits(),
        )
        self.assertEqual(
            [
                os.path.join(self.dir, "image-1.png"),
                os.path.join(self.dir, "image-2.jpg"),
                os.path.join(self.dir, "image-3.gif"),
            ],
            paths,
        )
        with open(paths[0], "rb") as fh:
            self.assertEqual(PNG, fh.read())

    def test_rejects_content_that_is_not_an_image(self):
        with self.assertRaises(ImagePolicyError) as caught:
            images.materialize_images([data_url(b"#!/bin/sh\nrm -rf /\n")], self.dir, limits())
        self.assertIn("not a supported image", str(caught.exception))

    def test_rejects_a_declared_type_that_contradicts_the_bytes(self):
        # A JPEG announced as PNG is either a confused client or someone
        # probing what the suffix controls; either way it is not written.
        with self.assertRaises(ImagePolicyError) as caught:
            images.materialize_images([data_url(JPEG, "image/png")], self.dir, limits())
        self.assertIn("declares image/png", str(caught.exception))

    def test_rejects_a_type_outside_the_allowlist(self):
        with self.assertRaises(ImagePolicyError):
            images.materialize_images([data_url(b"%PDF-1.7\n", "application/pdf")], self.dir, limits())

    def test_enforces_the_image_count_cap(self):
        with self.assertRaises(ImagePolicyError) as caught:
            images.materialize_images([data_url(PNG)] * 5, self.dir, limits(max_images=4))
        self.assertIn("too many images", str(caught.exception))

    def test_enforces_the_aggregate_cap_across_images_that_each_fit(self):
        big = PNG + b"\x00" * 3000
        # Each is under max_image_bytes; together they are over max_total_bytes.
        with self.assertRaises(ImagePolicyError) as caught:
            images.materialize_images(
                [data_url(big), data_url(big), data_url(big)],
                self.dir,
                limits(max_image_bytes=4096, max_total_bytes=5000),
            )
        self.assertIn("over the maximum", str(caught.exception))

    def test_rejects_a_blank_url(self):
        with self.assertRaises(ImagePolicyError):
            images.materialize_images(["   "], self.dir, limits())

    def test_rejects_schemes_other_than_http_https_and_data(self):
        for url in ("ftp://h/x.png", "file:///etc/passwd", "gopher://h/x"):
            with self.subTest(url=url):
                with self.assertRaises(ImagePolicyError) as caught:
                    images.materialize_images([url], self.dir, limits())
                self.assertIn("http, https, or data", str(caught.exception))

    def test_remote_images_go_through_the_network_policy_with_the_per_image_cap(self):
        fetcher = FakeFetch()
        paths = images.materialize_images(
            ["https://images.example.com/a/pic.png?v=2"],
            self.dir,
            limits(max_image_bytes=4096),
            fetcher=fetcher,
        )
        self.assertEqual([os.path.join(self.dir, "image-1.png")], paths)
        self.assertEqual(
            [("https", "images.example.com", None, "/a/pic.png?v=2", 4096)], fetcher.calls
        )

    def test_an_empty_remote_body_is_refused(self):
        with self.assertRaises(ImagePolicyError):
            images.materialize_images(
                ["https://images.example.com/pic.png"],
                self.dir,
                limits(),
                fetcher=FakeFetch(body=b""),
            )

    def test_a_remote_body_that_is_not_an_image_is_refused(self):
        with self.assertRaises(ImagePolicyError):
            images.materialize_images(
                ["https://images.example.com/pic.png"],
                self.dir,
                limits(),
                fetcher=FakeFetch(body=b"<html>nope</html>", content_type="text/html"),
            )


class LimitsFromEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.saved = {
            key: os.environ.get(key)
            for key in ("RUNNER_MAX_IMAGES", "RUNNER_MAX_IMAGE_BYTES", "RUNNER_MAX_IMAGE_TOTAL_BYTES")
        }

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_defaults_when_unset(self):
        for key in self.saved:
            os.environ.pop(key, None)
        resolved = ImageLimits.from_environment()
        self.assertEqual(8, resolved.max_images)
        self.assertEqual(10 * 1024 * 1024, resolved.max_image_bytes)
        self.assertEqual(32 * 1024 * 1024, resolved.max_total_bytes)

    def test_an_operator_can_tighten_them(self):
        os.environ["RUNNER_MAX_IMAGES"] = "2"
        os.environ["RUNNER_MAX_IMAGE_BYTES"] = "1024"
        resolved = ImageLimits.from_environment()
        self.assertEqual(2, resolved.max_images)
        self.assertEqual(1024, resolved.max_image_bytes)

    def test_a_bad_override_fails_loudly_instead_of_falling_back(self):
        os.environ["RUNNER_MAX_IMAGES"] = "lots"
        with self.assertRaises(ValueError):
            ImageLimits.from_environment()

        os.environ["RUNNER_MAX_IMAGES"] = "0"
        with self.assertRaises(ValueError):
            ImageLimits.from_environment()
