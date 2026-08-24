"""Tests for the release-notes feature pack (2026-08-12):

- pptx_list_elements / pptx_comment (OOXML comment parts, no python-pptx)
- GitHub plugin sources install without git (tarball fallback)
- event_log JSONL persistence (reconnect-after-restart replay)
- provider quota errors stop retrying
- headless sessions carry the flag through persistence
- corrupt task index auto-recovery
- automation limits (maxRuns), cancellation, partial-creation validation
"""

import asyncio
import io
import json
import zipfile

import pytest
from app.services import plugin_installer
from app.services.tools import pptx_tools

# ── PPTX fixture + tests ──────────────────────────────────────────────────


def _minimal_pptx_bytes() -> bytes:
    """A tiny valid-enough PPTX: one slide with a title shape (cNvPr id=4)."""
    ns_p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
    ns_a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    ns_r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    ns_ct = 'http://schemas.openxmlformats.org/package/2006/content-types'
    ns_pr = 'http://schemas.openxmlformats.org/package/2006/relationships'

    content_types = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="{ns_ct}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>'''
    root_rels = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{ns_pr}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>'''
    presentation = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="{ns_p}" xmlns:r="{ns_r}">
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>'''
    pres_rels = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{ns_pr}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>'''
    slide = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="{ns_p}" xmlns:a="{ns_a}" xmlns:r="{ns_r}">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="Title 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="6000000" cy="800000"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>Q3 Roadmap</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>'''
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types)
        zf.writestr('_rels/.rels', root_rels)
        zf.writestr('ppt/presentation.xml', presentation)
        zf.writestr('ppt/_rels/presentation.xml.rels', pres_rels)
        zf.writestr('ppt/slides/slide1.xml', slide)
    return buf.getvalue()


@pytest.fixture
def pptx_file(tmp_path):
    p = tmp_path / 'deck.pptx'
    p.write_bytes(_minimal_pptx_bytes())
    return str(p)


def test_pptx_list_elements(pptx_file):
    result = pptx_tools.list_elements(pptx_file)
    assert result['ok'] is True
    assert result['totalSlides'] == 1
    (slide,) = result['slides']
    assert slide['index'] == 1
    (el,) = slide['elements']
    assert el['id'] == 4
    assert el['name'] == 'Title 1'
    assert el['type'] == 'title'
    assert el['text'] == 'Q3 Roadmap'
    assert el['pos'] == {'x': 914400, 'y': 457200}


def test_pptx_comment_adds_ooxml_parts(pptx_file):
    result = pptx_tools.add_comment(pptx_file, 1, 4, 'Update this slide')
    assert result['ok'] is True
    assert result['commentId'] == 1
    assert result['anchor'] == {'x': 914400, 'y': 457200}
    # The five OOXML parts must exist and link up.
    with zipfile.ZipFile(pptx_file) as zf:
        names = zf.namelist()
        assert 'ppt/comments/comment1.xml' in names
        assert 'ppt/commentAuthors.xml' in names
        ct = zf.read('[Content_Types].xml').decode('utf-8')
        assert 'comments+xml' in ct
        assert 'commentAuthors+xml' in ct
        pres_rels = zf.read('ppt/_rels/presentation.xml.rels').decode('utf-8')
        assert 'commentAuthors' in pres_rels
        slide_rels = zf.read('ppt/slides/_rels/slide1.xml.rels').decode('utf-8')
        assert 'comments/comment1.xml' in slide_rels
        pres = zf.read('ppt/presentation.xml').decode('utf-8')
        assert 'cmAuthorLstIdLst' in pres
        comments = zf.read('ppt/comments/comment1.xml').decode('utf-8')
        assert 'Update this slide' in comments
        assert 'Assistant' in zf.read('ppt/commentAuthors.xml').decode('utf-8')
    # The file still opens/parses afterwards.
    assert pptx_tools.list_elements(pptx_file)['ok'] is True


def test_pptx_comment_unknown_element(pptx_file):
    result = pptx_tools.add_comment(pptx_file, 1, 999, 'nope')
    assert result['ok'] is False
    assert 'not found' in result['error']


def test_pptx_comment_slide_out_of_range(pptx_file):
    result = pptx_tools.add_comment(pptx_file, 7, 4, 'nope')
    assert result['ok'] is False
    assert 'out of range' in result['error']


# ── GitHub plugin sources ─────────────────────────────────────────────────


def test_parse_source_variants():
    assert plugin_installer.parse_source('octocat/hello-mcp') == ('octocat', 'hello-mcp', 'HEAD')
    assert plugin_installer.parse_source('https://github.com/a/b.git') == ('a', 'b', 'HEAD')
    assert plugin_installer.parse_source('git@github.com:a/b.git#v1.2') == ('a', 'b', 'v1.2')
    with pytest.raises(plugin_installer.PluginInstallError):
        plugin_installer.parse_source('not-a-source')


