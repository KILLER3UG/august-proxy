"""Computer-use per-app policy — resolve, then enforce.

Settings → Computer Access writes ``appPolicies`` (``{app: allow|ask|deny}`` in
``config.json``) through ``POST /api/august/computer/app-policy``. For its whole
life the only reader was the observability snapshot, which COUNTS the values.
Nothing consulted it before acting on the user's machine, so a user who set
``deny`` had changed a number in a report, not a permission.

Enforcement needs an app identity, and the action path never carried one:
``ActionRequest`` is ``{action, params}`` and the names the user typed into the
"Add app" box are free text. So this module owns the identity question:

* :func:`resolveTargetApp` asks the OS which window is in front, and returns the
  process/executable identity for it. That is the REAL target, not a guess.
* :func:`decide` turns that identity into ``allow`` / ``ask`` / ``deny`` /
  ``default``, and says which configured key matched.
* :func:`enforce` is the door the dispatcher calls. ``deny`` refuses, ``ask``
  hands a pending mutation to the existing approval machinery (the same
  ``createPendingMutation`` path every guarded tool uses, so the UI, the
  realtime event and the grant scopes are already there), ``allow`` and
  ``default`` proceed.

Design notes that matter:

* **Fail-open is wrong here and fail-closed is worse.** If the foreground
  window cannot be read (Linux without pygetwindow, a headless run, an import
  error), we return ``unknown`` and the caller falls back to the configured
  ``defaultPolicy`` — which is ``ask``. Silently denying every desktop action
  on a machine where introspection is unavailable would look like a broken
  product; silently allowing would be the bug this fixes. Neither happens:
  the outcome is visible either way because ``ask`` surfaces a prompt.
* **Matching is prefix/substring, case-insensitive**, because the identity is a
  window title or a process name and users type ``chrome``, ``Chrome.exe`` or
  ``Google Chrome`` interchangeably. An exact-match rule would silently fail to
  match, which is the failure mode that let the original bug hide.
* **Unknown app means ``defaultPolicy``, not ``allow``** — the config snapshot
  already advertises ``defaultPolicy: 'ask'``.
"""

from __future__ import annotations

import contextvars
import logging
from dataclasses import dataclass

from app.json_narrowing import as_dict, as_str

logger = logging.getLogger(__name__)

VALID_POLICIES = ('allow', 'ask', 'deny')
DEFAULT_POLICY = 'ask'

# The ACTIONS the low-level primitives perform, mapped to the REGISTERED tool
# name each one belongs to. This mapping is the reason `deny` used to degrade to
# `ask`: the primitives call `_refuseIfNotAllowed('press')` and the dispatcher
# calls it with `'navigate'`, so naively building `'desktop_' + action` produced
# `desktop_press` / `desktop_navigate` — neither of which is a real tool name,
# so both fell into the unknown-tool branch and got DEFAULT_POLICY instead of
# the user's deny. The map is asserted TOTAL by
# `tests/test_computer_use_policy.py::test_every_action_maps_to_a_registered_tool`,
# so a new action cannot be added without naming its tool.
ACTION_TO_TOOL: dict[str, str] = {
    'click': 'desktop_click',
    'type': 'desktop_type',
    'press': 'desktop_press_key',
    'open_url': 'desktop_open_url',
    'navigate': 'desktop_open_url',
    'ui_act': 'desktop_ui_act',
}

# Tools that drive the real mouse/keyboard. A per-APP policy is meaningless for
# the read-only ones (a screenshot is not "acting on Chrome"), so only the
# mutating surface is gated. This mirrors
# ``post_observation.DESKTOP_MUTATING_TOOLS`` — if a tool is added to one it
# belongs here too, and ``tests/test_computer_use_policy.py`` fails if the two
# sets drift.
GATED_TOOLS = frozenset(ACTION_TO_TOOL.values()) | frozenset(
    {
        'desktop_hotkey',
        'desktop_scroll',
        'desktop_drag',
        'computer_click',
        'computer_type',
        'computer_key',
        'computer_open',
        'computer_scroll',
        'computer_drag',
    }
)

