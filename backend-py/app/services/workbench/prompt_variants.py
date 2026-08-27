"""§9.3 #6: per-model-family prompt variants (plan Part 9, Set A).

One short guidance block per model family, appended to the workbench system
prompt. Families respond measurably differently to instruction style; the
variants keep August's single prompt architecture but give each family the
framing it follows best. Blocks are deliberately tiny — the operating rules
in <core> stay the single source of truth; variants only add family-specific
emphasis. Reasoning-effort pass-through already lives in effort.py; the
companion "temperature=1 when effort is set" rule is applied where the
upstream bodies are built (providers.py).
"""

from __future__ import annotations

from app.json_narrowing import as_str

# Detection order matters: specific vendor ids before generic substrings.
_FAMILY_MARKERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ('anthropic', ('claude', 'anthropic')),
    ('openai', ('gpt-', 'gpt4', 'gpt5', 'o1-', 'o3-', 'o4-', 'chatgpt', 'openai')),
    ('deepseek', ('deepseek',)),
    ('gemini', ('gemini', 'palm')),
    ('qwen', ('qwen', 'tongyi')),
    ('mistral', ('mistral', 'mixtral', 'codestral')),
    ('llama', ('llama', 'llama3')),
)

_FAMILY_VARIANTS: dict[str, str] = {
    'anthropic': (
        '<model_family_notes>\n'
        'You respond best to direct, literal instructions: state the task, get the tool '
        'calls. Emit tool calls without announcing them; batch independent calls in one turn.\n'
        '</model_family_notes>'
    ),
    'openai': (
        '<model_family_notes>\n'
        'Structure matters: keep intermediate reasoning short, prefer acting with tools '
        'over describing actions. When reasoning effort is on, do not restate the plan — '
        'execute it step by step.\n'
        '</model_family_notes>'
    ),
    'deepseek': (
        '<model_family_notes>\n'
        'Keep tool inputs strict JSON — no comments, no trailing commas. Prefer many small '
        'verified steps over one large speculative edit; always check command exit codes.\n'
        '</model_family_notes>'
    ),
    'gemini': (
        '<model_family_notes>\n'
        'Be explicit about completion criteria for each step. Batch independent tool calls '
        'together; verify file changes by re-reading after edits.\n'
        '</model_family_notes>'
    ),
    'qwen': (
        '<model_family_notes>\n'
        'Instructions are followed literally — keep them concrete. One tool call per intent; '
        'never emit placeholder content you have not verified.\n'
        '</model_family_notes>'
    ),
    'mistral': (
        '<model_family_notes>\n'
        'Keep outputs tight: code first, prose after. Verify every edit with a read or test '
        'before moving on.\n'
        '</model_family_notes>'
    ),
    'llama': (
        '<model_family_notes>\n'
        'Follow the tool protocol exactly; when unsure between editing and re-reading, '
        're-read first.\n'
        '</model_family_notes>'
    ),
}


def model_family(model: str) -> str:
    """Detect the model family from a model id ('' when unknown)."""
    m = as_str(model, '').lower()
    if not m:
        return ''
    for family, markers in _FAMILY_MARKERS:
        if any(marker in m for marker in markers):
            return family
    return ''


def family_prompt_variant(model: str) -> str:
    """The family-specific prompt block, or '' for unknown families."""
    return _FAMILY_VARIANTS.get(model_family(model), '')
