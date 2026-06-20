import Foundation
import SharedCLI

// MARK: - CLI Entry Point

/// notes-cli <command> [json-args]
/// Commands: check_permission, list_folders, list_notes, get_note, search_notes, create_note, update_note, delete_note
@main
struct NotesCLI {
    static let commandList =
        "check_permission, list_folders, list_notes, get_note, search_notes, create_note, update_note, delete_note"

    static func main() {
        // check_permission validates Notes automation via AppleEventsGate.
        runCLI(
            cliName: "notes-cli",
            commandList: commandList,
            entity: .notes,
            checkPermissionGate: { args in
                let allowLaunch = args.contains("--launch")
                return AppleEventsGate(
                    targetBundleId: "com.apple.Notes",
                    dataAccessScript: permissionCheckScript,
                    dataAccessTimeout: 30,
                    pidResolver: NSWorkspacePidResolver(),
                    appLauncher: allowLaunch ? NSWorkspaceAppLauncher() : NeverLaunchAppLauncher()
                )
            },
            commands: NotesCLI.commands
        )
    }

    static let commands: [String: ([String: Any]) throws -> Any] = [
        "list_folders": { _ in try NotesClient.listFolders() },
        "list_notes": { params in
            try NotesClient.listNotes(
                limit: params["limit"] as? Int ?? 20,
                folder: params["folder"] as? String
            )
        },
        "get_note": { params in
            guard let id = params["id"] as? String else { throw NotesCLIError.missingField("id") }
            return try NotesClient.getNote(id: id)
        },
        "search_notes": { params in
            guard let query = params["query"] as? String else { throw NotesCLIError.missingField("query") }
            return try NotesClient.searchNotes(query: query, limit: params["limit"] as? Int ?? 20)
        },
        "create_note": { params in
            guard let title = params["title"] as? String else { throw NotesCLIError.missingField("title") }
            return try NotesClient.createNote(
                title: title,
                body: params["body"] as? String,
                folder: params["folder"] as? String
            )
        },
        "update_note": { params in
            guard let id = params["id"] as? String else { throw NotesCLIError.missingField("id") }
            return try NotesClient.updateNote(
                id: id,
                title: params["title"] as? String,
                body: params["body"] as? String
            )
        },
        "delete_note": { params in
            guard let id = params["id"] as? String else { throw NotesCLIError.missingField("id") }
            return try NotesClient.deleteNote(id: id)
        },
    ]
}

// MARK: - Error Handling

enum NotesCLIError: LocalizedError {
    case missingField(String)

    var errorDescription: String? {
        switch self {
        case .missingField(let field):
            return "Missing required field: \(field)"
        }
    }
}

// MARK: - Permission Helpers

/// AppleScript command used by check_permission to verify Automation access.
/// Must access actual data (not just app metadata like `name`) to trigger the
/// macOS Automation permission prompt. `to name` does NOT require permission.
// SYNC: permissionCheckScript rationale must match mail/Sources/MailCLI.swift
let permissionCheckScript = "tell application \"Notes\" to count of notes"
