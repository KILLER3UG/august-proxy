"""
Knowledge tree — hierarchical topic organization with parent-child relationships.

Port of backend/services/memory/knowledge-tree.js.
"""

from __future__ import annotations
from datetime import datetime, timezone
from app.services.memory_store import saveMemory, getMemory
from app.jsonUtils import as_str, as_dict, as_list

_TREEKey = 'knowledge_tree'


def _read() -> dict[str, object]:
    return as_dict(getMemory(_TREEKey), {'nodes': {}, 'root': None})


def _write(tree: dict[str, object]) -> None:
    saveMemory(_TREEKey, tree)


def createNode(topic: str, parentTopic: str | None = None, content: str = '') -> dict[str, object]:
    """Create a knowledge tree node."""
    tree = _read()
    import uuid

    nodeId = f'kn_{uuid.uuid4().hex[:8]}'
    nodes = as_dict(tree.get('nodes'))
    if topic in nodes:
        return as_dict(nodes[topic])
    node: dict[str, object] = {
        'id': nodeId,
        'topic': topic,
        'parent': parentTopic,
        'content': content,
        'children': [],
        'createdAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    }
    nodes[topic] = node
    tree['nodes'] = nodes
    if parentTopic and parentTopic in nodes:
        parent = as_dict(nodes[parentTopic])
        children = as_list(parent.get('children'))
        if topic not in children:
            children.append(topic)
        parent['children'] = children
        nodes[parentTopic] = parent
    if tree.get('root') is None:
        tree['root'] = topic
    _write(tree)
    return node


def getNode(topic: str) -> dict[str, object] | None:
    tree = _read()
    nodes = as_dict(tree.get('nodes'))
    node = nodes.get(topic)
    if node is None:
        return None
    return as_dict(node)


def getChildren(topic: str) -> list[dict[str, object]]:
    tree = _read()
    nodes = as_dict(tree.get('nodes'))
    node = as_dict(nodes.get(topic))
    result: list[dict[str, object]] = []
    for child in as_list(node.get('children')):
        cid = as_str(child)
        if cid in nodes:
            result.append(as_dict(nodes[cid]))
    return result


def getPath(topic: str) -> list[dict[str, object]]:
    """Get the path from root to the given topic."""
    tree = _read()
    nodes = as_dict(tree.get('nodes'))
    path: list[dict[str, object]] = []
    current: str | None = topic
    while current and current in nodes:
        node = as_dict(nodes[current])
        path.append(node)
        current = as_str(node.get('parent')) or None
    return list(reversed(path))


def searchNodes(query: str) -> list[dict[str, object]]:
    """Search knowledge tree nodes by topic or content."""
    tree = _read()
    q = query.lower()
    results: list[dict[str, object]] = []
    for topic, node in as_dict(tree.get('nodes')).items():
        node_d = as_dict(node)
        if q in topic.lower() or q in as_str(node_d.get('content')).lower():
            results.append(node_d)
    return results


def updateNode(topic: str, content: str | None = None) -> bool:
    """Update a knowledge tree node's content."""
    tree = _read()
    nodes = as_dict(tree.get('nodes'))
    if topic not in nodes:
        return False
    if content is not None:
        as_dict(nodes[topic])['content'] = content
    _write(tree)
    return True
