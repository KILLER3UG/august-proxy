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
# mutating surface is gated.
#
# These are the names that are ACTUALLY REGISTERED (verified against
# tool_registry in tests/test_computer_use_policy.py). An earlier version also
# listed `computer_*` aliases and `desktop_hotkey`/`_scroll`/`_drag`, none of
# which exist as tools — aspirational names from a UI comment. Listing them
# made the set look broader than the enforcement surface, and made the drift
# test against post_observation.DESKTOP_MUTATING_TOOLS certify names that could
# never be invoked. If one is ever implemented, add it HERE AND register it;
# the registration test is what enforces that.
GATED_TOOLS = frozenset(ACTION_TO_TOOL.values())

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


def _windows_process_for_hwnd(hwnd: int) -> str:
    """Executable name (lowercased, no `.exe`) for a window handle, via ctypes.

    ``GetWindowThreadProcessId`` + ``QueryFullProcessImageNameW`` reach the
    process image name with nothing but the standard library — no psutil, no
    pywin32, neither of which this project depends on. Returns '' on any
    failure: this is introspection, and an unreadable process must not become a
    permission decision by itself.
    """
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL('user32', use_last_error=True)
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
        if not pid.value:
            return ''

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value
        )
        if not handle:
            return ''
        try:
            size = wintypes.DWORD(32768)
            buf = ctypes.create_unicode_buffer(size.value)
            if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return ''
            full = buf.value or ''
        finally:
            kernel32.CloseHandle(handle)
    except Exception:  # noqa: BLE001 -- non-Windows or an unavailable API
        return ''
    base = full.replace('\\', '/').rsplit('/', 1)[-1].strip().lower()
    return base[:-4] if base.endswith('.exe') else base


def resolveTargetApps() -> tuple[str, ...]:
    """Every identity the foreground window legitimately answers to.

    The process first (stable, language-independent), then the window title.
    Both are returned because a user may type either: ``chrome`` matches the
    process, ``Google Chrome`` matches the title, and a process that is a
    generic host (soffice.bin, electron.exe) is only distinguishable by title.
    Returning both is what lets :func:`decide` match whichever the user wrote,
    instead of silently narrowing them to one spelling.

    Best-effort: an empty tuple means "unknown app", which the caller treats as
    the configured default — never as "allowed".
    """
    out: list[str] = []
    try:
        import pygetwindow as gw  # type: ignore[import-not-found]

        active = gw.getActiveWindow()
        if active is None:
            return ()
        # pygetwindow exposes the raw HWND as `_hWnd`; some builds use `hwnd`.
        hwnd = getattr(active, '_hWnd', None)
        if hwnd is None:
            hwnd = getattr(active, 'hwnd', None)
        if hwnd:
            proc = _windows_process_for_hwnd(int(hwnd))
            if proc:
                out.append(proc)
        title = str(getattr(active, 'title', '') or '').strip()
        if title:
            out.append(title)
    except Exception:  # noqa: BLE001 -- window introspection is best-effort
        logger.debug('app policy: foreground window unavailable', exc_info=True)
    # De-duplicate case-insensitively, keeping the first spelling of each.
    seen: set[str] = set()
    uniq: list[str] = []
    for value in out:
        folded = value.lower()
        if folded not in seen:
            seen.add(folded)
            uniq.append(value)
    return tuple(uniq)


def resolveTargetApp() -> str:
    """The single best identity of the foreground window, or ``''``.

    Kept for callers that only need one string; :func:`resolveTargetApps` is
    what enforcement should use.
    """
    apps = resolveTargetApps()
    return apps[0] if apps else ''


def targetAliases(app: str) -> tuple[str, ...]:
    """Every string a policy key may legitimately be written as for ``app``.

    The process name plus the title, so a user who typed either one matches.
    Kept next to the resolver because deriving the two together is the whole
    point: identity resolution and matching must not drift apart.
    """
    out: list[str] = []
    primary = (app or '').strip()
    if primary:
        out.append(primary.lower())
    return tuple(dict.fromkeys(out))


