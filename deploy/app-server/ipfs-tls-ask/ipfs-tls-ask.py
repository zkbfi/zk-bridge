#!/usr/bin/env python3
"""The "ask" endpoint of Caddy's on-demand TLS for <cid>.ipfs.zkb.fi (deploy/app-server/Caddyfile).

Caddy asks GET /check?domain=<host> before it gets a certificate for a name it has none for. The answer is 200 only
when the host is exactly <cidv1-base32>.<suffix> AND this node holds the content (a HEAD to the node's own gateway,
which serves only its pins: Gateway.NoFetch). Everything else is 403. Names that are no CID cost nothing: they are
refused before kubo is asked. Results are cached, and the lookups in kubo are rate limited, so a flood of random
names cannot hammer the node.

Standard library only; runs as an unprivileged user (zk-bridge-ipfs-tls-ask.service), on 127.0.0.1.
Settings (environment): ZKB_TLSASK_PORT (8089), ZKB_TLSASK_GATEWAY (http://127.0.0.1:8080),
ZKB_TLSASK_SUFFIX (.ipfs.zkb.fi), ZKB_TLSASK_TTL (600 seconds), ZKB_TLSASK_RATE (20 lookups per second).
"""
import base64
import binascii
import http.client
import os
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_LABEL = 63          # one DNS label
CACHE_MAX = 10000       # entries; the oldest go first
LOOKUP_TIMEOUT = 3.0    # seconds for the node to answer
_LABEL = re.compile(r"^b[a-z2-7]+$")


def _varint(data, pos):
    value = shift = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
        if shift > 28:
            break
    raise ValueError("bad varint")


def is_cidv1_label(label):
    """True for a CIDv1 in lowercase base32 (multibase prefix b) that fits one DNS label."""
    if len(label) > MAX_LABEL or not _LABEL.match(label):
        return False
    body = label[1:]
    try:
        raw = base64.b32decode(body.upper() + "=" * (-len(body) % 8))
        version, pos = _varint(raw, 0)
        _codec, pos = _varint(raw, pos)
        _hash_code, pos = _varint(raw, pos)
        digest_len, pos = _varint(raw, pos)
    except (ValueError, binascii.Error):
        return False
    return version == 1 and digest_len > 0 and len(raw) - pos == digest_len


def cid_of_host(host, suffix):
    """The CID label of <cid><suffix>, or None when the host is anything else."""
    if not isinstance(host, str) or not host.endswith(suffix):
        return None
    label = host[: -len(suffix)]
    return label if is_cidv1_label(label) else None


class Checker:
    def __init__(self, gateway, suffix, ttl=600.0, rate=20.0, clock=time.monotonic):
        parsed = urllib.parse.urlsplit(gateway)
        self.gateway_host, self.gateway_port = parsed.hostname, parsed.port or 80
        self.suffix, self.ttl, self.rate, self.clock = suffix, ttl, rate, clock
        self.cache = {}          # cid -> (expires, held)
        self.tokens, self.last = rate, clock()
        self.lock = threading.Lock()

    def _take_token(self):
        now = self.clock()
        self.tokens = min(self.rate, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True

    def _held(self, cid):
        conn = http.client.HTTPConnection(self.gateway_host, self.gateway_port, timeout=LOOKUP_TIMEOUT)
        try:
            conn.request("HEAD", "/ipfs/" + cid)
            # 2xx, or the redirect that a directory gets to its trailing slash. No redirect is followed.
            return 200 <= conn.getresponse().status < 400
        except (OSError, http.client.HTTPException):
            return False
        finally:
            conn.close()

    def allowed(self, host):
        cid = cid_of_host(host, self.suffix)
        if cid is None:
            return False
        with self.lock:
            now = self.clock()
            hit = self.cache.get(cid)
            if hit and hit[0] > now:
                return hit[1]
            if not self._take_token():
                return False  # not cached: Caddy asks again on the next handshake
        held = self._held(cid)  # outside the lock: a slow node does not block the other answers
        with self.lock:
            if len(self.cache) >= CACHE_MAX:
                for key in sorted(self.cache, key=lambda k: self.cache[k][0])[: CACHE_MAX // 10]:
                    del self.cache[key]
            self.cache[cid] = (self.clock() + self.ttl, held)
        return held


def make_server(checker, host="127.0.0.1", port=8089):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            domain = urllib.parse.parse_qs(url.query).get("domain", [""])[0]
            ok = url.path == "/check" and checker.allowed(domain)
            self.send_response(200 if ok else 403)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, fmt, *args):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main():
    checker = Checker(
        os.environ.get("ZKB_TLSASK_GATEWAY", "http://127.0.0.1:8080"),
        os.environ.get("ZKB_TLSASK_SUFFIX", ".ipfs.zkb.fi"),
        float(os.environ.get("ZKB_TLSASK_TTL", "600")),
        float(os.environ.get("ZKB_TLSASK_RATE", "20")),
    )
    make_server(checker, "127.0.0.1", int(os.environ.get("ZKB_TLSASK_PORT", "8089"))).serve_forever()


if __name__ == "__main__":
    main()
