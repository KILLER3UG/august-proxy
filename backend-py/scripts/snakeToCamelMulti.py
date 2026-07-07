#!/usr/bin/env python3
"""
Multi-language regex-based snake_case → camelCase converter.

Used for **TypeScript / TSX / JavaScript** and **Rust** files. (Python has its
own AST tool at `scripts/snakeToCamel.py`.)

Why regex? TS/TSX parsing requires the TypeScript compiler API which is heavy
to bootstrap from a Python harness; with a deny-list of wire-protocol identifiers
and a careful token-aware scanner, regex is sufficient for the surface area
covered here.

The scanner splits each file into three streams:
  • STRING_LITERAL  — anything inside ' " ` ; skipped
  • COMMENT         — // or /* ... */ ; passed through unchanged
  • CODE            — the remainder; renamed

Inside CODE, we look for whole-word matches of an identifier that:
  • contains at least one underscore (i.e. is genuinely snake_case)
  • is not in the deny-list
  • is not all-uppercase (UPPER_SNAKE_CASE constant)
  • has no leading underscore (private names are kept)

Usage:
    python scripts/snakeToCamelMulti.py --lang ts src/             # directory
    python scripts/snakeToCamelMulti.py --lang ts --dry-run file.tsx
    python scripts/snakeToCamelMulti.py --lang rust src-tauri/src/

In-place modification with .bak backup.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path
from typing import Iterable

# Reuse the canonical name converter + deny-list loader from the Python tool.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from snakeToCamel import _DENY_LIST, _is_upper_snake, _load_deny_list, _snake_to_camel  # type: ignore


# ── Token-aware scanner ──────────────────────────────────────────────────


def _iter_string_spans(text: str, lang: str) -> Iterable[tuple[int, int]]:
    """Yield (start, end) char spans of source text that are string literals.

    For both TS and Rust we recognise:
      • single-quoted  'foo'
      • double-quoted  "foo"
      • backtick       `foo`   (TS template literal; Rust raw string `r#"..."#`
        is also handled with a more permissive rule)
      • Rust raw strings: r"foo", r#"foo"#, br"foo"
    Backslash escapes are honoured.
    """
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        # Line comment
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            if j == -1:
                j = n
            yield (i, j)
            i = j
            continue
        # Block comment
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            if j == -1:
                j = n
            else:
                j += 2
            yield (i, j)
            i = j
            continue
        # Rust raw string: r"foo", r#"foo"#, br"foo"
        if lang == "rust" and c in ("r", "R") and i + 1 < n and text[i + 1] == '"':
            # count leading '#'s
            k = i + 2
            hashes = 0
            while k < n and text[k] == "#":
                hashes += 1
                k += 1
            # find matching closing
            close = '"' + "#" * hashes
            j = text.find(close, k)
            if j == -1:
                j = n
            else:
                j += len(close)
            yield (i, j)
            i = j
            continue
        if lang == "rust" and c == "b" and i + 1 < n and text[i + 1] in ("r", "R") and i + 2 < n and text[i + 2] == '"':
            k = i + 3
            hashes = 0
            while k < n and text[k] == "#":
                hashes += 1
                k += 1
            close = '"' + "#" * hashes
            j = text.find(close, k)
            if j == -1:
                j = n
            else:
                j += len(close)
            yield (i, j)
            i = j
            continue
        # Single / double quote string (with backslash escapes)
        if c in ('"', "'"):
            quote = c
            j = i + 1
            while j < n:
                if text[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if text[j] == quote:
                    j += 1
                    break
                j += 1
            yield (i, j)
            i = j
            continue
        # Template literal (backtick) — for TS only; Rust doesn't have these.
        if lang != "rust" and c == "`":
            j = i + 1
            while j < n:
                if text[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if text[j] == "`":
                    j += 1
                    break
                j += 1
            yield (i, j)
            i = j
            continue
        i += 1


def _is_string_position(text: str, pos: int, lang: str) -> bool:
    """Return True if pos is inside a string literal or comment."""
    for start, end in _iter_string_spans(text, lang):
        if start <= pos < end:
            return True
    return False


_IDENT_RE = re.compile(r"\b([a-z][a-zA-Z0-9_]*)\b")


def _is_camel(s: str) -> bool:
    """Conservative: a name is already camelCase if it has no underscores and
    contains no consecutive uppercase letters preceded by lowercase."""
    if "_" in s:
        return False
    return True


def _rename_in_code(text: str, lang: str, deny: set[str]) -> tuple[str, list[dict]]:
    """Return (new_text, rename_log) where rename_log is a list of changes."""
    log: list[dict] = []
    # Build string-position map lazily.
    string_spans = list(_iter_string_spans(text, lang))

    def in_string(pos: int) -> bool:
        for s, e in string_spans:
            if s <= pos < e:
                return True
        return False

    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        m = _IDENT_RE.match(text, i)
        if not m:
            out.append(text[i])
            i += 1
            continue
        name = m.group(1)
        start, end = m.span()
        # Skip if inside a string literal / comment
        if in_string(start):
            out.append(text[start:end])
            i = end
            continue
        # Skip if it's already camelCase with no underscores
        if "_" not in name:
            out.append(text[start:end])
            i = end
            continue
        # Skip leading-underscore (private) names — keep as-is
        if name.startswith("_"):
            out.append(text[start:end])
            i = end
            continue
        # Skip UPPER_SNAKE constants
        if _is_upper_snake(name):
            out.append(text[start:end])
            i = end
            continue
        # Skip the deny list
        if name in deny:
            out.append(text[start:end])
            i = end
            continue
        # Compute camelCase
        camel = _snake_to_camel(name)
        if camel == name:
            out.append(text[start:end])
            i = end
            continue
        log.append({"old": name, "new": camel, "offset": start})
        out.append(camel)
        i = end
    return "".join(out), log


# ── File processor ──────────────────────────────────────────────────────


def convert_file(path: Path, lang: str, deny: set[str], *, dry_run: bool = False,
                 show_diff: bool = False) -> dict:
    original = path.read_text(encoding="utf-8")
    new_text, log = _rename_in_code(original, lang, deny)
    result = {
        "file": str(path),
        "status": "unchanged" if original == new_text else "modified",
        "renames": log,
    }
    if original == new_text:
        return result
    if dry_run:
        print(f"[DRY-RUN] {path} — {len(log)} rename(s)")
        for r in log[:10]:
            print(f"  off {r['offset']}: {r['old']} → {r['new']}")
        if len(log) > 10:
            print(f"  … +{len(log) - 10} more")
        return result
    if show_diff:
        diff = difflib.unified_diff(
            original.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=str(path), tofile=str(path),
            lineterm="",
        )
        sys.stdout.writelines(diff)
    backup = path.with_suffix(path.suffix + ".bak")
    backup.write_text(original, encoding="utf-8")
    path.write_text(new_text, encoding="utf-8")
    result["backup"] = str(backup)
    return result


def convert_directory(dir_path: Path, lang: str, deny: set[str], **kw) -> list[dict]:
    if lang == "ts":
        exts = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
    elif lang == "rust":
        exts = {".rs"}
    else:
        raise ValueError(f"unsupported lang: {lang}")
    results = []
    for f in sorted(dir_path.rglob("*")):
        if not f.is_file() or f.suffix not in exts:
            continue
        # skip common generated / build dirs
        if any(part in {"node_modules", "dist", "build", "target", ".git",
                        "__pycache__", "web-dist", "tsbuildinfo"} for part in f.parts):
            continue
        results.append(convert_file(f, lang, deny, **kw))
    return results


# ── CLI ─────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-language snake_case → camelCase (TS/TSX/JS/Rust)")
    parser.add_argument("targets", nargs="+", help="Files or directories to convert")
    parser.add_argument("--lang", choices=["ts", "rust"], required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--diff", action="store_true")
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--deny-list", help="Additional deny-list file")
    args = parser.parse_args()

    deny = set(_DENY_LIST)
    if args.deny_list:
        deny = _load_deny_list(args.deny_list)

    all_results: list[dict] = []
    for target in args.targets:
        p = Path(target)
        if p.is_file():
            all_results.append(convert_file(p, args.lang, deny,
                                            dry_run=args.dry_run,
                                            show_diff=args.diff))
        elif p.is_dir():
            all_results.extend(convert_directory(p, args.lang, deny,
                                                 dry_run=args.dry_run,
                                                 show_diff=args.diff))
        else:
            print(f"Warning: {target} not found", file=sys.stderr)

    if args.report:
        print(json.dumps(all_results, indent=2))
    modified = sum(1 for r in all_results if r["status"] == "modified")
    unchanged = sum(1 for r in all_results if r["status"] == "unchanged")
    total_renames = sum(len(r.get("renames", [])) for r in all_results)
    print(f"\nSummary: {modified} modified, {unchanged} unchanged, {total_renames} renames")


if __name__ == "__main__":
    main()
