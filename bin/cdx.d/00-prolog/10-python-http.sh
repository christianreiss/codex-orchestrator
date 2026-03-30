CODEX_PY_HTTP_UTIL="$(
  cat <<'PY'
import json
import os
import pathlib
import socket
import ssl
import urllib.error
import urllib.request

def cdx_enable_force_ipv4():
    if getattr(cdx_enable_force_ipv4, "_patched", False):
        return
    if os.environ.get("CODEX_FORCE_IPV4", "").lower() in ("1", "true", "yes"):
        _orig_getaddrinfo = socket.getaddrinfo
        def _force_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
            return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
        socket.getaddrinfo = _force_getaddrinfo
    cdx_enable_force_ipv4._patched = True

def cdx_build_ssl_contexts(cafile="", allow_insecure_env="CODEX_SYNC_ALLOW_INSECURE"):
    contexts = []
    primary = ssl.create_default_context()
    if cafile:
        try:
            primary.load_verify_locations(cafile)
        except Exception:
            primary = None
    if primary is not None:
        try:
            primary.verify_flags &= ~ssl.VERIFY_X509_STRICT
        except AttributeError:
            pass
        contexts.append(primary)
    try:
        fallback = ssl.create_default_context()
        fallback.verify_flags &= ~ssl.VERIFY_X509_STRICT
        contexts.append(fallback)
    except Exception:
        pass
    allow_insecure = os.environ.get(allow_insecure_env, "").lower() in ("1", "true", "yes")
    if allow_insecure:
        try:
            contexts.append(ssl._create_unverified_context())
        except Exception:
            pass
    return contexts or [None]

def cdx_request_json(method, url, api_key, cafile="", payload=None, timeout=20, allow_insecure_env="CODEX_SYNC_ALLOW_INSECURE"):
    data = None
    headers = {"X-API-Key": api_key}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
    except Exception as exc:
        raise RuntimeError(f"request failed: {exc}") from exc
    last_err = None
    for ctx in cdx_build_ssl_contexts(cafile, allow_insecure_env=allow_insecure_env):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "ignore")
            reason = f"http-{exc.code}"
            if body:
                reason = f"{reason}:{body.strip()[:80]}"
            raise RuntimeError(reason) from exc
        except Exception as exc:
            last_err = exc
            continue
    raise RuntimeError(f"request failed: {last_err}")

_cdx_api_key = ""
_cdx_cafile = ""

def cdx_atomic_write_text(target, content, mode=None):
    target = pathlib.Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    tmp.replace(target)
    if mode is not None:
        try:
            os.chmod(target, mode)
        except PermissionError:
            pass

def cdx_short_request_json(method, url, payload=None):
    if "cdx_request_json" not in globals():
        raise RuntimeError("request failed: missing-python-http-util")
    return cdx_request_json(method=method, url=url, api_key=_cdx_api_key, cafile=_cdx_cafile, payload=payload, timeout=20)
PY
)"
export CODEX_PY_HTTP_UTIL
