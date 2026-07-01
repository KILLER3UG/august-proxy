"""
Knowledge tree — hierarchical topic organization with parent-child relationships.

Port of backend/services/memory/knowledge-tree.js.
"""
from __future__ import annotations
from app.services.memoryStore import saveMemory, getMemory
_TREEKey = 'knowledge_tree'

def _read() -> dict[str, object]:
    return getMemory(_TREEKey) or {'nodes': {}, 'root': None}

def _write(tree: dict[str, object]) -> None:
    saveMemory(_TREEKey, tree)

def createNode(topic: str, parentTopic: str | None=None, content: str='') -> dict[str, object]:
    """Create a knowledge tree node."""
    tree = _read()
    import uuid
    nodeId = f'kn_{uuid.uuid4().hex[:8]}'
    if topic in tree.get('nodes', {}):
        return tree['nodes'][topic]
    node = {'id': nodeId, 'topic': topic, 'parent': parentTopic, 'content': content, 'children': [], 'createdAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z'}
    tree.setdefault('nodes', {})[topic] = node
    if parentTopic and parentTopic in tree.get('nodes', {}):
        if topic not in tree['nodes'][parentTopic]['children']:
            tree['nodes'][parentTopic]['children'].append(topic)
    if tree.get('root') is None:
        tree['root'] = topic
    _write(tree)
    return node

def getNode(topic: str) -> dict[str, object] | None:
    tree = _read()
    return tree.get('nodes', {}).get(topic)

def getChildren(topic: str) -> list[dict[str, object]]:
    tree = _read()
    node = tree.get('nodes', {}).get(topic)
    if not node:
        return []
    return [tree['nodes'][c] for c in node.get('children', []) if c in tree.get('nodes', {})]

def getPath(topic: str) -> list[dict[str, object]]:
    """Get the path from root to the given topic."""
    tree = _read()
    path = []
    current = topic
    while current and current in tree.get('nodes', {}):
        path.append(tree['nodes'][current])
        current = tree['nodes'][current].get('parent')
    return list(reversed(path))

def searchNodes(query: str) -> list[dict[str, object]]:
    """Search knowledge tree nodes by topic or content."""
    tree = _read()
    q = query.lower()
    results = []
    for topic, node in tree.get('nodes', {}).items():
        if q in topic.lower() or q in node.get('content', '').lower():
            results.append(node)
    return results

def updateNode(topic: str, content: str | None=None) -> bool:
    """Update a knowledge tree node's content."""
    tree = _read()
    if topic not in tree.get('nodes', {}):
        return False
    if content is not None:
        tree['nodes'][topic]['content'] = content
    _write(tree)
    return True