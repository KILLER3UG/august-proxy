"""
Workbench chat engine — session management, streaming chat loop,
tool execution, and plan/approval workflow.

Port of backend/services/workbench/workbench.js (3,675 lines).

Key subsystems:
- Session CRUD (create, get, list, delete, reset)
- Streaming chat loop (Anthropic and OpenAI, streaming and non-streaming)
- Tool execution dispatch (15+ tool types)
- Plan/approval gate (plan mode, pending mutations, approval tokens)
- System prompt building (3-tier cache structure)
- Effort/thinking budget resolution
- Goal system (stubbed)
- Subagent dispatch (stubbed)
"""
from __future__ import annotations
import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator, Callable
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float, as_bool
from app.models import AnthropicRequest, ChatCompletionRequest, ChatMessage, ToolDefinition, FunctionDefinition, Usage
logger = logging.getLogger('workbench')
MAX_MANAGED_TOOL_ROUNDS = 10
WORKBENCH_TOKEN_BUDGET = 2000000

@dataclass
class WorkbenchSession:
    """In-memory representation of a workbench session.

    Persisted to disk as JSON via saveSessions().
    """
    id: str = ''
    title: str = 'New Session'
    provider: str = ''
    model: str = ''
    agentId: str = ''
    guardMode: str = 'full'
    createdAt: str = ''
    updatedAt: str = ''
    startedAt: str = ''
    messageCount: int = 0
    mutationCount: int = 0
    workspacePath: str = ''
    goal: str = ''
    plan: dict[str, object] | None = None
    planApproved: bool = False
    clarify: dict[str, object] | None = None
    todos: list[dict[str, object]] | None = None
    messages: list[dict[str, object]] = field(default_factory=list)
    pendingMutations: list[dict[str, object]] = field(default_factory=list)
    mutationLog: list[dict[str, object]] = field(default_factory=list)
    status: str = 'idle'
    metadata: dict[str, object] = field(default_factory=dict)
    totalInputTokens: int = 0
    totalOutputTokens: int = 0
    totalCost: float = 0.0
    queuedUserMessages: list[dict[str, object]] = field(default_factory=list)

    def toDict(self) -> dict[str, object]:
        return {'id': self.id, 'title': self.title, 'provider': self.provider, 'model': self.model, 'agentId': self.agentId, 'guardMode': self.guardMode, 'createdAt': self.createdAt, 'updatedAt': self.updatedAt, 'startedAt': self.startedAt, 'messageCount': self.messageCount, 'mutationCount': self.mutationCount, 'workspacePath': self.workspacePath, 'goal': self.goal, 'plan': self.plan, 'planApproved': self.planApproved, 'clarify': self.clarify, 'todos': self.todos, 'messages': self.messages, 'pendingMutations': self.pendingMutations, 'mutationLog': self.mutationLog, 'status': self.status, 'metadata': self.metadata, 'totalInputTokens': self.totalInputTokens, 'totalOutputTokens': self.totalOutputTokens, 'totalCost': self.totalCost, 'queuedUserMessages': self.queuedUserMessages}

    @staticmethod
    def fromDict(d: dict[str, object]) -> WorkbenchSession:
        return WorkbenchSession(id=as_str(d.get('id', '')), title=as_str(d.get('title', 'New Session')), provider=as_str(d.get('provider', '')), model=as_str(d.get('model', '')), agentId=as_str(d.get('agentId', '')), guardMode=as_str(d.get('guardMode', 'full')), createdAt=as_str(d.get('createdAt', '')), updatedAt=as_str(d.get('updatedAt', '')), startedAt=as_str(d.get('startedAt', '')), messageCount=as_int(d.get('messageCount', 0)), mutationCount=as_int(d.get('mutationCount', 0)), workspacePath=as_str(d.get('workspacePath', '')), goal=as_str(d.get('goal', '')), plan=as_dict(d.get('plan')), planApproved=as_bool(d.get('planApproved', False)), clarify=as_dict(d.get('clarify')), todos=as_list(d.get('todos')), messages=as_list(d.get('messages', [])), pendingMutations=as_list(d.get('pendingMutations', [])), mutationLog=as_list(d.get('mutationLog', [])), status=as_str(d.get('status', 'idle')), metadata=as_dict(d.get('metadata', {})), totalInputTokens=as_int(d.get('totalInputTokens', 0)), totalOutputTokens=as_int(d.get('totalOutputTokens', 0)), totalCost=as_float(d.get('totalCost', 0.0)), queuedUserMessages=as_list(d.get('queuedUserMessages', [])))
_SESSIONFile = 'workbench-sessions.json'
_sessions: dict[str, WorkbenchSession] = {}
_statusSubscribers: list[Callable[[dict[str, object]], None]] = []

def _sessionsPath() -> Path:
    from app.lib.paths import dataPath
    return dataPath(_SESSIONFile)

def _now() -> str:
    return datetime.utcnow().isoformat() + 'Z'

def _loadSessions() -> None:
    """Load sessions from disk."""
    path = _sessionsPath()
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text('utf-8'))
        for item in data:
            session = WorkbenchSession.fromDict(item)
            _sessions[session.id] = session
    except (json.JSONDecodeError, OSError):
        pass

def saveSessions() -> None:
    """Persist all sessions to disk (keeps last 50)."""
    sortedSessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)[:50]
    path = _sessionsPath()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([s.toDict() for s in sortedSessions], indent=2), 'utf-8')

def _emitSessionStatus(sessionId: str) -> None:
    """Notify status subscribers of a session status change."""
    session = _sessions.get(sessionId)
    if not session:
        return
    event = {'type': 'session_status', 'sessionId': sessionId, 'status': session.status, 'guardMode': session.guardMode, 'pendingMutations': len(session.pendingMutations) > 0}
    for cb in _statusSubscribers:
        try:
            cb(event)
        except Exception:
            pass

def createWorkbenchSession(provider: str='', agentId: str='', guardMode: str='', task: str='', goal: str='') -> WorkbenchSession:
    """Create a new workbench session."""
    sessionId = f'wb_{uuid.uuid4().hex[:12]}'
    now = _now()
    session = WorkbenchSession(id=sessionId, provider=provider, agentId=agentId, guardMode=normalizeGuardMode(guardMode or 'full'), goal=goal, createdAt=now, updatedAt=now, startedAt=now)
    if goal:
        session.goal = goal
    _sessions[sessionId] = session
    saveSessions()
    _emitSessionStatus(sessionId)
    return session

def getWorkbenchSession(sessionId: str | None) -> WorkbenchSession | None:
    """Get a session by ID. Returns None if not found."""
    if not sessionId:
        return None
    if not _sessions:
        _loadSessions()
    return _sessions.get(sessionId)

def setWorkbenchSessionAgent(sessionId: str, agentId: str) -> WorkbenchSession | None:
    """Bind (or clear) an agent on a session so its context shapes the prompt."""
    session = getWorkbenchSession(sessionId)
    if not session:
        return None
    session.agentId = agentId or ''
    session.updatedAt = _now()
    saveSessions()
    _emitSessionStatus(sessionId)
    return session

def listWorkbenchSessions() -> list[dict[str, object]]:
    """Return all sessions summarized."""
    if not _sessions:
        _loadSessions()
    sortedSessions = sorted(_sessions.values(), key=lambda s: s.updatedAt, reverse=True)
    return [summarizeSession(s) for s in sortedSessions]

def deleteWorkbenchSession(sessionId: str) -> bool:
    """Delete a session."""
    if sessionId not in _sessions:
        return False
    session = _sessions[sessionId]
    try:
        from app.services import augArtifactService
        augArtifactService.deleteForSession(session.workspacePath or None, sessionId)
    except Exception:
        pass
    del _sessions[sessionId]
    saveSessions()
    return True

def resetWorkbenchSession(sessionId: str, provider: str='', agentId: str='') -> WorkbenchSession | None:
    """Delete and recreate a session."""
    deleteWorkbenchSession(sessionId)
    return createWorkbenchSession(provider=provider, agentId=agentId)

def summarizeSession(session: WorkbenchSession) -> dict[str, object]:
    """Return a lightweight summary of a session."""
    return {'id': session.id, 'title': session.title, 'provider': session.provider, 'model': session.model, 'agentId': session.agentId, 'guardMode': session.guardMode, 'goal': session.goal, 'plan': session.plan is not None, 'planApproved': session.planApproved, 'messageCount': session.messageCount, 'mutationCount': session.mutationCount, 'status': session.status, 'createdAt': session.createdAt, 'updatedAt': session.updatedAt, 'startedAt': session.startedAt, 'workspacePath': session.workspacePath}

def getWorkbenchSessionStatus(sessionId: str) -> dict[str, object] | None:
    """Return flat status for the UI's approval banner."""
    session = _sessions.get(sessionId)
    if not session:
        return None
    hasPending = len(session.pendingMutations) > 0
    return {'sessionId': sessionId, 'status': session.status, 'guardMode': session.guardMode, 'pendingMutation': session.pendingMutations[-1] if hasPending else None, 'plan': session.plan, 'planApproved': session.planApproved, 'todos': session.todos}

