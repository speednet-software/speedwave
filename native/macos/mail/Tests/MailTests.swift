import SharedCLI
import XCTest
@testable import mail_cli

final class MailTests: XCTestCase {


    func testParseMailboxesTypesMessageCountAsANumber() {
        let rows = AppleMailClient.parseMailboxes("iCloud||INBOX||42\nWork||Archive||0\n")
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0]["account"] as? String, "iCloud")
        XCTAssertEqual(rows[0]["name"] as? String, "INBOX")
        XCTAssertEqual(rows[0]["message_count"] as? Int, 42)
        XCTAssertEqual(rows[1]["message_count"] as? Int, 0)
    }

    func testParseMailboxesOmitsAMessageCountThatIsNotAnInteger() {
        let rows = AppleMailClient.parseMailboxes("iCloud||INBOX||missing value\n")
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0]["message_count"])
    }

    func testParseMessageListTypesReadAsABoolean() {
        let rows = AppleMailClient.parseMessageList(
            "<a@x>||Hi||Anna <anna@x>||Monday||false\n<b@x>||Re||Bob <bob@x>||Tuesday||true\n"
        )
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0]["id"] as? String, "<a@x>")
        XCTAssertEqual(rows[0]["read"] as? Bool, false)
        XCTAssertEqual(rows[1]["read"] as? Bool, true)
    }

    func testParseMessageListOfEmptyOutputIsEmpty() {
        XCTAssertTrue(AppleMailClient.parseMessageList("").isEmpty)
    }


    func testDetectClientsReportsAppleMailAsTheOnlySupportedClient() {
        let clients = detectClients(outlookInstalled: { false })["clients"] as? [[String: Any]] ?? []
        XCTAssertEqual(clients.count, 1)
        XCTAssertEqual(clients.first?["name"] as? String, "Apple Mail")
        XCTAssertEqual(clients.first?["supported"] as? Bool, true)
        XCTAssertNil(clients.first?["instructions"])
    }

    func testDetectClientsReportsAnInstalledOutlookAsUnsupportedWithInstructions() {
        let clients = detectClients(outlookInstalled: { true })["clients"] as? [[String: Any]] ?? []
        XCTAssertEqual(clients.count, 2)
        let outlook = clients.last
        XCTAssertEqual(outlook?["name"] as? String, "Microsoft Outlook")
        XCTAssertEqual(outlook?["supported"] as? Bool, false)
        let instructions = outlook?["instructions"] as? String ?? ""
        XCTAssertTrue(instructions.contains("not supported"), instructions)
        XCTAssertTrue(instructions.contains("Internet Accounts"), instructions)
        XCTAssertTrue(instructions.contains("Apple Mail"), instructions)
    }


    func testMailErrorMissingField() {
        let error = MailError.missingField("to")
        XCTAssertEqual(error.errorDescription, "Missing required field: to")
    }


    func testMailErrorConfirmRequired() {
        let error = MailError.confirmRequired
        XCTAssertTrue(error.errorDescription!.contains("confirm_send"))
    }


    func testSplitAddressListSingleAddress() {
        XCTAssertEqual(splitAddressList("alice@example.com"), ["alice@example.com"])
    }

    func testSplitAddressListMultipleAddressesTrimsWhitespace() {
        XCTAssertEqual(
            splitAddressList("alice@example.com, bob@example.com,  carol@example.com"),
            ["alice@example.com", "bob@example.com", "carol@example.com"]
        )
    }

    func testSplitAddressListDropsEmptyEntries() {
        XCTAssertEqual(splitAddressList("alice@example.com,, bob@example.com,"), ["alice@example.com", "bob@example.com"])
    }

    func testSplitAddressListEmptyStringReturnsEmptyArray() {
        XCTAssertEqual(splitAddressList(""), [])
    }


    func testAppleMailRecipientClausesSingleAddress() {
        let result = AppleMailClient.recipientClauses("alice@example.com", kind: "to")
        XCTAssertEqual(
            result,
            "        make new to recipient at end of to recipients with properties {address:\"alice@example.com\"}"
        )
    }

    func testAppleMailRecipientClausesMultipleAddressesOneLinePerRecipient() {
        let result = AppleMailClient.recipientClauses("alice@example.com,bob@example.com", kind: "cc")
        let lines = result.components(separatedBy: "\n")
        XCTAssertEqual(lines.count, 2, "must emit one AppleScript line per recipient")
        XCTAssertTrue(lines[0].contains("cc recipient") && lines[0].contains("alice@example.com"))
        XCTAssertTrue(lines[1].contains("cc recipient") && lines[1].contains("bob@example.com"))
    }

    func testAppleMailRecipientClausesEmptyStringProducesNoLines() {
        XCTAssertEqual(AppleMailClient.recipientClauses("", kind: "bcc"), "")
    }


    func testMailboxLookupSearchesEveryAccountWhenNoAccountIsGiven() {
        let script = AppleMailClient.mailboxLookup(name: "Archive", account: nil)
        XCTAssertTrue(script.contains("repeat with spwAcctRef in accounts"), script)
        XCTAssertTrue(script.contains("set spwAcct to contents of spwAcctRef"), script)
        XCTAssertTrue(script.contains("exists mailbox \"Archive\" of spwAcct"), script)
        XCTAssertFalse(script.contains("exists account"), script)
    }

    func testMailboxLookupSearchesOnlyTheNamedAccount() {
        let script = AppleMailClient.mailboxLookup(name: "Archive", account: "Exchange")
        XCTAssertTrue(script.contains("if not (exists account \"Exchange\")"), script)
        XCTAssertTrue(script.contains("repeat with spwAcctRef in {account \"Exchange\"}"), script)
    }

    func testMailboxLookupEscapesQuotesInNames() {
        let script = AppleMailClient.mailboxLookup(name: "My \"Box\"", account: "Work \"A\"")
        XCTAssertTrue(script.contains("mailbox \"My \\\"Box\\\"\" of spwAcct"), script)
        XCTAssertTrue(script.contains("account \"Work \\\"A\\\"\""), script)
    }

    func testListMailboxesNamesANestedMailboxByItsPathInTheAccount() {
        let script = AppleMailClient.listMailboxesScript
        XCTAssertTrue(script.contains("repeat while class of parentBox is mailbox"), script)
        XCTAssertTrue(script.contains("set mbName to name of parentBox & \"/\" & mbName"), script)
    }

    func testMailboxLookupWithoutANameIsTheInbox() {
        XCTAssertEqual(AppleMailClient.mailboxLookup(name: nil, account: nil), "set mb to inbox")
    }

    func testPermissionCheckScriptAccessesData() {
        XCTAssertFalse(
            permissionCheckScript.hasSuffix("to name"),
            "permissionCheckScript must not use 'to name' — it does not require Automation permission"
        )
        XCTAssertTrue(
            permissionCheckScript.contains("Mail"),
            "permissionCheckScript must target Mail app"
        )
    }

    func testFormatPermissionResultWithAutomationPermissionError() {
        let errorMsg = ScriptError.automationPermission("not allowed").errorDescription!
        let json = formatPermissionResult(granted: false, error: errorMsg)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertTrue(parsed["granted"] is Bool)
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertTrue((parsed["error"] as! String).contains("Automation permission denied"))
    }

    func testFormatPermissionResultWithTimeoutError() {
        let errorMsg = ScriptError.timeout(15, nil).errorDescription!
        let json = formatPermissionResult(granted: false, error: errorMsg)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertTrue((parsed["error"] as! String).contains("timed out after 15s"))
    }

    func testFormatPermissionResultWithScriptFailedError() {
        let errorMsg = ScriptError.scriptFailed("some error").errorDescription!
        let json = formatPermissionResult(granted: false, error: errorMsg)
        let data = json.data(using: .utf8)!
        let parsed = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false)
        XCTAssertTrue(parsed["error"] is String)
        XCTAssertTrue((parsed["error"] as! String).contains("AppleScript error"))
    }


    final class FakeMailGate: PermissionGate {
        var initialStatus: RawAuthorizationStatus = .notDetermined
        var postRequestStatus: RawAuthorizationStatus = .notDetermined
        var requestGranted: Bool = false
        var dataAccessError: String? = nil
        var queryCount = 0
        func authorizationStatus() -> RawAuthorizationStatus {
            queryCount += 1
            return queryCount == 1 ? initialStatus : postRequestStatus
        }
        func requestAccess(completion: @escaping (Bool, Error?) -> Void) {
            completion(requestGranted, nil)
        }
        func verifyDataAccess() -> String? { dataAccessError }
    }

    func testCheckPermissionGrantedWhenAEReturnsNoErr() {
        let gate = FakeMailGate()
        gate.initialStatus = .granted
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, true)
        XCTAssertEqual(parsed["status"] as? String, "granted")
    }

    func testCheckPermissionDeniedReturnsAppleEventsTccutil() {
        let gate = FakeMailGate()
        gate.initialStatus = .denied
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "denied")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("tccutil reset AppleEvents pl.speedwave.desktop.mail"),
                      "Mail denied must use AppleEvents service + sub-identifier, got: \(error)")
        XCTAssertFalse(error.contains("tccutil reset Mail"),
                       "Mail must NOT use 'tccutil reset Mail' (no such TCC service), got: \(error)")
    }

    func testCheckPermissionTargetNotRunningOnProcNotFound() {
        let gate = FakeMailGate()
        gate.initialStatus = .targetNotRunning(bundleId: "com.apple.mail")
        gate.postRequestStatus = .targetNotRunning(bundleId: "com.apple.mail")
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "targetNotRunning")
        let error = parsed["error"] as? String ?? ""
        XCTAssertFalse(error.lowercased().contains("tccutil"),
                       "targetNotRunning must NOT recommend tccutil")
        XCTAssertTrue(error.contains("Mail.app"),
                      "Mail targetNotRunning must mention Mail.app")
    }

    func testCheckPermissionSilentRejectWhenNotDeterminedTwice() {
        let gate = FakeMailGate()
        gate.initialStatus = .notDetermined
        gate.postRequestStatus = .notDetermined
        gate.requestGranted = false
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("reinstall"),
                      "silentReject must mention reinstall (signing/entitlement guidance)")
    }

    func testCheckPermissionGrantedButDataAccessFails() {
        let gate = FakeMailGate()
        gate.initialStatus = .granted
        gate.dataAccessError = "AppleScript error: cannot read mailboxes"
        let result = performCheckPermission(gate: gate, entity: .mail)
        let parsed = try! JSONSerialization.jsonObject(with: result.data(using: .utf8)!) as! [String: Any]
        XCTAssertEqual(parsed["granted"] as? Bool, false,
                       "Data-access failure must downgrade granted=true")
        XCTAssertEqual(parsed["status"] as? String, "silentReject")
        let error = parsed["error"] as? String ?? ""
        XCTAssertTrue(error.contains("data access failed"),
                      "Error must explain data-access layer failure")
        XCTAssertTrue(error.contains("cannot read mailboxes"),
                      "Underlying probe error must be included")
    }
}
