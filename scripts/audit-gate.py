#!/usr/bin/env python3
import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import date

GHSA_RE = re.compile(r"GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}")
NPM_SEVERITY_RANK = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
DEFAULT_NPM_MIN_SEVERITY = "high"
# The exact four lockfiles scripts/audit-run.sh audits (cargo-root, cargo-desktop,
# npm-mcp, npm-desktop) -- not every package-lock.json/Cargo.lock in the repo.
# A change to, say, the root package-lock.json or containers/proxy/Cargo.lock
# touches no audited file, so it must not trigger the PR audit lane.
AUDITED_LOCKFILES = {
    "Cargo.lock",
    "desktop/src-tauri/Cargo.lock",
    "mcp-servers/package-lock.json",
    "desktop/src/package-lock.json",
}


def npm_severity_at_least(severity, min_severity):
    return NPM_SEVERITY_RANK.get(severity, 0) >= NPM_SEVERITY_RANK.get(min_severity, 0)


def extract_npm(data, npm_min_severity=DEFAULT_NPM_MIN_SEVERITY):
    advisories = {}
    for pkg in data.get("vulnerabilities", {}).values():
        for via in pkg.get("via", []):
            if not isinstance(via, dict):
                continue
            if not npm_severity_at_least(via.get("severity"), npm_min_severity):
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


def extract_cargo(data, npm_min_severity=None):
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


@dataclass(frozen=True)
class AdvisoryException:
    id: str
    expires: date
    jira: str


def main(argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


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

    p_default_severity = sub.add_parser("print-npm-default-severity")
    p_default_severity.set_defaults(func=cmd_print_npm_default_severity)

    return parser


def cmd_extract(args):
    advisories = load_report(f"{args.ecosystem}:{args.input}", args.npm_min_severity)
    print(json.dumps(advisories, indent=2, sort_keys=True))
    return 0


def cmd_diff(args):
    today = date.fromisoformat(args.today) if args.today else date.today()
    base = merge_reports(args.base, args.npm_min_severity)
    head = merge_reports(args.head, args.npm_min_severity)
    new_advisories = {aid: info for aid, info in head.items() if aid not in base}
    unexempted, exempted, expired = evaluate_advisories(new_advisories, args.exceptions, today)
    return report_and_exit(
        unexempted, exempted, expired, args.markdown_out, "PR introduces a dependency with a known vulnerability"
    )


def cmd_absolute(args):
    today = date.fromisoformat(args.today) if args.today else date.today()
    reports = merge_reports(args.report, args.npm_min_severity)
    unexempted, exempted, expired = evaluate_advisories(reports, args.exceptions, today)
    return report_and_exit(
        unexempted, exempted, expired, args.markdown_out, "known vulnerability without a valid exception"
    )


def cmd_lockfiles_touched(args):
    with open(args.changed) as f:
        changed = json.load(f)
    touched = any(path in AUDITED_LOCKFILES for path in changed)
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


def cmd_print_npm_default_severity(_args):
    print(DEFAULT_NPM_MIN_SEVERITY)
    return 0


def load_report(spec, npm_min_severity=DEFAULT_NPM_MIN_SEVERITY):
    if ":" not in spec:
        raise SystemExit(f"audit-gate: report spec must be ecosystem:path, got: {spec}")
    ecosystem, path = spec.split(":", 1)
    if ecosystem not in EXTRACTORS:
        raise SystemExit(f"audit-gate: unknown ecosystem '{ecosystem}' (expected npm or cargo)")
    data = read_audit_json(ecosystem, path)
    return EXTRACTORS[ecosystem](data, npm_min_severity)


def read_audit_json(ecosystem, path):
    try:
        with open(path) as f:
            text = f.read()
    except OSError as e:
        raise SystemExit(f"audit-gate: cannot read {ecosystem} audit report at {path}: {e}")
    if not text.strip():
        raise SystemExit(
            f"audit-gate: empty {ecosystem} audit report at {path} "
            "(the audit tool produced no output, check its log for the real error)"
        )
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise SystemExit(f"audit-gate: {ecosystem} audit report at {path} is not valid JSON: {e}")
    if ecosystem == "npm" and isinstance(data, dict) and "error" in data:
        error = data["error"]
        summary = error.get("summary") if isinstance(error, dict) else error
        raise SystemExit(f"audit-gate: npm audit reported an error instead of a report at {path}: {summary}")
    if ecosystem == "cargo" and (not isinstance(data, dict) or "vulnerabilities" not in data):
        raise SystemExit(
            f"audit-gate: cargo audit report at {path} is missing 'vulnerabilities' (the audit likely failed)"
        )
    return data


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
        exception = AdvisoryException(id=adv_id, expires=date.fromisoformat(expires), jira=jira)
        if exception.expires >= today:
            active[adv_id] = exception
        else:
            expired.append(exception)
    return active, expired


def evaluate_advisories(advisories, exceptions_path, today):
    active_exceptions, expired = load_exceptions(exceptions_path, today)
    unexempted = {aid: info for aid, info in advisories.items() if aid not in active_exceptions}
    exempted = {aid: (info, active_exceptions[aid]) for aid, info in advisories.items() if aid in active_exceptions}
    return unexempted, exempted, expired


def report_and_exit(unexempted, exempted, expired, markdown_out, failure_message):
    print(render(unexempted, exempted, expired, as_markdown=False))
    if markdown_out:
        with open(markdown_out, "w") as f:
            f.write(render(unexempted, exempted, expired, as_markdown=True))
            f.write("\n")
    if unexempted:
        print(failure_message, file=sys.stderr)
        return 1
    return 0


def render(unexempted, exempted, expired, as_markdown):
    lines = ["# Known advisories", ""] if as_markdown else []
    if as_markdown and not unexempted and not exempted:
        lines.append("No known advisories.")
        return "\n".join(lines)
    if unexempted:
        lines.append(
            "## Without a valid exception"
            if as_markdown
            else f"{len(unexempted)} advisory(ies) without a valid exception:"
        )
        if as_markdown:
            lines.append("")
        for aid, info in sorted(unexempted.items()):
            lines.append(_advisory_line(as_markdown, aid, info.get("title", ""), info.get("url")))
        if as_markdown:
            lines.append("")
    if exempted:
        lines.append(
            "## Covered by an exception"
            if as_markdown
            else f"{len(exempted)} advisory(ies) covered by a valid exception:"
        )
        if as_markdown:
            lines.append("")
        for aid, (_info, exception) in sorted(exempted.items()):
            lines.append(_exception_line(as_markdown, aid, exception))
        if as_markdown:
            lines.append("")
    if expired:
        lines.append(
            "## Expired exceptions"
            if as_markdown
            else f"{len(expired)} exception(s) expired and no longer apply:"
        )
        if as_markdown:
            lines.append("")
        for exception in expired:
            lines.append(_expired_line(as_markdown, exception))
        if as_markdown:
            lines.append("")
    return "\n".join(lines)


def _advisory_line(as_markdown, aid, title, url):
    if as_markdown:
        label = f"[{aid}]({url})" if url else aid
        return f"- {label}: {title}"
    return f"  - {aid}: {title}"


def _exception_line(as_markdown, aid, exception):
    prefix = "-" if as_markdown else "  -"
    return f"{prefix} {aid}: expires {exception.expires.isoformat()} ({exception.jira})"


def _expired_line(as_markdown, exception):
    prefix = "-" if as_markdown else "  -"
    return f"{prefix} {exception.id}: expired {exception.expires.isoformat()} ({exception.jira})"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
