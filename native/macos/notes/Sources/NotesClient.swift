import Foundation
import SharedCLI

/// Apple Notes.app automation via AppleScript.
enum NotesClient {

    /// AppleScript `of folder "<name>"` clause, or empty string when unscoped.
    /// Notes folder lookups match by name, not by the opaque CoreData id.
    static func folderClause(_ folder: String?) -> String {
        guard let f = folder else { return "" }
        return "of folder \"\(escapeAppleScript(f))\""
    }

    /// True only when a probe confirms the folder is absent; a probe error returns false
    /// so an unrelated -1728 surfaces its real cause rather than a wrong folder message.
    static func folderDefinitelyMissing(_ name: String) -> Bool {
        let script = "tell application \"Notes\" to return (exists folder \"\(escapeAppleScript(name))\")"
        guard let out = try? ScriptRunner.run(script, timeout: 10) else { return false }
        return out == "false"
    }

    /// True only when a probe confirms the note id is absent; a probe error returns false
    /// so an unrelated -1728 surfaces its real cause rather than a wrong note message.
    static func noteDefinitelyMissing(_ id: String) -> Bool {
        let script = "tell application \"Notes\" to return (exists note id \"\(escapeAppleScript(id))\")"
        guard let out = try? ScriptRunner.run(script, timeout: 10) else { return false }
        return out == "false"
    }

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
        let script = """
        tell application "Notes"
            set output to ""
            set noteCount to 0
            set allNotes to every note \(folderClause(folder))
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

        let output = try runNoteScript(
            script, timeout: 30, folder: folder,
            folderMissing: { folder.map { Self.folderDefinitelyMissing($0) } ?? false }
        )
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

        let output = try runNoteScript(
            script, timeout: 30, noteId: id,
            noteMissing: { Self.noteDefinitelyMissing(id) }
        )
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

    static func searchNotes(query: String, limit: Int, folder: String? = nil) throws -> [String: Any] {
        let queryEsc = escapeAppleScript(query)
        let script = """
        tell application "Notes"
            set output to ""
            set noteCount to 0
            set matchingNotes to (every note \(folderClause(folder)) whose name contains "\(queryEsc)" or plaintext contains "\(queryEsc)")
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

        let output = try runNoteScript(
            script, timeout: 30, folder: folder,
            folderMissing: { folder.map { Self.folderDefinitelyMissing($0) } ?? false }
        )
        let notes = parseDelimited(output, fields: ["id", "name", "modified", "folder"])
        return ["notes": notes]
    }

    static func createNote(title: String, body: String?, folder: String?) throws -> [String: Any] {
        let titleEsc = escapeAppleScript(title)
        let bodyContent = body ?? ""
        let bodyEsc = escapeAppleScript(bodyContent)

        let script = """
        tell application "Notes"
            set n to make new note \(folderClause(folder)) with properties {name:"\(titleEsc)", body:"\(bodyEsc)"}
            return id of n
        end tell
        """

        let noteId = try runNoteScript(
            script, timeout: 30, folder: folder,
            folderMissing: { folder.map { Self.folderDefinitelyMissing($0) } ?? false }
        )
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

        _ = try runNoteScript(
            script, timeout: 30, noteId: id,
            noteMissing: { Self.noteDefinitelyMissing(id) }
        )
        return ["status": "updated"]
    }

    static func deleteNote(id: String) throws -> [String: Any] {
        let idEsc = escapeAppleScript(id)
        let script = """
        tell application "Notes"
            delete note id "\(idEsc)"
        end tell
        """

        _ = try runNoteScript(
            script, timeout: 30, noteId: id,
            noteMissing: { Self.noteDefinitelyMissing(id) }
        )
        return ["status": "deleted"]
    }
}

/// Runs a Notes-scoped AppleScript. A -1728 "Can't get" failure that names the scoped
/// `folder`/`noteId` maps to a not-found teaching error only when a probe confirms it's
/// actually absent — a per-note read failure inside the same script keeps its real cause.
func runNoteScript(
    _ script: String,
    timeout: TimeInterval,
    folder: String? = nil,
    noteId: String? = nil,
    folderMissing: () -> Bool = { false },
    noteMissing: () -> Bool = { false }
) throws -> String {
    do { return try ScriptRunner.run(script, timeout: timeout) }
    catch ScriptError.timeout(let seconds, _) {
        throw ScriptError.timeout(seconds, "note may contain large attachments")
    }
    catch ScriptError.scriptFailed(let msg)
        where folder != nil && appleScriptNotFoundNames(msg, folder!) && folderMissing()
    {
        throw CLIError.notFound(
            "Folder not found. List valid folders via listNoteFolders and use their name field as folder_id."
        )
    }
    catch ScriptError.scriptFailed(let msg)
        where noteId != nil && appleScriptNotFoundNames(msg, noteId!) && noteMissing()
    {
        throw CLIError.notFound(
            "Note not found. List notes via listNotes/searchNotes and use its id."
        )
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
