"""Nessa Docs catalog API routes.

Exposes `app.services.docs_state` so the desktop app can browse a project's
`docs/state/` map instead of telling the user to install the upstream renderer.

Two doors, both deliberate:

* The project path goes through `resolve_workspace_root`, the same normalizer the
  other workspace surfaces use — it is expanded, resolved and refused when it is
  not an existing directory.
* It then clears `listable_root`, the rule that keeps a credential store
  unlistable. Without it this endpoint would be a new way to read `*.md` out of a
  directory the rest of the app refuses to walk, and AGENTS.md counts the doors
  that already do this: a new lister calls the two helpers rather than adding a
  third rule.

Only `<project>/docs/state/**.md` is ever read, and `body` is returned for ONE
page at a time by id, so no response can slurp a tree of documents.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Query

from app.services import docs_state
from app.services.sandbox.paths import listable_root, resolve_workspace_root

router = APIRouter(prefix='/api/docs-state')


def _refuse(project: str, denial: str | None = None) -> dict[str, object]:
    """A catalog-shaped refusal. The browser renders `health.issues` rather than
    a thrown request, so an unusable path is reported the same way a broken page
    is — and never as an empty map, which reads as "this project has no docs"."""
    return {
        'projectRoot': project,
        'stateDir': f'{docs_state.STATE_DIR}/',
        'found': False,
        'pages': [],
        'roots': [],
        'health': {
            'errors': 1,
            'warnings': 0,
            'issues': [{
                'severity': 'error',
                'code': 'project-refused',
                'message': denial or (
                    'That project path is not a readable directory this app will '
                    'list. Pass a workspace folder that exists and is not a '
                    'credential store.'
                ),
                'path': project,
            }],
        },
    }


def _authorized(project: str) -> tuple[Path | None, str | None]:
    """Resolve and clear the project path, or return the denial to show.

    `listable_root` answers `(root, denial)` — NOT a boolean. Written as
    `if not listable_root(...)` the guard is permanently false, because a
    two-tuple is always truthy, and the door would have failed OPEN while
    looking like it was enforced.
    """
    root, denial = listable_root(project)
    if denial is not None or root is None:
        return None, denial
    if resolve_workspace_root(str(root)) is None:
        return None, f'{project} is not an existing directory.'
    return root, denial


@router.get('')
def get_catalog(
    project: str = Query(..., description='Absolute path of the project to read.'),
    body: bool = Query(False, description='Include each page body (large).'),
) -> dict[str, object]:
    root, denial = _authorized(project)
    if root is None:
        return _refuse(project, denial)
    catalog = docs_state.load_catalog(root)
    if not body:
        # The tree and Health are small; the bodies are what a page request is
        # for. Shipping every body with the catalog would put a whole docs tree
        # through the transcript cap on the first paint.
        catalog = {**catalog, 'bodies': {}}
    return catalog


@router.get('/page')
def get_page(
    project: str = Query(..., description='Absolute path of the project to read.'),
    id: str = Query(..., alias='id', description='The page id from the catalog.'),
) -> dict[str, object]:
    root, denial = _authorized(project)
    if root is None:
        return {'found': False, 'page': None, 'body': '', 'denial': denial or ''}
    catalog = docs_state.load_catalog(root)
    pages = {str(p['id']): p for p in catalog['pages']}
    page = pages.get(id)
    if page is None:
        return {'found': False, 'page': None, 'body': ''}
    return {
        'found': True,
        'page': page,
        'body': catalog['bodies'].get(str(page['path']), ''),
    }
