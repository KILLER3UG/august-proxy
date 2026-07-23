"""HTTP-level regression tests for the Workbench plan approve/reject routes.

Regression: the desktop client sends ``sessionId`` in the JSON body (matching
the ``/plan`` submit route) while these routes historically declared it as a
query param, so the backend always saw an empty id and returned 404. The routes
now read the body first and fall back to the query string.
"""

from __future__ import annotations

from app.routers import workbench as workbench_router
from app.services.workbench.workbench import createWorkbenchSession, submitPlan
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(workbench_router.router)
    return TestClient(app)


def testApprovePlanReadsSessionIdFromBody():
    session = createWorkbenchSession()
    submitPlan(session, {'plan': 'Test plan', 'steps': ['Step 1']})

    resp = _client().post('/api/workbench/plan/approve', json={'sessionId': session.id})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {'status': 'approved'}
    assert session.planApproved is True


def testRejectPlanReadsSessionIdFromBody():
    session = createWorkbenchSession()
    submitPlan(session, {'plan': 'Test plan'})

    resp = _client().post('/api/workbench/plan/reject', json={'sessionId': session.id})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {'status': 'rejected'}
    assert session.plan is None


def testApprovePlanStillAcceptsQueryStringFallback():
    session = createWorkbenchSession()
    submitPlan(session, {'plan': 'Test plan'})

    resp = _client().post(f'/api/workbench/plan/approve?sessionId={session.id}')
    assert resp.status_code == 200, resp.text
    assert session.planApproved is True


def testApprovePlanUnknownSessionIs404():
    resp = _client().post('/api/workbench/plan/approve', json={'sessionId': 'wb_does_not_exist'})
    assert resp.status_code == 404
