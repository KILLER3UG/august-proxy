"""The compact goal block the seat prompt carries.

Small on purpose: the model needs to know WHERE it is working, what that goal permits, and what it
still owes — ids, outputs and the movement ledger are one ``goal_read`` call away. This is the same
split the memory lane makes (an index in the prompt, bodies on demand).

Read per assembly, not cached: a goal edit mid-session must reach the NEXT turn's prompt, which is
worth the provider's prefix cache being rebuilt — the alternative is a model working inside a bound
it was never shown.
"""
from __future__ import annotations

from app.services.goals import records as R
from app.services.goals import store as S
from app.services.goals.policy import effective


def goals_prompt_block(session_id: str) -> str:
    envs = S.load_envs()
    if not any(e.id == R.ROOT_ID for e in envs):
        return ''  # the layer has not been seeded: say nothing rather than invent a bound
    env_id = S.env_of_session(session_id)
    env = next((e for e in envs if e.id == env_id), None)
    if env is None:
        return ''
    allow = [str(t.get('name') or '') for t in _seat_tools()]
    policy = effective(envs, env_id, allow)
    lines = [f'<goals>\nYou are working in "{env.title}" ({env.id}): {env.goal}']
    lines.append(f'This goal reaches {len(policy.allow)} tool(s)'
                 + (f'; it refuses: {", ".join(n for n, _ in policy.denials[:6])}' if policy.denials else '')
                 + f'. Rounds: {policy.max_rounds if policy.max_rounds < 10 ** 6 else "uncapped"}.')
    if env.outputs:
        owed = R.unmet_outputs(env, S.load_artifacts(env.id))
        lines.append(f'Outputs: {len(env.outputs)} named'
                     + (f', still owed: {"; ".join(owed)}' if owed else ', all on file') + '.')
    run = S.session_run(env.id, session_id)
    if run is not None:
        lines.append(f'Run {run.id} is {run.status} at round {run.round} of {env.bound.max_rounds}'
                     + (' — parked at its ceiling; close it or begin the next goal.' if run.status == 'parked'
                        else '. A new turn resumes it with its rounds intact.'))
    sub = [e for e in envs if e.parent_id == env.id and e.status == 'active']
    if sub:
        lines.append('Open goals under this one: ' + '; '.join(f'"{e.title}" ({e.id})' for e in sub[:5]) + '.')
    lines.append('A claim is not a finding: only a mark with an evidence row is. Close the run yourself '
                 'when the goal closes; nothing closes it for you.</goals>')
    return '\n'.join(lines)


def _seat_tools() -> list[dict[str, object]]:
    # listRaw(): the registry's own entries. listTools() returns OpenAI-shaped wrappers whose name
    # lives under function.name, and reading t['name'] off those made every bound look empty.
    from app.services.tool_registry import listRaw

    return listRaw()