# Read-only desktop tools: explicitly NOT gated, so they short-circuit to allow
# instead of falling into the unknown-tool branch below.
READ_ONLY_TOOLS = frozenset(
    {
        'desktop_screenshot',
        'desktop_screen_size',
        'desktop_mouse_position',
        'desktop_list_windows',
        'desktop_ui_tree',
    }
)


@dataclass(frozen=True)
class Decision:
    """The resolved verdict for one action.

    ``matched_key`` is the configured policy key that won (or ``''``), which the
    caller needs for the denial message: "denied by your policy for 'chrome'"
    is actionable, "denied" is not.
    """

    policy: str
    matched_key: str = ''
    app: str = ''

    @property
    def is_deny(self) -> bool:
        return self.policy == 'deny'

    @property
    def needs_ask(self) -> bool:
        return self.policy == 'ask'


def _policies() -> dict[str, str]:
    """``{app: allow|ask|deny}`` from config, ignoring anything malformed."""
    try:
        from app.services.config_service import getConfig

        raw = as_dict(getConfig().get('appPolicies'))
    except Exception:  # noqa: BLE001 -- a policy layer must never crash a turn
        logger.debug('app policy: config read failed; using default', exc_info=True)
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        app = str(k or '').strip()
        policy = as_str(v).strip().lower()
        if app and policy in VALID_POLICIES:
            out[app] = policy
    return out


def resolveTargetApp() -> str:
    """Identity of the window currently in front. ``''`` when unknown.

    Tries the process name first (stable, no user-visible text) and falls back
    to the window title. Both are returned best-effort; a failure here is a
    normal condition on a headless box, not an exception to propagate.
    """
    try:
        import pygetwindow as gw  # type: ignore[import-not-found]

        active = gw.getActiveWindow()
        if active is not None:
            title = str(getattr(active, 'title', '') or '').strip()
            if title:
                return title
    except Exception:  # noqa: BLE001 -- window introspection is best-effort
        logger.debug('app policy: foreground window unavailable', exc_info=True)
    return ''


def decide(app: str, *, policies: dict[str, str] | None = None) -> Decision:
    """Map a target app to its policy.

    Substring, case-insensitive, most-specific-key-wins: if the user configured
    both ``chrome`` and ``Google Chrome``, the longer key is the one they meant.
    """
    resolved = _policies() if policies is None else policies
    target = (app or '').strip().lower()
    if target and resolved:
        best_key = ''
        best_policy = ''
        for key, policy_value in resolved.items():
            k = str(key or '').strip().lower()
            # Validate here too, not only in _policies(): an invalid value must
            # never become a Decision, whichever path supplied the map.
            if not k or policy_value not in VALID_POLICIES:
                continue
            if k in target or target in k:
                if len(k) > len(best_key):
                    best_key, best_policy = k, policy_value
        if best_key:
            return Decision(policy=best_policy, matched_key=best_key, app=app)
    return Decision(policy=DEFAULT_POLICY, matched_key='', app=app)


# The read-only primitives on :mod:`app.services.desktop_automation`. These
# observe the desktop without acting on it, so gating them would prompt the user
# to approve looking at their screen. Declared HERE so the conformance test can
# assert the exemption list is exactly this — a new primitive defaults to gated.
READ_ONLY_PRIMITIVES: frozenset[str] = frozenset(
    {
        'takeScreenshot',
        'getMousePosition',
        'getScreenSize',
        'listWindows',
        # Webcam, not the desktop: it grabs one frame, forwards it to a vision
        # analyzer and deletes it. It acts on NOTHING in the user's session.
        # Camera access is gated separately by the `cameraAccess` brain-config
        # flag, so gating it here would double-prompt for the same permission.
        'captureCameraFrame',
    }
)


