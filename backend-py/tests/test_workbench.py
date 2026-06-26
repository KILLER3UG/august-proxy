"""Workbench service unit tests."""
import pytest
from app.services.workbench.workbench import (
    create_workbench_session, get_workbench_session, list_workbench_sessions,
    summarize_session, delete_workbench_session,
    normalize_guard_mode, is_plan_mode_blocked,
    build_system_prompt, submit_plan, approve_workbench_plan,
    reject_workbench_plan, create_pending_mutation, consume_pending_mutation,
    set_workbench_goal, get_workbench_goal_status, get_workbench_activity,
    resolve_effective_effort, effort_to_thinking_budget,
    effort_to_openai_reasoning_effort,
)
from app.services.workbench.managed_tool_policy import (
    is_managed_tool_parallel_safe, parse_openai_tool_args,
)
from app.services.workbench.tool_executor import execute_tool_batch
from app.services.workbench.selfheal import detect_error, build_hints, enhance_tool_result, apply_self_heal_to_messages
from app.services.workbench.validator import validate_tool_arguments, build_validation_error_tool_message


class TestSessionManagement:
    def test_create_session(self):
        session = create_workbench_session(provider="anthropic", guard_mode="full")
        assert session.id.startswith("wb_")
        assert session.provider == "anthropic"
        assert session.guard_mode == "full"

    def test_get_session(self):
        session = create_workbench_session()
        found = get_workbench_session(session.id)
        assert found is not None
        assert found.id == session.id

    def test_list_sessions(self):
        create_workbench_session()
        sessions = list_workbench_sessions()
        assert len(sessions) >= 1

    def test_delete_session(self):
        session = create_workbench_session()
        assert delete_workbench_session(session.id) is True
        assert get_workbench_session(session.id) is None

    def test_summarize_session(self):
        session = create_workbench_session(provider="test")
        summary = summarize_session(session)
        assert summary["id"] == session.id
        assert summary["provider"] == "test"


class TestPlanAndApproval:
    def test_submit_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "Test plan", "steps": ["Step 1"]})
        assert session.plan is not None
        assert session.plan_approved is False

    def test_approve_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "Test"})
        assert approve_workbench_plan(session.id) is True
        assert session.plan_approved is True

    def test_reject_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "Test"})
        assert reject_workbench_plan(session.id) is True
        assert session.plan is None

    def test_pending_mutations(self):
        session = create_workbench_session()
        mutation = create_pending_mutation(session, "write_file", {"path": "/tmp/test"})
        assert mutation is not None
        assert "token" in mutation
        assert session.status == "awaiting_approval"

        assert consume_pending_mutation(mutation["token"]) is True
        assert session.status == "idle"


class TestGuardMode:
    def test_normalize(self):
        assert normalize_guard_mode("plan") == "plan"
        assert normalize_guard_mode("FULL") == "full"
        assert normalize_guard_mode("ask") == "ask"
        assert normalize_guard_mode("invalid") == "full"

    def test_plan_mode_blocked(self):
        assert is_plan_mode_blocked("write_file") is True
        assert is_plan_mode_blocked("run_command") is True
        assert is_plan_mode_blocked("read_file") is False
        assert is_plan_mode_blocked("WebSearch") is False


class TestGoalSystem:
    def test_set_and_get_goal(self):
        session = create_workbench_session()
        set_workbench_goal(session, "Complete the task")
        status = get_workbench_goal_status(session.id)
        assert status is not None
        assert status["goal"] == "Complete the task"
        assert status["active"] is True


class TestEffort:
    def test_resolve_effort(self):
        session = create_workbench_session()
        assert resolve_effective_effort("high", session) == "high"
        assert resolve_effective_effort("", session) == "medium"

    def test_thinking_budget(self):
        assert effort_to_thinking_budget("low") <= 8192
        assert effort_to_thinking_budget("high", max_tokens=32000) == 16000
        assert effort_to_thinking_budget("max", model_max=64000, max_tokens=32000) >= 32000

    def test_openai_reasoning(self):
        assert effort_to_openai_reasoning_effort("high") == "high"
        assert effort_to_openai_reasoning_effort("low") == "low"


