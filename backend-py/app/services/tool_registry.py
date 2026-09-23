"""
Tool registry — register, describe, and dispatch tools (Phase 3).

Supports reserved bridge names and optional keywords per tool.
"""

from __future__ import annotations

import contextvars
import logging
import os
import re
from typing import Callable, Coroutine

logger = logging.getLogger(__name__)

_registry: dict[str, dict[str, object]] = {}
ToolHandler = Callable[..., Coroutine[object, object, str]]
# Bridge tool names (tool_search / tool_describe / tool_call) are REGISTERED
# with real handlers in tool_bridges now — the set is empty so registration
# works; the names are documented in tool_bridges for def assembly.
_RESERVEDNames: frozenset[str] = frozenset()
_daemonContext: contextvars.ContextVar[bool] = contextvars.ContextVar('daemon_context', default=False)
# Monotonic generation for tool-definition caches (increments on register/clear).
_generation: int = 0


def setDaemonContext() -> None:
    """Mark subsequent tool calls as coming from a daemon.

    While set, `run_command` rejects mutating commands (daemons are
    read-only — nobody is watching to approve a write) and the workbench
    treats calls as unattended (no approval prompts).
    """
    _daemonContext.set(True)


def clearDaemonContext() -> None:
    """Exit daemon context."""
    _daemonContext.set(False)


def isDaemonContext() -> bool:
    """Check if currently in daemon context."""
    return _daemonContext.get()


# --------------------------------------------------------------------------
# Daemon (unattended) command policy.
#
# Daemons run with no user watching, so their shell access is read-only. This
# used to be a substring list ('rm ', ' del', 'dd ' …) evaluated against the
# lowercased command line, which is not a policy so much as a string search:
# `/bin/rm -rf x`, `find . -delete`, `git clean -fdx`, `truncate -s 0 f`,
# `xargs rm`, `python -c "os.remove(...)"` and `cmd /c del f` all sailed
# through, while `echo "do not rm me"` was blocked. Classification is now done
# on the parsed argv of each shell segment, against the program actually being
# executed plus the flags it is given.
# --------------------------------------------------------------------------

# Programs whose only interesting behavior is destruction.
_DAEMON_DENY_PROGRAMS = frozenset({
    'rm', 'del', 'erase', 'unlink', 'shred', 'wipe',
    'mv', 'ren', 'rename', 'move',
    'rmdir', 'rd', 'dd', 'mkfs', 'format', 'fdisk', 'diskpart',
    'truncate', 'tee', 'chmod', 'chown', 'cacls', 'icacls', 'takeown',
    'kill', 'pkill', 'killall', 'taskkill', 'stop-process',
    'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'systemctl', 'service',
    'reg', 'sc', 'setx', 'netsh',
})

# Wrappers that hide the real program: resolve one level in, else refuse.
_DAEMON_TRANSPARENT_PREFIXES = frozenset({
    'sudo', 'doas', 'env', 'nohup', 'time', 'command', 'builtin', 'xargs',
})

# Options that consume the token after them. Without this table `sudo -u root
# rm -rf x` stops unwrapping at `-u`, classifies the *option* as the program,
# and finds it harmless — the deny list was reachable by adding one flag.
_DAEMON_WRAPPER_VALUE_OPTIONS: dict[str, frozenset[str]] = {
    'sudo': frozenset({'-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
                       '-C', '--close-from', '-r', '--role', '-t', '--type'}),
    # `doas -s` takes NO argument (it means "run the shell"): listing it as a
    # value option consumed the *program* behind it and promoted the trailing
    # argument — `doas -s rm x` classified `x` and waved `rm` through.
    'doas': frozenset({'-C', '-u'}),
    'env': frozenset({'-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-v',
                      '--debug', '--default-signal', '--ignore-signal', '--signal-context'}),
    'xargs': frozenset({'-n', '--max-args', '-s', '--max-chars', '-P', '--max-procs',
                        '-I', '--replace', '-E', '--eof', '-d', '--delimiter',
                        '-L', '--max-lines', '-a', '--arg-file'}),
    'time': frozenset({'-o', '--output'}),
    'exec': frozenset({'-a', '--argv0'}),
    'command': frozenset(),
    'nohup': frozenset(),
    'builtin': frozenset(),
}


