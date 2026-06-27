"""Agent registry tests — CRUD, depth, permission inheritance (isolated data)."""
from app.services.tools import agent_registry


def test_create_persists_extended_schema(isolated_data):
    a = agent_registry.create_agent(
        name="Researcher", description="summarises", role="Researcher",
        tools=["read_file", "web_search"], model_alias="fast", actor="test",
    )
    assert a["role"] == "Researcher"
    assert a["description"] == "summarises"
    assert a["modelAlias"] == "fast"
    # Persisted across a fresh list call.
    assert any(x["id"] == a["id"] for x in agent_registry.list_agents())


def test_update_and_delete(isolated_data):
    a = agent_registry.create_agent(name="Dev", actor="test")
    updated = agent_registry.update_agent(a["id"], {"role": "Developer"}, actor="test")
    assert updated["role"] == "Developer"
    assert agent_registry.delete_agent(a["id"], actor="test") is True
    assert agent_registry.get_agent(a["id"]) is None


def test_depth_cap_blocks(isolated_data):
    from app.services.workbench.subagent import execute_sub_agent

    # Build a chain deeper than the cap (_MAX_AGENT_DEPTH = 4).
    parent = agent_registry.create_agent(name="P", actor="test")
    deep = agent_registry.create_agent(name="C", parent_id=parent["id"], actor="test")
    for _ in range(4):
        deep = agent_registry.create_agent(name="D", parent_id=deep["id"], actor="test")

    class FakeSession:
        id = "s1"
        model = ""
        agent_id = ""
        provider = ""

    import asyncio
    result = asyncio.run(execute_sub_agent(FakeSession(), deep["id"], "goal", "", emit=None))
    assert result["status"] == "blocked"


def test_derive_child_permissions_intersects(isolated_data):
    parent = agent_registry.create_agent(name="P", permissions=["read_file", "web_search", "bash"], actor="test")
    child = agent_registry.create_agent(
        name="C", parent_id=parent["id"], permissions=["read_file", "write_file"], actor="test"
    )
    derived = agent_registry.derive_child_permissions(parent["id"], child["id"])
    # write_file is not in parent's set, so the intersection drops it.
    assert "read_file" in derived
    assert "write_file" not in derived


def test_render_agent_context(isolated_data):
    a = agent_registry.create_agent(name="R", role="Researcher", description="digs up info", tools=["t"], actor="test")
    ctx = agent_registry.render_agent_context(a["id"])
    assert "Researcher" in ctx
    assert "digs up info" in ctx
