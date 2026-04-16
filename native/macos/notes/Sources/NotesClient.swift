import Foundation
import SharedCLI

/// Apple Notes.app automation via AppleScript.
enum NotesClient {

    static func listFolders() throws -> [String: Any] {
        let script = """
        tell application "Notes"
            set output to ""
            repeat with acct in accounts
                set acctName to name of acct
                repeat with f in folders of acct
                    set fName to name of f
                    set fId to id of f
                    set nc to count of notes of f
                    set output to output & fId & "||" & fName & "||" & acctName & "||" & nc & linefeed
                end repeat
            end repeat
            return output
        end tell
        """

        let output = try runNoteScript(script, timeout: 30)
        let folders = parseDelimited(output, fields: ["id", "name", "account_name", "note_count"])
        return ["folders": folders]
    }

    static func listNotes(limit: Int, folder: String?) throws -> [String: Any] {
        let folderClause: String
        if let f = folder {
            folderClause = "of folder \"\(escapeAppleScript(f))\""
        } else {
            folderClause = ""
        }

        let script = """
        tell application "Notes"
            set output to ""
            set noteCount to 0
            set allNotes to every note \(folderClause)
            repeat with n in allNotes
                if noteCount < \(limit) then
                    set nId to id of n
                    set nName to name of n
                    set nMod to modification date of n as string
                    try
                        set nFolder to name of container of n
                    on error
                        set nFolder to "(unknown)"
                    end try
                    set output to output & nId & "||" & nName & "||" & nMod & "||" & nFolder & linefeed
                    set noteCount to noteCount + 1
                end if
            end repeat
            return output
        end tell
        """

        let output = try runNoteScript(script, timeout: 30)
        let notes = parseDelimited(output, fields: ["id", "name", "modified", "folder"])
        return ["notes": notes]
    }

    static func getNote(id: String) throws -> [String: Any] {
        let idEsc = escapeAppleScript(id)
        // Use 30s timeout - large notes with attachments can be slow
        let script = """
        tell application "Notes"
            set n to note id "\(idEsc)"
            set nId to id of n
            set nName to name of n
            set nBody to body of n
            set nPlain to plaintext of n
            set nMod to modification date of n as string
            set nCreated to creation date of n as string
            try
                set nFolder to name of container of n
            on error
                set nFolder to "(unknown)"
            end try
            return nId & "||" & nName & "||" & nMod & "||" & nCreated & "||" & nFolder & "||" & nPlain & "||||" & nBody
        end tell
        """

        let output = try runNoteScript(script, timeout: 30)
        // Split on || but body (HTML) might contain || so we use |||| as body separator
        let mainParts = output.components(separatedBy: "||||")
        guard mainParts.count >= 2 else {
            throw NotesError.unexpectedFormat
        }

        let headerParts = mainParts[0].components(separatedBy: "||")
        guard headerParts.count >= 6 else {
            throw NotesError.unexpectedFormat
        }

        return [
            "note": [
                "id": headerParts[0].trimmingCharacters(in: .whitespaces),
                "name": headerParts[1].trimmingCharacters(in: .whitespaces),
                "modified": headerParts[2].trimmingCharacters(in: .whitespaces),
                "created": headerParts[3].trimmingCharacters(in: .whitespaces),
                "folder": headerParts[4].trimmingCharacters(in: .whitespaces),
                "plaintext": headerParts[5].trimmingCharacters(in: .whitespaces),
                "body": mainParts[1...].joined(separator: "||||").trimmingCharacters(in: .whitespaces),
            ]
        ]
    }

    static func searchNotes(query: String, limit: Int) throws -> [String: Any] {
        let queryEsc = escapeAppleScript(query)
        let script = """
        tell application "Notes"
            set output to ""
            set noteCount to 0
            set matchingNotes to (every note whose name contains "\(queryEsc)" or plaintext contains "\(queryEsc)")
            repeat with n in matchingNotes
                if noteCount < \(limit) then
                    set nId to id of n
                    set nName to name of n
                    set nMod to modification date of n as string
                    try
                        set nFolder to name of container of n
                    on error
                        set nFolder to "(unknown)"
                    end try
                    set output to output & nId & "||" & nName & "||" & nMod & "||" & nFolder & linefeed
                    set noteCount to noteCount + 1
                end if
            end repeat
            return output
        end tell
        """

        let output = try runNoteScript(script, timeout: 30)
        let notes = parseDelimited(output, fields: ["id", "name", "modified", "folder"])
        return ["notes": notes]
    }

    static func createNote(title: String, body: String?, folder: String?) throws -> [String: Any] {
        let titleEsc = escapeAppleScript(title)
        let bodyContent = body ?? ""
        let bodyEsc = escapeAppleScript(bodyContent)

        let folderClause: String
        if let f = folder {
            folderClause = "of folder \"\(escapeAppleScript(f))\""
        } else {
            folderClause = ""
        }

        let script = """
        tell application "Notes"
            set n to make new note \(folderClause) with properties {name:"\(titleEsc)", body:"\(bodyEsc)"}
            return id of n
        end tell
        """

        let noteId = try runNoteScript(script, timeout: 30)
        return [
            "id": noteId.trimmingCharacters(in: .whitespacesAndNewlines),
            "status": "created",
        ]
    }

    static func updateNote(id: String, title: String?, body: String?) throws -> [String: Any] {
        let idEsc = escapeAppleScript(id)

        var setStatements = ""
        if let title = title {
            setStatements += "set name of n to \"\(escapeAppleScript(title))\"\n"
        }
        if let body = body {
            setStatements += "set body of n to \"\(escapeAppleScript(body))\"\n"
        }

        guard !setStatements.isEmpty else {
            throw NotesError.noFieldsToUpdate
        }

        let script = """
        tell application "Notes"
            set n to note id "\(idEsc)"
            \(setStatements)
        end tell
        """

        _ = try runNoteScript(script, timeout: 30)
        return ["status": "updated"]
    }

    static func deleteNote(id: String) throws -> [String: Any] {
        let idEsc = escapeAppleScript(id)
        let script = """
        tell application "Notes"
            delete note id "\(idEsc)"
        end tell
        """

        _ = try runNoteScript(script, timeout: 30)
        return ["status": "deleted"]
    }
}

func runNoteScript(_ script: String, timeout: TimeInterval) throws -> String {
    do { return try ScriptRunner.run(script, timeout: timeout) }
    catch ScriptError.timeout(let seconds, _) {
        throw ScriptError.timeout(seconds, "note may contain large attachments")
    }
}

enum NotesError: LocalizedError {
    case unexpectedFormat
    case noFieldsToUpdate

    var errorDescription: String? {
        switch self {
        case .unexpectedFormat:
            return "Unexpected response format from Notes.app"
        case .noFieldsToUpdate:
            return "No fields to update. Provide 'title' or 'body'."
        }
    }
}