def decide(
    app: str, *, policies: dict[str, str] | None = None, aliases: tuple[str, ...] = ()
) -> Decision:
    """Map a target app to its policy.

    ``aliases`` are the OTHER identities of the same window (its title, when
    ``app`` is the process name). A key matching any of them counts, so a user
    who typed ``Google Chrome`` still matches when the resolver returned
    ``chrome``.

    Matching is PREFIX-based and directional, most-specific-key-wins. The
    previous rule was a symmetric substring test (``k in target or target in
    k``), which meant a one-character key like ``e`` matched almost every
    window title — a permission decision nobody wrote. Directional matching
    answers the real question instead: "does the configured key name this
    app?", which is true when the identity STARTS WITH the key (``chrome``
    matches ``chrome.exe``) or the key contains the full identity (``chrome``
    matching a user who typed the whole filename).
    """
    resolved = _policies() if policies is None else policies
    identities = [(app or '').strip().lower()] + [a.strip().lower() for a in aliases]
    identities = [i for i in dict.fromkeys(identities) if i]
    if not identities or not resolved:
        return Decision(policy=DEFAULT_POLICY, matched_key='', app=app)
    best_key = ''
    best_policy = ''
    for key, policy_value in resolved.items():
        k = str(key or '').strip().lower()
        # Validate here too, not only in _policies(): an invalid value must
        # never become a Decision, whichever path supplied the map.
        if not k or policy_value not in VALID_POLICIES:
            continue
        for identity in identities:
            # Directional, and a key must be substantial enough to NAME
            # something. `endswith` alone made a one-character key like "e"
            # match almost every identity — a deny nobody wrote. A key shorter
            # than 3 characters cannot name an app, so it never matches on a
            # suffix; prefix/exact still apply so "vim"/"vi" can be configured.
            if identity.startswith(k) or k.startswith(identity):
                if len(k) > len(best_key):
                    best_key, best_policy = k, policy_value
                break
            if len(k) >= 3 and identity.endswith(k):
                if len(k) > len(best_key):
                    best_key, best_policy = k, policy_value
                break
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
        identities = resolveTargetApps() if app is None else (app,)
        if not identities:
            return decide('', policies=policies)
        return decide(
            identities[0], policies=policies, aliases=tuple(identities[1:])
        )
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

    ``reset`` raises ``RuntimeError`` — not ``ValueError`` — when a token has
    already been used, and that happens on any path where the flag is cleared
    twice (the gate consuming it, then the caller's ``finally``). Since this
    runs in a ``finally`` inside tool dispatch, an escaping exception here would
    replace the tool's real result with a bookkeeping error. Never raises.
    """
    if token is not None:
        try:
            _approved.reset(token)  # type: ignore[arg-type]
            return
        except (ValueError, RuntimeError):
            # Token created in a different context, or already spent. Either
            # way the safe end state is "not approved".
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


def _queuedArgs(tool_name: str, action: str, params: dict[str, object]) -> dict[str, object]:
    """The args to queue for ``tool_name`` — in ITS schema's shape.

    The primitive is reached through the dispatcher, which takes
    ``{'action': ..., **params}``. Queueing that dict verbatim under the
    concrete tool name looked right and was not: `desktop_click`'s schema is
    ``{x, y, button}``, so on replay the extra `action` key failed validation and
    the approved click returned a TypeError — every desktop approval except
    `ui_act` was broken, and the test claiming the round-trip worked was green
    because it hand-built the mutation without `action`.

    So: same shape the primitive will receive, keyed by the name the approval
    will dispatch.
    """
    if tool_name == 'desktop_ui_act':
        # The UIA tool IS parameterised by action, so it keeps it.
        return {'action': action, **params}
    return dict(params or {})


def _queueApproval(session: object, action: str, params: dict[str, object]) -> str:
    """Hand the action to the EXISTING approval machinery.

    Reusing ``createPendingMutation`` means the approval card, the realtime
    event, the once/session/always grants and the preview text are the same
    ones every guarded tool already uses — rather than a second, parallel
    approval system built for desktop actions alone.
    """
    try:
        from app.services.workbench.workbench import createPendingMutation

        # The tool name comes from the MAP, never from string assembly. This is
        # the same derivation that produced `desktop_press` — not a registered
        # tool — which silently downgraded `deny` to `ask`. The queued name also
        # drives the sandbox gate category and the "always allow" grant scope, so
        # a wrong one mints a grant for a tool that does not exist.
        tool_name = ACTION_TO_TOOL.get(action, '')
        if not tool_name:
            return ''
        mutation = createPendingMutation(
            session,  # type: ignore[arg-type]
            tool_name,
            _queuedArgs(tool_name, action, params),
        )
        return str((mutation or {}).get('token') or '')
    except Exception:  # noqa: BLE001 -- caller treats an empty token as a refusal
        logger.debug('app policy: approval queue failed', exc_info=True)
        return ''

