#!/usr/bin/env python3
"""Prints the skeleton of a redacted LinkedIn fixture: sections, headings, buttons and links that matter
for the adapters. Usage: scripts/outline-fixture.py fixtures/redacted/profile/en/<file>.html"""
import sys
from html.parser import HTMLParser

VOID = {'br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'param', 'track'}
KEYWORDS = ['Connect', 'Message', 'More', 'Follow', 'Pending', 'Show all', 'see more', 'Invite', 'Withdraw', 'Experience', 'About', 'Activity', 'Education']


class Outline(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.rows = [], []

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        a = dict(attrs)
        self.stack.append(tag)
        if tag in ('section', 'h1', 'h2', 'h3', 'button', 'a', 'ul', 'li'):
            self.rows.append([len(self.stack), tag, a.get('aria-label') or '', (a.get('href') or '')[:80], a.get('id') or '', ''])

    def handle_endtag(self, tag):
        while self.stack and self.stack.pop() != tag:
            pass

    def handle_data(self, data):
        if self.rows and data.strip() and len(self.rows[-1][5]) < 80:
            self.rows[-1][5] += data.strip() + ' '


html = open(sys.argv[1], encoding='utf8').read()
p = Outline()
p.feed(html[html.find('<main'):] if '<main' in html else html)
for depth, tag, label, href, el_id, text in p.rows:
    blob = label + text
    keep = tag in ('section', 'h1', 'h2', 'h3') or (tag in ('button', 'a') and any(k in blob for k in KEYWORDS))
    if keep:
        extra = f' id="{el_id}"' if el_id and tag == 'section' else ''
        print(f'{"  " * min(depth // 3, 12)}{tag}{extra} label="{label[:45]}" href="{href[:60]}" text="{text[:60].strip()}"')