def subscribeSessionStatus(callback: Callable[[dict[str, object]], None]) -> Callable[[], None]:
    """Register a session status subscriber. Returns unsubscribe function."""
    _statusSubscribers.append(callback)

    def unsubscribe() -> None:
        if callback in _statusSubscribers:
            _statusSubscribers.remove(callback)
    return unsubscribe

def normalizeGuardMode(mode: str) -> str:
    """Normalize guard mode to one of: plan, full, ask."""
    lower = mode.strip().lower()
    if lower in ('plan', 'full', 'ask'):
        return lower
    return 'full'

def isPlanModeBlocked(toolName: str, args: dict[str, object] | None=None) -> bool:
    """In plan mode, only DESTRUCTIVE tools are blocked.

    Everything else — read-only file tools, search, web, memory, agent,
    skill, MCP, and any other non-mutating tool — may run so the model can
    investigate freely. Destructive actions (writes, edits, deletes, shell
    commands, installs) require an approved plan; when the model attempts
    one it gets a tool result telling it to call `submit_plan` and ask the
    user for permission.
    """
    if not toolName:
        return False
    name = toolName.lower()
    destructive = {'write_file', 'edit_file', 'create_file', 'str_replace', 'str_replace_editor', 'strreplaceeditttool', 'apply_patch', 'patch_file', 'delete_file', 'remove_file', 'move_file', 'rename_file', 'mkdir', 'makedirs', 'run_command', 'bash', 'bashtool', 'shell', 'exec', 'execute', 'terminal', 'install', 'uninstall', 'pip_install', 'npm_install', 'pnpm_add', 'browser_click', 'browser_type', 'browser_select', 'browser_evaluate', 'create_agent', 'update_agent', 'delete_agent', 'create_alias', 'update_alias', 'delete_alias', 'configure_fallback'}
    if name in destructive:
        return True
    destructiveMarkers = ('write', 'edit', 'delete', 'remove', 'install', 'uninstall', 'exec', 'command', 'bash', 'shell', 'patch', 'rename')
    return any((marker in name for marker in destructiveMarkers))

def buildSystemPrompt(session: WorkbenchSession) -> str:
    """Assemble the 3-tier XML system prompt for a workbench session (Phase 1).

    Uses the Phase 1 context_builder which emits the 3-tier structure:
      Tier 1: Identity & Constraints (static)
      Tier 2: Environment & Experience (semi-stable)
      Tier 3: Dynamic Runtime (volatile)

    Wires brain_orchestrator classification, workspace, VCS, memory stats,
    whats-new, and guard mode rules — achieving Node.js parity.
    """
    from app.services.memory.contextBuilder import buildSystemPrompt as ctxBuild
    from app.services.memoryStore import getMemory
    memory = {}
    profile = getMemory('userProfile')
    if profile:
        memory['userProfile'] = profile
    context = getMemory('current_context')
    if context:
        memory['global_context'] = context
    projects = getMemory('active_projects')
    if projects:
        memory['active_projects'] = projects
    try:
        from app.services.memory.autoMemory import getRelevantMemories
        recentText = ''
        if session.messages:
            recent = session.messages[-6:] if len(session.messages) > 6 else session.messages
            recentText = ' '.join((str(m.get('content', '') or '') for m in recent if isinstance(m, dict) and m.get('role') in ('user', 'assistant')))
        if recentText:
            prefetched = getRelevantMemories(recentText, limit=5)
            if prefetched:
                memory['autoMemories'] = prefetched
    except Exception:
        pass
    try:
        from app.services.memoryStore import _conn as brainConn
        conn = brainConn()
        heuristicsRows = conn.execute('SELECT rule, source, category FROM learnedHeuristics ORDER BY updatedAt DESC').fetchall()
        if heuristicsRows:
            memory['learnedHeuristics'] = [dict(r) for r in heuristicsRows]
    except Exception:
        pass
    coreFacts = getMemory('coreMemory')
    if coreFacts:
        memory['coreMemory'] = coreFacts
    agentContext = None
    if session.agentId:
        try:
            from app.services.tools.agentRegistry import renderAgentContext
            agentContext = renderAgentContext(session.agentId)
        except Exception:
            pass
    brainPolicy = None
    try:
        from app.services.memory.brainOrchestrator import extractTextFromMessages, classifyTask, policyForTask
        msgs = []
        if hasattr(session, 'messages') and session.messages:
            msgs = session.messages
        taskText = extractTextFromMessages(msgs)
        taskType = classifyTask(taskText)
        brainPolicy = policyForTask(taskType)
    except Exception:
        pass
    workspacePath = str(session.workspacePath) if hasattr(session, 'workspacePath') and session.workspacePath else ''
    vcsInfo = ''
    if workspacePath:
        try:
            import subprocess
            branch = subprocess.run(['git', 'branch', '--show-current'], cwd=workspacePath, capture_output=True, text=True, timeout=5).stdout.strip()
            status = subprocess.run(['git', 'status', '--short'], cwd=workspacePath, capture_output=True, text=True, timeout=5).stdout.strip()
            if branch:
                dirty = ' (dirty)' if status else ' (clean)'
                vcsInfo = f'{branch}{dirty}'
        except Exception:
            pass
    memoryStats = {}
    try:
        from app.services.memoryStore import getStats as memStats
        memoryStats = memStats()
    except Exception:
        pass
    whatsNew = ''
    if workspacePath:
        try:
            import subprocess
            log = subprocess.run(['git', 'log', '--oneline', '--since=24 hours ago', '--max-count=10'], cwd=workspacePath, capture_output=True, text=True, timeout=5).stdout.strip()
            if log:
                lines = log.split('\n')
                whatsNew = 'Recent git activity:\n' + '\n'.join((f'  - {l}' for l in lines))
        except Exception:
            pass
    skillsManifest = ''
    try:
        from app.services import skillService
        cat = skillService.catalogue()
        if cat:
            lines = []
            for s in cat:
                desc = s.get('description', '')
                trigger = s.get('trigger', '')
                entry = f"{s['name']}: {desc}" if desc else f"{s['name']}"
                if trigger:
                    entry += f' (trigger: {trigger})'
                lines.append(entry)
            skillsManifest = '\n'.join(lines)
    except Exception:
        pass
    cognitiveBudget = None
    try:
        from app.services.workbench.tokenBudget import computeBudget
        provider = getattr(session, 'provider', None) or ''
        model = getattr(session, 'model', None) or ''
        providerName = provider.get('name', '') if isinstance(provider, dict) else str(provider)
        modelName = model.get('name', '') if isinstance(model, dict) else str(model)
        msgsForBudget = getattr(session, 'messages', []) or []
        cognitiveBudget = computeBudget(msgsForBudget, model=modelName or None, provider=providerName or None)
    except Exception:
        pass
    sessionDict = {'goal': session.goal, 'plan': session.plan.to_dict() if hasattr(session.plan, 'to_dict') else session.plan, 'planApproved': session.planApproved, 'workspacePath': workspacePath, 'vcs': vcsInfo, 'brainPolicy': brainPolicy, 'cognitiveBudget': cognitiveBudget, 'memoryStats': memoryStats, 'whatsNew': whatsNew, 'skillsManifest': skillsManifest, 'executionState': getattr(session, '_execution_state', None), 'workingMemory': getattr(session, '_working_memory', None), 'subconsciousUpdates': _buildDaemonUpdates(getattr(session, 'id', ''))}
    for k in ('coreMemory', 'learnedHeuristics', 'autoMemories'):
        if k in memory:
            sessionDict[k] = memory[k]
    tools = toolDefinitions(session)
    # Load workspace AUG.md into Tier 2 as soft context (Claude CLAUDE.md parity).
    augMdBody = ''
    if workspacePath:
        try:
            from app.services import augDirectiveService
            loaded = augDirectiveService.load(workspacePath)
            if loaded and loaded.get('body'):
                augMdBody = loaded['body']
        except Exception:
            pass
    sessionDict['augMd'] = augMdBody
    sessionDict['todos'] = session.todos
    from app.services.workbench.promptCache import getCache
    promptCache = getCache()
    cacheKey = getattr(session, 'id', '') or ''
    cachedT12 = promptCache.get(cacheKey)
    base = ctxBuild(session=sessionDict, memory=memory, tools=tools, agentContext=agentContext, cachedT12=cachedT12)
    if cachedT12 is None:
        try:
            from app.services.memory.contextBuilder import buildTier1, buildTier2
            t1 = buildTier1(sessionDict)
            t2 = buildTier2(sessionDict)
            t12Parts = []
            if t1:
                t12Parts.append(t1)
            if t2:
                t12Parts.append(t2)
            if t12Parts:
                promptCache.set(cacheKey, '\n\n'.join(t12Parts))
        except Exception:
            pass
    extraParts: list[str] = []
    try:
        from app.services import skillService
        cat = skillService.catalogue()
        if cat:
            intro = "Skills are on-demand capability extensions. Each entry below lists a skill's name, description, and optional trigger. To use a skill, call the `load_skill` tool with its name to load the full instructions, then follow them."
            lines = [intro, '']
            for s in cat:
                desc = s.get('description', '')
                trigger = s.get('trigger', '')
                entry = f"- {s['name']}: {desc}" if desc else f"- {s['name']}"
                if trigger:
                    entry += f' (trigger: {trigger})'
                lines.append(entry)
            extraParts.append('## Available Skills\n' + '\n'.join(lines))
    except Exception:
        pass
    extraParts.append(
        "## Clarifying questions when uncertain\n"
        "When you are genuinely uncertain about the user's intent, requirements, or a decision "
        "that would change your approach, DO NOT guess or invent requirements. Instead, call the "
        "`submit_clarify` tool with a concise `question` (1-2 sentences) and up to 5 short `choices` "
        "(options the user can pick from). You may also pass a `questions` array to ask several "
        "related questions at once. The UI presents your choices as numbered options and adds its own "
        "free-text input for anything not covered, so do NOT include a 'something else' option yourself. "
        "Ask at most one round of clarifying questions unless the user's answer reveals new ambiguity. "
        "This applies in every guard mode, including plan mode."
    )
    if extraParts:
        return base + '\n\n' + '\n\n'.join(extraParts)
    return base

