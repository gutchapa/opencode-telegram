#!/usr/bin/env python3
"""
github-digest.py - Daily GitHub repo activity tracker
Usage:
  github-digest.py                    # Full digest
  github-digest.py --save             # Save to file
  github-digest.py --repo openclaw/openclaw  # Single repo check
  github-digest.py --since 48         # Lookback hours (default: 24)
"""
import json
import sys
import os
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

CONFIG_FILE = os.path.join(os.environ.get("DIGEST_HOME", os.path.expanduser("~/.config/github-digest")), "github-repos.json")
OUTPUT_FILE = os.path.join(os.environ.get("DIGEST_HOME", os.path.expanduser("~/.config/github-digest")), "github-digest.md")

# GitHub API (unauthenticated: 60 req/hour, authenticated: 5000/hour)
GITHUB_API = "https://api.github.com"

def api_request(endpoint):
    """Make GitHub API request."""
    url = f"{GITHUB_API}/{endpoint}"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "github-digest-script")
    req.add_header("Accept", "application/vnd.github.v3+json")
    
    # Try to use GITHUB_TOKEN if available
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"token {token}")
    
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        if e.code == 403:
            return {"error": "Rate limited. Set GITHUB_TOKEN env var."}
        return {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}

def parse_github_time(ts):
    """Parse GitHub timestamp."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except:
        return None

def is_recent(dt, hours=24):
    """Check if datetime is within lookback window."""
    if not dt:
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt >= cutoff

def get_latest_release(repo):
    """Get latest release if recent."""
    data = api_request(f"repos/{repo}/releases/latest")
    if not data or "error" in data:
        return None
    
    published = parse_github_time(data.get("published_at"))
    if not is_recent(published):
        return None
    
    return {
        "tag": data.get("tag_name"),
        "name": data.get("name"),
        "published": data.get("published_at")[:10],
        "url": data.get("html_url"),
        "body": data.get("body", "")[:200] + "..." if len(data.get("body", "")) > 200 else data.get("body", "")
    }

def get_recent_commits(repo, max_count=3):
    """Get recent commits from default branch."""
    data = api_request(f"repos/{repo}/commits?per_page={max_count}")
    if not data or "error" in data:
        return []
    
    commits = []
    for commit in data:
        if not isinstance(commit, dict):
            continue
        commit_data = commit.get("commit", {})
        author = commit_data.get("author", {})
        dt = parse_github_time(author.get("date"))
        
        if is_recent(dt):
            message = commit_data.get("message", "No message").split("\n")[0][:80]
            commits.append({
                "sha": commit.get("sha", "")[:7],
                "message": message,
                "author": author.get("name", "Unknown"),
                "date": author.get("date", "")[:10] if author.get("date") else "?"
            })
    
    return commits

def get_repo_info(repo):
    """Get basic repo info."""
    data = api_request(f"repos/{repo}")
    if not data or "error" in data:
        return None
    
    return {
        "stars": data.get("stargazers_count", 0),
        "updated": data.get("updated_at", "")[:10],
        "description": data.get("description", "No description")[:100]
    }

def generate_digest(config, since_hours=24):
    """Generate markdown digest."""
    lines = []
    lines.append("# 📊 Daily GitHub Digest")
    lines.append(f"*{datetime.now().strftime('%Y-%m-%d %H:%M')} | {since_hours}h lookback*")
    lines.append("")
    
    total_repos_checked = 0
    total_updates = 0
    
    for category, repos in config.get("categories", {}).items():
        category_updates = []
        
        for repo_entry in repos:
            repo = repo_entry.get("repo", "")
            why = repo_entry.get("why", "")
            
            if not repo:
                continue
            
            total_repos_checked += 1
            info = get_repo_info(repo)
            
            if not info:
                continue
            
            release = get_latest_release(repo)
            commits = get_recent_commits(repo, config.get("settings", {}).get("max_commits_per_repo", 3))
            
            updates = []
            
            if release:
                updates.append(f"🚀 **Release**: [{release['tag']}]({release['url']}) — {release['name']}")
            
            for commit in commits:
                updates.append(f"🔹 `{commit['sha']}` {commit['message']} — *{commit['author']}*")
            
            if updates:
                total_updates += 1
                category_updates.append({
                    "repo": repo,
                    "why": why,
                    "stars": info["stars"],
                    "updates": updates
                })
        
        if category_updates:
            lines.append(f"## {category}")
            lines.append("")
            
            for item in category_updates:
                lines.append(f"### [{item['repo']}](https://github.com/{item['repo']}) ⭐ {item['stars']:,}")
                lines.append(f"*{item['why']}*")
                lines.append("")
                for update in item["updates"]:
                    lines.append(f"- {update}")
                lines.append("")
    
    lines.append("---")
    lines.append(f"*Checked {total_repos_checked} repos | {total_updates} with activity*")
    lines.append("")
    lines.append("💡 **Tip**: Found something interesting? `git clone` it or check the release notes.")
    lines.append("")
    lines.append("📋 *Want to add/remove repos? Edit `$DIGEST_HOME/github-repos.json`*)")
    
    return "\n".join(lines)

def main():
    since_hours = 24
    save_mode = False
    single_repo = None
    
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--since" and i + 1 < len(args):
            since_hours = int(args[i + 1])
            i += 2
        elif args[i] == "--save":
            save_mode = True
            i += 1
        elif args[i] == "--repo" and i + 1 < len(args):
            single_repo = args[i + 1]
            i += 2
        else:
            i += 1
    
    # Load config
    try:
        with open(CONFIG_FILE) as f:
            config = json.load(f)
    except FileNotFoundError:
        print(f"Config not found: {CONFIG_FILE}")
        sys.exit(1)
    
    # Override lookback
    config["settings"] = config.get("settings", {})
    config["settings"]["lookback_hours"] = since_hours
    
    # Single repo mode
    if single_repo:
        print(f"Checking {single_repo}...")
        info = get_repo_info(single_repo)
        release = get_latest_release(single_repo)
        commits = get_recent_commits(single_repo, 5)
        
        print(f"Stars: {info['stars'] if info else 'N/A'}")
        if release:
            print(f"Release: {release['tag']} — {release['name']}")
        for c in commits:
            print(f"  {c['sha']} {c['message']}")
        return
    
    # Generate digest
    print(f"Generating digest ({since_hours}h lookback)...", file=sys.stderr)
    digest = generate_digest(config, since_hours)
    
    if save_mode:
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, "w") as f:
            f.write(digest)
        print(f"Saved to: {OUTPUT_FILE}")
    else:
        print(digest)

if __name__ == "__main__":
    main()
