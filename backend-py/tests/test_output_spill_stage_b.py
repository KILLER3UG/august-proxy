"""Output-cap discipline, stage B: spill.

A fresh tool result larger than 50 KB is stored verbatim in a session-scoped
file (``.aug/spill/<sessionId>/NNNN-<tool>.txt``) and replaced inline by a
head/tail preview that fits the 30 KB / 2000-line model-facing budget, plus
one notice line naming the omitted size, the locator, and a retrieval hint.
Stage B applies to FRESH results; historical pruning at compaction time is
stage A (#2's companion). The end-to-end loop test lives in
test_workbench_tool_loop.py (TestSpillInLoop).
"""

from __future__ import annotations

import pytest
from app.services.workbench import workbench as wb


class TestSplitSpillPreview:
    def testHeadTailWithinBudgets(self):
        text = ('line %06d\n' % i for i in range(20000))  # ~200 KB
        text = ''.join(text)
        head, tail, omitted = wb._splitSpillPreview(text)
        assert len(head) <= wb._SPILL_HEAD_CHARS
        assert len(tail) <= wb._SPILL_TAIL_CHARS
        assert head.count('\n') < wb._SPILL_HEAD_LINES
        assert tail.count('\n') < wb._SPILL_TAIL_LINES
        assert omitted == len(text) - len(head) - len(tail)
        assert text.startswith(head)
        assert text.endswith(tail)

    def testLineBudgetClipsSingleGiantLine(self):
        text = 'x' * 20000 + '\n' + 'y' * 20000
        head, tail, _ = wb._splitSpillPreview(text)
        # char budgets dominate here; line budgets keep multi-line input sane
        assert len(head) <= wb._SPILL_HEAD_CHARS
        assert len(tail) <= wb._SPILL_TAIL_CHARS

    def testNeverSplitsSurrogatePair(self):
        # A dangling high surrogate exactly at the head cut must be dropped,
        # and a dangling low surrogate at the tail cut likewise.
        text = 'a' * (wb._SPILL_HEAD_CHARS - 1) + '\ud800' + 'b' * (wb._SPILL_HEAD_CHARS * 2)
        head, tail, _ = wb._splitSpillPreview(text)
        assert not ('\ud800' <= head[-1] <= '\udbff'), 'head ends on a dangling high surrogate'
        assert not ('\udc00' <= tail[0] <= '\udfff'), 'tail starts on a dangling low surrogate'
        text2 = 'c' * (wb._SPILL_TAIL_CHARS * 2) + '\udc00' + 'd' * (wb._SPILL_TAIL_CHARS - 1)
        _head2, tail2, _ = wb._splitSpillPreview(text2)
        assert not ('\udc00' <= tail2[0] <= '\udfff'), 'tail starts on a dangling low surrogate'


class TestSpillFileRelpath:
    def testSanitizesIds(self):
        rel = wb.spill_file_relpath('sess/with:weird..id', 3, 'run_command')
        assert rel == '.aug/spill/sess_with_weird..id/0003-run_command.txt'

    def testDefaultsForBlanks(self):
        rel = wb.spill_file_relpath('', 1, '')
        assert rel == '.aug/spill/session/0001-tool.txt'


class TestSpillToolResult:
    def _session(self, tmp_path, withWorkspace: bool = True):
        session = wb.createWorkbenchSession(provider='anthropic')
        if withWorkspace:
            session.workspacePath = str(tmp_path)
        return session

    def testNoWorkspaceReturnsNone(self, tmp_path):
        session = self._session(tmp_path, withWorkspace=False)
        assert wb._spillToolResult(session, 'run_command', 'x' * 60000) is None

    def testSpillsVerbatimAndReturnsPreviewWithNotice(self, tmp_path):
        session = self._session(tmp_path)
        big = ''.join(f'row {i:06d}\n' for i in range(8000))  # ~88 KB
        inline = wb._spillToolResult(session, 'run_command', big)
        assert inline is not None
        # Verbatim copy on disk.
        spillPath = tmp_path / '.aug' / 'spill' / session.id / '0001-run_command.txt'
        assert spillPath.is_file()
        assert spillPath.read_text(encoding='utf-8') == big
        # Inline replacement: head + notice + tail, inside the budget.
        assert 'characters omitted' in inline
        assert '.aug/spill/' in inline
        assert 'read_file' in inline  # retrieval hint
        assert 'explore subagent' in inline  # delegation hint
        assert len(inline) <= wb._SPILL_HEAD_CHARS + wb._SPILL_TAIL_CHARS + 400
        assert inline.startswith('row 000000')
        assert inline.endswith('row 007999\n')

    def testSequenceIncrementsPerSession(self, tmp_path):
        session = self._session(tmp_path)
        big = 'z' * 60000
        wb._spillToolResult(session, 'read_file', big)
        wb._spillToolResult(session, 'run_command', big)
        spillDir = tmp_path / '.aug' / 'spill' / session.id
        names = sorted(p.name for p in spillDir.iterdir())
        assert names == ['0001-read_file.txt', '0002-run_command.txt']

    def testUnretrievableResultIsNotSpilledAtAll(self, tmp_path):
        """A locator the model cannot open is a trap, not a receipt: it burns a
        round trying to obey the hint and then concludes the output never
        existed. Refuse the spill so the caller truncates honestly — and leave
        no orphan file in the user's workspace."""
        session = self._session(tmp_path)
        big = 'z' * 60000
        assert wb._spillToolResult(session, 'run_command', big, retrievable=False) is None
        assert list((tmp_path / '.aug').rglob('*.txt')) == []

    def testOmittingTheFlagStillSpills(self, tmp_path):
        """The code-runner bridge calls this without the new argument, and its
        workspace tool API always has read_file, so the default stays generous."""
        session = self._session(tmp_path)
        assert wb._spillToolResult(session, 'run_command', 'q' * 60000) is not None

    def testReceiptWarnsThatThePreviewIsNotEvidence(self, tmp_path):
        session = self._session(tmp_path)
        inline = wb._spillToolResult(session, 'run_command', 'w' * 60000)
        assert inline is not None
        assert 'do not report the omitted' in inline

    def testRetrievalToolSetNamesRealTools(self):
        """Same guard as the bare-surface allowlist: a stale name here silently
        disables spilling for a whole surface."""
        from app.services.tool_definitions import registerAll
        from app.services.tool_registry import listTools

        registerAll()
        # The registry stores OpenAI-format defs — the name is at
        # t['function']['name'] (same trap the bare-allowlist guard documents).
        registered = {str(t['function']['name']) for t in listTools()}
        assert wb._SPILL_RETRIEVAL_TOOLS <= registered, (
            wb._SPILL_RETRIEVAL_TOOLS - registered
        )
