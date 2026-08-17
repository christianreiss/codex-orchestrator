"""Outbound fetch policy for operator-supplied URLs.

The runner downloads images whose URL comes straight from an API caller, from
inside the compose network, next to the orchestrator and its database. That is
an SSRF primitive unless every hop is constrained, and the previous
implementation had the classic gap: `_assert_public_host` resolved the hostname
with `getaddrinfo`, approved the answer, and then handed the *hostname* back to
`urllib`, which resolved it a second time. Between those two lookups an
attacker-controlled DNS record only has to change once — a rebind — and the
connection lands on 169.254.169.254 or the MySQL container with the check
already passed.

So resolution happens once here, and the socket is opened to the exact address
that was approved. The original hostname is still what the `Host` header and
the TLS SNI carry, so virtual hosts and certificate validation keep working,
and the connected peer is re-checked after `connect()` before a single byte of
the request is written.

The allow rule is `is_global`, not a denylist. Enumerating bad ranges leaves
whatever was not enumerated reachable — the old check missed the CGNAT block
(100.64.0.0/10), through which a cloud metadata service is often reachable.
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from dataclasses import dataclass
from typing import Callable, Iterable, Optional

DEFAULT_PORTS = {"http": 80, "https": 443}

#: Deliberately small. Every one of these is a network round trip the caller
#: controls the target of, so the ceiling is a resource bound, not a courtesy.
DEFAULT_CONNECT_TIMEOUT = 5.0
DEFAULT_READ_TIMEOUT = 15.0


class UrlPolicyError(ValueError):
    """The URL is not one this runner is willing to fetch."""


@dataclass(frozen=True)
class ResolvedTarget:
    """A URL reduced to one approved address, with its identity preserved."""

    scheme: str
    hostname: str
    port: int
    address: str
    family: int

    @property
    def is_tls(self) -> bool:
        return self.scheme == "https"


def classify_address(raw: str) -> ipaddress._BaseAddress:
    """Parse one `getaddrinfo` result, dropping any scope suffix."""
    try:
        return ipaddress.ip_address(raw.split("%", 1)[0])
    except ValueError as exc:  # pragma: no cover - getaddrinfo should not emit these
        raise UrlPolicyError(f"host resolved to an unparseable address: {raw}") from exc


def is_permitted_address(addr: ipaddress._BaseAddress) -> bool:
    """Only globally routable unicast addresses are fetchable.

    An IPv4-mapped IPv6 address (`::ffff:169.254.169.254`) is unwrapped first:
    Python classifies the mapped form by its embedded IPv4 for most properties
    but not for `is_global`, so the unwrap is what makes the two spellings of
    one address answer identically.
    """
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped
    if addr.is_multicast or addr.is_unspecified:
        return False
    return bool(addr.is_global)


def resolve_target(
    scheme: str,
    hostname: Optional[str],
    port: Optional[int],
    *,
    resolver: Callable[..., list] = socket.getaddrinfo,
) -> ResolvedTarget:
    """Resolve `hostname` once and approve exactly one address to connect to.

    Every returned address must be permitted, not merely the one that gets
    picked: a name answering with one public and one private address is a
    rebinding attempt with both answers pre-staged, and choosing the public one
    would make the outcome depend on resolver ordering.
    """
    if scheme not in DEFAULT_PORTS:
        raise UrlPolicyError('URL scheme must be "http" or "https"')
    if not hostname:
        raise UrlPolicyError("URL is missing a host")

    # `None` means the URL carried no port; `0` means it carried one and it is
    # invalid. `port or default` conflated the two and silently rewrote
    # `https://host:0/` into a request to 443.
    effective_port = DEFAULT_PORTS[scheme] if port is None else port
    if not 0 < effective_port < 65536:
        raise UrlPolicyError("URL port is out of range")

    try:
        infos = resolver(hostname, effective_port, 0, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UrlPolicyError(f"could not resolve host: {exc}") from exc
    if not infos:
        raise UrlPolicyError("could not resolve host")

    chosen: Optional[ResolvedTarget] = None
    for family, _type, _proto, _canon, sockaddr in infos:
        addr = classify_address(sockaddr[0])
        if not is_permitted_address(addr):
            raise UrlPolicyError(
                "host is not allowed: it resolves to a non-public address"
            )
        if chosen is None:
            chosen = ResolvedTarget(
                scheme=scheme,
                hostname=hostname,
                port=effective_port,
                address=str(addr),
                family=family,
            )
    if chosen is None:  # pragma: no cover - guarded by the `not infos` check
        raise UrlPolicyError("could not resolve host")
    return chosen


def connect(
    target: ResolvedTarget,
    *,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    ssl_context: Optional[ssl.SSLContext] = None,
) -> http.client.HTTPConnection:
    """Open a connection pinned to the approved address.

    `http.client` would re-resolve the hostname, so the socket is built here and
    handed to the connection object. The peer is verified after `connect()`:
    the address the kernel actually reached must be the address that was
    approved, which is what closes the window a second lookup would open.
    """
    sock = socket.create_connection(
        (target.address, target.port), timeout=connect_timeout
    )
    try:
        peer = sock.getpeername()[0]
        if classify_address(peer) != classify_address(target.address):
            raise UrlPolicyError(
                f"connected peer {peer} is not the approved address {target.address}"
            )
        if target.is_tls:
            context = ssl_context or ssl.create_default_context()
            # `server_hostname` drives both SNI and certificate verification, so
            # the pinned IP never weakens who we prove we are talking to.
            sock = context.wrap_socket(sock, server_hostname=target.hostname)
    except Exception:
        sock.close()
        raise

    conn_class = (
        http.client.HTTPSConnection if target.is_tls else http.client.HTTPConnection
    )
    # The hostname (not the IP) is passed so the request line and `Host` header
    # carry the name the caller asked for.
    conn = conn_class(target.hostname, target.port, timeout=connect_timeout)
    conn.sock = sock
    return conn


@dataclass(frozen=True)
class FetchResult:
    status: int
    content_type: str
    body: bytes
    truncated: bool


def fetch(
    scheme: str,
    hostname: Optional[str],
    port: Optional[int],
    path: str,
    *,
    max_bytes: int,
    headers: Optional[dict] = None,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    read_timeout: float = DEFAULT_READ_TIMEOUT,
    resolver: Callable[..., list] = socket.getaddrinfo,
    ssl_context: Optional[ssl.SSLContext] = None,
) -> FetchResult:
    """GET one URL under the full policy, reading at most `max_bytes`.

    Redirects are not followed. Each hop would need its own resolution and
    approval, and a 30x is the cheapest way to turn an approved public URL into
    a request against the metadata service.

    `Accept-Encoding: identity` is sent so the byte cap is a cap on real bytes:
    a gzip stream that expands past the limit after decoding would otherwise
    slip through a check made on the compressed size.
    """
    target = resolve_target(scheme, hostname, port, resolver=resolver)
    conn = connect(target, connect_timeout=connect_timeout, ssl_context=ssl_context)
    try:
        conn.sock.settimeout(read_timeout)
        request_headers = {
            "User-Agent": "codex-orchestrator-runner/1.0",
            "Accept-Encoding": "identity",
            "Connection": "close",
            **(headers or {}),
        }
        conn.request("GET", path or "/", headers=request_headers)
        response = conn.getresponse()
        if 300 <= response.status < 400:
            raise UrlPolicyError("redirects are not followed")
        if response.status != 200:
            raise UrlPolicyError(f"download failed with HTTP {response.status}")

        # Read one byte past the cap so an over-size body is detected rather
        # than silently truncated into a valid-looking short file.
        body = response.read(max_bytes + 1)
        truncated = len(body) > max_bytes
        if truncated:
            raise UrlPolicyError("download exceeds the maximum allowed size")
        content_type = (response.headers.get_content_type() or "").lower()
        return FetchResult(
            status=response.status,
            content_type=content_type,
            body=body,
            truncated=False,
        )
    except (socket.timeout, TimeoutError) as exc:
        raise UrlPolicyError("download timed out") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise UrlPolicyError(f"download failed: {exc}") from exc
    finally:
        conn.close()


def permitted_addresses(infos: Iterable) -> list[str]:
    """Helper for diagnostics and tests: the permitted subset of a resolution."""
    out = []
    for info in infos:
        addr = classify_address(info[4][0])
        if is_permitted_address(addr):
            out.append(str(addr))
    return out
