"""Agent registry tests — CRUD, depth, permission inheritance (isolated data)."""
from app.services.tools import agent_registry

def testCreatePersistsExtendedSchema(isolatedData):
    a = agent_registry.createAgent(name='Researcher', description='summarises', role='Researcher', tools=['read_file', 'web_search'], modelAlias='fast', actor='test')
    assert a['role'] == 'Researcher'
    assert a['description'] == 'summarises'
    assert a['modelAlias'] == 'fast'
    assert any((x['id'] == a['id'] for x in agent_registry.listAgents()))

def testUpdateAndDelete(isolatedData):
    a = agent_registry.createAgent(name='Dev', actor='test')
    updated = agent_registry.updateAgent(a['id'], {'role': 'Developer'}, actor='test')
    assert updated['role'] == 'Developer'
    assert agent_registry.deleteAgent(a['id'], actor='test') is True
    assert agent_registry.getAgent(a['id']) is None

def testDepthCapBlocks(isolatedData):
    from app.services.workbench.subagent import executeSubAgent
    parent = agent_registry.createAgent(name='P', actor='test')
    deep = agent_registry.createAgent(name='C', parentId=parent['id'], actor='test')
    for __ in range(4):
        deep = agent_registry.createAgent(name='D', parentId=deep['id'], actor='test')

    class FakeSession:
        id = 's1'
        model = ''
        agentId = ''
        provider = ''
    import asyncio
    result = asyncio.run(executeSubAgent(FakeSession(), deep['id'], 'goal', '', emit=None))
    assert result['status'] == 'blocked'

def testDeriveChildPermissionsIntersects(isolatedData):
    parent = agent_registry.createAgent(name='P', permissions=['read_file', 'web_search', 'bash'], actor='test')
    child = agent_registry.createAgent(name='C', parentId=parent['id'], permissions=['read_file', 'write_file'], actor='test')
    derived = agent_registry.deriveChildPermissions(parent['id'], child['id'])
    assert 'read_file' in derived
    assert 'write_file' not in derived

def testRenderAgentContext(isolatedData):
    a = agent_registry.createAgent(name='R', role='Researcher', description='digs up info', tools=['t'], actor='test')
    ctx = agent_registry.renderAgentContext(a['id'])
    assert 'Researcher' in ctx
    assert 'digs up info' in ctx