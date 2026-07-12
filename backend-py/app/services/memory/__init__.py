"""Memory subsystem — brain configuration, context building, compaction, and topic indexing."""

from app.services.memory.brain_orchestrator import getBrainConfig, classifyTask, extractTextFromMessages, riskForTask  # noqa: F401
from app.services.memory.context_builder import buildSystemPrompt, buildSlimCoreContext  # noqa: F401
from app.services.memory.context_compressor import compressMessages, localSummarize  # noqa: F401
from app.services.memory.context_scrubber import ContextScrubber  # noqa: F401
from app.services.memory.topic_index import classifyTopic, indexSession  # noqa: F401

__all__ = [
    'get_brain_config',
    'classify_task',
    'extract_text_from_messages',
    'risk_for_task',
    'build_system_prompt',
    'build_slim_core_context',
    'compress_messages',
    'local_summarize',
    'ContextScrubber',
    'classify_topic',
    'index_session',
]
