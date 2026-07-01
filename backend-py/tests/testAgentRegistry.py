"""Agent registry tests — CRUD, depth, permission inheritance (isolated data)."""
from app.services.tools import agentRegistry

def testCreatePersistsExtendedSchema(isolatedData):
    a = agentRegistry.createAgent(name='Researcher', description='summarises', role='Researcher', tools=['read_file', 'web_search'], modelAlias='fast', actor='test')
    assert a['role'] == 'Researcher'
    assert a['description'] == 'summarises'
    assert a['modelAlias'] == 'fast'
    assert any((x['id'] == a['id'] for x in agentRegistry.listAgents()))

def testUpdateAndDelete(isolatedData):
    a = agentRegistry.createAgent(name='Dev', actor='test')
    updated = agentRegistry.updateAgent(a['id'], {'role': 'Developer'}, actor='test')
    assert updated['role'] == 'Developer'
    assert agentRegistry.deleteAgent(a['id'], actor='test') is True
    assert agentRegistry.getAgent(a['id']) is None

def testDepthCapBlocks(isolatedData):
    from app.services.workbench.subagent import executeSubAgent
    parent = agentRegistry.createAgent(name='P', actor='test')
    deep = agentRegistry.createAgent(name='C', parentId=parent['id'], actor='test')
    for __ in range(4):
        deep = agentRegistry.createAgent(name='D', parentId=deep['id'], actor='test')

    class FakeSession:
        id = 's1'
        model = ''
        agentId = ''
        provider = ''
    import asyncio
    result = asyncio.run(executeSubAgent(FakeSession(), deep['id'], 'goal', '', emit=None))
    assert result['status'] == 'blocked'

def testDeriveChildPermissionsIntersects(isolatedData):
    parent = agentRegistry.createAgent(name='P', permissions=['read_file', 'web_search', 'bash'], actor='test')
    child = agentRegistry.createAgent(name='C', parentId=parent['id'], permissions=['read_file', 'write_file'], actor='test')
    derived = agentRegistry.deriveChildPermissions(parent['id'], child['id'])
    assert 'read_file' in derived
    assert 'write_file' not in derived

def testRenderAgentContext(isolatedData):
    a = agentRegistry.createAgent(name='R', role='Researcher', description='digs up info', tools=['t'], actor='test')
    ctx = agentRegistry.renderAgentContext(a['id'])
    assert 'Researcher' in ctx
    assert 'digs up info' in ctx