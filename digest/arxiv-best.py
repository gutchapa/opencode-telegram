#!/usr/bin/env python3
"""Lean best-papers feed for the morning digest: HF daily (upvoted) + arXiv
cs.AI / cs.CL / cs.LG, scored, max N lean lines. Best-effort: never fails,
prints a fallback line instead. Usage: python3 arxiv-best.py --max 8"""
import json
import re
import sys
import urllib.request
from datetime import date, timedelta

MAX_DEFAULT = 8
TOPIC_RES = [
    r'\bagent\b', r'\breasoning\b', r'\beval\b', r'\bra[gq]\b', r'\bdistill',
    r'\bquant', r'\bdevice\b', r'\blocal\b', r'\bsmall\b.*\bmodel\b',
    r'\btool\b.*\buse\b', r'\bmemory\b', r'\bcoding\b', r'\bfrontier\b',
]


def fetch_json(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': 'opencode-telegram-digest'})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except Exception:
        return None


def fetch_text(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': 'opencode-telegram-digest'})
    try:
        return urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8', 'ignore')
    except Exception:
        return ''


def hf_daily(max_n):
    """HuggingFace papers of the day, upvoted ones first."""
    out = []
    for back in range(0, 2):
        day = (date.today() - timedelta(days=back)).isoformat()
        data = fetch_json(f'https://huggingface.co/api/daily_papers?date={day}')
        if not data:
            continue
        papers = data if isinstance(data, list) else data.get('papers', data.get('dailyPapers', []))
        for p in papers if isinstance(papers, list) else []:
            title = p.get('title') or (p.get('paper') or {}).get('title') or ''
            pid = p.get('id') or (p.get('paper') or {}).get('id') or ''
            up = p.get('upvotes', p.get('votes', 0)) or 0
            if title:
                out.append({'title': title.strip(), 'id': str(pid), 'up': int(up), 'src': 'hf'})
        if out:
            break
    out.sort(key=lambda p: -p['up'])
    return out[:max_n]


def arxiv_recent():
    """Latest cs.AI/CL/LG listings via the arXiv API."""
    q = 'cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG'
    xml = fetch_text(
        f'http://export.arxiv.org/api/query?search_query={q}'
        '&start=0&max_results=30&sortBy=submittedDate&sortOrder=descending'
    )
    if not xml:
        return []
    out = []
    for m in re.finditer(r'<entry>(.*?)</entry>', xml, re.S):
        e = m.group(1)
        tid = re.search(r'<id>http://arxiv.org/abs/([^<]+)', e)
        title = re.search(r'<title>(.*?)</title>', e, re.S)
        summ = re.search(r'<summary>(.*?)</summary>', e, re.S)
        cats = re.findall(r'<category term="([^"]+)"', e)
        if not (tid and title):
            continue
        summary = re.sub(r'\s+', ' ', summ.group(1)).strip() if summ else ''
        raw_id = tid.group(1)
        clean_id = re.sub(r'v\d+$', '', raw_id)
        out.append({
            'title': re.sub(r'\s+', ' ', title.group(1)).strip(),
            'id': clean_id,
            'summary': summary[:160],
            'cats': cats,
            'src': 'arxiv',
        })
    return out


def score(p):
    s = 0
    text = (p['title'] + ' ' + p.get('summary', '')).lower()
    if 'github.com' in text or 'code' in text and 'open' in text:
        s += 2
    if len(set(p.get('cats', []))) > 1:
        s += 1
    for rx in TOPIC_RES:
        if re.search(rx, text):
            s += 1
            break
    s += min(p.get('up', 0), 5)
    return s


def main():
    max_n = MAX_DEFAULT
    for i, a in enumerate(sys.argv):
        if a == '--max' and i + 1 < len(sys.argv):
            try:
                max_n = max(1, min(12, int(sys.argv[i + 1])))
            except ValueError:
                pass
    pool = hf_daily(max_n) + arxiv_recent()
    if not pool:
        print('(arxiv unavailable)')
        return
    seen = set()
    ranked = []
    for p in pool:
        key = re.sub(r'\W+', '', p['title'].lower())[:60]
        if key in seen:
            continue
        seen.add(key)
        p['score'] = score(p)
        ranked.append(p)
    ranked.sort(key=lambda p: -p['score'])
    for p in ranked[:max_n]:
        line = f"* {p['title']} (arXiv:{p['id']}, score={p['score']})"
        if p.get('summary'):
            line += f" — {p['summary']}"
        print(line[:220])


if __name__ == '__main__':
    main()
