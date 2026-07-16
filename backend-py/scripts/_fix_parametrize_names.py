"""Fix pytest parametrize names after camel→snake param rename."""
from __future__ import annotations

import re
from pathlib import Path

RENAMES = {
    'sessionId': 'session_id',
    'factKey': 'fact_key',
    'eventType': 'event_type',
    'proposalType': 'proposal_type',
    'agentId': 'agent_id',
    'jobId': 'job_id',
    'userId': 'user_id',
    'requestId': 'request_id',
    'toolName': 'tool_name',
    'modelId': 'model_id',
    'providerId': 'provider_id',
    'sinceSeq': 'since_seq',
    'maxAgeSeconds': 'max_age_seconds',
    'workspacePath': 'workspace_path',
    'taskId': 'task_id',
    'examId': 'exam_id',
}


def fix_param_block(block: str) -> str:
    out = block
    for camel, snake in RENAMES.items():
        out = re.sub(rf"\b{camel}\b", snake, out)
    return out


def main() -> None:
    root = Path(__file__).resolve().parents[1] / 'tests'
    changed = 0
    for path in root.rglob('*.py'):
        text = path.read_text(encoding='utf-8')
        new = re.sub(
            r'@pytest\.mark\.parametrize\([^)]+\)',
            lambda m: fix_param_block(m.group(0)),
            text,
        )
        if new != text:
            path.write_text(new, encoding='utf-8', newline='\n')
            changed += 1
            print(path)
    print(f'updated {changed} files')


if __name__ == '__main__':
    main()