def _unwrapDaemonPrefixes(tokens: list[str]) -> tuple[int, list[str]] | None:
    """Index of the real program behind transparent wrappers, plus the tokens
    those wrappers swallowed as option *values*.

    Returns None when the chain cannot be resolved, so the caller refuses
    rather than classifying an option as the program. The swallowed tokens come
    back because a value can itself be the program (`doas -s rm x`) — handing
    back only the index would hide it behind a flag.
    """
    index = 0
    swallowed: list[str] = []
    while index < len(tokens):
        wrapper = _normalizeProgram(tokens[index])
        if wrapper not in _DAEMON_TRANSPARENT_PREFIXES:
            return index, swallowed
        index += 1
        valueOptions = _DAEMON_WRAPPER_VALUE_OPTIONS.get(wrapper, frozenset())
        while index < len(tokens):
            arg = tokens[index]
            if arg == '--':
                index += 1
                break
            if arg.startswith('-'):
                index += 1
                if '=' in arg:
                    continue
                if arg in valueOptions and index < len(tokens):
                    if not tokens[index].startswith('-'):
                        swallowed.append(tokens[index])
                        index += 1
                continue
            if _isEnvAssignment(arg):
                # `env FOO=bar rm x`: an assignment behind a wrapper is not the
                # program. Stopping here classified `foo=bar` as one and waved
                # the whole command behind it through — the same hole as `-u`,
                # wearing `NAME=value` instead of a flag.
                index += 1
                continue
            break
    # Every token was a wrapper (or its option): there is no program to
    # classify. Returning `(None, …)` here would sail past the caller's
    # `is None` guard and compare None against a length.
    return None


def _hiddenByWrapperValue(value: str) -> str | None:
    """Why this swallowed wrapper value hides a program, or None when it can't.

    A wrapper option's value may be a whole command line: `env -S 'rm -rf x'`
    and `env -S 'python -c …'` exec the string, and `doas -s rm x` hides `rm`
    behind a flag that does not even take an argument. Classifying only the
    token *behind* the value would then certify the wrong program.
    """
    parts = value.split()
    if not parts:
        return None
    word = _normalizeProgram(parts[0])
    if word in _DAEMON_DENY_PROGRAMS or word in _DAEMON_SHELLS_AND_INSTALLERS:
        return f'wrapper option value {value!r} hides the program that runs'
    if word in _DAEMON_INTERPRETERS and (
        any(part.split('=', 1)[0] in _DAEMON_INLINE_CODE_FLAGS for part in parts[1:])
        or '-' in parts[1:]
    ):
        return f'wrapper option value {value!r} carries inline code'
    return None

# Programs that can execute arbitrary code passed inline on the command line.
# Only refused when an inline-code flag is actually present: a daemon running a
# pre-existing `analyze.py` is no more dangerous than the daemon's own code, so
# refusing it would break working automations without closing a hole.
_DAEMON_INTERPRETERS = frozenset({
    'python', 'python3', 'python2', 'py', 'pypy', 'node', 'deno', 'bun', 'ruby',
    'perl', 'php', 'lua', 'osascript',
})

# Shells, installers and fetch-and-run tools: writing files or executing
# downloaded code is their normal job, so a read-only daemon has no
# legitimate use for them at all.
_DAEMON_SHELLS_AND_INSTALLERS = frozenset({
    'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish',
    'npm', 'npx', 'pnpm', 'yarn', 'pip', 'uv', 'uvx', 'cargo', 'make',
    'docker', 'kubectl', 'ssh', 'scp', 'rsync', 'ansible',
})

# Per-program flags that turn an otherwise-safe invocation destructive.
# Compared lowercased, matching `_DAEMON_DENY_FLAGS` lookups below.
_DAEMON_DENY_FLAGS: dict[str, tuple[str, ...]] = {
    'find': ('-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf'),
    'git': ('clean', 'reset', 'checkout', 'restore', 'rm', 'mv', 'push', 'rebase',
            'gc', 'stash', 'config'),
    'sed': ('--in-place', '-i'),
    'tar': ('--delete',),
    # curl/wget are classified case-sensitively in `_httpWriteReason` instead:
    # lowercasing conflates `-t` (timeout) with `-T` (upload) and `-f` (fail)
    # with `-F` (multipart), which invents false positives for harmless flags.
}

# `-c`/`-e` style inline-code flags, shared across interpreter families.
_DAEMON_INLINE_CODE_FLAGS = frozenset({
    '-c', '-e', '--command', '--eval', '-encodedcommand',
})

