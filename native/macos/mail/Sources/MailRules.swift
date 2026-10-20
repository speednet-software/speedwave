import Foundation
import SharedCLI

/// Read-only access to Mail's rules and the request to fetch new mail; nothing here creates, changes or deletes a rule.
enum MailRules {
    private static let recordSeparator: Character = "\u{1E}"
    private static let fieldSeparator: Character = "\u{1F}"

    /// Prints each rule, then its conditions and actions, as records of fields; the separators are ASCII RS/US,
    /// which no rule name or expression typed in Mail carries.
    static let listRulesScript = """
        on spwMailboxFields(mb)
            tell application "Mail"
                set mbName to name of mb
                set parentBox to container of mb
                repeat while class of parentBox is mailbox
                    set mbName to name of parentBox & "/" & mbName
                    set parentBox to container of parentBox
                end repeat
                set acctName to ""
                try
                    set acctName to name of account of mb
                end try
                return mbName & (character id 31) & acctName
            end tell
        end spwMailboxFields

        tell application "Mail"
            set US to character id 31
            set RS to character id 30
            set output to ""
            repeat with spwRuleRef in (every rule)
                set spwRule to contents of spwRuleRef
                set output to output & "rule" & US & (name of spwRule) & US & (enabled of spwRule as string) & US & (all conditions must be met of spwRule as string) & RS
                repeat with spwCondRef in (rule conditions of spwRule)
                    set spwCond to contents of spwCondRef
                    set spwHeader to ""
                    try
                        set spwHeader to «property rhed» of spwCond
                    end try
                    if spwHeader is missing value then set spwHeader to ""
                    set output to output & "condition" & US & (rule type of spwCond as string) & US & spwHeader & US & (qualifier of spwCond as string) & US & (expression of spwCond) & RS
                end repeat
                if should move message of spwRule then set output to output & "action" & US & "move" & US & my spwMailboxFields(move message of spwRule) & US & US & RS
                if should copy message of spwRule then set output to output & "action" & US & "copy" & US & my spwMailboxFields(copy message of spwRule) & US & US & RS
                if mark read of spwRule then set output to output & "action" & US & "mark_read" & US & US & US & US & RS
                if mark flagged of spwRule then set output to output & "action" & US & "mark_flagged" & US & US & US & US & RS
                if delete message of spwRule then set output to output & "action" & US & "delete" & US & US & US & US & RS
                set spwForward to forward message of spwRule
                if spwForward is not missing value and spwForward is not "" then set output to output & "action" & US & "forward" & US & US & US & spwForward & US & RS
                set spwRedirect to redirect message of spwRule
                if spwRedirect is not missing value and spwRedirect is not "" then set output to output & "action" & US & "redirect" & US & US & US & spwRedirect & US & RS
                set spwReply to reply text of spwRule
                if spwReply is not missing value and spwReply is not "" then set output to output & "action" & US & "reply" & US & US & US & US & spwReply & RS
                set spwScript to missing value
                try
                    set spwScript to POSIX path of (run script of spwRule)
                end try
                if spwScript is not missing value then set output to output & "action" & US & "run_script" & US & US & US & US & spwScript & RS
                if stop evaluating rules of spwRule then set output to output & "action" & US & "stop_evaluating_rules" & US & US & US & US & RS
            end repeat
            return output
        end tell
        """

    static func listRules(scripts: MailScripts) throws -> [[String: Any]] {
        parseRules(try scripts.run(listRulesScript))
    }

    /// Rules with their conditions and actions; an empty field is left out, a record before the first rule is dropped.
    static func parseRules(_ output: String) -> [[String: Any]] {
        var rules: [[String: Any]] = []
        for record in output.split(separator: recordSeparator) {
            let fields = record.split(separator: fieldSeparator, omittingEmptySubsequences: false).map(String.init)
            guard let kind = fields.first?.trimmingCharacters(in: .whitespacesAndNewlines) else { continue }
            switch kind {
            case "rule" where fields.count == 4:
                rules.append([
                    "name": fields[1],
                    "enabled": fields[2] == "true",
                    "match_all": fields[3] == "true",
                    "conditions": [[String: String]](),
                    "actions": [[String: String]](),
                ])
            case "condition" where fields.count == 5 && !rules.isEmpty:
                let condition = nonEmpty([
                    "field": fields[1], "header": fields[2], "qualifier": fields[3], "expression": fields[4],
                ])
                append(condition, to: "conditions", of: &rules)
            case "action" where fields.count == 6 && !rules.isEmpty:
                let action = nonEmpty([
                    "type": fields[1], "mailbox": fields[2], "account": fields[3], "address": fields[4], "text": fields[5],
                ])
                append(action, to: "actions", of: &rules)
            default:
                continue
            }
        }
        return rules
    }

    static func checkMailScript(account: String?) -> String {
        guard let account = account else {
            return "tell application \"Mail\" to check for new mail"
        }
        let accountEsc = escapeAppleScript(account)
        return """
            tell application "Mail"
                if not (exists account "\(accountEsc)") then error "\(accountNotFoundMarker)"
                check for new mail for account "\(accountEsc)"
            end tell
            """
    }

    static func checkMail(scripts: MailScripts, account: String?) throws -> [String: Any] {
        _ = try scripts.run(checkMailScript(account: account), account: account)
        var result: [String: Any] = ["status": "started"]
        result["account"] = account
        return result
    }

    private static func nonEmpty(_ fields: [String: String]) -> [String: String] {
        fields.filter { !$0.value.isEmpty }
    }

    private static func append(_ item: [String: String], to key: String, of rules: inout [[String: Any]]) {
        var items = rules[rules.count - 1][key] as? [[String: String]] ?? []
        items.append(item)
        rules[rules.count - 1][key] = items
    }
}
