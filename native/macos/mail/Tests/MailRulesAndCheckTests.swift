import SharedCLI
import XCTest
@testable import mail_cli

final class MailRulesAndCheckTests: XCTestCase {
    private let harness = MailCommandHarness()

    private func record(_ fields: String...) -> String {
        fields.joined(separator: "\u{1F}") + "\u{1E}"
    }

    func testListRulesReturnsEachRuleWithItsConditionsAndActions() throws {
        harness.executor.reply(
            record("rule", "Invoices", "true", "false")
                + record("condition", "from header", "", "does contain value", "billing@acme.example")
                + record("condition", "header key", "X-Mailer", "begins with value", "Acme")
                + record("action", "move", "Finance/Invoices", "Work", "", "")
                + record("action", "mark_read", "", "", "", "")
                + record("rule", "Forward boss", "false", "true")
                + record("condition", "any recipient", "", "is equal to value", "me@example.com")
                + record("action", "forward", "", "", "assistant@example.com", "")
                + record("action", "reply", "", "", "", "Out of office\nuntil Monday")
        )

        let result = try harness.call("list_rules")

        let rules = try XCTUnwrap(result["rules"] as? [[String: Any]])
        XCTAssertEqual(rules.count, 2)
        XCTAssertEqual(rules[0]["name"] as? String, "Invoices")
        XCTAssertEqual(rules[0]["enabled"] as? Bool, true)
        XCTAssertEqual(rules[0]["match_all"] as? Bool, false)
        let conditions = try XCTUnwrap(rules[0]["conditions"] as? [[String: String]])
        XCTAssertEqual(conditions, [
            ["field": "from header", "qualifier": "does contain value", "expression": "billing@acme.example"],
            ["field": "header key", "header": "X-Mailer", "qualifier": "begins with value", "expression": "Acme"],
        ])
        let actions = try XCTUnwrap(rules[0]["actions"] as? [[String: String]])
        XCTAssertEqual(actions, [
            ["type": "move", "mailbox": "Finance/Invoices", "account": "Work"],
            ["type": "mark_read"],
        ])
        XCTAssertEqual(rules[1]["enabled"] as? Bool, false)
        XCTAssertEqual(rules[1]["match_all"] as? Bool, true)
        XCTAssertEqual(rules[1]["actions"] as? [[String: String]], [
            ["type": "forward", "address": "assistant@example.com"],
            ["type": "reply", "text": "Out of office\nuntil Monday"],
        ])
    }

    func testARuleWhoseTargetMailboxIsGoneIsListedWithItsTargetMarkedMissing() throws {
        harness.executor.reply(
            record("rule", "Old", "true", "true")
                + record("action", "move", ruleTargetMissingMarker, "", "", "")
                + record("action", "copy", "Archive/2026", "Work", "", "")
        )

        let result = try harness.call("list_rules")

        let actions = try XCTUnwrap((result["rules"] as? [[String: Any]])?.first?["actions"] as? [[String: Any]])
        XCTAssertEqual(actions.count, 2)
        XCTAssertEqual(actions[0]["type"] as? String, "move")
        XCTAssertEqual(actions[0]["target_missing"] as? Bool, true)
        XCTAssertNil(actions[0]["mailbox"])
        XCTAssertEqual(actions[1]["mailbox"] as? String, "Archive/2026")
        XCTAssertNil(actions[1]["target_missing"])
    }

    func testTheRuleTargetPathWalksContainersOfEitherClassAndAMissingTargetDoesNotFailTheCall() {
        let script = MailRules.listRulesScript

        XCTAssertFalse(script.contains("repeat while class of parentBox is mailbox"), script)
        XCTAssertTrue(script.contains("if class of spwUp is not container and class of spwUp is not mailbox then exit repeat"), script)
        XCTAssertTrue(script.contains("return \"\(ruleTargetMissingMarker)\""), script)
    }

    func testListRulesWithNoRulesReturnsAnEmptyList() throws {
        harness.executor.reply("")

        let result = try harness.call("list_rules")

        XCTAssertEqual((result["rules"] as? [Any])?.count, 0)
    }

    func testListRulesKeepsAFieldThatContainsTheOldRowDelimiter() throws {
        harness.executor.reply(
            record("rule", "A || B", "true", "true")
                + record("condition", "subject header", "", "does contain value", "x||y")
        )

        let rules = try XCTUnwrap(try harness.call("list_rules")["rules"] as? [[String: Any]])

        XCTAssertEqual(rules.first?["name"] as? String, "A || B")
        XCTAssertEqual((rules.first?["conditions"] as? [[String: String]])?.first?["expression"], "x||y")
    }

    func testListRulesIgnoresConditionsAndActionsBeforeTheFirstRule() throws {
        harness.executor.reply(
            record("condition", "subject header", "", "does contain value", "stray")
                + record("rule", "Only", "true", "true")
        )

        let rules = try XCTUnwrap(try harness.call("list_rules")["rules"] as? [[String: Any]])

        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual((rules.first?["conditions"] as? [Any])?.count, 0)
        XCTAssertEqual((rules.first?["actions"] as? [Any])?.count, 0)
    }

    func testListRulesOnlyReadsRules() throws {
        _ = try harness.call("list_rules")

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("every rule"))
        XCTAssertFalse(script.contains("make new"))
        XCTAssertNil(script.range(of: #"\bdelete (rule|spw)"#, options: .regularExpression))
        XCTAssertNil(script.range(of: #"set [a-z ]+ of spwRule to"#, options: .regularExpression))
    }

    func testCheckMailWithoutAnAccountChecksEveryAccount() throws {
        let result = try harness.call("check_mail")

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("check for new mail"))
        XCTAssertFalse(script.contains("for account"))
        XCTAssertEqual(result as NSDictionary, ["status": "started"])
    }

    func testCheckMailForAnAccountChecksOnlyThatAccount() throws {
        let result = try harness.call("check_mail", ["account": "Work \"Exchange\""])

        let script = try XCTUnwrap(harness.executor.calls.first?.script)
        XCTAssertTrue(script.contains("check for new mail for spwAcct\n"), script)
        XCTAssertTrue(script.contains(#"every account whose name is "Work \"Exchange\"""#), script)
        XCTAssertEqual(result as NSDictionary, ["status": "started", "account": "Work \"Exchange\""])
    }

    func testCheckMailForAnUnknownAccountIsReportedAsAccountNotFound() throws {
        harness.executor.fail(ScriptError.scriptFailed("execution error: \(accountNotFoundMarker) (-2700)"))

        let error = harness.callFailing("check_mail", ["account": "Nope"])

        XCTAssertEqual(error as? MailFailure, .accountNotFound("Nope"))
    }

    func testListRulesAndCheckMailRunWithinTheBudget() throws {
        _ = try harness.call("list_rules", [scriptTimeoutParam: 4_000])
        _ = try harness.call("check_mail", [scriptTimeoutParam: 4_000])

        XCTAssertEqual(harness.executor.calls.map(\.timeout), [4, 4])
    }
}
