"""Memory subsystem — brain configuration, context building, compaction, and topic indexing."""

from app.services.memory.brain_orchestrator import get_brain_config, classify_task, extract_text_from_messages, risk_for_task
from app.services.memory.context_builder import build_system_prompt, build_slim_core_context
from app.services.memory.context_compressor import compress_messages, local_summarize
from app.services.memory.context_scrubber import ContextScrubber
from app.services.memory.topic_index import classify_topic, index_session

__all__ = [
    "get_brain_config",
    "classify_task",
    "extract_text_from_messages",
    "risk_for_task",
    "build_system_prompt",
    "build_slim_core_context",
    "compress_messages",
    "local_summarize",
    "ContextScrubber",
    "classify_topic",
    "index_session",
]