def enforce(
    tool_name: str, *, app: str | None = None, policies: dict[str, str] | None = None
) -> Decision:
    """The door. ``app=None`` means "resolve it yourself".

    ``policies`` overrides the configured map (tests, and a future caller that
    already holds the resolved map) — without it the parameter was honoured in
    :func:`decide` but silently ignored here, so an ``app=`` passed by a caller
    was decided against real config rather than the map in hand.

    Returns a :class:`Decision`; the CALLER refuses on ``is_deny`` and opens an
    approval on ``needs_ask``. This function never executes the tool and never
    raises — a policy layer that can take the agent down is worse than no
    policy layer.
    """
    if tool_name in READ_ONLY_TOOLS:
        return Decision(policy='allow')
    # Anything that is neither explicitly read-only nor explicitly gated is an
    # UNKNOWN tool name — a typo (`desktop_press` for `desktop_press_key`), or
    # a desktop-mutating tool added without updating GATED_TOOLS. Treating that
    # as 'allow' is a fail-open default that silently un-gates the new tool,
    # which is the exact defect class this layer exists to remove. Fail to the
    # prompt instead: a new door asks before it opens.
    if tool_name not in GATED_TOOLS:
        logger.debug(
            'app policy: %r is in neither the gated nor the read-only set; '
            'defaulting to ask (add it to one of them)',
            tool_name,
        )
        return Decision(policy=DEFAULT_POLICY)
    try:
        target = app if app is not None else resolveTargetApp()
        return decide(target, policies=policies)
    except Exception:  # noqa: BLE001 -- degrade to the prompt, never fail open
        # Fail to the documented default, which prompts rather than silently
        # permitting. Never fail-open, never crash the turn.
        logger.debug('app policy: decision failed; defaulting to ask', exc_info=True)
        return Decision(policy=DEFAULT_POLICY)


# --------------------------------------------------------------------------
# The enforcement door
#
# An approved replay must not be re-evaluated against a window that has since
# changed, so approval is carried on a ContextVar set by the replay path and
# consumed (reset) here. It lives in this module — NOT in the primitives or the
# dispatcher — so the dependency runs one way and both callers share it.
# --------------------------------------------------------------------------

_approved: contextvars.ContextVar[bool] = contextvars.ContextVar(
    'computer_use_policy_approved', default=False
)


def enforceSync(action: str, *, policies: dict[str, str] | None = None) -> dict[str, object] | None:
    """Synchronous gate, for the UIA path.

    ``desktop_uia.act`` is a sync function (UIA's own API is sync), so it cannot
    await :func:`enforceDesktopAction`. This is the same verdict and the same
    consequence for `deny`; the only difference is that `ask` cannot open an
    approval card from a sync context, so it refuses with the same message the
    async gate gives when no session is in scope — a prompt nobody can answer is
    not consent. The approved-replay path does not reach here: a UIA action
    approved through the chat runs under the approval flag set by
    ``execute_approved_mutation``, which this honors first.
    """
    if _approved.get():
        return None
    toolName = ACTION_TO_TOOL.get(action, 'desktop_ui_act')
    decision = enforce(toolName)
    if decision.is_deny:
        target = decision.matched_key or decision.app or 'this app'
        return {
            'ok': False,
            'error': (
                f"Blocked by your computer-use policy: '{target}' is set to deny, so August "
                'cannot click, type or press keys there. Change it in '
                'Settings → Computer Access.'
            ),
            'policy': 'deny',
            'matchedApp': decision.matched_key,
            'action': action,
        }
    if decision.needs_ask:
        target = decision.app or decision.matched_key
        where = f"'{target}'" if target else 'the current window'
        return {
            'ok': False,
            'error': (
                f'Needs your approval to act on {where}. Accessibility actions cannot ask '
                'mid-call — use the desktop tools from chat, or set this app to allow in '
                'Settings → Computer Access.'
            ),
            'policy': 'ask',
            'matchedApp': decision.matched_key,
            'action': action,
        }
    return None


def markApproved() -> object:
    """Mark the current context as carrying a human approval for one act.

    Returns the ContextVar token. The caller MUST pass it back to
    :func:`clearApproved` in a ``finally``; ``reset(token)`` restores only the
    value THIS context had, so a concurrently-running sibling task that
    inherited the approval keeps its own copy rather than having it consumed
    underneath it.
    """
    return _approved.set(True)