# `python -m pip …` is `pip …` wearing an interpreter's clothes: the installer
# deny list never sees the program name because argv[0] is `python`.
_DAEMON_MODULE_DENY = frozenset({
    'pip', 'pip3', 'uv', 'uvx', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'conda',
    'ensurepip', 'venv', 'virtualenv', 'setuptools', 'distutils', 'build',
})

# Fork-bomb family: a function definition whose body invokes itself. There is
# no program name to classify, so it is matched structurally.
_DAEMON_FUNCTION_DEFINITION = re.compile(r'\w*\(\s*\)\s*\{')

# HTTP clients: fetching is a read, but a body or a state-changing verb is a
# write to someone else's server — which is exactly what an unattended run
# must not do without an approver.
_DAEMON_HTTP_TOOLS = frozenset({'curl', 'wget'})
_DAEMON_SAFE_HTTP_METHODS = frozenset({'get', 'head'})
# Matched case-sensitively against the raw argv: `curl -X` sets a method while
# `curl -x` sets a proxy, and `curl -f` (--fail) is nothing like `curl -F`
# (multipart upload). A lowercased comparison would get both wrong.
_DAEMON_HTTP_WRITE_FLAGS = frozenset({
    # Request bodies / uploads. curl `-T` uploads; curl `-t` is a timeout and
    # wget `-t` is a retry count, so neither may appear here.
    '-d', '--data', '--data-binary', '--data-raw', '-F', '--form', '--form-string',
    '--post-data', '--post-file', '-T', '--upload-file',
    # Writing a response, header or cookie jar to disk. curl `-J` honours the
    # remote filename; `-j` merely discards cookies.
    '-o', '--output', '-O', '-J', '--remote-name', '--remote-header-name',
    '-c', '--cookie-jar',
})
_DAEMON_HTTP_METHOD_FLAGS = frozenset({'-X', '--request'})

# `>` / `>>` / `2>` redirect to a path is a write. `/dev/null` and NUL are drops.
_DAEMON_NULL_SINKS = frozenset({'/dev/null', 'nul'})

_SEGMENT_SPLIT_CHARS = ('&&', '||', ';', '|', '\n', '&')


def _splitShellSegments(command: str) -> list[str]:
    """Split a command line into segments at shell control operators."""
    segments: list[str] = []
    buffer = command
    while buffer:
        earliest_index = -1
        earliest_op = ''
        for op in _SEGMENT_SPLIT_CHARS:
            index = buffer.find(op)
            if index != -1 and (earliest_index == -1 or index < earliest_index):
                earliest_index = index
                earliest_op = op
        if earliest_index == -1:
            segments.append(buffer)
            break
        segments.append(buffer[:earliest_index])
        buffer = buffer[earliest_index + len(earliest_op):]
    return [seg.strip() for seg in segments if seg.strip()]


def _normalizeProgram(token: str) -> str:
    """Bare, lowercase program name: strips paths, .exe and shell quoting."""
    program = token.strip().strip('"\'')
    program = program.replace('\\', '/').rsplit('/', 1)[-1]
    if program.lower().endswith('.exe'):
        program = program[:-4]
    return program.lower()


def _redirectWritesSomewhere(segment: str) -> bool:
    """True when a `>`/`>>` target is a real file rather than a null sink."""
    index = 0
    while index < len(segment):
        char = segment[index]
        if char == '>':
            rest = segment[index + 1:]
            if rest.startswith('>'):
                rest = rest[1:]
            target = rest.lstrip().split()[0] if rest.lstrip() else ''
            target = target.strip('"\'')
            if target and target.lower() not in _DAEMON_NULL_SINKS:
                return True
            index += 1
            continue
        index += 1
    return False


# Config keys a daemon may set inline with `git -c`. Everything else is
# refused because a git config value can *name a program to run*: alias `!…`,
# core.pager, core.editor, core.sshCommand, core.fsmonitor, diff.external,
# merge.*.program, credential.helper. A deny list of those keys is a list to
# grow forever, so only keys that hold plain data are open.
_GIT_INLINE_CONFIG_ALLOW = frozenset({
    'user.name', 'user.email', 'user.username',
    'commit.gpgsign', 'tag.gpgsign',
    'core.autocrlf', 'core.safecrlf', 'core.filemode', 'core.symlinks',
    'core.longpaths', 'core.quotepath', 'core.precomposeunicode',
    'init.defaultbranch', 'safe.directory', 'gc.auto',
    'protocol.file.allow', 'protocol.https.allow', 'protocol.ssh.allow',
})


