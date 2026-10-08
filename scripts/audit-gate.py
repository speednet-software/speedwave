#!/usr/bin/env python3
import argparse
import json
import re
import sys
from datetime import date

GHSA_RE = re.compile(r"GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}")

NPM_SEVERITY_RANK = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
DEFAULT_NPM_MIN_SEVERITY = "high"


def npm_severity_at_least(severity, min_severity):
    return NPM_SEVERITY_RANK.get(severity, 0) >= NPM_SEVERITY_RANK.get(min_severity, 0)


def extract_npm(data, min_severity=DEFAULT_NPM_MIN_SEVERITY):
    advisories = {}
    for pkg in data.get("vulnerabilities", {}).values():
        for via in pkg.get("via", []):
            if not isinstance(via, dict):
                continue
            if not npm_severity_at_least(via.get("severity"), min_severity):
                continue
            url = via.get("url")
            adv_id = None
            if url:
                match = GHSA_RE.search(url)
                if match:
                    adv_id = match.group(0)
            if adv_id is None and via.get("source") is not None:
                adv_id = f"npm:{via['source']}"
            if adv_id is None:
                continue
            advisories[adv_id] = {
                "title": via.get("title", ""),
                "severity": via.get("severity"),
                "url": url,
            }
    return advisories


def extract_cargo(data):
    advisories = {}
    for item in data.get("vulnerabilities", {}).get("list", []):
        advisory = item.get("advisory", {})
        adv_id = advisory.get("id")
        if not adv_id:
            continue
        advisories[adv_id] = {
            "title": advisory.get("title", ""),
            "severity": advisory.get("severity"),
            "url": advisory.get("url"),
        }
    return advisories


EXTRACTORS = {"npm": extract_npm, "cargo": extract_cargo}


def load_report(spec, npm_min_severity=DEFAULT_NPM_MIN_SEVERITY):
    if ":" not in spec:
        raise SystemExit(f"audit-gate: report spec must be ecosystem:path, got: {spec}")
    ecosystem, path = spec.split(":", 1)
    if ecosystem not in EXTRACTORS:
        raise SystemExit(f"audit-gate: unknown ecosystem '{ecosystem}' (expected npm or cargo)")
    with open(path) as f:
        data = json.load(f)
    if ecosystem == "npm":
        return extract_npm(data, npm_min_severity)
    return extract_cargo(data)


def merge_reports(specs, npm_min_severity=DEFAULT_NPM_MIN_SEVERITY):
    merged = {}
    for spec in specs:
        merged.update(load_report(spec, npm_min_severity))
    return merged


def load_exceptions(path, today):
    with open(path) as f:
        entries = json.load(f)
    active = {}
    expired = []
    for entry in entries:
        adv_id = entry.get("id")
        expires = entry.get("expires")
        jira = entry.get("jira")
        if not adv_id or not expires or not jira:
            raise SystemExit(
                f"audit-gate: malformed exception entry, needs id, expires and jira: {entry}"
            )
        expires_date = date.fromisoformat(expires)
        if expires_date >= today:
            active[adv_id] = entry
        else:
            expired.append(entry)
    return active, expired


def partition(advisories, active_exceptions):
    unexempted = {aid: info for aid, info in advisories.items() if aid not in active_exceptions}
    exempted = {aid: info for aid, info in advisories.items() if aid in active_exceptions}
    return unexempted, exempted


def render_report(unexempted, exempted, expired):
    lines = []
    if unexempted:
        lines.append(f"{len(unexempted)} advisory(ies) without a valid exception:")
        for aid, info in sorted(unexempted.items()):
            lines.append(f"  - {aid}: {info.get('title', '')}")
    if exempted:
        lines.append(f"{len(exempted)} advisory(ies) covered by a valid exception:")
        for aid, info in sorted(exempted.items()):
            entry = info.get("_exception", {})
            lines.append(
                f"  - {aid}: exception expires {entry.get('expires')} ({entry.get('jira')})"
            )
    if expired:
        lines.append(f"{len(expired)} exception(s) expired and no longer apply:")
        for entry in expired:
            lines.append(f"  - {entry.get('id')}: expired {entry.get('expires')} ({entry.get('jira')})")
    return "\n".join(lines)


def render_markdown(unexempted, exempted, expired):
    lines = ["# Known advisories", ""]
    if not unexempted and not exempted:
        lines.append("No known advisories.")
        return "\n".join(lines)
    if unexempted:
        lines.append("## Without a valid exception")
        lines.append("")
        for aid, info in sorted(unexempted.items()):
            url = info.get("url")
            label = f"[{aid}]({url})" if url else aid
            lines.append(f"- {label}: {info.get('title', '')}")
        lines.append("")
    if exempted:
        lines.append("## Covered by an exception")
        lines.append("")
        for aid, info in sorted(exempted.items()):
            entry = info.get("_exception", {})
            lines.append(f"- {aid}: expires {entry.get('expires')} ({entry.get('jira')})")
        lines.append("")
    if expired:
        lines.append("## Expired exceptions")
        lines.append("")
        for entry in expired:
            lines.append(f"- {entry.get('id')}: expired {entry.get('expires')} ({entry.get('jira')})")
        lines.append("")
    return "\n".join(lines)


