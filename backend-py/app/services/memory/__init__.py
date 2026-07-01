"""Memory subsystem — brain configuration, context building, compaction, and topic indexing."""
from app.services.memory.brainOrchestrator import getBrainConfig, classifyTask, extractTextFromMessages, riskForTask
from app.services.memory.contextBuilder import buildSystemPrompt, buildSlimCoreContext
from app.services.memory.contextCompressor import compressMessages, localSummarize
from app.services.memory.contextScrubber import ContextScrubber
from app.services.memory.topicIndex import classifyTopic, indexSession
__all__ = ['get_brain_config', 'classify_task', 'extract_text_from_messages', 'risk_for_task', 'build_system_prompt', 'build_slim_core_context', 'compress_messages', 'local_summarize', 'ContextScrubber', 'classify_topic', 'index_session']