def test_tarball_fallback_without_git(tmp_path, monkeypatch):
    """Public GitHub sources install via the HTTP tarball when git is missing."""
    import tarfile

    monkeypatch.setattr(plugin_installer, '_git_available', lambda: False)

    class _FakeResp:
        status_code = 200

        def __init__(self, payload: bytes):
            self.content = payload

        def raise_for_status(self):
            return None

    def _build_tarball() -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w:gz') as tf:
            data = b'console.log("hello")'
            info = tarfile.TarInfo('hello-mcp/index.js')
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        return buf.getvalue()

    monkeypatch.setattr(
        'httpx.get',
        lambda url, **kw: _FakeResp(_build_tarball()),
    )
    monkeypatch.setattr('app.lib.paths.dataDir', lambda: tmp_path)

    async def _run():
        return await plugin_installer.install_from_github('hello-mcp', 'octocat/hello-mcp')

    result = asyncio.run(_run())
    assert result['ok'] is True
    assert result['method'] == 'tarball'
    assert result['entry'] == 'index.js'
    entry = result['args'][0]
    assert 'hello-mcp' in entry and entry.endswith('index.js')


def test_detect_entry_prefers_dist():
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / 'dist').mkdir()
        (root / 'dist' / 'index.js').write_text('x')
        (root / 'index.js').write_text('y')
        assert plugin_installer._detect_entry(root) == 'dist/index.js'


# ── Event log persistence ─────────────────────────────────────────────────


def test_event_log_rehydrates_from_jsonl(tmp_path, monkeypatch):
    from app.services import event_log as el

    monkeypatch.setattr('app.lib.paths.dataDir', lambda: tmp_path)
    log1 = el.EventLog()
    log1.append('sess_a', 'thinking', {'content': 'first'})
    seq2 = log1.append('sess_a', 'finalOutput', {'content': 'second'})
    assert seq2 == 2
    # Persistence is async (writer thread) — drain before simulating a restart.
    assert log1.flush() is True

    # A fresh instance (simulating a backend restart) must replay the tail.
    log2 = el.EventLog()
    collected = []
    async def _collect():
        async for ev in log2.subscribe('sess_a', sinceSeq=0):
            collected.append(ev)
            if ev['seq'] == 2:
                break
    asyncio.run(_collect())
    assert [ev['type'] for ev in collected] == ['thinking', 'finalOutput']
    # seq continuity: the next append continues after the rehydrated max.
    assert log2.append('sess_a', 'done', {}) == 3


def test_event_log_skips_torn_line(tmp_path, monkeypatch):
    from app.services import event_log as el

    monkeypatch.setattr('app.lib.paths.dataDir', lambda: tmp_path)
    log1 = el.EventLog()
    log1.append('sess_b', 'thinking', {})
    assert log1.flush() is True
    # Corrupt the JSONL with a torn line, then rehydrate.
    p = el._log_path('sess_b')
    with p.open('a', encoding='utf-8') as f:
        f.write('{"seq": 2, "type": "finalOutput", "payload": {')  # torn
    log2 = el.EventLog()
    entry = log2._getOrCreate('sess_b')  # no crash; rehydrates the intact line
    assert entry.nextSeq == 2  # only the intact line counted
    assert [ev['seq'] for ev in entry.events] == [1]


# ── Quota errors stop retrying ────────────────────────────────────────────


def test_quota_errors_are_not_retryable(monkeypatch):
    from app.services.workbench import workbench as wb

    assert wb._isRetryableModelError({'error': 'insufficient_quota: you exceeded your current quota'}) is False
    assert wb._isRetryableModelError({'error': 'quota exceeded', 'errorStatus': 429}) is False
    assert wb._isRetryableModelError({'error': 'Payment required', 'errorStatus': 402}) is False
    # Transient errors still retry.
    assert wb._isRetryableModelError({'error': 'rate limit exceeded', 'errorStatus': 429}) is True
    assert wb._isRetryableModelError({'error': 'upstream timeout', 'errorStatus': 504}) is True


# ── Headless sessions ─────────────────────────────────────────────────────


def test_headless_session_round_trip(monkeypatch):
    from app.services.workbench import sessions as sess_mod

    monkeypatch.setattr(sess_mod, '_sessions', {})
    monkeypatch.setattr(sess_mod, '_persist_io_lock', __import__('threading').Lock())
    s = sess_mod.create_workbench_session(headless=True)
    assert s.headless is True
    d = s.toDict()
    assert d['headless'] is True
    restored = sess_mod.WorkbenchSession.fromDict(d)
    assert restored.headless is True
    assert sess_mod.create_workbench_session().headless is False