def _shouldAutoCompact(attentionPressure: str, turnsSinceCompaction: int) -> bool:
    """v1.1: Compaction triggers only at critical pressure and after 5-turn cooldown.

    Spec reference: cognitive-architecture-v1.md §5.5
    - Trigger: attention_pressure == "critical" (90% with accurate tokenizer, 85% with fallback)
    - Cooldown: minimum 5 turns between compactions
    """
    return attentionPressure == 'critical' and turnsSinceCompaction >= 5

def _buildDaemonUpdates(sessionId: str) -> str:
    """Build the <subconscious_updates> XML block from daemon results.

    v2: Preserves the [CRITICAL] prefix on daemon output so the model
    can detect critical alerts and pause to inform the user.
    """
    try:
        from app.services.daemonManager import getManager
        manager = getManager()
        daemons = manager.list_daemons(sessionId)
        if not daemons:
            return ''
        lines: list[str] = ['<subconscious_updates>']
        for d in daemons:
            attrs = f'''name="{_xmlEscape(d['name'])}" status="{d['status']}"'''
            if d.get('triggered'):
                attrs += ' triggered="true"'
            output = d.get('output') or ''
            if d.get('error'):
                attrs += f''' error="{_xmlEscape(str(d['error']))}"'''
                lines.append(f'  <daemon {attrs} />')
            elif output:
                lines.append(f'  <daemon {attrs}>{_xmlEscape(output)}</daemon>')
            else:
                lines.append(f'  <daemon {attrs} />')
        lines.append('</subconscious_updates>')
        return '\n'.join(lines)
    except Exception:
        return ''

def _xmlEscape(s: str) -> str:
    """Minimal XML attribute/text escape."""
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

def resolveEffectiveEffort(incoming: str | None, session: WorkbenchSession, modelEntry: dict[str, object] | None=None) -> str:
    """Resolve the effort level from incoming param, session, or model default."""
    if incoming and incoming in ('low', 'medium', 'high', 'max'):
        return incoming
    if session.metadata.get('effort') in ('low', 'medium', 'high', 'max'):
        return session.metadata['effort']
    return 'medium'

def effortToThinkingBudget(effort: str, modelMax: int=32000, maxTokens: int=8192) -> int:
    """Map effort to Anthropic thinking budget tokens."""
    mapping = {'low': min(4096, maxTokens), 'medium': min(8192, maxTokens), 'high': min(16000, maxTokens), 'max': min(modelMax, maxTokens * 2)}
    return mapping.get(effort, 8192)

def effortToPromptInstruction(effort: str) -> str:
    """Map effort to a system-prompt instruction."""
    instructions = {'low': 'Provide quick, concise responses. Minimize analysis.', 'medium': 'Provide balanced responses with moderate analysis.', 'high': 'Provide thorough, detailed analysis. Take your time.', 'max': 'Provide exhaustive, comprehensive analysis. Leave nothing out.'}
    return instructions.get(effort, instructions['medium'])

def effortToOpenaiReasoningEffort(effort: str) -> str:
    """Map August's 4-level effort to OpenAI's 3-level reasoning_effort."""
    mapping = {'low': 'low', 'medium': 'medium', 'high': 'high', 'max': 'high'}
    return mapping.get(effort, 'medium')

def toolDefinitions(session: WorkbenchSession) -> list[dict[str, object]]:
    """Return tool definitions in Anthropic format for a session.

    The tool registry stores definitions in OpenAI format
    (``{"type":"function","function":{...}}``). Anthropic's API expects a
    different shape (``{"name","description","input_schema"}``). We
    canonicalize every registered tool through
    ``sanitize_anthropic_tool_definition`` (a no-op for already-Anthropic
    entries, a converter for OpenAI entries) and dedupe by name.

    We deliberately do NOT append the proxy-passthrough ``mcp__workspace__*``
    / ``WebSearch`` / ``WebFetch`` managed tools here: those are only
    dispatchable inside the proxy passthrough adapter, not in the
    workbench (whose ``_execute_tool`` consults ``tool_registry`` only).
    The workbench registers its own ``web_search`` / ``web_fetch`` /
    ``run_command`` handlers, which cover the same surface and *are*
    dispatchable here. MCP server tools are added separately (see
    ``_mcp_tool_definitions_anthropic``).

    Phase 3: If progressive disclosure is active and the tool set exceeds
    the threshold, BM25 pre-loads the most relevant tools and defers the rest.
    """
    from app.adapters.proxyTools import sanitizeAnthropicToolDefinition
    from app.services.toolRegistry import listTools
    tools: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in listTools():
        t = sanitizeAnthropicToolDefinition(raw)
        if not t:
            continue
        if t['name'] in seen:
            continue
        seen.add(t['name'])
        tools.append(t)
    tools.extend(_mcpToolDefinitionsAnthropic(seen))
    try:
        from app.services.tools.modelTools import assembleToolDefs
        messages = getattr(session, 'messages', None) or []
        contextMsgs = list(messages) if isinstance(messages, list) else []
        result = assembleToolDefs(all_tool_defs=tools, context_messages=contextMsgs)
        if result.activated:
            session._tool_assembly = result
            return result.tool_defs
    except Exception:
        pass
    return tools

def openaiToolDefinitions(session: WorkbenchSession) -> list[dict[str, object]]:
    """Return tool definitions in OpenAI format for a session.

    Mirrors ``tool_definitions``: registry tools (which may be in mixed
    OpenAI/Anthropic format) are normalized to OpenAI format and deduped
    by name, then real MCP server tools are appended.
    """
    from app.adapters.proxyTools import anthropicToOpenaiToolDefinition
    from app.services.toolRegistry import listTools
    tools: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in listTools():
        if raw.get('type') == 'function' and isinstance(raw.get('function'), dict):
            name = raw['function'].get('name', '')
            if name and name not in seen:
                seen.add(name)
                tools.append(raw)
            continue
        t = anthropicToOpenaiToolDefinition(raw)
        name = as_dict(t.get('function', {})).get('name', '')
        if name and name not in seen:
            seen.add(name)
            tools.append(t)
    tools.extend(_mcpToolDefinitionsOpenai(seen))
    return tools

def _mcpToolDefinitionsAnthropic(seen: set[str]) -> list[dict[str, object]]:
    """Real MCP server tools in Anthropic format, deduped against ``seen``."""
    from app.adapters.proxyTools import openaiToAnthropicToolDefinition
    from app.services.tools.mcpClient import getMcpToolDefinitionsSync
    out: list[dict[str, object]] = []
    for raw in getMcpToolDefinitionsSync():
        t = openaiToAnthropicToolDefinition(raw)
        name = t.get('name', '')
        if name and name not in seen:
            seen.add(name)
            out.append(t)
    return out

def _mcpToolDefinitionsOpenai(seen: set[str]) -> list[dict[str, object]]:
    """Real MCP server tools in OpenAI format, deduped against ``seen``."""
    from app.services.tools.mcpClient import getMcpToolDefinitionsSync
    out: list[dict[str, object]] = []
    for raw in getMcpToolDefinitionsSync():
        fn = raw.get('function', {}) if raw.get('type') == 'function' else {}
        name = fn.get('name', '')
        if name and name not in seen:
            seen.add(name)
            out.append(raw)
    return out

def _formatQueuedMessagesAsUserTurn(entries: list[dict[str, object]]) -> dict[str, object]:
    """Build a single user-role message that wraps one or more queued entries.

    The wrapping is explicit so the model can distinguish a queued
    follow-up from a fresh top-of-conversation prompt: each entry is
    enclosed in <queued_message> tags with the original timestamp, and
    a brief preamble tells the model what these messages are and how to
    treat them (continue, redirect, or acknowledge-and-defer).
    """
    if not entries:
        return {'role': 'user', 'content': ''}
    parts: list[str] = []
    parts.append('[The following message(s) were queued by the user while you were responding. They did NOT interrupt your current work — they were added as follow-up(s). Consider whether each one changes your current approach, supersedes the original request, or should simply be acknowledged for later. Continue with whatever is most helpful given this new context.]')
    parts.append('')
    for entry in entries:
        queuedAt = entry.get('queuedAt') or ''
        text = entry.get('text') or ''
        attachmentCount = len(entry.get('attachments') or [])
        attrParts = []
        if queuedAt:
            attrParts.append(f'timestamp="{queuedAt}"')
        if attachmentCount:
            attrParts.append(f'attachments="{attachmentCount}"')
        attrStr = ' ' + ' '.join(attrParts) if attrParts else ''
        parts.append(f'<queued_message{attrStr}>')
        parts.append(text)
        parts.append('</queued_message>')
        parts.append('')
    return {'role': 'user', 'content': '\n'.join(parts).strip()}

