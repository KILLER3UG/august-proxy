"""Emit the brain-config facts the frontend gate checks, as JSON.

The gate asks the BACKEND rather than re-implementing it: the ranges, the
allowed-key set and the field table all live in one module, and a second
copy of the rules in a gate is a second copy to keep in step — which is the
shape of problem this gate exists to close.

The range for a key is read out of the validator's own error message
("must be between 0 and 500"), so the gate cannot disagree with the
validator about what the range is.

Writes nothing. Reads the module only.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
os.environ.setdefault('HARNESS_DATA_DIR', tempfile.mkdtemp(prefix='august-brain-probe-'))
sys.path.insert(0, str(REPO / 'backend-py'))

from app.services import brain_config_service as svc  # noqa: E402

# A value no range can contain, so the validator's "must be between X and Y"
# message always answers.
_OUT_OF_RANGE = 10**12

_RANGE_RE = re.compile(r'must be between (-?\d+(?:\.\d+)?) and (-?\d+(?:\.\d+)?)')


def _kind_defaults() -> dict[str, object]:
    """One value of the right type for each key, to ask the validator about."""
    out: dict[str, object] = {}
    for key in svc.boolKeys:
        out[key] = True
    for key in svc.numKeys:
        out[key] = 1
    for key in svc.floatKeys:
        out[key] = 0.0
    for key in svc.strKeys:
        out[key] = 'probe'
    return out


def main() -> int:
    defaults = _kind_defaults()

    accepted: dict[str, bool] = {}
    errors: dict[str, str] = {}
    for key, value in defaults.items():
        ok, message = svc.validatePatch({key: value})
        accepted[key] = ok
        if not ok:
            errors[key] = message

    ranges: dict[str, list[float]] = {}
    for key in svc.numKeys:
        ok, message = svc.validatePatch({key: _OUT_OF_RANGE})
        if ok:
            continue
        m = _RANGE_RE.search(message)
        if m:
            ranges[key] = [float(m.group(1)), float(m.group(2))]
        else:
            ranges[key] = []

    field_keys: list[str] = []
    field_defaults: dict[str, object] = {}
    for entry in svc.fieldTable:
        name, _kind, default, _desc = entry
        field_keys.append(name)
        field_defaults[name] = default

    # The keys the validator gives an EXPLICIT range branch, as opposed to the
    # fallback. A key on the fallback inherits a range that starts at 1, which
    # is why a "0 means off" key has to name its own branch.
    source = Path(svc.__file__).read_text(encoding='utf-8')
    explicit: set[str] = set()
    for m in re.finditer(r"(?:el)?if\s+key\s*(?:==|in)\s*([^\n:]+):", source):
        for name in re.findall(r"'([A-Za-z0-9_]+)'", m.group(1)):
            explicit.add(name)

    print(
        json.dumps(
            {
                'allowedKeys': sorted(svc.allowedKeys),
                'numKeys': sorted(svc.numKeys),
                'boolKeys': sorted(svc.boolKeys),
                'floatKeys': sorted(svc.floatKeys),
                'strKeys': sorted(svc.strKeys),
                'fieldKeys': sorted(field_keys),
                'fieldDefaults': field_defaults,
                'ranges': ranges,
                'accepted': accepted,
                'errors': errors,
                'explicitRangeKeys': sorted(explicit),
            },
            indent=2,
            default=str,
        )
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