# ── Corrupt task index recovery ───────────────────────────────────────────


def test_scheduler_recovers_corrupt_jobs_file(tmp_path, monkeypatch):
    import json as _json

    from app.services import scheduler

    jobs_file = tmp_path / 'scheduled-jobs.json'
    jobs_file.write_text('{not valid json', encoding='utf-8')
    monkeypatch.setattr(scheduler, '_JOBSFile', jobs_file)
    monkeypatch.setattr(scheduler, '_jobs', {})
    scheduler._loadJobs()
    assert scheduler._jobs == {}
    # The corrupt file was preserved (not silently lost).
    backups = list(tmp_path.glob('scheduled-jobs.json.corrupt-*'))
    assert len(backups) == 1
    assert not jobs_file.exists()


def test_automations_store_recovers_corrupt_file(tmp_path, monkeypatch):
    from app.services import automations_store

    store_file = tmp_path / 'automations.json'
    store_file.write_text('{"jobs": [', encoding='utf-8')
    monkeypatch.setattr(automations_store, '_path', lambda: store_file)
    monkeypatch.setattr(automations_store, '_jobs', None)
    monkeypatch.setattr(automations_store, '_jobs_path_key', None)
    loaded = automations_store._load()
    assert loaded == {}
    assert len(list(tmp_path.glob('automations.json.corrupt-*'))) == 1


# ── Automation limits / partial creation ──────────────────────────────────


def test_automation_upsert_rejects_partial_creation(monkeypatch):
    from app.services import automations_store

    monkeypatch.setattr(automations_store, '_path', lambda: __import__('pathlib').Path('nope.json'))
    with pytest.raises(ValueError, match='prompt'):
        automations_store.upsert_job({'id': 'auto_test', 'jobType': 'workbench', 'name': 'x', 'schedule': 'every 5 minutes'})
    with pytest.raises(ValueError, match='command'):
        automations_store.upsert_job({'id': 'auto_test2', 'jobType': 'shell', 'name': 'x', 'schedule': 'every 5 minutes'})
    with pytest.raises(ValueError, match='url'):
        automations_store.upsert_job({'id': 'auto_test3', 'jobType': 'http', 'name': 'x', 'schedule': 'every 5 minutes'})


def test_automation_max_runs_auto_disables(monkeypatch):
    from app.services import automations_store

    jobs: dict[str, dict] = {}
    monkeypatch.setattr(automations_store, '_path', lambda: __import__('pathlib').Path('nope.json'))
    monkeypatch.setattr(automations_store, '_jobs', None)
    monkeypatch.setattr(automations_store, '_jobs_path_key', None)
    monkeypatch.setattr(automations_store, '_load', lambda: jobs)
    monkeypatch.setattr(automations_store, '_save', lambda: None)
    # Run mutations inline against the dict.
    async def _inline_mutate(mutator):
        return mutator(jobs)

    monkeypatch.setattr(automations_store, '_mutate', _inline_mutate)

    job = automations_store.upsert_job(
        {'id': 'auto_lim', 'jobType': 'shell', 'name': 'lim', 'command': 'echo hi', 'schedule': 'every 5 minutes', 'maxRuns': 1}
    )
    assert job['maxRuns'] == 1
    # One terminal run completes the limit → auto-disable + limitReached.
    now = automations_store._now()
    asyncio.run(
        automations_store._finish_run(
            'auto_lim',
            run_id='r1',
            started_at=now,
            status='ok',
            output='done',
            trigger='manual',
            session_id=None,
        )
    )
    updated = automations_store.get_job('auto_lim')
    assert updated['limitReached'] is True
    assert updated['enabled'] is False
    # A further run is refused up-front (no new run starts).
    result = asyncio.run(automations_store.run_job_async('auto_lim', approved=True, trigger='manual'))
    assert result['status'] == 'limit_reached'


def test_automation_cancel_marks_job(monkeypatch):
    from app.services import automations_store

    jobs: dict[str, dict] = {
        'auto_c': {'id': 'auto_c', 'jobType': 'shell', 'name': 'c', 'command': 'echo', 'status': 'running', 'runs': []}
    }
    monkeypatch.setattr(automations_store, '_load', lambda: jobs)
    monkeypatch.setattr(automations_store, '_save', lambda: None)

    result = asyncio.run(automations_store.cancel_job_async('auto_c'))
    assert result['status'] == 'idle'
    assert result['runs'][-1]['status'] == 'cancelled'