def attach_exception_info(exempted, active_exceptions):
    for aid, info in exempted.items():
        info["_exception"] = active_exceptions[aid]
    return exempted


def write_markdown(path, unexempted, exempted, expired):
    if path:
        with open(path, "w") as f:
            f.write(render_markdown(unexempted, exempted, expired))
            f.write("\n")


def cmd_extract(args):
    advisories = load_report(f"{args.ecosystem}:{args.input}", args.npm_min_severity)
    print(json.dumps(advisories, indent=2, sort_keys=True))
    return 0


def cmd_diff(args):
    today = date.fromisoformat(args.today) if args.today else date.today()
    base = merge_reports(args.base, args.npm_min_severity)
    head = merge_reports(args.head, args.npm_min_severity)
    active_exceptions, expired = load_exceptions(args.exceptions, today)
    new_advisories = {aid: info for aid, info in head.items() if aid not in base}
    unexempted, exempted = partition(new_advisories, active_exceptions)
    attach_exception_info(exempted, active_exceptions)
    print(render_report(unexempted, exempted, expired))
    write_markdown(args.markdown_out, unexempted, exempted, expired)
    if unexempted:
        print("PR introduces a dependency with a known vulnerability", file=sys.stderr)
        return 1
    return 0


def cmd_absolute(args):
    today = date.fromisoformat(args.today) if args.today else date.today()
    reports = merge_reports(args.report, args.npm_min_severity)
    active_exceptions, expired = load_exceptions(args.exceptions, today)
    unexempted, exempted = partition(reports, active_exceptions)
    attach_exception_info(exempted, active_exceptions)
    print(render_report(unexempted, exempted, expired))
    write_markdown(args.markdown_out, unexempted, exempted, expired)
    if unexempted:
        print("known vulnerability without a valid exception", file=sys.stderr)
        return 1
    return 0


LOCKFILE_BASENAMES = {"package-lock.json", "Cargo.lock"}


def cmd_lockfiles_touched(args):
    with open(args.changed) as f:
        changed = json.load(f)
    touched = any(path.rsplit("/", 1)[-1] in LOCKFILE_BASENAMES for path in changed)
    print("true" if touched else "false")
    return 0


def cmd_issue_plan(args):
    with open(args.existing) as f:
        issues = json.load(f)
    matches = [i for i in issues if i.get("title") == args.title and i.get("state") == "open"]
    if matches:
        chosen = min(matches, key=lambda i: i["number"])
        print(json.dumps({"action": "update", "number": chosen["number"]}))
    else:
        print(json.dumps({"action": "create"}))
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="audit-gate")
    sub = parser.add_subparsers(dest="command", required=True)

    p_extract = sub.add_parser("extract")
    p_extract.add_argument("--ecosystem", choices=sorted(EXTRACTORS), required=True)
    p_extract.add_argument("--in", dest="input", required=True)
    p_extract.add_argument("--npm-min-severity", default=DEFAULT_NPM_MIN_SEVERITY)
    p_extract.set_defaults(func=cmd_extract)

    p_diff = sub.add_parser("diff")
    p_diff.add_argument("--exceptions", required=True)
    p_diff.add_argument("--base", action="append", required=True)
    p_diff.add_argument("--head", action="append", required=True)
    p_diff.add_argument("--today")
    p_diff.add_argument("--markdown-out")
    p_diff.add_argument("--npm-min-severity", default=DEFAULT_NPM_MIN_SEVERITY)
    p_diff.set_defaults(func=cmd_diff)

    p_absolute = sub.add_parser("absolute")
    p_absolute.add_argument("--exceptions", required=True)
    p_absolute.add_argument("--report", action="append", required=True)
    p_absolute.add_argument("--today")
    p_absolute.add_argument("--markdown-out")
    p_absolute.add_argument("--npm-min-severity", default=DEFAULT_NPM_MIN_SEVERITY)
    p_absolute.set_defaults(func=cmd_absolute)

    p_touched = sub.add_parser("lockfiles-touched")
    p_touched.add_argument("--changed", required=True)
    p_touched.set_defaults(func=cmd_lockfiles_touched)

    p_issue = sub.add_parser("issue-plan")
    p_issue.add_argument("--existing", required=True)
    p_issue.add_argument("--title", required=True)
    p_issue.set_defaults(func=cmd_issue_plan)

    return parser


def main(argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