def enqueueUserMessage(sessionId: str, text: str, attachments: list[dict[str, object]] | None=None) -> dict[str, object] | None:
    """Append a user message to the session's pending queue.

    Returns the queued entry on success, or None if the session does not
    exist. Emits a ``user_message_queued`` SSE event so open tabs can
    update their local view in real time.
    """
    session = _sessions.get(sessionId)
    if not session:
        return None
    if not hasattr(session, 'queuedUserMessages') or session.queuedUserMessages is None:
        session.queuedUserMessages = []
    entry: dict[str, object] = {'id': f'qm_{uuid.uuid4().hex[:12]}', 'text': text, 'attachments': list(attachments or []), 'queuedAt': _now()}
    session.queuedUserMessages.append(entry)
    session.updatedAt = _now()
    saveSessions()
    try:
        from app.services import eventLog
        eventLog.eventLog.append(sessionId, 'user_message_queued', {'sessionId': sessionId, 'messageId': entry['id'], 'text': text, 'queuedAt': entry['queuedAt']})
    except Exception:
        pass
    return entry

def dequeueUserMessage(sessionId: str, messageId: str) -> bool:
    """Remove a single queued message by id. Emits ``user_message_dequeued``."""
    session = _sessions.get(sessionId)
    if not session:
        return False
    entries = getattr(session, 'queuedUserMessages', None) or []
    removed: dict[str, object] | None = None
    kept: list[dict[str, object]] = []
    for entry in entries:
        if entry.get('id') == messageId and removed is None:
            removed = entry
        else:
            kept.append(entry)
    if removed is None:
        return False
    session.queuedUserMessages = kept
    session.updatedAt = _now()
    saveSessions()
    try:
        from app.services import eventLog
        eventLog.eventLog.append(sessionId, 'user_message_dequeued', {'sessionId': sessionId, 'messageId': messageId})
    except Exception:
        pass
    return True

def listQueuedMessages(sessionId: str) -> list[dict[str, object]]:
    """Return the current queued messages for a session."""
    session = _sessions.get(sessionId)
    if not session:
        return []
    return list(getattr(session, 'queuedUserMessages', None) or [])

def drainQueuedMessages(sessionId: str, emit: Callable[[dict[str, object]], None] | None=None) -> list[dict[str, object]]:
    """Pop all queued messages and return them in FIFO order.

    Also emits a ``user_message_injected`` event per entry so the
    frontend can render each queued message as an inline user bubble
    in the conversation thread.
    """
    session = _sessions.get(sessionId)
    if not session:
        return []
    entries = list(getattr(session, 'queuedUserMessages', None) or [])
    if not entries:
        return []
    session.queuedUserMessages = []
    session.updatedAt = _now()
    saveSessions()
    if emit is not None:
        try:
            from app.services import eventLog
            for entry in entries:
                eventLog.eventLog.append(sessionId, 'userMessageInjected', {'sessionId': sessionId, 'messageId': entry.get('id', ''), 'text': entry.get('text', ''), 'queuedAt': entry.get('queuedAt', '')})
        except Exception:
            pass
    return entries

