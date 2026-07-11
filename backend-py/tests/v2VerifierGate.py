"""v2 — Test verifier gate injection."""
import pytest
from app.services.memory import context_builder

def testSpecificGateWithCommand():
    """When phase=review and verification_command is non-empty, gate has the command."""
    session = {'id': 'test', 'execution_state': {'phase': 'review', 'step': 3, 'verification_command': 'python -m pytest tests/test_auth.py -x'}}
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert '<verifier_gate>' in prompt
    assert 'python -m pytest' in prompt
    assert 'Verify before proceeding' in prompt

def testGenericGateWithoutCommand():
    """When phase=review and verification_command is empty, gate is generic."""
    session = {'id': 'test', 'execution_state': {'phase': 'review', 'step': 3, 'verification_command': ''}}
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert '<verifier_gate>' in prompt
    assert 'verification' in prompt.lower() or 'test' in prompt.lower()

def testNoGateForImplementPhase():
    """When phase=implement, no verifier gate."""
    session = {'id': 'test', 'execution_state': {'phase': 'implement', 'step': 3, 'verification_command': 'pytest'}}
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert '<verifier_gate>' not in prompt

def testGateAppearsForCompletePhase():
    """phase=complete also triggers the gate."""
    session = {'id': 'test', 'execution_state': {'phase': 'complete', 'step': 5, 'verification_command': 'make test'}}
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert '<verifier_gate>' in prompt
    assert 'make test' in prompt

def testNoExecutionStateNoGate():
    """When there's no execution_state, no gate."""
    session = {'id': 'test'}
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert '<verifier_gate>' not in prompt