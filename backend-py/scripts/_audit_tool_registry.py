"""Audit script: boot the tool registry and list every registered tool."""
from __future__ import annotations

import json

from app.services.tool_definitions import registerAll

registerAll()


def main() -> None:
    from app.services.tool_registry import listRaw

    tools = listRaw()
    print(f"TOTAL REGISTERED: {len(tools)}")
    broken = []
    names = []
    for t in sorted(tools, key=lambda x: str(x.get("name"))):
        name = t.get("name")
        names.append(name)
        handler = t.get("handler")
        schema = t.get("inputSchema") or t.get("parameters") or t.get("schema")
        issues = []
        if not callable(handler):
            issues.append(f"HANDLER NOT CALLABLE: {handler!r}")
        if not isinstance(schema, dict) or not schema:
            issues.append("SCHEMA MISSING/EMPTY")
        desc = t.get("description") or ""
        if len(str(desc)) < 20:
            issues.append("DESCRIPTION TOO SHORT")
        if issues:
            broken.append((name, issues))
        bucket_tag = ""
        try:
            from app.services.tool_policy import prompt_bucket

            bucket_tag = prompt_bucket(str(name))
        except Exception as exc:
            bucket_tag = f"bucket-error:{exc}"
        print(f"- {name:28s} [{bucket_tag}] desc={len(str(desc))}ch schema={'ok' if isinstance(schema, dict) and schema else 'MISSING'}")
    print()
    if broken:
        print("BROKEN TOOLS:")
        for name, issues in broken:
            print(f"  {name}: {'; '.join(issues)}")
    else:
        print("NO BROKEN TOOL REGISTRATIONS DETECTED")

    # Cross-check against the capabilities-prompt bucket map
    try:
        from app.services.memory.capabilities_prompt import unclassified_tools

        unclassified = unclassified_tools(names)
        if unclassified:
            print(f"\nUNCLASSIFIED TOOLS (tool_other): {unclassified}")
        else:
            print("\nALL TOOLS CLASSIFIED INTO BUCKETS")
    except Exception as exc:
        print(f"classification cross-check failed: {exc}")

    # Anthropic conversion sanity
    try:
        from app.adapters.proxy_tools import sanitize_anthropic_tool_definition

        bad_conv = []
        seen = set()
        for raw in tools:
            conv = sanitize_anthropic_tool_definition(raw)
            if not conv:
                bad_conv.append(raw.get("name"))
                continue
            n = conv.get("name")
            if n in seen:
                bad_conv.append(f"DUP:{n}")
            seen.add(n)
        if bad_conv:
            print(f"ANTHROPIC CONVERSION ISSUES: {bad_conv}")
        else:
            print(f"ANTHROPIC CONVERSION OK ({len(seen)} unique)")
    except Exception as exc:
        print(f"anthropic conversion check failed: {exc}")


if __name__ == "__main__":
    main()
