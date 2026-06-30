"""Agent registry tests — CRUD, depth, permission inheritance (isolated data)."""
from app.services.tools import agentRegistry

def testCreatePersistsExtendedSchema(isolatedData):
    a = agentRegistry.create_agent(name='Researcher', description='summarises', role='Researcher', tools=['read_file', 'web_search'], model_alias='fast', actor='test')
    assert a['role'] == 'Researcher'
    assert a['description'] == 'summarises'
    assert a['modelAlias'] == 'fast'
    assert any((x['id'] == a['id'] for x in agentRegistry.list_agents()))

def testUpdateAndDelete(isolatedData):
    a = agentRegistry.create_agent(name='Dev', actor='test')
    updated = agentRegistry.update_agent(a['id'], {'role': 'Developer'}, actor='test')
    assert updated['role'] == 'Developer'
    assert agentRegistry.delete_agent(a['id'], actor='test') is True
    assert agentRegistry.get_agent(a['id']) is None

def testDepthCapBlocks(isolatedData):
    from app.services.workbench.subagent import executeSubAgent
    parent = agentRegistry.create_agent(name='P', actor='test')
    deep = agentRegistry.create_agent(name='C', parent_id=parent['id'], actor='test')
    for __ in range(4):
        deep = agentRegistry.create_agent(name='D', parent_id=deep['id'], actor='test')

    class FakeSession:
        id = 's1'
        model = ''
        agentId = ''
        provider = ''
    import asyncio
    result = asyncio.run(executeSubAgent(FakeSession(), deep['id'], 'goal', '', emit=None))
    assert result['status'] == 'blocked'

def testDeriveChildPermissionsIntersects(isolatedData):
    parent = agentRegistry.create_agent(name='P', permissions=['read_file', 'web_search', 'bash'], actor='test')
    child = agentRegistry.create_agent(name='C', parent_id=parent['id'], permissions=['read_file', 'write_file'], actor='test')
    derived = agentRegistry.derive_child_permissions(parent['id'], child['id'])
    assert 'read_file' in derived
    assert 'write_file' not in derived

def testRenderAgentContext(isolatedData):
    a = agentRegistry.create_agent(name='R', role='Researcher', description='digs up info', tools=['t'], actor='test')
    ctx = agentRegistry.render_agent_context(a['id'])
    assert 'Researcher' in ctx
    assert 'digs up info' in ctx