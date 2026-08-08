import sys

for path in sys.argv[1:]:
    print('=' * 20, path)
    src = open(path, encoding='utf-8').read().splitlines()
    for i, line in enumerate(src, 1):
        s = line.strip()
        if (s.startswith('def ') or s.startswith('async def ') or s.startswith('class ')) and not s.startswith('#'):
            print(i, s)
