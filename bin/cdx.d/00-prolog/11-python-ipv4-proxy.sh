CODEX_PY_IPV4_PROXY_UTIL="$(
  cat <<'PY'
import os
import select
import signal
import socket
import socketserver
import sys
from urllib.parse import urlsplit


def _connect_ipv4(host, port):
    last_err = None
    for family, socktype, proto, _canonname, sockaddr in socket.getaddrinfo(
        host, port, socket.AF_INET, socket.SOCK_STREAM
    ):
        sock = None
        try:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(15.0)
            sock.connect(sockaddr)
            sock.settimeout(None)
            return sock
        except OSError as exc:
            last_err = exc
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
    if last_err is None:
        raise OSError(f"failed to resolve domain to IPv4 addresses: {host}")
    raise last_err


def _relay_bidirectional(left, right):
    sockets = [left, right]
    try:
        for sock in sockets:
            sock.setblocking(False)
        while True:
            readable, _, _ = select.select(sockets, [], [], 60.0)
            if not readable:
                continue
            for source in readable:
                target = right if source is left else left
                try:
                    chunk = source.recv(65536)
                except OSError:
                    return
                if not chunk:
                    return
                view = memoryview(chunk)
                while view:
                    try:
                        written = target.send(view)
                    except OSError:
                        return
                    view = view[written:]
    finally:
        for sock in sockets:
            try:
                sock.close()
            except OSError:
                pass


class ThreadedTcpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ProxyHandler(socketserver.StreamRequestHandler):
    def handle(self):
        request_line = self.rfile.readline(65537)
        if not request_line:
            return
        if len(request_line) > 65536:
            self._write_error(414, b"request line too long")
            return
        try:
            method, target, version = request_line.decode("iso-8859-1").strip().split(" ", 2)
        except ValueError:
            self._write_error(400, b"bad request")
            return

        headers = []
        while True:
            line = self.rfile.readline(65537)
            if not line:
                return
            if len(line) > 65536:
                self._write_error(431, b"header line too long")
                return
            if line in (b"\r\n", b"\n"):
                break
            headers.append(line)

        if method.upper() == "CONNECT":
            self._handle_connect(target)
            return

        self._handle_forward(method, target, version, headers)

    def _handle_connect(self, target):
        if ":" not in target:
            self._write_error(400, b"CONNECT target missing port")
            return
        host, port_text = target.rsplit(":", 1)
        try:
            port = int(port_text)
        except ValueError:
            self._write_error(400, b"invalid CONNECT port")
            return
        try:
            upstream = _connect_ipv4(host, port)
        except OSError as exc:
            self._write_error(502, f"upstream connect failed: {exc}".encode("utf-8", "ignore"))
            return
        self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        self.wfile.flush()
        _relay_bidirectional(self.connection, upstream)

    def _handle_forward(self, method, target, version, headers):
        parts = urlsplit(target)
        host = parts.hostname
        if not host:
            self._write_error(400, b"proxy request requires absolute URL")
            return
        scheme = (parts.scheme or "http").lower()
        port = parts.port or (443 if scheme == "https" else 80)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query

        content_length = 0
        sanitized_headers = []
        saw_host = False
        for raw_header in headers:
            lowered = raw_header.lower()
            if lowered.startswith(b"proxy-connection:"):
                continue
            if lowered.startswith(b"host:"):
                saw_host = True
            if lowered.startswith(b"content-length:"):
                try:
                    content_length = int(raw_header.split(b":", 1)[1].strip() or b"0")
                except ValueError:
                    content_length = 0
            sanitized_headers.append(raw_header)
        if not saw_host:
            host_value = host if parts.port is None else f"{host}:{port}"
            sanitized_headers.append(f"Host: {host_value}\r\n".encode("iso-8859-1"))

        body = b""
        if content_length > 0:
            body = self.rfile.read(content_length)

        try:
            upstream = _connect_ipv4(host, port)
        except OSError as exc:
            self._write_error(502, f"upstream connect failed: {exc}".encode("utf-8", "ignore"))
            return

        try:
            upstream.sendall(f"{method} {path} {version}\r\n".encode("iso-8859-1"))
            for raw_header in sanitized_headers:
                upstream.sendall(raw_header)
            upstream.sendall(b"\r\n")
            if body:
                upstream.sendall(body)
            _relay_bidirectional(self.connection, upstream)
        except OSError:
            try:
                upstream.close()
            except OSError:
                pass

    def _write_error(self, code, message):
        reason = {
            400: b"Bad Request",
            414: b"URI Too Long",
            431: b"Request Header Fields Too Large",
            502: b"Bad Gateway",
        }.get(code, b"Proxy Error")
        body = message + b"\n"
        self.wfile.write(
            b"HTTP/1.1 %d %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
            % (code, reason, len(body), body)
        )
        self.wfile.flush()


def main():
    state_dir = os.environ.get("CODEX_IPV4_PROXY_DIR", "")
    if not state_dir:
        print("missing CODEX_IPV4_PROXY_DIR", file=sys.stderr)
        return 1
    os.makedirs(state_dir, exist_ok=True)
    port_file = os.path.join(state_dir, "port")

    server = ThreadedTcpServer(("127.0.0.1", 0), ProxyHandler)
    with open(port_file, "w", encoding="utf-8") as handle:
        handle.write(str(server.server_address[1]))
        handle.flush()

    def _shutdown(_signum, _frame):
        server.shutdown()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
)"
export CODEX_PY_IPV4_PROXY_UTIL