def clearApproved(token: object | None = None) -> None:
    """Drop the approval. ``token`` is the value :func:`markApproved` returned.

    Called after the approved call completes AND by the gate itself when it
    consumes the flag, so an approval can never outlive the action it covers.
    """
    if token is not None:
        try:
            _approved.reset(token)  # type: ignore[arg-type]
            return
        except ValueError:
            # Token created in a different context — fall back to a plain set.
            pass
    _approved.set(False)


async def enforceDesktopAction(
    action: str,
    *,
    params: dict[str, object] | None = None,
    policies: dict[str, str] | None = None,
) -> dict[str, object] | None:
    """Gate one mutating desktop action. ``None`` = proceed.

    This is the function every mutating primitive calls. It owns the whole
    verdict→consequence mapping so a new entry point cannot get half of it.
    """
    if _approved.get():
        # Consume the approval for THIS context: one approval, one action. The
        # value is reset (not shared-mutated) so a concurrently-running sibling
        # that inherited `True` cannot have its approval spent by us.
        _approved.set(False)
        return None

    toolName = ACTION_TO_TOOL.get(action)
    if toolName is None:
        # An action with no mapped tool is an UNKNOWN mutating action. Prompt
        # rather than permit: a new primitive must name its tool before it can
        # be governed.
        logger.debug('app policy: action %r has no tool mapping; defaulting to ask', action)
        return {
            'ok': False,
            'error': (
                f'Needs your approval to act on the current window ({action}). '
                'This action is not in your computer-use policy map yet.'
            ),
            'policy': 'ask',
            'matchedApp': '',
            'action': action,
        }

    decision = enforce(toolName, policies=policies)
    if decision.is_deny:
        target = decision.matched_key or decision.app or 'this app'
        return {
            'ok': False,
            'error': (
                f"Blocked by your computer-use policy: '{target}' is set to deny, so August "
                'cannot click, type, press keys or open links there. Change it in '
                'Settings → Computer Access.'
            ),
            'policy': 'deny',
            'matchedApp': decision.matched_key,
            'action': action,
        }

    if not decision.needs_ask:
        return None

    target = decision.app or decision.matched_key
    where = f"'{target}'" if target else 'the current window'
    session = _currentSession()
    if session is None:
        # A prompt nobody can answer is not consent — refuse rather than act.
        return {
            'ok': False,
            'error': (
                f'Needs your approval to act on {where}, and there is no chat session to '
                'ask on. Ask for it from the chat, or set this app to allow in '
                'Settings → Computer Access.'
            ),
            'policy': 'ask',
            'matchedApp': decision.matched_key,
            'action': action,
        }

    token = _queueApproval(session, action, params or {})
    if not token:
        return {
            'ok': False,
            'error': f'Needs your approval to act on {where}, but the request could not be queued.',
            'policy': 'ask',
            'matchedApp': decision.matched_key,
            'action': action,
        }
    return {
        'ok': False,
        'error': f'Waiting for your approval to act on {where}. Approve or reject it in the chat.',
        'policy': 'ask',
        'pendingToken': token,
        'matchedApp': decision.matched_key,
        'action': action,
    }


def _currentSession() -> object | None:
    try:
        from app.services.workbench.context import currentSessionId
        from app.services.workbench.sessions import get_workbench_session

        return get_workbench_session(currentSessionId.get())
    except Exception:  # noqa: BLE001 -- absent session means "refuse", not "allow"
        logger.debug('app policy: session lookup failed', exc_info=True)
        return None


def _queueApproval(session: object, action: str, params: dict[str, object]) -> str:
    """Hand the action to the EXISTING approval machinery.

    Reusing ``createPendingMutation`` means the approval card, the realtime
    event, the once/session/always grants and the preview text are the same
    ones every guarded tool already uses — rather than a second, parallel
    approval system built for desktop actions alone.
    """
    try:
        from app.services.workbench.workbench import createPendingMutation

        mutation = createPendingMutation(
            session,  # type: ignore[arg-type]
            'desktop_' + action,
            {'action': action, **params},
        )
        return str((mutation or {}).get('token') or '')
    except Exception:  # noqa: BLE001 -- caller treats an empty token as a refusal
        logger.debug('app policy: approval queue failed', exc_info=True)
        return ''

