#!/usr/bin/env python3
"""The "ask" endpoint of Caddy's on-demand TLS for <cid>.ipfs.zkb.fi (deploy/app-server/Caddyfile).

Caddy asks GET /check?domain=<host> before it gets a certificate for a name it has none for. The answer is 200 only
when the host is exactly <cid><suffix> with a strict CID (CIDv1, lowercase base32, dag-pb or raw, sha2-256) AND that
CID is in the list of recursive pins of our IPFS node. Everything else is 403.

The list is a file (default /var/lib/zk-bridge-ipfs-pins/pins.txt, one CID per line) that ipfs-pins.sh writes as root
from the node's pin list. This service never talks to the node and holds no token, so a CID that is only cached in the
node, or that carries its own content (an identity hash), gets no certificate. The file is read again when its
modification time changes.

Standard library only; runs as an unprivileged user (zk-bridge-ipfs-tls-ask.service), on 127.0.0.1.
Settings (environment): ZKB_TLSASK_PORT (8089), ZKB_TLSASK_PINS (the file above), ZKB_TLSASK_SUFFIX (.ipfs.zkb.fi).
"""
import base64
import binascii
import os
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_LABEL = 63          # one DNS label
DAG_PB, RAW = 0x70, 0x55
SHA2_256 = 0x12
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
    """True for a CIDv1 in lowercase base32 that names a file tree or a raw block hashed with sha2-256 (32 bytes).

    The identity hash (its content is the CID), other hashes and other codecs are refused.
    """
    if len(label) > MAX_LABEL or not _LABEL.match(label):
        return False
    body = label[1:]
    try:
        raw = base64.b32decode(body.upper() + "=" * (-len(body) % 8))
        version, pos = _varint(raw, 0)
        codec, pos = _varint(raw, pos)
        hash_code, pos = _varint(raw, pos)
        digest_len, pos = _varint(raw, pos)
    except (ValueError, binascii.Error):
        return False
    return (version == 1 and codec in (DAG_PB, RAW) and hash_code == SHA2_256 and digest_len == 32
            and len(raw) - pos == 32)


def cid_of_host(host, suffix):
    """The CID label of <cid><suffix>, or None when the host is anything else."""
    if not isinstance(host, str) or not host.endswith(suffix):
        return None
    label = host[: -len(suffix)]
    return label if is_cidv1_label(label) else None


class Pins:
    """The CIDs of the pins file; read again when the file's modification time (or size) changes."""

    def __init__(self, path):
        self.path, self.stamp, self.cids, self.lock = path, None, frozenset(), threading.Lock()

    def current(self):
        try:
            st = os.stat(self.path)
            stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
        except OSError:
            self.cids, self.stamp = frozenset(), None
            return self.cids
        with self.lock:
            if stamp != self.stamp:
                try:
                    with open(self.path, encoding="ascii", errors="ignore") as handle:
                        self.cids = frozenset(line.strip() for line in handle if is_cidv1_label(line.strip()))
                    self.stamp = stamp
                except OSError:
                    self.cids, self.stamp = frozenset(), None
            return self.cids


class Checker:
    def __init__(self, pins_path, suffix):
        self.pins, self.suffix = Pins(pins_path), suffix

    def allowed(self, host):
        cid = cid_of_host(host, self.suffix)
        return cid is not None and cid in self.pins.current()


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
        os.environ.get("ZKB_TLSASK_PINS", "/var/lib/zk-bridge-ipfs-pins/pins.txt"),
        os.environ.get("ZKB_TLSASK_SUFFIX", ".ipfs.zkb.fi"),
    )
    make_server(checker, "127.0.0.1", int(os.environ.get("ZKB_TLSASK_PORT", "8089"))).serve_forever()


if __name__ == "__main__":
    main()
