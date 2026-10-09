#!/usr/bin/env python3
import json
import os
import subprocess
import sys

CRITICAL_CVSS = 9.0
CRITICAL_EPSS_PERCENTILE = 0.95
MAJOR_UPDATE = "version-update:semver-major"
SECURITY_LABEL = "security"
ISSUE_LABEL = "dependencies"


def main():
    repo = require_env("GH_REPO")
    pr_number = require_env("PR_NUMBER")
    pr_url = require_env("PR_URL")
    alerts_token = require_env("ALERTS_TOKEN")
    dependencies = json.loads(require_env("UPDATED_DEPENDENCIES"))

    alerts = matching_alerts(dependencies, open_alerts(repo, alerts_token))
    for alert in alerts:
        ensure_issue(repo, alert, pr_url)

    if any(is_critical(alert) for alert in alerts):
        gh("pr", "edit", pr_number, "--repo", repo, "--add-label", SECURITY_LABEL)

    majors = [d["dependencyName"] for d in dependencies if d.get("updateType") == MAJOR_UPDATE]
    if majors:
        print(f"::notice::major updates need review, auto-merge not enabled: {', '.join(majors)}")
    else:
        gh("pr", "merge", pr_number, "--repo", repo, "--squash", "--auto")


def require_env(name):
    value = os.environ.get(name, "")
    if not value:
        sys.exit(f"::error::{name} is not set")
    return value


def open_alerts(repo, token):
    output = gh(
        "api", "--paginate", f"repos/{repo}/dependabot/alerts?state=open&per_page=100", "--jq", ".[]",
        token=token,
    )
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def matching_alerts(dependencies, alerts):
    matched = {}
    for dependency in dependencies:
        for alert in alerts:
            if alert_matches(dependency, alert):
                matched[alert["number"]] = alert
    return list(matched.values())


def alert_matches(dependency, alert):
    package = alert["dependency"]["package"]["name"]
    if package != dependency["dependencyName"]:
        return False
    directory = dependency.get("directory") or ""
    if not directory:
        return True
    return manifest_directory(alert["dependency"]["manifest_path"]) == directory.strip("/")


def manifest_directory(manifest_path):
    return os.path.dirname(manifest_path).strip("/")


def is_critical(alert):
    if alert["dependency"].get("scope") != "runtime":
        return False
    return cvss_score(alert) >= CRITICAL_CVSS or epss_percentile(alert) >= CRITICAL_EPSS_PERCENTILE


def cvss_score(alert):
    advisory = alert["security_advisory"]
    severities = advisory.get("cvss_severities") or {}
    scores = [(severities.get(version) or {}).get("score") for version in ("cvss_v3", "cvss_v4")]
    scores.append((advisory.get("cvss") or {}).get("score"))
    return max((score for score in scores if score is not None), default=0.0)


def epss_percentile(alert):
    epss = alert["security_advisory"].get("epss")
    if isinstance(epss, list):
        epss = epss[0] if epss else None
    percentile = (epss or {}).get("percentile") or 0.0
    return percentile / 100 if percentile > 1 else percentile


def ensure_issue(repo, alert, pr_url):
    ghsa = alert["security_advisory"]["ghsa_id"]
    package = alert["dependency"]["package"]["name"]
    manifest = alert["dependency"]["manifest_path"]
    title = f"Dependabot: {ghsa} in {package} ({manifest})"
    existing = gh(
        "issue", "list", "--repo", repo, "--state", "all", "--search", f'"{ghsa}" in:title',
        "--json", "number,title", "--jq", f'.[] | select(.title == "{title}") | .number',
    )
    if existing.strip():
        print(f"Issue for {ghsa} in {manifest} already exists: #{existing.split()[0]}")
        return
    gh("issue", "create", "--repo", repo, "--title", title, "--label", ISSUE_LABEL,
       "--body", issue_body(alert, pr_url))


def issue_body(alert, pr_url):
    advisory = alert["security_advisory"]
    dependency = alert["dependency"]
    epss = epss_percentile(alert)
    verdict = (
        "critical: the fix ships as a critical release; cherry-pick the merged commit onto the newest "
        "release line for a hotfix"
        if is_critical(alert)
        else "not critical: the fix ships with the next beta release"
    )
    return "\n".join([
        f"**{advisory['summary']}**",
        "",
        f"- Advisory: [{advisory['ghsa_id']}](https://github.com/advisories/{advisory['ghsa_id']})"
        + (f" ({advisory['cve_id']})" if advisory.get("cve_id") else ""),
        f"- Package: `{dependency['package']['name']}` in `{dependency['manifest_path']}`",
        f"- Scope: {dependency.get('scope') or 'unknown'}",
        f"- CVSS: {cvss_score(alert)}",
        f"- EPSS percentile: {epss * 100:.1f}",
        f"- Verdict: {verdict}",
        f"- Alert: {alert['html_url']}",
        f"- Fix PR: {pr_url}",
    ])


def gh(*args, token=None):
    env = dict(os.environ)
    if token:
        env["GH_TOKEN"] = token
    result = subprocess.run(["gh", *args], env=env, check=True, stdout=subprocess.PIPE, text=True)
    return result.stdout


if __name__ == "__main__":
    main()
