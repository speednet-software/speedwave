import Foundation

// MARK: - CLI Entry Point

/// notes-cli <command> [json-args]
/// Commands: list_folders, list_notes, get_note, search_notes, create_note, update_note, delete_note
@main
struct NotesCLI {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            exitWithError("Usage: notes-cli <command> [json-args]\nCommands: list_folders, list_notes, get_note, search_notes, create_note, update_note, delete_note")
        }

        let command = args[1]
        let jsonArgs = args.count >= 3 ? args[2] : "{}"

        guard let argsData = jsonArgs.data(using: .utf8),
              let params = try? JSONSerialization.jsonObject(with: argsData) as? [String: Any]
        else {
            exitWithError("Invalid JSON arguments: \(jsonArgs)")
        }

        do {
            let result: Any
            switch command {
            case "list_folders":
                result = try NotesClient.listFolders()
            case "list_notes":
                let limit = params["limit"] as? Int ?? 20
                let folder = params["folder"] as? String
                result = try NotesClient.listNotes(limit: limit, folder: folder)
            case "get_note":
                guard let id = params["id"] as? String else {
                    throw NotesCLIError.missingField("id")
                }
                result = try NotesClient.getNote(id: id)
            case "search_notes":
                guard let query = params["query"] as? String else {
                    throw NotesCLIError.missingField("query")
                }
                let limit = params["limit"] as? Int ?? 20
                result = try NotesClient.searchNotes(query: query, limit: limit)
            case "create_note":
                guard let title = params["title"] as? String else {
                    throw NotesCLIError.missingField("title")
                }
                let body = params["body"] as? String
                let folder = params["folder"] as? String
                result = try NotesClient.createNote(title: title, body: body, folder: folder)
            case "update_note":
                guard let id = params["id"] as? String else {
                    throw NotesCLIError.missingField("id")
                }
                let title = params["title"] as? String
                let body = params["body"] as? String
                result = try NotesClient.updateNote(id: id, title: title, body: body)
            case "delete_note":
                guard let id = params["id"] as? String else {
                    throw NotesCLIError.missingField("id")
                }
                result = try NotesClient.deleteNote(id: id)
            default:
                exitWithError("Unknown command: \(command)\nAvailable: list_folders, list_notes, get_note, search_notes, create_note, update_note, delete_note")
            }

            let data = try JSONSerialization.data(
                withJSONObject: result,
                options: [.prettyPrinted, .sortedKeys]
            )
            if let json = String(data: data, encoding: .utf8) {
                print(json)
            }
        } catch {
            exitWithError(error.localizedDescription)
        }
    }
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

func exitWithError(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
