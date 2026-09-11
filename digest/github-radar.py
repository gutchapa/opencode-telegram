#!/usr/bin/env python3
"""
github-radar.py - Catch viral repos before they go mainstream
Usage:
  github-radar.py                    # Full radar sweep
  github-radar.py --days 3          # Shorter lookback (default: 7)
  github-radar.py --save             # Save to file
  github-radar.py --hn-only          # Only Hacker News
"""
import json
import sys
import os
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone, timedelta
import re
import ssl

CONFIG_FILE = os.path.join(os.environ.get("DIGEST_HOME", os.path.expanduser("~/.config/github-digest")), "github-radar.json")
OUTPUT_FILE = os.path.join(os.environ.get("DIGEST_HOME", os.path.expanduser("~/.config/github-digest")), "github-radar.md")

GITHUB_API = "https://api.github.com"
HN_API = "https://hn.algolia.com/api/v1/search_by_date"

def api_request(url, headers=None):
    """Generic API request."""
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "github-radar-script")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    
    token = os.environ.get("GITHUB_TOKEN")
    if token and "github.com" in url:
        req.add_header("Authorization", f"token {token}")
    
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return {"error": "Rate limited"}
        return {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}

def parse_github_time(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except:
        return None

def days_since(dt):
    if not dt:
        return 999
    return (datetime.now(timezone.utc) - dt).days

def compute_velocity(stars, created_at):
    """Stars per day since creation."""
    dt = parse_github_time(created_at)
    days = max(days_since(dt), 1)
    return round(stars / days, 1)

def score_relevance(text, keywords):
    """Score how relevant text is to keywords."""
    text_lower = text.lower()
    score = 0
    for kw in keywords:
        if kw.lower() in text_lower:
            score += 10
            # Bonus for being in name/title
            if kw.lower() in text_lower.split()[:5]:
                score += 20
    return score

def should_exclude(repo, patterns):
    """Check if repo matches exclusion patterns."""
    text = f"{repo.get('name', '')} {repo.get('description', '')}".lower()
    for pattern in patterns:
        if pattern.lower() in text:
            return True
    return False

def search_github(query, min_stars=0):
    """Search GitHub repos."""
    # GitHub search API: encode query properly
    # Spaces in query should be +, but we pass to q= parameter
    encoded = urllib.parse.quote_plus(query)
    url = f"{GITHUB_API}/search/repositories?q={encoded}&sort=stars&order=desc&per_page=30"
    
    data = api_request(url)
    if not data or "error" in data:
        return []
    
    return data.get("items", [])

def scan_hackernews(keywords, days=7):
    """Scan HN Show HN for relevant posts."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    
    # Search Show HN posts from last N days
    hits = []
    page = 0
    while page < 3:  # Max 3 pages
        url = f"{HN_API}?tags=show_hn&numericFilters=created_at_i>{int(cutoff.timestamp())}&hitsPerPage=30&page={page}"
        data = api_request(url)
        
        if not data or "hits" not in data:
            break
        
        for hit in data["hits"]:
            title = hit.get("title", "")
            text = hit.get("text", "")
            combined = f"{title} {text}"
            
            relevance = score_relevance(combined, keywords)
            if relevance >= 20:  # At least 2 keyword matches
                hits.append({
                    "title": title,
                    "url": hit.get("url", f"https://news.ycombinator.com/item?id={hit.get('objectID')}"),
                    "points": hit.get("points", 0),
                    "comments": hit.get("num_comments", 0),
                    "relevance": relevance,
                    "author": hit.get("author", "?"),
                })
        
        if len(data["hits"]) < 30:
            break
        page += 1
    
    # Sort by relevance then points
    hits.sort(key=lambda x: (x["relevance"], x["points"]), reverse=True)
    return hits[:10]

def generate_radar(config, days=7):
    """Generate radar report."""
    lines = []
    date_format = "%Y-%m-%d"
    since_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(date_format)
    
    lines.append("# 🎯 GitHub Trending Radar")
    lines.append(f"*{datetime.now().strftime('%Y-%m-%d %H:%M')} | {days} day lookback | Catching viral before mainstream*")
    lines.append("")
    lines.append("---")
    lines.append("")
    
    filters = config.get("filters", {})
    exclude_patterns = filters.get("exclude_patterns", [])
    min_velocity = filters.get("min_stars_velocity_per_day", 20)
    
    all_findings = []
    
    # GitHub searches
    for search in config.get("github_search_queries", []):
        query_template = search["query"]
        query = query_template % since_date
        keywords = search.get("relevance_keywords", [])
        min_stars = search.get("min_stars", 100)
        
        repos = search_github(query, min_stars)
        
        for repo in repos:
            if filters.get("exclude_forks", True) and repo.get("fork", False):
                continue
            if filters.get("exclude_archived", True) and repo.get("archived", False):
                continue
            if should_exclude(repo, exclude_patterns):
                continue
            
            stars = repo.get("stargazers_count", 0)
            created = repo.get("created_at", "")
            pushed = repo.get("pushed_at", "")
            
            velocity = compute_velocity(stars, created)
            if velocity < min_velocity:
                continue
            
            age_days = days_since(parse_github_time(created))
            if age_days > filters.get("max_age_days", 30):
                continue
            
            # Relevance score
            desc = repo.get("description", "") or ""
            relevance = score_relevance(f"{repo['name']} {desc}", keywords)
            
            # Total score
            total_score = relevance + (velocity * 2) + (stars // 100)
            
            if total_score < config.get("output", {}).get("min_total_score", 50):
                continue
            
            all_findings.append({
                "source": "github",
                "category": search["name"],
                "name": repo["full_name"],
                "url": repo["html_url"],
                "description": desc[:150] + "..." if len(desc) > 150 else desc,
                "stars": stars,
                "velocity": velocity,
                "age_days": age_days,
                "relevance": relevance,
                "score": total_score,
                "language": repo.get("language", "?"),
            })
    
    # Deduplicate by name
    seen = set()
    unique = []
    for f in sorted(all_findings, key=lambda x: x["score"], reverse=True):
        if f["name"] not in seen:
            seen.add(f["name"])
            unique.append(f)
    
    # Take top N
    max_results = config.get("output", {}).get("max_results_per_query", 10)
    github_findings = unique[:max_results * 2]
    
    # Hacker News
    hn_keywords = []
    for search in config.get("github_search_queries", []):
        hn_keywords.extend(search.get("relevance_keywords", []))
    hn_keywords = list(set(hn_keywords))
    
    hn_findings = scan_hackernews(hn_keywords, days)
    
    # Output GitHub findings
    if github_findings:
        lines.append("## 🔥 GitHub Trending")
        lines.append(f"*Repos gaining stars fast | Velocity > {min_velocity}/day*")
        lines.append("")
        
        for i, f in enumerate(github_findings, 1):
            highlight = "🔴" if f["score"] >= config.get("output", {}).get("highlight_threshold", 500) else ""
            lines.append(f"### {i}. [{f['name']}]({f['url']}) {highlight}")
            lines.append(f"*{f['description']}*")
            lines.append("")
            lines.append(f"| Stars | Velocity | Age | Language | Category |")
            lines.append(f"|-------|----------|-----|----------|----------|")
            lines.append(f"| {f['stars']:,} | {f['velocity']}/day | {f['age_days']}d | {f['language']} | {f['category']} |")
            lines.append("")
            
            # Why it matters
            if f["velocity"] > 100:
                lines.append(f"⚡ **Viral**: {f['velocity']} stars/day — mainstream attention imminent")
            elif "agent" in f["name"].lower() or "agent" in f["description"].lower():
                lines.append(f"🤖 **Agent**: Related to AI agents — check if it replaces/supplements your stack")
            elif "claude" in f["description"].lower() or "cursor" in f["description"].lower():
                lines.append(f"💻 **Coding Tool**: Could be a Cursor/Claude alternative — worth evaluating")
            elif "local" in f["description"].lower():
                lines.append(f"🏠 **Local**: Self-hosted/privacy focused — aligns with your Mac Mini setup")
            else:
                lines.append(f"📈 **Trending**: Fast star growth in {f['category']} category")
            
            lines.append("")
    else:
        lines.append("## 🔥 GitHub Trending")
        lines.append("*Nothing viral in the last {} days. Quiet period, or the algo missed it.*".format(days))
        lines.append("")
    
    # Output HN findings
    if hn_findings:
        lines.append("## 📰 Hacker News - Show HN")
        lines.append("*Early adopter projects. Often precede GitHub virality by 1-3 days.*")
        lines.append("")
        
        for i, f in enumerate(hn_findings[:5], 1):
            lines.append(f"### {i}. [{f['title']}]({f['url']})")
            lines.append(f"👍 {f['points']} points | 💬 {f['comments']} comments | by {f['author']} | Relevance: {f['relevance']}")
            lines.append("")
    
    lines.append("---")
    lines.append(f"*Scanned {len(config.get('github_search_queries', []))} categories | {len(github_findings)} GitHub hits | {len(hn_findings)} HN hits*")
    lines.append("")
    lines.append("💡 **How to use this:**")
    lines.append("- 🔴 = Exploding fast, check NOW")
    lines.append("- High velocity (>100/day) = Will be everywhere in 48h")
    lines.append("- HN posts with 100+ points = Early adopter validation")
    lines.append("- Click through, read README, decide if it fits your stack")
    lines.append("")
    lines.append("📋 *Edit repos/categories: `$DIGEST_HOME/github-radar.json`*")
    
    return "\n".join(lines)

def main():
    days = 7
    save_mode = False
    hn_only = False
    
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--days" and i + 1 < len(args):
            days = int(args[i + 1])
            i += 2
        elif args[i] == "--save":
            save_mode = True
            i += 1
        elif args[i] == "--hn-only":
            hn_only = True
            i += 1
        else:
            i += 1
    
    try:
        with open(CONFIG_FILE) as f:
            config = json.load(f)
    except FileNotFoundError:
        print(f"Config not found: {CONFIG_FILE}")
        sys.exit(1)
    
    print(f"🎯 Scanning for viral repos (last {days} days)...", file=sys.stderr)
    report = generate_radar(config, days)
    
    if save_mode:
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, "w") as f:
            f.write(report)
        print(f"Saved to: {OUTPUT_FILE}")
    else:
        print(report)

if __name__ == "__main__":
    main()