async def sendWorkbenchMessageStream(sessionId: str, message: str, provider: str='', agentId: str='', effort: str='', model: str='', modelProvider: str='', guardMode: str='', emit: Callable[[dict[str, object]], None] | None=None, signal: asyncio.Event | None=None) -> None:
    """The primary streaming entry point for workbench chat.

    This is the main chat loop that:
    1. Gets or creates the session
    2. Appends the user message
    3. Resolves provider/model
    4. Calls the model's streaming endpoint
    5. Handles tool calls in a loop
    6. Emits events for the SSE stream
    """
    session = getWorkbenchSession(sessionId)
    if not session:
        session = createWorkbenchSession(provider=provider, agentId=agentId, guardMode=guardMode or 'full')
        sessionId = session.id
    if provider:
        session.provider = provider
    if agentId:
        session.agentId = agentId
    if guardMode:
        session.guardMode = normalizeGuardMode(guardMode)
    session.status = 'streaming'
    session.updatedAt = _now()
    _emitSessionStatus(sessionId)
    session.messages.append({'role': 'user', 'content': message})
    session.messageCount += 1
    effectiveEffort = resolveEffectiveEffort(effort or session.metadata.get('effort', ''), session)
    resolvedProvider = None
    if modelProvider:
        resolvedProvider = _resolveWorkbenchProvider(modelProvider, '')
    if not resolvedProvider and model:
        resolvedProvider = _resolveWorkbenchProvider('', model)
    if not resolvedProvider:
        resolvedProvider = _resolveWorkbenchProvider(session.provider, model)
    if not resolvedProvider:
        resolvedProvider = _resolveWorkbenchProvider('', '')
    resolvedModel = _resolveModel(resolvedProvider, model or '')
    if emit:
        emit({'type': 'started', 'sessionId': sessionId, 'model': resolvedModel})
    if resolvedProvider:
        from app.services import providerCredentials
        creds = providerCredentials.resolve(resolvedProvider.get('name') or resolvedProvider.get('id') or '')
        apiKey = (creds or {}).get('api_key') if creds else None
        if not apiKey:
            if emit:
                emit({'type': 'error', 'message': f"API key not configured for {resolvedProvider.get('name', 'unknown')}"})
            session.status = 'idle'
            if emit:
                emit({'type': 'done', 'sessionId': sessionId})
            return
    if getattr(session, '_failure_feedback_age', None) is not None:
        session._failure_feedback_age += 1
        if session._failure_feedback_age >= 3:
            session._failure_feedback = None
            session._failure_feedback_age = None
    systemText = buildSystemPrompt(session)
    tools = toolDefinitions(session)
    openaiTools = openaiToolDefinitions(session)
    isAnthropic = _isAnthropicProvider(resolvedProvider)
    isOpenai = _isOpenaiProvider(resolvedProvider)

    def _isCancelled() -> bool:
        return signal is not None and signal.is_set()
    try:
        from app.services.memory.contextCompressor import compressMessages, isFeatureEnabled
        from app.providers.clients.base import estimateTokens
        if isFeatureEnabled():
            originalTokens = estimateTokens(session.messages)
            ratio = originalTokens / WORKBENCH_TOKEN_BUDGET if WORKBENCH_TOKEN_BUDGET else 0.0
            if ratio >= 0.9:
                attentionPressure = 'critical'
            elif ratio >= 0.75:
                attentionPressure = 'high'
            elif ratio >= 0.5:
                attentionPressure = 'medium'
            else:
                attentionPressure = 'low'
            currentTurn = getattr(session, 'turn_count', 0)
            lastCompaction = getattr(session, '_last_compaction_turn', -100)
            turnsSinceCompaction = currentTurn - lastCompaction
            threshold = WORKBENCH_TOKEN_BUDGET // 2
            currentMessages = list(session.messages)
            if _shouldAutoCompact(attentionPressure, turnsSinceCompaction):
                compressed = compressMessages(currentMessages, threshold=threshold, head_count=4, tail_count=6)
                compressedTokens = estimateTokens(compressed)
                if compressedTokens < originalTokens:
                    compressedCount = len(currentMessages) - len(compressed)
                    currentMessages = compressed
                    session._last_compaction_turn = currentTurn
                    if emit:
                        emit({'type': 'compaction', 'originalTokens': originalTokens, 'compressedTokens': compressedTokens, 'compressedCount': compressedCount, 'headCount': 4, 'tailCount': 6})
        else:
            currentMessages = list(session.messages)
    except Exception:
        currentMessages = list(session.messages)
    totalInputTokens = 0
    totalOutputTokens = 0
    finalContextTokens = 0
    toolRound = 0
    while True:
        toolRound += 1
        if _isCancelled():
            break
        if toolRound > 1:
            queued = drainQueuedMessages(sessionId, emit=emit)
            if queued:
                logger.debug('workbench round %d: injecting %d queued user message(s)', toolRound, len(queued))
                currentMessages.append(_formatQueuedMessagesAsUserTurn(queued))
        logger.debug('workbench round %d start (model=%s, in=%d, out=%d)', toolRound, resolvedModel, totalInputTokens, totalOutputTokens)
        if toolRound == 1:
            toolNames = [t.get('name') for t in tools] if isAnthropic else [as_dict(t.get('function', {})).get('name') for t in openaiTools]
            logger.debug('workbench presenting %d tools to model: %s', len(toolNames), toolNames)
        if isAnthropic:
            response = await _callAnthropicWorkbench(currentMessages, systemText, resolvedModel, tools, effectiveEffort, provider=resolvedProvider, emit=emit)
        elif isOpenai:
            response = await _callOpenaiWorkbench(currentMessages, systemText, resolvedModel, openaiTools, effectiveEffort, provider=resolvedProvider, emit=emit)
        else:
            if emit:
                emit({'type': 'error', 'message': f'Unknown provider format for {resolvedProvider}'})
            break
        if response.get('error'):
            if toolRound > 1:
                logger.warning('workbench model re-call failed after tool round %d: %s', toolRound - 1, response['error'])
            if emit:
                emit({'type': 'error', 'message': response['error']})
            break
        respUsage = response.get('usage', {})
        if respUsage:
            totalInputTokens += respUsage.get('input_tokens', 0)
            totalOutputTokens += respUsage.get('output_tokens', 0)
            finalContextTokens = respUsage.get('input_tokens', 0)
        if isAnthropic:
            assistantMsg = {'role': 'assistant', 'content': response.get('content', [])}
            contentBlocks = response.get('content', [])
            textContent = _extractText(contentBlocks)
            thinkingContent = _extractThinking(contentBlocks)
            toolUses = [b for b in contentBlocks if b.get('type') == 'tool_use']
        else:
            choices = response.get('choices', [])
            choice = choices[0] if choices else {}
            msg = choice.get('message', {})
            assistantMsg = {'role': 'assistant', 'content': msg.get('content', ''), 'tool_calls': msg.get('tool_calls', [])}
            textContent = response.get('text', '')
            thinkingContent = response.get('thinking', '')
            toolUses = response.get('tool_uses', [])
        if not toolUses:
            if toolRound > 1 and (not textContent) and (not thinkingContent):
                logger.warning('workbench model re-call returned empty content after tool round %d (no text, no tools)', toolRound - 1)
            currentMessages.append(assistantMsg)
            queued = drainQueuedMessages(sessionId, emit=emit)
            if queued:
                logger.debug('workbench mid-response: injecting %d queued user message(s) after text turn', len(queued))
                currentMessages.append(_formatQueuedMessagesAsUserTurn(queued))
                continue
            break
        toolResults: list[dict[str, object]] = []
        planSubmittedThisRound = False
        clarifySubmittedThisRound = False
        for tu in toolUses:
            if _isCancelled():
                break
            toolName = tu.get('name', '')
            toolInput = tu.get('input', {})
            toolUseId = tu.get('id', f'toolu_{uuid.uuid4().hex[:16]}')
            if toolName in ('submit_plan', 'submitPlan'):
                planPayload = toolInput.get('plan') or toolInput.get('steps') or toolInput
                submitPlan(session, planPayload if isinstance(planPayload, dict) else {'plan': planPayload})
                if emit:
                    emit({'type': 'planProposed', 'plan': session.plan})
                    emit({'type': 'toolResult', 'id': toolUseId, 'name': toolName, 'content': 'Plan submitted. Awaiting user approval.', 'status': 'done'})
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': 'Plan submitted. Awaiting user approval.'})
                planSubmittedThisRound = True
                continue
            if toolName in ('submit_clarify', 'ask_clarify'):
                submitClarify(session, toolInput)
                if emit:
                    emit({'type': 'clarifyProposed', 'clarify': session.clarify})
                    emit({'type': 'toolResult', 'id': toolUseId, 'name': toolName, 'content': 'Question sent to the user. Awaiting their answer.', 'status': 'done'})
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': 'Question sent to the user. Awaiting their answer.'})
                clarifySubmittedThisRound = True
                continue
            if toolName in ('submit_todos', 'submitTodos'):
                todosPayload = toolInput.get('todos') or toolInput.get('items') or toolInput
                if not isinstance(todosPayload, list):
                    todosPayload = [todosPayload] if todosPayload else []
                title = toolInput.get('title') or ''
                submitTodos(session, todosPayload, title=title)
                if emit:
                    emit({'type': 'todosUpdated', 'todos': session.todos})
                    emit({'type': 'toolResult', 'id': toolUseId, 'name': toolName, 'content': 'Todo list saved.', 'status': 'done'})
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': 'Todo list saved.'})
                continue
            if toolName in ('update_todos', 'updateTodos'):
                todosPayload = toolInput.get('todos') or toolInput.get('items') or toolInput
                if not isinstance(todosPayload, list):
                    todosPayload = [todosPayload] if todosPayload else []
                title = toolInput.get('title') or ''
                updateTodos(session, todosPayload, title=title)
                if emit:
                    emit({'type': 'todosUpdated', 'todos': session.todos})
                    emit({'type': 'toolResult', 'id': toolUseId, 'name': toolName, 'content': 'Todo list updated.', 'status': 'done'})
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': 'Todo list updated.'})
                continue
            blockedReason = _checkToolGuard(session, toolName, toolInput)
            if blockedReason:
                if emit:
                    emit({'type': 'toolResult', 'name': toolName, 'error': blockedReason, 'status': 'blocked'})
                toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': f'[Blocked] {blockedReason}'})
                continue
            if emit:
                emit({'type': 'toolCall', 'id': toolUseId, 'name': toolName, 'input': toolInput, 'status': 'running'})
            try:
                from app.services.workbench.toolGuardrails import ToolCallTracker
                if not hasattr(session, '_tool_tracker') or session._tool_tracker is None:
                    session._tool_tracker = ToolCallTracker()
                tracker = session._tool_tracker
                status, msg = tracker.check(toolName, toolInput)
                if status == 'block':
                    result = msg
                    tracker.record_failure(toolName)
                else:
                    result = await _executeTool(toolName, toolInput, session)
                    if isinstance(result, str) and result.startswith('Error:'):
                        tracker.record_failure(toolName)
                    if status == 'warn':
                        result = msg + '\n' + result
            except Exception:
                result = await _executeTool(toolName, toolInput, session)
            MAX_SSE_CONTENT = 100 * 1024
            contentTruncated = len(result) > MAX_SSE_CONTENT
            sseContent = result[:MAX_SSE_CONTENT]
            if contentTruncated:
                sseContent += '\n\n[... Tool result truncated at 100 KB — full length: {} bytes]'.format(len(result))
            if emit:
                providerSetup = None
                if toolName == 'setup_provider':
                    try:
                        parsed = json.loads(result)
                        if isinstance(parsed, dict) and parsed.get('providerId'):
                            providerSetup = parsed
                    except Exception:
                        providerSetup = None
                emit({'type': 'toolResult', 'id': toolUseId, 'name': toolName, 'content': sseContent, 'contentTruncated': contentTruncated, 'contentFullLength': len(result), 'summary': str(result)[:2000], 'status': 'done', 'providerSetup': providerSetup})
                if toolName.startswith('browser_'):
                    try:
                        parsed = json.loads(result)
                    except Exception:
                        parsed = None
                    if isinstance(parsed, dict) and parsed.get('status') == 'success':
                        emit({'type': 'browserAction', 'id': toolUseId, 'name': toolName, 'input': toolInput, 'url': parsed.get('url'), 'title': parsed.get('title'), 'target': parsed.get('target'), 'screenshot': parsed.get('screenshot'), 'typed': parsed.get('typed'), 'selected': parsed.get('selected'), 'scrolled': parsed.get('scrolled'), 'status': 'success'})
            toolResults.append({'tool_use_id': toolUseId, 'role': 'tool', 'content': result})
        if not toolResults:
            try:
                from app.services.workbench.toolGuardrails import ToolCallTracker
                if hasattr(session, '_tool_tracker') and session._tool_tracker:
                    session._tool_tracker.record_text_response()
            except Exception:
                pass
            try:
                from app.services.daemonManager import getManager
                manager = getManager()
                manager.increment_turns(session.id)
            except Exception:
                pass
            break
        currentMessages.append(assistantMsg)
        currentMessages.extend(toolResults)
        if planSubmittedThisRound:
            break
        if clarifySubmittedThisRound:
            break
    try:
        logger.debug('workbench turn complete: %d rounds, in=%d out=%d', toolRound, totalInputTokens, totalOutputTokens)
        session.messages = list(currentMessages)
        session.status = 'idle'
        session.updatedAt = _now()
        try:
            saveSessions()
        except Exception:
            logger.exception('workbench save_sessions failed; still emitting done')
        _emitSessionStatus(sessionId)
        if totalInputTokens > 0 or totalOutputTokens > 0:
            try:
                from app.services.memoryStore import recordUsage
                recordUsage(sessionId=session.id, model=resolvedModel, inputTokens=totalInputTokens, outputTokens=totalOutputTokens, contextTokens=finalContextTokens)
                session.totalInputTokens += totalInputTokens
                session.totalOutputTokens += totalOutputTokens
            except Exception:
                logger.exception('workbench recordUsage failed')
    finally:
        if emit:
            emit({'type': 'done', 'sessionId': sessionId})
    reviewModel = _backgroundTaskModel('reviewModel', resolvedModel)
    reflectionModel = _backgroundTaskModel('reflectionModel', resolvedModel)
    autoMemoryModel = _backgroundTaskModel('autoMemoryModel', resolvedModel)
    try:
        from app.services.memory.backgroundReview import tryBackgroundReview, ReviewGates
        asyncio.create_task(tryBackgroundReview(session, list(currentMessages), gates=ReviewGates(turn_interval=3, tool_round_interval=6), llm_client=_makeReviewLlmClient(resolvedProvider, reviewModel)))
    except Exception:
        pass
    try:
        asyncio.create_task(asyncio.to_thread(_syncAutoMemory, session, list(currentMessages), autoMemoryModel))
    except Exception:
        pass
    try:
        from app.services.memory.selfEvolution import reflectOnTurn
        asyncio.create_task(asyncio.to_thread(reflectOnTurn, list(currentMessages), reflectionModel))
    except Exception:
        pass

