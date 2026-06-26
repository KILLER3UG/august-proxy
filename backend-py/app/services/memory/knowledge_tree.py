"""
Knowledge tree — hierarchical topic organization with parent-child relationships.

Port of backend/services/memory/knowledge-tree.js.
"""

from __future__ import annotations

from typing import Any

from app.services.memory_store import save_memory, get_memory

_TREE_KEY = "knowledge_tree"


def _read() -> dict[str, Any]:
    return get_memory(_TREE_KEY) or {"nodes": {}, "root": None}


def _write(tree: dict[str, Any]) -> None:
    save_memory(_TREE_KEY, tree)


def create_node(topic: str, parent_topic: str | None = None, content: str = "") -> dict[str, Any]:
    """Create a knowledge tree node."""
    tree = _read()
    import uuid
    node_id = f"kn_{uuid.uuid4().hex[:8]}"
    if topic in tree.get("nodes", {}):
        return tree["nodes"][topic]
    node = {"id": node_id, "topic": topic, "parent": parent_topic, "content": content, "children": [], "createdAt": __import__("datetime").datetime.utcnow().isoformat() + "Z"}
    tree.setdefault("nodes", {})[topic] = node
    if parent_topic and parent_topic in tree.get("nodes", {}):
        if topic not in tree["nodes"][parent_topic]["children"]:
            tree["nodes"][parent_topic]["children"].append(topic)
    if tree.get("root") is None:
        tree["root"] = topic
    _write(tree)
    return node


def get_node(topic: str) -> dict[str, Any] | None:
    tree = _read()
    return tree.get("nodes", {}).get(topic)


def get_children(topic: str) -> list[dict[str, Any]]:
    tree = _read()
    node = tree.get("nodes", {}).get(topic)
    if not node:
        return []
    return [tree["nodes"][c] for c in node.get("children", []) if c in tree.get("nodes", {})]


def get_path(topic: str) -> list[dict[str, Any]]:
    """Get the path from root to the given topic."""
    tree = _read()
    path = []
    current = topic
    while current and current in tree.get("nodes", {}):
        path.append(tree["nodes"][current])
        current = tree["nodes"][current].get("parent")
    return list(reversed(path))


def search_nodes(query: str) -> list[dict[str, Any]]:
    """Search knowledge tree nodes by topic or content."""
    tree = _read()
    q = query.lower()
    results = []
    for topic, node in tree.get("nodes", {}).items():
        if q in topic.lower() or q in node.get("content", "").lower():
            results.append(node)
    return results


def update_node(topic: str, content: str | None = None) -> bool:
    """Update a knowledge tree node's content."""
    tree = _read()
    if topic not in tree.get("nodes", {}):
        return False
    if content is not None:
        tree["nodes"][topic]["content"] = content
    _write(tree)
    return True
