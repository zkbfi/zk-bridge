#!/usr/bin/env python3
"""Compares routes of the live indexer (blue) and the new one (green).

  compare_indexers.py --blue 42069 --green 42070 /api/summary /api/pair ...

Per route: the status code must match, and for a 200 the shape of the answer (keys and value types) must match.
Numbers where green is more than 2% behind blue are counted and named (path only, with both values for at most 20
leaves per route). Prints "ok", "WARN" or "FAIL" lines. Exit 1 when any route FAILs; WARN lines do not change the exit
code, the playbook reads them.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request


def get(port, route):
    url = "http://127.0.0.1:%s%s" % (port, route)
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            status, text = response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read().decode("utf-8", "replace")
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    return status, body


NULL = "null"


def shape(value):
    """The keys and value types of an answer. A list has the merged shape of all its items, so order does not matter, and
    null merges with any type (a nullable field is null in some items and set in others)."""
    if value is None:
        return NULL
    if isinstance(value, list):
        merged = NULL
        for item in value:
            merged = merge(merged, shape(item))
        return ("list", merged)
    if isinstance(value, dict):
        return ("object", tuple(sorted((key, shape(child)) for key, child in value.items())))
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    return "string"


def merge(a, b):
    """The shape of two items of one list, or "mixed" when they disagree."""
    if a == NULL:
        return b
    if b == NULL or a == b:
        return a
    if isinstance(a, tuple) and isinstance(b, tuple) and a[0] == b[0] == "list":
        return ("list", merge(a[1], b[1]))
    if isinstance(a, tuple) and isinstance(b, tuple) and a[0] == b[0] == "object":
        left, right = dict(a[1]), dict(b[1])
        if set(left) != set(right):
            return "mixed"
        return ("object", tuple(sorted((key, merge(left[key], right[key])) for key in left)))
    return "mixed"


def compatible(a, b):
    """Whether blue and green answer the same shape. Null on either side matches any type."""
    if a == NULL or b == NULL:
        return True
    if isinstance(a, tuple) and isinstance(b, tuple) and a[0] == b[0]:
        if a[0] == "list":
            return compatible(a[1], b[1])
        left, right = dict(a[1]), dict(b[1])
        return set(left) == set(right) and all(compatible(left[key], right[key]) for key in left)
    return a == b


def leaves(value, path, out):
    if isinstance(value, bool):
        return out
    if isinstance(value, (int, float)):
        out[path] = value
    elif isinstance(value, dict):
        for key, child in value.items():
            leaves(child, path + "." + key, out)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--blue", required=True)
    parser.add_argument("--green", required=True)
    parser.add_argument("routes", nargs="+")
    args = parser.parse_args()
    failures = 0
    for route in args.routes:
        try:
            blue_status, blue = get(args.blue, route)
            green_status, green = get(args.green, route)
        except Exception as error:  # noqa: BLE001
            print("FAIL %s: %s" % (route, type(error).__name__))
            failures += 1
            continue
        if blue_status != green_status:
            print("FAIL %s: status blue %s, green %s" % (route, blue_status, green_status))
            failures += 1
            continue
        if blue_status == 200 and not compatible(shape(blue), shape(green)):
            print("FAIL %s: the shape of the answer differs" % route)
            failures += 1
            continue
        behind = 0
        if blue is not None and green is not None:
            blue_leaves = leaves(blue, "", {})
            for path, value in leaves(green, "", {}).items():
                other = blue_leaves.get(path)
                if other is not None and other > 0 and value < other * 0.98:
                    behind += 1
                    if behind <= 20:
                        print("  %s%s: blue %s, green %s" % (route, path, other, value))
        if behind:
            print("WARN %s: status %s, %d number(s) where green is behind blue by more than 2%%" % (route, green_status, behind))
        else:
            print("ok   %s: status %s" % (route, green_status))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