def _backgroundTaskModel(taskKey: str, chatModel: str) -> str:
    """Resolve the model to use for a background task.

    Uses the per-task model from the background-review config when background
    tasks are enabled and a model is configured; otherwise falls back to the
    chat session's model.
    """
    try:
        from app.services.backgroundReviewService import getConfig
        cfg = getConfig()
        if cfg.get('enabled') and cfg.get(taskKey):
            return cfg[taskKey]
    except Exception:
        pass
    return chatModel

def _syncAutoMemory(session: WorkbenchSession, messages: list[dict[str, object]], model: str='') -> None:
    """Auto-memory sync — save conversation summaries and extract todos.

    Runs fire-and-forget after each workbench turn so it never delays
    the response. These lightweight rule-based extractions complement
    the heavier LLM-based background_review. The ``model`` argument is
    the resolved auto-memory model (falls back to the chat model) used
    for audit/metadata on the saved memories."""
    from app.services.memory.autoMemory import saveAutoMemory, extractAndSaveTodos
    try:
        extractAndSaveTodos(messages)
    except Exception:
        pass
    try:
        lastUserMsg = _lastUserMessageText(session)
        if lastUserMsg:
            summary = f'User asked: {lastUserMsg[:300]}'
            saveAutoMemory(f'conv_summary_{session.id[:8]}', summary, category='conversation', importance=0.3)
    except Exception:
        pass

def _lastUserMessageText(session: WorkbenchSession) -> str:
    """Extract text content from the last user message in a session."""
    for msg in reversed(session.messages):
        if msg.get('role') == 'user':
            content = msg.get('content', '')
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                texts = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text']
                return ' '.join(texts)
    return ''

def _makeReviewLlmClient(mainProvider: dict[str, object] | None, reviewModelHint: str='') -> Callable | None:
    """Create an LLM client for background review calls.

    Resolves the provider from the ``reviewModel`` config (or the provided
    ``review_model_hint``, which is already the per-task resolved model),
    falling back to the main session provider. Returns None if no provider
    is available (review will be a no-op).
    """
    try:
        from app.providers import resolver as providerResolver
        provider = None
        reviewConfig: dict[str, object] | None = None
        try:
            from app.services.backgroundReviewService import getConfig
            reviewConfig = getConfig()
            reviewModel = reviewConfig.get('reviewModel', '') or reviewModelHint
            if reviewModel:
                provider = providerResolver.resolve(reviewModel)
        except Exception:
            reviewModel = reviewModelHint
        if not provider:
            provider = mainProvider
        if not provider:
            provider = providerResolver.resolve('')
        if not provider:
            return None
        from app.providers.clients import getClient
        client = getClient(provider)
        if not client:
            return None
        apiKey = client.resolveApiKey()
        if not apiKey:
            return None
        _client = client
        _reviewModel = reviewModel or 'claude-sonnet-4-20250514'

        async def reviewLlm(prompt: list[dict[str, object]]) -> str:
            """Call a cheap/fast model for background review."""
            try:
                body = {'model': _reviewModel, 'messages': prompt, 'max_tokens': 1024}
                resp = await _client.chat_completions(body)
                bodyJson = resp.body_json or {}
                if resp.is_error or 'error' in bodyJson:
                    return ''
                choices = bodyJson.get('choices', [])
                if not choices:
                    return ''
                return choices[0].get('message', {}).get('content', '')
            except Exception:
                return ''
        return reviewLlm
    except Exception:
        return None

def _resolveWorkbenchProvider(providerName: str, modelHint: str='') -> dict[str, object] | None:
    """Resolve a provider from name or model hint."""
    from app.providers import resolver as providerResolver
    if providerName:
        provider = providerResolver.resolve(providerName)
        if provider:
            return provider
    if modelHint:
        provider = providerResolver.resolve(modelHint)
        if provider:
            return provider
    providers = providerResolver.list_available()
    return providers[0] if providers else None

def _resolveModel(provider: dict[str, object] | None, modelHint: str='') -> str:
    """Resolve the model name from hint or provider default."""
    if modelHint:
        return modelHint
    if provider:
        return provider.get('defaultModel', '')
    return ''

def _isAnthropicProvider(provider: dict[str, object] | None) -> bool:
    return provider and provider.get('apiMode') == 'anthropicMessages'

def _isOpenaiProvider(provider: dict[str, object] | None) -> bool:
    return provider and provider.get('apiMode') in ('openaiChat', 'openaiChat', 'codexResponses')

def _extractText(contentBlocks: list[dict[str, object]]) -> str:
    """Extract text from Anthropic content blocks."""
    parts = []
    for block in contentBlocks:
        if block.get('type') == 'text':
            parts.append(block.get('text', ''))
    return '\n'.join(parts)

def _extractThinking(contentBlocks: list[dict[str, object]]) -> str:
    """Extract thinking/reasoning from Anthropic content blocks."""
    parts = []
    for block in contentBlocks:
        if block.get('type') == 'thinking':
            parts.append(block.get('text', ''))
    return '\n'.join(parts)

async def _callAnthropicWorkbench(messages: list[dict[str, object]], systemText: str, model: str, tools: list[dict[str, object]], effort: str, provider: dict[str, object] | None=None, emit: Callable[[dict[str, object]], None] | None=None) -> dict[str, object]:
    """Call an Anthropic-format model with progressive streaming.

    Emits ``thinking``, ``final_output``, and ``tool_use`` events as
    tokens arrive. Returns the full aggregated response dict with
    ``content``, ``text``, ``thinking``, and ``tool_uses`` keys.
    """
    from app.adapters.anthropic import buildAnthropicUpstreamRequest
    from app.providers.clients import getClient
    if not provider:
        provider = _resolveWorkbenchProvider('', model)
    if not provider:
        return {'error': 'No provider available'}
    client = getClient(provider)
    if not client:
        return {'error': f"No client for {provider.get('name')}"}
    apiKey = client.resolveApiKey()
    if not apiKey:
        return {'error': 'API key not configured'}
    from app.adapters.anthropic import translateMessagesToAnthropic
    anthropicMessages = translateMessagesToAnthropic(messages)
    req = AnthropicRequest(model=model, max_tokens=8192)
    body = buildAnthropicUpstreamRequest(req, model, [{'type': 'text', 'text': systemText}])
    body['messages'] = anthropicMessages
    if tools:
        body['tools'] = tools
    thinkingBudget = effortToThinkingBudget(effort)
    if thinkingBudget > 0 and _supportsThinking(provider, model):
        body['thinking'] = {'type': 'enabled', 'budget_tokens': thinkingBudget}
    contentBlocks: list[dict[str, object]] = []
    accumulatedText = ''
    accumulatedThinking = ''
    toolUses: list[dict[str, object]] = []
    currentToolBlock: dict[str, object] | None = None
    currentToolInputParts: list[str] = []
    usage: dict[str, int] = {}
    try:
        async for event in client.messagesStream(body):
            eventType = event.get('_event_type', '')
            if eventType == 'content_block_start':
                block = event.get('content_block', {})
                blockType = block.get('type', '')
                if blockType == 'tool_use':
                    currentToolBlock = {'type': 'tool_use', 'id': block.get('id', f'toolu_{uuid.uuid4().hex[:16]}'), 'name': block.get('name', ''), 'input': {}}
                    currentToolInputParts = []
                elif blockType == 'text':
                    text = block.get('text', '')
                    if text:
                        accumulatedText += text
                        if emit:
                            emit({'type': 'finalOutput', 'content': text})
                elif blockType == 'thinking':
                    text = block.get('thinking', '')
                    if text:
                        accumulatedThinking += text
                        if emit:
                            emit({'type': 'thinking', 'content': text})
            elif eventType == 'content_block_delta':
                delta = event.get('delta', {})
                deltaType = delta.get('type', '')
                if deltaType == 'text_delta':
                    text = delta.get('text', '')
                    if text:
                        accumulatedText += text
                        if emit:
                            emit({'type': 'finalOutput', 'content': text})
                elif deltaType == 'thinking_delta':
                    text = delta.get('thinking', '')
                    if text:
                        accumulatedThinking += text
                        if emit:
                            emit({'type': 'thinking', 'content': text})
                elif deltaType == 'input_json_delta':
                    currentToolInputParts.append(delta.get('partial_json', ''))
            elif eventType == 'content_block_stop':
                if currentToolBlock:
                    raw = ''.join(currentToolInputParts)
                    if raw:
                        try:
                            currentToolBlock['input'] = json.loads(raw)
                        except json.JSONDecodeError:
                            currentToolBlock['input'] = {'_raw': raw}
                    toolUses.append(currentToolBlock)
                    currentToolBlock = None
                    currentToolInputParts = []
            elif eventType == 'message_delta':
                msgUsage = event.get('usage', {})
                if msgUsage:
                    usage['input_tokens'] = msgUsage.get('input_tokens', 0)
                    usage['output_tokens'] = msgUsage.get('output_tokens', 0)
            elif eventType == 'error':
                return {'error': f'Stream error: {event}'}
    except Exception as exc:
        return {'error': str(exc)}
    if accumulatedThinking:
        contentBlocks.append({'type': 'thinking', 'text': accumulatedThinking})
    if accumulatedText:
        contentBlocks.append({'type': 'text', 'text': accumulatedText})
    contentBlocks.extend(toolUses)
    return {'content': contentBlocks, 'text': accumulatedText, 'thinking': accumulatedThinking, 'tool_uses': toolUses, 'usage': usage}