def _gitInlineConfigRefusal(rawArgs: list[str]) -> str | None:
    """Why this `git -c …` line is refused, or None when every key is data.

    `git config` (the subcommand) is denied by `_DAEMON_DENY_FLAGS`, but
    `git -c alias.x='!rm -rf /' x` performs the same injection in one command:
    I confirmed the alias executes on git 2.55, so the flag needs the same door.
    Case-sensitively matched against raw tokens — `rest` is lower-cased and
    `-C <dir>` (chdir) would otherwise read as `-c`.
    """
    position = 0
    while position < len(rawArgs):
        token = rawArgs[position]
        if token in ('-c', '--config-env'):
            inline = rawArgs[position + 1] if position + 1 < len(rawArgs) else ''
            position += 2
        elif token.startswith('--config-env='):
            inline = token.partition('=')[2]
            position += 1
        else:
            position += 1
            continue
        key = inline.partition('=')[0].lower()
        if not key or key not in _GIT_INLINE_CONFIG_ALLOW:
            named = key or inline or 'key=?'
            return (
                f'git -c {named} injects configuration that can name a program '
                f'to run; set it with `git config` outside daemon context'
            )
    return None


def commandBlockReason(command: str) -> str | None:
    """Why this command is unsafe for unattended execution, or None to allow."""
    import shlex

    text = (command or '').strip()
    if not text:
        return None
    # Command substitution defeats any static reading of the line: the real
    # program is only knowable at run time, so there is nothing to classify.
    if '$(' in text or '`' in text or '${' in text:
        return 'shell substitution hides the program that will run'
    # `:(){:|:&};:` and every variant of it is a function definition that
    # forks itself; there is no program name to classify at all. The retired
    # substring list matched this literal, so the shape must stay denied here.
    if _DAEMON_FUNCTION_DEFINITION.search(text):
        return 'shell function definition can fork without limit'
    if _redirectWritesSomewhere(text):
        return 'output redirection writes a file'

    for segment in _splitShellSegments(text):
        segment = _stripEnvAssignments(segment)
        try:
            tokens = shlex.split(segment, posix=(os.name != 'nt'))
        except ValueError:
            # Unbalanced quoting: we cannot name the program, so refuse.
            return f'unparseable command segment ({segment[:60]!r})'
        if not tokens:
            continue

        resolved = _unwrapDaemonPrefixes(tokens)
        if resolved is None or resolved[0] >= len(tokens):
            return f'wrapper with no resolvable program: {tokens[0]!r}'
        index, swallowed = resolved

        program = _normalizeProgram(tokens[index])
        rest = [tok.lower() for tok in tokens[index + 1:]]
        for value in swallowed:
            hidden = _hiddenByWrapperValue(value)
            if hidden:
                return hidden
        if index > 0 and program.startswith('-'):
            # An option this table does not know would otherwise be classified
            # as a harmless program name and waved through. Only meaningful
            # behind a wrapper — a leading '-' is not a wrapper at all.
            return f'unrecognised wrapper argument {program!r} hides the program that runs'

        if program in _DAEMON_DENY_PROGRAMS:
            return f'{program} mutates the filesystem or system state'
        if program in _DAEMON_SHELLS_AND_INSTALLERS:
            return f'{program} writes files or executes fetched code'
        if program == 'git':
            # Checked case-SENSITIVELY against the raw tokens: `rest` is lower-
            # cased, and `-C <dir>` (chdir) would otherwise read as `-c`.
            inlineConfig = _gitInlineConfigRefusal(tokens[index + 1:])
            if inlineConfig:
                return inlineConfig
        if program in _DAEMON_INTERPRETERS:
            if any(token.split('=', 1)[0] in _DAEMON_INLINE_CODE_FLAGS for token in rest):
                return f'{program} invoked with an inline code flag'
            if '-' in rest:
                # `python - <<EOF` pipes a whole program in, so no segment of it
                # is ever classified — the heredoc body reads as new commands.
                return f'{program} reads the program to run from stdin'
            for offset, token in enumerate(rest):
                if token not in ('-m', '--module'):
                    continue
                module = rest[offset + 1].partition('.')[0] if offset + 1 < len(rest) else ''
                if module in _DAEMON_MODULE_DENY:
                    return f'{program} -m {module} installs packages or runs fetched code'
                break

        deny = _DAEMON_DENY_FLAGS.get(program, ())
        if program in _DAEMON_HTTP_TOOLS:
            reason = _httpWriteReason(program, tokens[index + 1:])
            if reason:
                return reason
        for token in rest:
            bare = token.split('=', 1)[0]
            if bare in deny or (program == 'git' and bare.lstrip('-') in deny):
                return f'{program} invoked with the destructive flag {token}'
    return None


