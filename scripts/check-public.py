#!/usr/bin/env python3
"""This repo is public. Before a commit, check that nothing private goes out.

  python3 scripts/check-public.py           staged files (pre-commit hook)
  python3 scripts/check-public.py --all     every tracked file
  python3 scripts/check-public.py --msg F   a commit message file (commit-msg hook)

Reads, when present (both git-ignored, kept only on the maintainer's machine):
  private/check-patterns.txt   regexes that must not appear (server names, ids, ...), one per line
  private/names.txt            real people's names that must not appear, one per line
Secrets are checked separately by gitleaks in the same hook.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def lines(rel):
    p = ROOT / rel
    if not p.exists():
        return []
    return [l.strip() for l in p.read_text().splitlines() if l.strip() and not l.startswith('#')]


PATTERNS = [re.compile(p, re.I) for p in lines('private/check-patterns.txt')]
NAMES = lines('private/names.txt')


def problems_in(label, text):
    out = []
    for p in PATTERNS:
        m = p.search(text)
        if m:
            out.append(f'{label}:{text.count(chr(10), 0, m.start()) + 1}: private pattern #{PATTERNS.index(p) + 1}')
    for n in NAMES:
        if n in text:
            out.append(f'{label}: a real person\'s name from private/names.txt')
    return out


def main():
    args = sys.argv[1:]
    if args[:1] == ['--msg']:
        found = problems_in('commit message', Path(args[1]).read_text())
    else:
        cmd = ['git', 'ls-files'] if args[:1] == ['--all'] else ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR']
        files = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True).stdout.split('\n')
        found = []
        for rel in filter(None, files):
            if rel == 'package-lock.json':
                continue
            if args[:1] == ['--all']:
                p = ROOT / rel
                text = p.read_text(errors='ignore') if p.is_file() else ''
            else:
                text = subprocess.run(['git', 'show', f':{rel}'], cwd=ROOT, capture_output=True, text=True, errors='ignore').stdout
            found += problems_in(rel, text)
    if not PATTERNS and not NAMES:
        print('check-public: no private/check-patterns.txt or private/names.txt here; only gitleaks checks this commit', file=sys.stderr)
    if found:
        print('\n'.join(found[:100]), file=sys.stderr)
        sys.exit(f'check-public: {len(found)} problem(s). This repo is public; remove them before committing.')


if __name__ == '__main__':
    main()