async def _callOpenaiWorkbench(messages: list[dict[str, object]], systemText: str, model: str, tools: list[dict[str, object]], effort: str, provider: dict[str, object] | None=None, emit: Callable[[dict[str, object]], None] | None=None) -> dict[str, object]:
    """Call an OpenAI-format model with progressive streaming.

    Emits ``thinking`` / ``reasoning`` and ``final_output`` events as
    tokens arrive. Returns the full aggregated response dict with
    ``choices`` (OpenAI format), ``text``, ``thinking``, and ``tool_uses``.
    """
    from app.providers.clients import getClient
    if not provider:
        provider = _resolveWorkbenchProvider('', model)
    if not provider:
        return {'error': 'No provider available'}
    client = getClient(provider)
    if not client:
        return {'error': f"No client for {provider.get('name')}"}
    apiKey = client.resolveApiKey()
    if not apiKey:
        return {'error': 'API key not configured'}
    from app.adapters.anthropic import translateMessages
    openaiMessages = translateMessages(messages)
    openaiMessages.insert(0, {'role': 'system', 'content': systemText})
    req = ChatCompletionRequest(model=model)
    body: dict[str, object] = req.model_dump()  # type: ignore[assignment]
    body['messages'] = openaiMessages
    body['max_tokens'] = 8192
    if tools:
        body['tools'] = tools
    reasoning = effortToOpenaiReasoningEffort(effort)
    if reasoning:
        body['reasoning_effort'] = reasoning
        contentText = ''
        thinkingText = ''
        toolCallsAccum: dict[int, dict[str, object]] = {}
        finishReason: str | None = None
        usage: dict[str, int] = {}
        try:
            async for event in client.chatCompletionsStream(body):
                eventType = event.get('_event_type', '')
                if eventType not in ('chat.completion.chunk', ''):
                    pass
                eventUsage = event.get('usage')
                if eventUsage:
                    usage['input_tokens'] = eventUsage.get('prompt_tokens', 0)
                    usage['output_tokens'] = eventUsage.get('completion_tokens', 0)
                choices = event.get('choices', [])
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.get('delta', {})
                reasoner = delta.get('reasoning_content') or delta.get('reasoning')
                if reasoner:
                    thinkingText += reasoner
                    if emit:
                        emit({'type': 'thinking', 'content': reasoner})
                textDelta = delta.get('content', '')
                if textDelta:
                    contentText += textDelta
                    if emit:
                        emit({'type': 'finalOutput', 'content': textDelta})
                for tc in delta.get('tool_calls', []):
                    idx = tc.get('index', 0)
                    if idx not in toolCallsAccum:
                        fn = tc.get('function', {})
                        toolCallsAccum[idx] = {'id': tc.get('id', f'call_{uuid.uuid4().hex[:12]}'), 'type': 'function', 'function': {'name': fn.get('name', ''), 'arguments': fn.get('arguments', '')}}
                    else:
                        fn = tc.get('function', {})
                        existing = toolCallsAccum[idx]['function']
                        if fn.get('arguments'):
                            existing['arguments'] += fn['arguments']
                        if fn.get('name'):
                            existing['name'] += fn['name']
                if choice.get('finish_reason'):
                    finishReason = choice['finish_reason']
        except Exception as exc:
            return {'error': str(exc)}
    assistantMessage: dict[str, object] = {'role': 'assistant', 'content': contentText}
    toolUses: list[dict[str, object]] = []
    if toolCallsAccum:
        tcList = []
        for idx in sorted(toolCallsAccum):
            tc = toolCallsAccum[idx]
            fn = tc['function']
            try:
                parsedArgs = json.loads(fn['arguments']) if fn['arguments'] else {}
            except (json.JSONDecodeError, TypeError):
                parsedArgs = {}
            tcList.append({'id': tc['id'], 'type': 'function', 'function': {'name': fn['name'], 'arguments': json.dumps(parsedArgs)}})
            toolUses.append({'type': 'tool_use', 'id': tc['id'], 'name': fn['name'], 'input': parsedArgs})
            assistantMessage['tool_calls'] = tcList
    return {'choices': [{'index': 0, 'message': assistantMessage, 'finish_reason': finishReason or 'stop'}], 'text': contentText, 'thinking': thinkingText, 'tool_uses': toolUses, 'usage': usage}

def _supportsThinking(provider: dict[str, object], model: str) -> bool:
    """Check if a provider/model supports Anthropic-style thinking."""
    profiles = provider.get('modelProfiles', {})
    profile = profiles.get(model) or profiles.get('*') or {}
    return profile.get('supportsThinking', False) or profile.get('supportsReasoning', False)

async def _executeTool(toolName: str, args: dict[str, object], session: WorkbenchSession) -> str:
    """Execute a workbench tool by dispatching to the correct handler.

    Two dispatch paths:
      * ``mcp__<server_id>__<tool>`` names route to the MCP client
        (``execute_mcp_tool_call``), which talks to the relevant MCP
        server subprocess over JSON-RPC.
      * everything else dispatches through ``tool_registry``.
    """
    from app.services.toolRegistry import dispatch as dispatchTool
    from app.services.workbench.context import currentSessionId
    token = currentSessionId.set(session.id)
    try:
        from app.services.tools.mcpClient import executeMcpToolCall, isMcpToolName
        if isMcpToolName(toolName):
            return str(await executeMcpToolCall(toolName, args))
        result = await dispatchTool(toolName, args)
        return str(result)
    except Exception as exc:
        import traceback as _tb
        tbList = _tb.extract_tb(exc.__traceback__)
        lastFrame = tbList[-1] if tbList else None
        feedback = {'tool': toolName, 'error_type': type(exc).__name__, 'error_message': str(exc), 'file': lastFrame.filename if lastFrame else None, 'line': lastFrame.lineno if lastFrame else None, 'function': lastFrame.name if lastFrame else None, 'offending_code': lastFrame.line if lastFrame else None}
        session._failure_feedback = feedback
        session._failure_feedback_age = 0
        return f"Tool {toolName} failed: {feedback['error_type']}: {feedback['error_message']}"
    finally:
        currentSessionId.reset(token)

def _checkToolGuard(session: WorkbenchSession, toolName: str, args: dict[str, object]) -> str | None:
    """Check if a tool execution is blocked by guard mode or permissions.

    Returns None if allowed, or a string reason if blocked.
    """
    if session.guardMode == 'plan' and (not session.planApproved) and isPlanModeBlocked(toolName, args):
        return f"Tool '{toolName}' is destructive and cannot run in plan mode. You cannot execute destructive tools here. Finish investigating with the non-destructive tools, then call `submit_plan` with your proposed steps and ask the user to approve it before executing."
    if session.guardMode == 'ask' and isPlanModeBlocked(toolName, args):
        return f"Tool '{toolName}' requires your approval. Present the intended change to the user and wait for them to approve it before calling this tool again."
    return None

def submitPlan(session: WorkbenchSession, planData: dict[str, object]) -> None:
    """Store a plan on the session. v1.1: drop prior execution state and working memory."""
    session.plan = planData
    session.planApproved = False
    session._execution_state = None
    session._working_memory = None
    session.updatedAt = _now()
    try:
        from app.services import augArtifactService
        augArtifactService.savePlan(session.workspacePath or None, session.id, planData, status='pending')
    except Exception:
        pass
    _emitSessionStatus(session.id)


def submitClarify(session: WorkbenchSession, clarifyData: dict[str, object]) -> None:
    """Store a clarification question on the session for the user to answer.

    Mirrors ``submitPlan``: the payload is persisted on the session and an
    SSE ``clarifyProposed`` event is emitted by the tool loop. The UI renders
    a question with up to 5 numbered choices plus a free-text "Something
    else" input, then feeds the user's answer back into the model as a
    queued user message.
    """
    MAX_CLARIFY_CHOICES = 5
    if not isinstance(clarifyData, dict):
        clarifyData = {}
    questions = clarifyData.get('questions')
    if isinstance(questions, list) and questions:
        normalized: list[dict[str, object]] = []
        for q in questions:
            if not isinstance(q, dict):
                continue
            item: dict[str, object] = {'question': str(q.get('question', ''))}
            rawChoices = q.get('choices') or []
            if isinstance(rawChoices, list):
                item['choices'] = [str(c) for c in rawChoices[:MAX_CLARIFY_CHOICES]]
            normalized.append(item)
        payload: dict[str, object] = {'questions': normalized}
    else:
        question = clarifyData.get('question') or ''
        rawChoices = clarifyData.get('choices') or []
        choices = [str(c) for c in rawChoices[:MAX_CLARIFY_CHOICES]] if isinstance(rawChoices, list) else []
        payload = {'question': str(question), 'choices': choices}
    contextSummary = clarifyData.get('contextSummary')
    if contextSummary:
        payload['contextSummary'] = str(contextSummary)
    session.clarify = payload
    session.updatedAt = _now()
    _emitSessionStatus(session.id)