def _httpWriteReason(program: str, rawArgs: list[str]) -> str | None:
    """Flag a curl/wget call that changes state on a remote server.

    Flags are matched case-sensitively because `curl -X` is the method while
    `curl -x` is the proxy — lowercasing them would refuse proxy configuration
    as if it were a POST.
    """
    for position, token in enumerate(rawArgs):
        name, _, inline_value = token.partition('=')
        if name in _DAEMON_HTTP_WRITE_FLAGS:
            return f'{program} sends a request body'
        if name in _DAEMON_HTTP_METHOD_FLAGS:
            verb = inline_value or (
                rawArgs[position + 1] if position + 1 < len(rawArgs) else ''
            )
            if verb and verb.lower() not in _DAEMON_SAFE_HTTP_METHODS:
                return f'{program} issues a {verb.upper()} request, which can change server state'
    return None


def _stripEnvAssignments(segment: str) -> str:
    """Drop leading `VAR=value` assignments so the real program is first."""
    tokens = segment.split()
    while tokens and _isEnvAssignment(tokens[0]):
        tokens = tokens[1:]
    return ' '.join(tokens)


def _isEnvAssignment(token: str) -> bool:
    name, _, _value = token.partition('=')
    if not _value:
        return False
    name = name.lstrip('$').replace('_', ' ')
    return bool(name) and all(char.isalpha() or char == ' ' or char.isdigit() for char in name)


def isCommandBlocked(command: str) -> bool:
    """Check if a command is unsafe to run unattended (daemon context)."""
    return commandBlockReason(command) is not None


def register(
    name: str,
    description: str,
    handler: ToolHandler,
    parameters: dict[str, object] | None = None,
    keywords: list[str] | None = None,
) -> None:
    """Register a tool.

    ``keywords`` is an optional list of search terms for BM25 retrieval (Phase 3).
    """
    global _generation
    if name in _RESERVEDNames:
        raise ValueError(f"Cannot register reserved bridge name: '{name}'")
    _registry[name] = {
        'name': name,
        'description': description,
        'handler': handler,
        'parameters': parameters or {},
        'keywords': keywords or [],
    }
    _generation += 1


def generation() -> int:
    """Monotonic counter bumped on each register/unregister.

    Tool-definition caches key on this so they rebuild after the registry changes.
    """
    return _generation


def unregister(name: str) -> bool:
    """Remove a registered tool. Returns True if it was present.

    Bumps ``generation()`` so tool-definition caches drop entries for withdrawn
    tools and stop serving stale schemas.
    """
    global _generation
    if name not in _registry:
        return False
    del _registry[name]
    _generation += 1
    return True


def get(name: str) -> dict[str, object] | None:
    """Get a tool definition by name."""
    return _registry.get(name)


def getTool(name: str) -> dict[str, object] | None:
    """Alias for get()."""
    return _registry.get(name)


def listRaw() -> list[dict[str, object]]:
    """List all registered tools in raw (internal) format with keywords."""
    return list(_registry.values())


_DESKTOP_TOOL_PREFIXES = (
    'desktop_',
    'computer_',
    'host_',
)


def is_host_agent_tool(name: str) -> bool:
    """Tools that require a reachable host agent / local desktop automation."""
    if not isinstance(name, str):
        return False
    return name.startswith(_DESKTOP_TOOL_PREFIXES) or name in (
        'screenshot',
        'computer_use',
        'move_mouse',
        'click_mouse',
        'type_text',
    )


async def host_agent_available() -> bool:
    """True when host agent URL is set and health responds, or local desktop is usable."""
    import os

    url = os.environ.get('AUGUST_HOST_AGENT_URL', '').strip()
    if url:
        try:
            from app.services.host_agent import getHostInfo

            info = await getHostInfo()
            return bool(info.get('available'))
        except Exception:
            return False
    # Local pyautogui path: available when import works (desktop_automation)
    try:
        import app.services.desktop_automation as da  # noqa: F401

        return True
    except Exception:
        return False


