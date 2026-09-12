"""Skill packs — install/validate/uninstall against a fake archive fetch."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from app.services import skill_packs

SKILL_MD = (
    '---\n'
    'name: {name}\n'
    'description: a test pack skill\n'
    '---\n\n'
    '# {name}\n\nBody for the acceptance test.\n'
)


def _zip(entries: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        for name, body in entries.items():
            zf.writestr(name, body)
    return buf.getvalue()


@pytest.fixture()
def root(tmp_path, monkeypatch):
    skills = tmp_path / 'skills'
    skills.mkdir()
    monkeypatch.setattr(skill_packs, '_agentRoot', lambda: skills)
    return skills


def _fetch_ok(monkeypatch, blob: bytes):
    monkeypatch.setattr(skill_packs, '_fetch', lambda url: blob)


def test_source_parsing():
    assert skill_packs._archive_url('acme/skills@v2') == (
        'https://codeload.github.com/acme/skills/zip/v2', ''
    )
    assert skill_packs._archive_url('acme/skills')[0].endswith('/zip/HEAD')
    assert skill_packs._archive_url('acme/skills/packs/eda')[1] == 'packs/eda'
    assert skill_packs._archive_url('https://x.test/a.zip') == ('https://x.test/a.zip', '')
    with pytest.raises(ValueError):
        skill_packs._archive_url('http://insecure.test/a.zip')


def test_install_and_manifest(root, monkeypatch):
    blob = _zip({
        'repo-main/skills/alpha/SKILL.md': SKILL_MD.format(name='alpha'),
        'repo-main/skills/alpha/assets/a.txt': 'asset',
        'repo-main/skills/beta/SKILL.md': SKILL_MD.format(name='beta'),
        'repo-main/README.md': 'ignore me',
    })
    _fetch_ok(monkeypatch, blob)
    out = skill_packs.install_pack('acme/skills')
    assert out['ok'] is True, out
    assert sorted(out['skills']) == ['alpha', 'beta']
    assert (root / 'alpha' / 'SKILL.md').is_file()
    assert (root / 'alpha' / 'assets' / 'a.txt').read_text() == 'asset'
    manifest = json.loads((root / '.packs.json').read_text())
    assert manifest['skills']['source'] == 'acme/skills'
    assert sorted(manifest['skills']['skills']) == ['alpha', 'beta']


def test_reinstall_updates_and_prunes(root, monkeypatch):
    _fetch_ok(monkeypatch, _zip({
        'r/s1/SKILL.md': SKILL_MD.format(name='s1'),
        'r/s2/SKILL.md': SKILL_MD.format(name='s2'),
    }))
    skill_packs.install_pack('https://x.test/p.zip')
    _fetch_ok(monkeypatch, _zip({'r/s1/SKILL.md': SKILL_MD.format(name='s1')}))
    out = skill_packs.install_pack('https://x.test/p.zip')
    assert out['skills'] == ['s1']
    assert (root / 's1').is_dir() and not (root / 's2').exists()


def test_collisions_refused_not_clobbered(root, monkeypatch):
    (root / 'mine').mkdir()
    (root / 'mine' / 'SKILL.md').write_text('do not touch')
    _fetch_ok(monkeypatch, _zip({
        'r/mine/SKILL.md': SKILL_MD.format(name='mine'),
        'r/new/SKILL.md': SKILL_MD.format(name='new'),
    }))
    out = skill_packs.install_pack('https://x.test/p.zip')
    assert out['ok'] is True and out['skills'] == ['new']
    assert any('already exists' in r for r in out['refused'])
    assert (root / 'mine' / 'SKILL.md').read_text() == 'do not touch'


def test_traversal_refused(root, monkeypatch):
    _fetch_ok(monkeypatch, _zip({'../evil.txt': 'x', 'ok/SKILL.md': SKILL_MD.format(name='ok')}))
    out = skill_packs.install_pack('https://x.test/p.zip')
    assert out['ok'] is False and 'unsafe path' in out['error']


def test_empty_archive_receipt(root, monkeypatch):
    _fetch_ok(monkeypatch, _zip({'README.md': 'no skills here'}))
    out = skill_packs.install_pack('https://x.test/p.zip')
    assert out['ok'] is False and 'no skill folders' in out['error']


def test_uninstall_removes_only_pack_dirs(root, monkeypatch):
    (root / 'keepme').mkdir()
    _fetch_ok(monkeypatch, _zip({'r/k1/SKILL.md': SKILL_MD.format(name='k1')}))
    skill_packs.install_pack('https://x.test/p.zip')
    assert (root / 'k1').is_dir()
    out = skill_packs.uninstall_pack('p.zip')
    assert out['ok'] is True and out['removed'] == ['k1']
    assert not (root / 'k1').exists() and (root / 'keepme').is_dir()
    assert skill_packs.list_packs() == []


def test_invalid_skillmd_refused(root, monkeypatch):
    _fetch_ok(monkeypatch, _zip({'r/bad/SKILL.md': 'no frontmatter at all'}))
    out = skill_packs.install_pack('https://x.test/p.zip')
    assert out['ok'] is False and any('SKILL.md' in r for r in out.get('refused', []))


@pytest.mark.asyncio
async def test_packs_endpoints(isolatedData, root, monkeypatch):
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    _fetch_ok(monkeypatch, _zip({'r/hello/SKILL.md': SKILL_MD.format(name='hello')}))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        r = await ac.post('/api/skills/packs', json={'source': 'https://x.test/p.zip'})
        assert r.status_code == 200, r.text
        assert r.json()['ok'] is True
        # list route wins over GET /api/skills/{name}
        r = await ac.get('/api/skills/packs')
        assert r.status_code == 200 and r.json()['packs'][0]['pack'] == 'p.zip'
        r = await ac.delete('/api/skills/packs/p.zip')
        assert r.status_code == 200 and r.json()['ok'] is True
        r = await ac.delete('/api/skills/packs/nope')
        assert r.status_code == 404
