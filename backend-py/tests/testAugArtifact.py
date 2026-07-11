"""Tests for the AUG plan/todo artifact persistence service."""

from __future__ import annotations

from pathlib import Path

from app.services import aug_artifact_service


def testSavePlanWritesJson(tmp_path):
    ws = str(tmp_path)
    meta = aug_artifact_service.savePlan(ws, 'wb_session123', {'summary': 'My Plan', 'plan': 'step 1'})
    planFile = Path(meta['path'])
    assert planFile.exists()
    assert meta['title'] == 'My Plan'
    assert meta['status'] == 'pending'
    assert 'session123' in meta['slug']


def testSaveTodosWritesJson(tmp_path):
    ws = str(tmp_path)
    todos = [{'content': 'do a', 'status': 'pending'}, {'content': 'do b', 'status': 'in_progress'}]
    meta = aug_artifact_service.saveTodos(ws, 'wb_session456', todos, title='Release work')
    planFile = Path(meta['path'])
    assert planFile.exists()
    assert meta['title'] == 'Release work'
    assert meta['todos'] == todos


def testListAndDeleteForSession(tmp_path):
    ws = str(tmp_path)
    aug_artifact_service.savePlan(ws, 'wb_aaa', {'summary': 'Plan A'})
    aug_artifact_service.saveTodos(ws, 'wb_aaa', [{'content': 'x'}], title='Todos A')
    aug_artifact_service.savePlan(ws, 'wb_bbb', {'summary': 'Plan B'})
    arts = aug_artifact_service.listArtifacts(ws)
    assert len(arts) == 3
    removed = aug_artifact_service.deleteForSession(ws, 'wb_aaa')
    assert removed == 2
    arts = aug_artifact_service.listArtifacts(ws)
    assert len(arts) == 1
    assert arts[0]['sessionId'] == 'wb_bbb'


def testDeleteArtifactManual(tmp_path):
    ws = str(tmp_path)
    meta = aug_artifact_service.savePlan(ws, 'wb_ccc', {'summary': 'Plan C'})
    slug = meta['slug']
    res = aug_artifact_service.deleteArtifact(ws, 'plans', slug)
    assert res['removed'] is True
    assert aug_artifact_service.listArtifacts(ws) == []


def testSlugify():
    assert aug_artifact_service.slugify('My Cool Plan!') == 'my-cool-plan'
    assert aug_artifact_service.slugify('') == 'untitled'
    long = 'x' * 100
    assert len(aug_artifact_service.slugify(long)) <= 50


def testTitleFromPlan():
    assert aug_artifact_service._titleFromPlan({'summary': 'Sum'}) == 'Sum'
    assert aug_artifact_service._titleFromPlan({'plan': '# Heading\nbody'}) == 'Heading'
    assert aug_artifact_service._titleFromPlan({'foo': 'bar'}) == 'plan'


def testUpdatePlanStatus(tmp_path):
    ws = str(tmp_path)
    aug_artifact_service.savePlan(ws, 'wb_ddd', {'summary': 'Plan D'}, status='pending')
    aug_artifact_service.updatePlanStatus(ws, 'wb_ddd', 'approved')
    arts = aug_artifact_service.listArtifacts(ws)
    assert arts[0]['status'] == 'approved'