def listTools(*, include_host_agent: bool | None = None) -> list[dict[str, object]]:
    """List tools; hide host/desktop tools when host agent is unavailable.

    ``include_host_agent``:
      - None: best-effort sync check (env URL unset → keep local desktop tools)
      - True/False: force include/exclude
    """
    show_host = include_host_agent
    if show_host is None:
        import os

        url = os.environ.get('AUGUST_HOST_AGENT_URL', '').strip()
        # When URL is set but we can't async-check here, hide until proven up
        # (callers that need async should pass include_host_agent after await).
        if url:
            show_host = False
        else:
            show_host = True  # local desktop path
    result: list[dict[str, object]] = []
    for t in _registry.values():
        name = t.get('name')
        if not isinstance(name, str):
            continue
        if not show_host and is_host_agent_tool(name):
            continue
        description = t.get('description')
        parameters = t.get('parameters')
        if not isinstance(description, str):
            description = ''
        if not isinstance(parameters, dict):
            parameters = {}
        result.append(
            {'type': 'function', 'function': {'name': name, 'description': description, 'parameters': parameters}}
        )
    return result


def schema_param_hint(tool: dict[str, object]) -> str:
    """Render a tool's registered JSON-schema parameters as a compact
    ``name:type`` list (required params starred) for error receipts."""
    params = tool.get('parameters')
    if not isinstance(params, dict):
        return ''
    props = params.get('properties')
    if not isinstance(props, dict):
        return ''
    required = params.get('required')
    requiredSet = {str(r) for r in required} if isinstance(required, list) else set()
    parts: list[str] = []
    for key, spec in props.items():
        typ = spec.get('type') if isinstance(spec, dict) else None
        label = f'{key}:{typ}' if typ else str(key)
        if str(key) in requiredSet:
            label += '*'
        parts.append(label)
    return ', '.join(parts)


# Argument-shape mistakes surface deep in handlers as these — the raw text
# ('str' object has no attribute 'get') tells the model nothing, so we swap
# it for a schema-aware receipt. Anything else (OSError, ValueError from
# real logic) keeps its message — it is genuinely informative.
ARG_SHAPE_EXCEPTIONS = (TypeError, AttributeError, KeyError, IndexError)


async def dispatch(name: str, args: dict[str, object]) -> str:
    """Dispatch a tool call by name and arguments.

    Host/desktop tools refuse when the host agent is configured but down.
    """
    tool = _registry.get(name)
    if not tool:
        return f'Error: Tool "{name}" not found.'
    if is_host_agent_tool(name):
        import os

        if os.environ.get('AUGUST_HOST_AGENT_URL', '').strip():
            if not await host_agent_available():
                return (
                    f'[UNAVAILABLE] Tool "{name}" requires the host agent, '
                    'which is disconnected. Set AUGUST_HOST_AGENT_URL to a healthy '
                    'agent or clear it to use local desktop automation.'
                )
    if name == 'run_command' and isDaemonContext():
        command = args.get('command', '')
        if not isinstance(command, str):
            command = ''
        if isCommandBlocked(command):
            reason = commandBlockReason(command) or 'mutating behavior'
            return (
                f"[BLOCKED] run_command rejected in daemon context: {reason}. "
                'Daemons are read-only — nobody is watching to approve a write. '
                'Rewrite this as a read-only command, or ask the user to run it.'
            )
    try:
        handler = tool['handler']
        if not callable(handler):
            return f'Error: Tool "{name}" handler is not callable.'
        result = await handler(**args)
        # Safety net: the tool-result pipeline (SSE, history, model context)
        # requires a string. A handler that returns dict/list (the camera
        # tools did) must not smuggle a non-str into the transcript.
        if not isinstance(result, str):
            import json

            try:
                result = json.dumps(result, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                result = str(result)
        return result
    except ARG_SHAPE_EXCEPTIONS as e:
        # The handler choked on the argument shape — hand the model a
        # schema-aware receipt instead of a raw Python message it cannot
        # act on (the old text made models flail through retry spirals).
        logger.warning('tool %s argument-shape failure', name, exc_info=True)
        hint = schema_param_hint(tool)
        suffix = f' Expected parameters: {hint}.' if hint else ''
        return (
            f'Error executing {name}: the arguments did not match this tool\'s schema '
            f'({type(e).__name__}). Pass arrays as arrays and objects as objects — '
            f'never stringified JSON. Required shape: {name}({hint or "see tool definition"}).{suffix}'
        )
    except Exception as e:
        return f'Error executing {name}: {e}'
