from collections import Counter

from app.routers import config, mcp, monitoring, workbench
from app.main import app

print('mcp routes', [(getattr(r, 'path', None), getattr(r, 'methods', None)) for r in mcp.router.routes])
print('workbench count', len(workbench.router.routes))
print('monitoring count', len(monitoring.router.routes))
print('config count', len(config.router.routes))
print('types', Counter(type(r).__name__ for r in app.routes))
for r in app.routes:
    name = type(r).__name__
    if name == 'APIRoute':
        print(r.methods, r.path)
    else:
        nested = getattr(r, 'routes', None)
        print(name, getattr(r, 'path', None), len(nested) if nested is not None else None)