def submitTodos(session: WorkbenchSession, todosData: list[dict[str, object]], *, title: str = '') -> None:
    """Store a todo list on the session and persist it to `.aug/todoList/`."""
    if not isinstance(todosData, list):
        todosData = [todosData] if todosData else []
    session.todos = todosData
    session.updatedAt = _now()
    try:
        from app.services import augArtifactService
        augArtifactService.saveTodos(session.workspacePath or None, session.id, todosData, title=title, status='active')
    except Exception:
        pass
    _emitSessionStatus(session.id)


def updateTodos(session: WorkbenchSession, todosData: list[dict[str, object]], *, title: str = '') -> None:
    """Replace the session's todo list in place and re-persist it."""
    submitTodos(session, todosData, title=title)

def approveWorkbenchPlan(sessionId: str) -> bool:
    """Approve a pending plan."""
    session = _sessions.get(sessionId)
    if not session or not session.plan:
        return False
    session.planApproved = True
    session.updatedAt = _now()
    saveSessions()
    # Reflect the approval on the persisted .aug artifact so the Plans
    # section doesn't keep showing it as "pending".
    try:
        from app.services import augArtifactService
        augArtifactService.updatePlanStatus(session.workspacePath or None, sessionId, 'approved')
    except Exception:
        pass
    _emitSessionStatus(sessionId)
    return True

def rejectWorkbenchPlan(sessionId: str) -> bool:
    """Reject a pending plan. v1.1: drop prior execution state and working memory."""
    session = _sessions.get(sessionId)
    if not session:
        return False
    session.plan = None
    session.planApproved = False
    session._execution_state = None
    session._working_memory = None
    session.updatedAt = _now()
    try:
        from app.services import augArtifactService
        augArtifactService.deleteForSession(session.workspacePath or None, sessionId)
    except Exception:
        pass
    saveSessions()
    _emitSessionStatus(sessionId)
    return True

def recordMutation(session: WorkbenchSession, toolName: str, args: dict[str, object], result: str) -> None:
    """Record a mutation in the session's mutation log."""
    session.mutationLog.append({'toolName': toolName, 'args': args, 'result': str(result)[:500], 'timestamp': _now()})
    session.mutationCount += 1

def createPendingMutation(session: WorkbenchSession, toolName: str, args: dict[str, object]) -> dict[str, object] | None:
    """Create a pending mutation token requiring approval."""
    token = f'mt_{uuid.uuid4().hex[:16]}'
    mutation = {'token': token, 'toolName': toolName, 'args': args, 'createdAt': _now(), 'ttl': 300}
    session.pendingMutations.append(mutation)
    session.status = 'awaiting_approval'
    saveSessions()
    _emitSessionStatus(session.id)
    return mutation

def consumePendingMutation(token: str, reject: bool=False) -> bool:
    """Approve or reject a pending mutation."""
    for session in _sessions.values():
        for i, pm in enumerate(session.pendingMutations):
            if pm.get('token') == token:
                if reject:
                    session.pendingMutations.pop(i)
                    session.status = 'idle'
                    saveSessions()
                    return True
                session.pendingMutations.pop(i)
                session.status = 'idle'
                saveSessions()
                return True
    return False

def setWorkbenchGoal(session: WorkbenchSession, condition: str) -> None:
    """Set an active goal on the session."""
    session.goal = condition
    session.updatedAt = _now()
    saveSessions()

def clearWorkbenchGoal(session: WorkbenchSession, reason: str='') -> None:
    """Clear the active goal."""
    session.goal = ''
    session.updatedAt = _now()
    saveSessions()

def getWorkbenchGoalStatus(sessionId: str) -> dict[str, object] | None:
    """Return current goal status."""
    session = _sessions.get(sessionId)
    if not session:
        return None
    return {'goal': session.goal, 'active': bool(session.goal)}

def updateWorkbenchGoal(sessionId: str, action: str, condition: str='') -> dict[str, object] | None:
    """Set/clear/status for goals."""
    session = _sessions.get(sessionId)
    if not session:
        return None
    if action == 'set' and condition:
        setWorkbenchGoal(session, condition)
    elif action == 'clear':
        clearWorkbenchGoal(session, 'user requested')
    return getWorkbenchGoalStatus(sessionId)

def getWorkbenchActivity(args: dict[str, object] | None=None) -> dict[str, object]:
    """Return recent workbench activity."""
    return {'sessions': len(_sessions), 'active': sum((1 for s in _sessions.values() if s.status == 'streaming')), 'pending_approvals': sum((1 for s in _sessions.values() if s.status == 'awaiting_approval'))}

def listProxyCapabilities() -> dict[str, object]:
    """List all tools grouped by source with mutation flags and token estimates.

    Phase 1 rewrite — port of workbench.js:1540 behavior:
    - Groups tools by source category (file, shell, memory, web, agent, bridge, mcp)
    - Flags mutating vs non-mutating per tool
    - Estimates per-tool schema token cost
    - Includes agent registry count
    """
    from app.services.toolRegistry import listTools as regListTools
    _MUTATINGTools = frozenset({'write_file', 'edit_file', 'delete_file', 'create_file', 'run_command', 'save_memory', 'save_fact', 'update_heuristics', 'update_state', 'write_scratchpad', 'delete_memory', 'submit_plan', 'approve_plan', 'reject_plan', 'load_skill', 'skill_manage', 'spawn_subagent', 'spawn_daemon', 'kill_daemon', 'write_blackboard', 'clear_blackboard'})
    allTools = regListTools()
    grouped: dict[str, list[dict[str, object]]] = {}
    for tool in allTools:
        name = tool.get('name', '') if isinstance(tool, dict) else str(tool)
        if not name:
            continue
        if name in ('read_file', 'write_file', 'list_directory', 'search_files', 'edit_file', 'delete_file', 'create_file'):
            group = 'file'
        elif name in ('run_command',):
            group = 'shell'
        elif name in ('memory_search', 'fact_search', 'context_read', 'brain_query', 'save_memory', 'delete_memory', 'save_fact', 'update_heuristics', 'load_skill', 'list_skills', 'skill_manage'):
            group = 'memory'
        elif name in ('web_fetch', 'web_search'):
            group = 'web'
        elif name in ('spawn_subagent', 'create_agent', 'list_agents'):
            group = 'agent'
        elif name in ('spawn_daemon', 'list_daemons', 'kill_daemon'):
            group = 'daemon'
        elif name in ('tool_search', 'tool_describe', 'toolCall'):
            group = 'bridge'
        elif name.startswith('mcp__'):
            group = 'mcp'
        else:
            group = 'other'
        isMutating = name in _MUTATINGTools
        schemaStr = str(tool.get('input_schema', tool.get('parameters', {})))
        estimatedTokens = len(schemaStr) // 4 + 50
        entry = {'name': name, 'mutating': isMutating, 'estimated_tokens': estimatedTokens}
        if group not in grouped:
            grouped[group] = []
        grouped[group].append(entry)
    agentCount = 0
    try:
        from app.services.tools.agentRegistry import listAgents
        agentCount = len(listAgents())
    except Exception:
        pass
    return {'tools_by_group': grouped, 'total_tools': len(allTools), 'mutating_tools': sum((1 for t in allTools if (t.get('name') if isinstance(t, dict) else t) in _MUTATINGTools)), 'estimated_total_tokens': sum((len(str(t)) // 4 + 50 for t in allTools)), 'agent_count': agentCount}

def getSession() -> WorkbenchSession | None:
    """Get the active workbench session from the current context.

    Used by the update_state tool to read/write execution state.
    In a production setting this would use a contextvar; for now it
    returns the most recently touched session as a best-effort approach,
    since tools run synchronously within a session's turn.
    """
    if not _sessions:
        return None
    try:
        return list(_sessions.values())[-1]
    except (IndexError, ValueError):
        return None

async def updateSessionState(session: WorkbenchSession, executionState: dict) -> None:
    """Update execution state on a session with an asyncio.Lock.

    Phase 5: ``asyncio.Lock`` per session around state mutations —
    parallel ``update_state`` and ``write_scratchpad`` calls are serialized
    per session, preventing dropped state updates. Lock timeout of 5 seconds
    prevents deadlock.
    """
    import asyncio
    if not hasattr(session, '_state_lock') or session._state_lock is None:
        session._state_lock = asyncio.Lock()
    try:
        await asyncio.wait_for(session._state_lock.acquire(), timeout=5.0)
        try:
            session._execution_state = executionState
            if hasattr(session, 'save') and callable(session.save):
                session.save()
        finally:
            session._state_lock.release()
    except asyncio.TimeoutError:
        pass
    except RuntimeError:
        pass