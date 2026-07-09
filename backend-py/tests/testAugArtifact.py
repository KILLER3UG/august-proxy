"""Tests for the AUG plan/todo artifact persistence service."""
from __future__ import annotations

from pathlib import Path

from app.services import augArtifactService


def testSavePlanWritesJson(tmp_path):
    ws = str(tmp_path)
    meta = augArtifactService.savePlan(ws, 'wb_session123', {'summary': 'My Plan', 'plan': 'step 1'})
    planFile = Path(meta['path'])
    assert planFile.exists()
    assert meta['title'] == 'My Plan'
    assert meta['status'] == 'pending'
    assert 'session123' in meta['slug']


def testSaveTodosWritesJson(tmp_path):
    ws = str(tmp_path)
    todos = [{'content': 'do a', 'status': 'pending'}, {'content': 'do b', 'status': 'in_progress'}]
    meta = augArtifactService.saveTodos(ws, 'wb_session456', todos, title='Release work')
    planFile = Path(meta['path'])
    assert planFile.exists()
    assert meta['title'] == 'Release work'
    assert meta['todos'] == todos


def testListAndDeleteForSession(tmp_path):
    ws = str(tmp_path)
    augArtifactService.savePlan(ws, 'wb_aaa', {'summary': 'Plan A'})
    augArtifactService.saveTodos(ws, 'wb_aaa', [{'content': 'x'}], title='Todos A')
    augArtifactService.savePlan(ws, 'wb_bbb', {'summary': 'Plan B'})
    arts = augArtifactService.listArtifacts(ws)
    assert len(arts) == 3
    removed = augArtifactService.deleteForSession(ws, 'wb_aaa')
    assert removed == 2
    arts = augArtifactService.listArtifacts(ws)
    assert len(arts) == 1
    assert arts[0]['sessionId'] == 'wb_bbb'


def testDeleteArtifactManual(tmp_path):
    ws = str(tmp_path)
    meta = augArtifactService.savePlan(ws, 'wb_ccc', {'summary': 'Plan C'})
    slug = meta['slug']
    res = augArtifactService.deleteArtifact(ws, 'plans', slug)
    assert res['removed'] is True
    assert augArtifactService.listArtifacts(ws) == []


def testSlugify():
    assert augArtifactService.slugify('My Cool Plan!') == 'my-cool-plan'
    assert augArtifactService.slugify('') == 'untitled'
    long = 'x' * 100
    assert len(augArtifactService.slugify(long)) <= 50


def testTitleFromPlan():
    assert augArtifactService._titleFromPlan({'summary': 'Sum'}) == 'Sum'
    assert augArtifactService._titleFromPlan({'plan': '# Heading\nbody'}) == 'Heading'
    assert augArtifactService._titleFromPlan({'foo': 'bar'}) == 'plan'


def testUpdatePlanStatus(tmp_path):
    ws = str(tmp_path)
    augArtifactService.savePlan(ws, 'wb_ddd', {'summary': 'Plan D'}, status='pending')
    augArtifactService.updatePlanStatus(ws, 'wb_ddd', 'approved')
    arts = augArtifactService.listArtifacts(ws)
    assert arts[0]['status'] == 'approved'