class TestSystemPrompt:
    def test_build_prompt(self):
        session = create_workbench_session(guard_mode="full")
        prompt = build_system_prompt(session)
        assert "August Proxy" in prompt
        assert len(prompt) > 50

    def test_prompt_with_goal(self):
        session = create_workbench_session()
        set_workbench_goal(session, "Build feature")
        prompt = build_system_prompt(session)
        assert "Build feature" in prompt

    def test_prompt_with_plan(self):
        session = create_workbench_session()
        submit_plan(session, {"plan": "My plan"})
        approve_workbench_plan(session.id)
        prompt = build_system_prompt(session)
        assert "My plan" in prompt
        assert "approved" in prompt

    def test_plan_mode_prompt(self):
        session = create_workbench_session(guard_mode="plan")
        prompt = build_system_prompt(session)
        assert "Plan Mode" in prompt
        assert "Create a plan first" in prompt


class TestManagedToolPolicy:
    def test_parallel_safe(self):
        assert is_managed_tool_parallel_safe("WebSearch") is True
        assert is_managed_tool_parallel_safe("WebFetch") is True
        assert is_managed_tool_parallel_safe("write_file") is False
        assert is_managed_tool_parallel_safe("read_file") is True
        assert is_managed_tool_parallel_safe("bash") is False

    def test_parse_args(self):
        result = parse_openai_tool_args({"function": {"arguments": '{"key": "val"}'}})
        assert result == {"key": "val"}

        result2 = parse_openai_tool_args({"function": {"arguments": "invalid"}})
        assert result2 == {}


@pytest.mark.asyncio
class TestToolExecutor:
    async def test_sequential(self):
        async def exec_one(tu):
            return {"tool_call_id": tu["id"], "content": "done"}
        results = await execute_tool_batch([{"id": "1"}, {"id": "2"}], exec_one)
        assert len(results) == 2

    async def test_parallel(self):
        async def exec_one(tu):
            return {"tool_call_id": tu["id"], "content": "done"}
        results = await execute_tool_batch(
            [{"id": "a"}, {"id": "b"}], exec_one,
            {"parallel": True, "can_run_in_parallel": lambda x: True},
        )
        assert len(results) == 2


class TestSelfHeal:
    def test_detect_error(self):
        assert detect_error("Error: file not found") is True
        assert detect_error("command not found: ls") is True
        assert detect_error("permission denied") is True
        assert detect_error("All good") is False

    def test_build_hints(self):
        hints = build_hints("command not found: ls")
        assert "Hint" in hints

        hints2 = build_hints("Error: permission denied")
        assert "Hint" in hints2

    def test_enhance_result(self):
        enhanced = enhance_tool_result("Error: something broke")
        assert "Hint" in enhanced

    def test_apply_to_messages(self):
        msgs = [{"role": "tool", "content": "Error: failed"}]
        healed = apply_self_heal_to_messages(msgs)
        assert "Hint" in healed[0]["content"]


class TestValidator:
    def test_valid_call(self):
        result = validate_tool_arguments(
            {"function": {"name": "WebSearch", "arguments": '{"query": "test"}'}},
            [{"function": {"name": "WebSearch", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
        )
        assert result["valid"] is True

    def test_missing_field(self):
        result = validate_tool_arguments(
            {"function": {"name": "WebSearch", "arguments": "{}"}},
            [{"function": {"name": "WebSearch", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
        )
        assert result["valid"] is False
        assert "Missing" in result.get("error", "")

    def test_anthropic_format(self):
        result = validate_tool_arguments(
            {"name": "WebSearch", "input": {"query": "test"}},
            [{"name": "WebSearch", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}],
        )
        assert result["valid"] is True

    def test_compatibility_shim(self):
        result = validate_tool_arguments(
            {"function": {"name": "WebFetch", "arguments": '{"prompt": "https://x.com"}'}},
            [{"function": {"name": "WebFetch", "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}}],
        )
        assert result["valid"] is True

    def test_error_message(self):
        msg = build_validation_error_tool_message("call_1", "WebSearch", "Missing field")
        assert "Validation Error" in msg["content"]
        assert msg["tool_call_id"] == "call_1"
