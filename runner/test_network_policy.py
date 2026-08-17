"""The runner's only caller-controlled outbound fetch.

`/exec` takes image URLs from an API caller and downloads them from inside the
compose network, next to the orchestrator and its database. The previous
implementation approved a hostname by resolving it with `getaddrinfo`, then
handed the *hostname* to urllib, which resolved it again — so a name whose
record changes between the two lookups (DNS rebinding) passed the check and
connected somewhere else. These tests pin the closure of that window: one
resolution, a socket opened to that exact address, and the connected peer
re-verified before any bytes are written.
"""

import ipaddress
import socket
import unittest

import network_policy
from network_policy import ResolvedTarget, UrlPolicyError


def resolution(*addresses, port=443):
    """A `getaddrinfo` stand-in returning the given addresses in order."""

    def resolver(host, prt, family=0, socktype=0, *args, **kwargs):
        infos = []
        for address in addresses:
            fam = socket.AF_INET6 if ":" in address else socket.AF_INET
            sockaddr = (address, prt or port, 0, 0) if fam == socket.AF_INET6 else (address, prt or port)
            infos.append((fam, socket.SOCK_STREAM, 6, "", sockaddr))
        return infos

    return resolver


class AddressPolicyTest(unittest.TestCase):
    def test_permits_ordinary_public_addresses(self):
        for address in ("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "8.8.8.8"):
            with self.subTest(address=address):
                self.assertTrue(
                    network_policy.is_permitted_address(ipaddress.ip_address(address))
                )

    def test_refuses_every_shape_of_internal_destination(self):
        blocked = [
            "127.0.0.1",              # loopback
            "::1",                    # loopback v6
            "10.0.0.1",               # RFC1918
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",        # cloud metadata
            "fd00::1",                # unique local
            "fe80::1",                # link-local v6
            "224.0.0.1",              # multicast
            "0.0.0.0",                # unspecified
            "::",
            "255.255.255.255",        # broadcast
            "100.64.0.1",             # CGNAT — the denylist form of this check missed it
            "192.0.0.1",              # IETF protocol assignments
            "198.18.0.1",             # benchmarking
            "240.0.0.1",              # reserved
        ]
        for address in blocked:
            with self.subTest(address=address):
                self.assertFalse(
                    network_policy.is_permitted_address(ipaddress.ip_address(address)),
                    f"{address} must not be fetchable",
                )

    def test_an_ipv4_mapped_ipv6_address_answers_like_its_ipv4(self):
        # `::ffff:169.254.169.254` is the metadata service wearing a different
        # spelling; both forms have to be refused.
        for address in ("::ffff:169.254.169.254", "::ffff:127.0.0.1", "::ffff:10.0.0.1"):
            with self.subTest(address=address):
                self.assertFalse(
                    network_policy.is_permitted_address(ipaddress.ip_address(address))
                )
        self.assertTrue(
            network_policy.is_permitted_address(ipaddress.ip_address("::ffff:93.184.216.34"))
        )


class ResolveTargetTest(unittest.TestCase):
    def test_resolves_a_public_host_to_one_pinned_address(self):
        target = network_policy.resolve_target(
            "https", "images.example.com", None, resolver=resolution("93.184.216.34")
        )
        self.assertEqual("93.184.216.34", target.address)
        self.assertEqual(443, target.port)
        self.assertEqual("images.example.com", target.hostname)
        self.assertTrue(target.is_tls)

    def test_defaults_the_port_per_scheme(self):
        http = network_policy.resolve_target(
            "http", "images.example.com", None, resolver=resolution("93.184.216.34")
        )
        self.assertEqual(80, http.port)
        self.assertFalse(http.is_tls)

    def test_rejects_a_mixed_resolution_rather_than_picking_the_public_answer(self):
        # Both records pre-staged is a rebinding attempt, and choosing the
        # public one would make the outcome depend on resolver ordering.
        with self.assertRaises(UrlPolicyError):
            network_policy.resolve_target(
                "https",
                "rebind.example.com",
                None,
                resolver=resolution("93.184.216.34", "127.0.0.1"),
            )
        with self.assertRaises(UrlPolicyError):
            network_policy.resolve_target(
                "https",
                "rebind.example.com",
                None,
                resolver=resolution("127.0.0.1", "93.184.216.34"),
            )

    def test_rejects_non_http_schemes(self):
        for scheme in ("ftp", "file", "gopher", "data"):
            with self.subTest(scheme=scheme):
                with self.assertRaises(UrlPolicyError):
                    network_policy.resolve_target(
                        scheme, "images.example.com", None, resolver=resolution("93.184.216.34")
                    )

    def test_rejects_a_missing_host_without_resolving(self):
        def explode(*_args, **_kwargs):  # pragma: no cover - must not run
            raise AssertionError("resolution must not be attempted for an empty host")

        with self.assertRaises(UrlPolicyError):
            network_policy.resolve_target("https", None, None, resolver=explode)
        with self.assertRaises(UrlPolicyError):
            network_policy.resolve_target("https", "", None, resolver=explode)

    def test_rejects_an_out_of_range_port(self):
        for port in (0, 65536, -1):
            with self.subTest(port=port):
                with self.assertRaises(UrlPolicyError):
                    network_policy.resolve_target(
                        "https", "images.example.com", port, resolver=resolution("93.184.216.34")
                    )

    def test_reports_an_unresolvable_host(self):
        def fails(*_args, **_kwargs):
            raise socket.gaierror("Name or service not known")

        with self.assertRaises(UrlPolicyError) as caught:
            network_policy.resolve_target("https", "nope.example.com", None, resolver=fails)
        self.assertIn("could not resolve", str(caught.exception))

    def test_reports_an_empty_resolution(self):
        with self.assertRaises(UrlPolicyError):
            network_policy.resolve_target(
                "https", "empty.example.com", None, resolver=lambda *a, **k: []
            )


class FakeSocket:
    """Minimal socket stand-in that reports a configurable peer."""

    def __init__(self, peer):
        self.peer = peer
        self.closed = False
        self.timeout = None

    def getpeername(self):
        return (self.peer, 443)

    def settimeout(self, value):
        self.timeout = value

    def close(self):
        self.closed = True


class ConnectPinningTest(unittest.TestCase):
    """The connection must land on the address that was approved."""

    def _target(self, address="93.184.216.34", scheme="http"):
        return ResolvedTarget(
            scheme=scheme,
            hostname="images.example.com",
            port=80 if scheme == "http" else 443,
            address=address,
            family=socket.AF_INET,
        )

    def test_connects_to_the_pinned_address_not_the_hostname(self):
        seen = {}

        def create_connection(addr, timeout=None):
            seen["addr"] = addr
            return FakeSocket(addr[0])

        original = network_policy.socket.create_connection
        network_policy.socket.create_connection = create_connection
        try:
            conn = network_policy.connect(self._target())
        finally:
            network_policy.socket.create_connection = original

        # The socket goes to the IP; the connection object keeps the hostname so
        # the request line and Host header stay correct.
        self.assertEqual(("93.184.216.34", 80), seen["addr"])
        self.assertEqual("images.example.com", conn.host)

    def test_refuses_a_peer_that_is_not_the_approved_address(self):
        def create_connection(addr, timeout=None):
            # The kernel reached somewhere else: exactly what a rebind between
            # the approval and the connect would produce.
            return FakeSocket("127.0.0.1")

        original = network_policy.socket.create_connection
        network_policy.socket.create_connection = create_connection
        try:
            with self.assertRaises(UrlPolicyError) as caught:
                network_policy.connect(self._target())
        finally:
            network_policy.socket.create_connection = original
        self.assertIn("is not the approved address", str(caught.exception))

    def test_closes_the_socket_when_the_peer_check_fails(self):
        created = []

        def create_connection(addr, timeout=None):
            sock = FakeSocket("10.0.0.5")
            created.append(sock)
            return sock

        original = network_policy.socket.create_connection
        network_policy.socket.create_connection = create_connection
        try:
            with self.assertRaises(UrlPolicyError):
                network_policy.connect(self._target())
        finally:
            network_policy.socket.create_connection = original
        self.assertTrue(created[0].closed, "a refused connection must not leak its socket")


class PermittedAddressesHelperTest(unittest.TestCase):
    def test_filters_a_resolution_down_to_the_public_answers(self):
        infos = resolution("93.184.216.34", "127.0.0.1")("h", 443)
        self.assertEqual(["93.184.216.34"], network_policy.permitted_addresses(infos))
