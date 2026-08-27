"""B0 — complete, honest ``trajectory.json`` (ATIF-compatible).

Pier's augmented ATIF v1.7 is the strictest target, so the conventions here
follow it: **one step per API turn**, **no fabricated assistant text** (a
step records only what the model actually emitted), peak context tokens, and
the summarization count. The trajectory is assembled purely from events the
workbench loop really emitted — never reconstructed or embellished.
"""

from __future__ import annotations

import json
import time
from typing import Any

SCHEMA_VERSION = 'atif-augment-1.7+august-b0'


class TrajectoryBuilder:
    """Collects bench envelopes and renders the trajectory document."""

    def __init__(self, *, run_id: str, task: str, model: str, provider: str) -> None:
        self.run_id = run_id
        self.task = task
        self.model = model
        self.provider = provider
        self.started_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        self.finished_at = ''
        # One step per API turn. A "turn" opens with context/pressure (the
        # loop emits it right before each model call) or with the first
        # tool_call/assistant event when pressure is absent.
        self.steps: list[dict[str, Any]] = []
        self._current: dict[str, Any] | None = None
        self.peak_context_tokens = 0
        self.max_context = 0
        self.summarization_count = 0
        self.retries = 0
        self.final_answer = ''
        self.final_answer_parsed: Any = None
        self.exit_code: int | None = None
        self.exit_reason = ''
        self.error = ''
        self.budgets: dict[str, Any] = {}
        self.integrity_violations: list[dict[str, Any]] = []

    # -- event ingestion ----------------------------------------------------

    def _open_step(self) -> dict[str, Any]:
        step = {
            'index': len(self.steps) + 1,
            'role': 'assistant',
            'tool_calls': [],
            'tool_results': [],
            'assistant_text': '',
            'context_tokens': 0,
        }
        self.steps.append(step)
        self._current = step
        return step

    def _step(self) -> dict[str, Any]:
        return self._current if self._current is not None else self._open_step()

    def ingest(self, event: dict[str, Any]) -> None:
        etype = str(event.get('type') or '')
        if etype == 'context/pressure':
            # A pressure event precedes each model round → step boundary.
            # The FIRST pressure of the run opens step 1; later ones close
            # the previous step implicitly (one step per API turn).
            if self._current is not None and (
                self._current['tool_calls']
                or self._current['assistant_text']
                or self._current['tool_results']
            ):
                self._current = None
            step = self._step()
            total = int(event.get('totalTokens') or 0)
            step['context_tokens'] = total
            self.peak_context_tokens = max(self.peak_context_tokens, total)
            self.max_context = max(self.max_context, int(event.get('maxContext') or 0))
        elif etype == 'step/tool_call':
            step = self._step()
            step['tool_calls'].append({
                'id': event.get('id') or event.get('toolUseId') or '',
                'name': event.get('name') or event.get('toolName') or '',
                'input': event.get('input') if event.get('input') is not None else event.get('args'),
            })
        elif etype == 'step/tool_result':
            step = self._step()
            step['tool_results'].append({
                'id': event.get('id') or event.get('toolUseId') or '',
                'name': event.get('name') or event.get('toolName') or '',
                'status': event.get('status') or '',
                'content': str(event.get('content') or event.get('result') or '')[:20000],
            })
        elif etype == 'step/assistant':
            step = self._step()
            text = str(event.get('content') or '')
            # No fabricated text: append exactly what the model emitted.
            step['assistant_text'] = (
                step['assistant_text'] + '\n' + text if step['assistant_text'] else text
            )
        elif etype == 'context/compaction':
            self.summarization_count += 1
        elif etype == 'run/retry':
            self.retries += 1
        elif etype == 'run/error':
            self.error = str(event.get('message') or '')[:2000]

    # -- finalization ------------------------------------------------------

    def finish(
        self,
        *,
        exit_code: int,
        exit_reason: str = '',
        final_answer: str = '',
        final_answer_parsed: Any = None,
        budgets: dict[str, Any] | None = None,
        session_totals: dict[str, Any] | None = None,
    ) -> None:
        self.finished_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        self.exit_code = exit_code
        self.exit_reason = exit_reason
        self.final_answer = final_answer
        self.final_answer_parsed = final_answer_parsed
        self.budgets = budgets or {}
        self.session_totals = session_totals or {}

    def to_dict(self) -> dict[str, Any]:
        return {
            'schema_version': SCHEMA_VERSION,
            'run_id': self.run_id,
            'task': self.task,
            'model': self.model,
            'provider': self.provider,
            'started_at': self.started_at,
            'finished_at': self.finished_at,
            'steps': self.steps,
            'step_count': len(self.steps),
            'peak_context_tokens': self.peak_context_tokens,
            'max_context': self.max_context,
            'summarization_count': self.summarization_count,
            'retries': self.retries,
            'final_answer': self.final_answer,
            'final_answer_parsed': self.final_answer_parsed,
            'exit_code': self.exit_code,
            'exit_reason': self.exit_reason,
            'error': self.error,
            'budgets': self.budgets,
            'session_totals': getattr(self, 'session_totals', {}),
            'integrity_violations': self.integrity_violations,
        }

    def write(self, path: str) -> None:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(self.to_dict(), f, indent=2, ensure_ascii=False, default=str)
