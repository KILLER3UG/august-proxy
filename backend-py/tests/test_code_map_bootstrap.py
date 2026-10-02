"""Environment bootstrapping — the orphaned
code_map.py is re-wired into the workspace prompt block: workdir file
listing + signatures so the first tool hop lands without exploration."""

from __future__ import annotations

import pytest
from app.services.workbench import code_map


@pytest.fixture(autouse=True)
def _clearCache():
    code_map._cache.clear()
    yield
    code_map._cache.clear()


class TestBuildCodeMap:
    def testEmptyWithoutWorkspace(self):
        assert code_map.build_code_map(None) == ''
        assert code_map.build_code_map('/definitely/not/a/dir') == ''

    def testListsFilesAndSignatures(self, tmp_path):
        (tmp_path / 'app.py').write_text(
            '# August backend\n\ndef main():\n    pass\n', encoding='utf-8'
        )
        sub = tmp_path / 'lib'
        sub.mkdir()
        (sub / 'util.ts').write_text('// helpers\nexport function util() {}\n', encoding='utf-8')

        block = code_map.build_code_map(str(tmp_path))
        assert 'Files:' in block
        assert 'app.py' in block
        assert 'lib/util.ts' in block
        assert 'Signatures:' in block
        assert '# August backend' in block

    def testSkipsNoiseDirsAndBinaries(self, tmp_path):
        (tmp_path / 'node_modules').mkdir()
        (tmp_path / 'node_modules' / 'junk.js').write_text('x', encoding='utf-8')
        (tmp_path / '.git').mkdir()
        (tmp_path / 'image.png').write_bytes(b'\x89PNG')
        (tmp_path / 'real.py').write_text('print("hi")\n', encoding='utf-8')

        block = code_map.build_code_map(str(tmp_path))
        assert 'real.py' in block
        assert 'junk.js' not in block
        assert 'image.png' not in block

    def testCacheServesSecondCall(self, tmp_path, monkeypatch):
        (tmp_path / 'a.py').write_text('x = 1\n', encoding='utf-8')
        first = code_map.build_code_map(str(tmp_path))
        # Mutate the workspace — the cached answer must still come back.
        (tmp_path / 'b.py').write_text('y = 2\n', encoding='utf-8')
        second = code_map.build_code_map(str(tmp_path))
        assert second == first


class TestPromptMount:
    def testMapIsNotInTheCachedSystemPrefix(self, tmp_path):
        """The map rides the per-turn tail, never the prefix-cached system block.

        build_code_map has a 120 s TTL by design (a bounded walk + stat of the
        workspace on every prompt build is too expensive). Inside <workspace>
        that TTL mutated a byte of the prefix-cached system block and forced a
        cold re-read of system + tools + history roughly every two minutes of
        coding work.
        """
        from app.services.workbench import workbench as wb

        (tmp_path / 'main.py').write_text('# entrypoint\nprint("go")\n', encoding='utf-8')
        session = wb.createWorkbenchSession(provider='anthropic')
        session.workspacePath = str(tmp_path)
        prompt = wb.buildSystemPrompt(session)
        assert '<workspace>' in prompt
        assert f'path: {tmp_path}' in prompt
        # The frozen prefix must stay free of a TTL'd workspace snapshot.
        workspaceBlock = prompt.split('<workspace>', 1)[1].split('</workspace>', 1)[0]
        assert 'main.py' not in workspaceBlock
        assert 'Files:' not in workspaceBlock

    def testTailSizesAccountForTheMap(self, tmp_path):
        from app.services.workbench.workbench import tailSectionSizes

        sizes = tailSectionSizes(None, None, None, None, None, '<workspace_map>x</workspace_map>')
        assert sizes['workspaceMapBytes'] == len('<workspace_map>x</workspace_map>')
        assert sizes['memoryBytes'] == 0
