import Foundation

struct StatusSnapshot: Decodable {
    let version: String
    let startedAt: String
    let apiUrl: String
    let mcpUrl: String
    let chats: [ChatFolder]
    let tunnel: TunnelStatus
}

struct ChatFolder: Decodable, Identifiable {
    let id: String
    let title: String?
    let setupCode: String
    let folderPath: String?
    let revision: Int
    let createdAt: String
    let lastSeenAt: String
    let recovery: WorkRecoverySummary?

    var displayName: String {
        let name = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Chat \(setupCode)" : name
    }
}

struct WorkRecoverySummary: Decodable {
    let lastSavedAt: String?
    let checkpointStatus: String?
    let activeOperations: Int
    let unresolvedOperations: Int
    let reviewRequired: Bool
    let latestSequence: Int

    var lastSavedDate: Date? { WorkLogDate.parse(lastSavedAt) }
}

struct WorkCheckpoint: Decodable {
    let goal: String
    let completed: [String]
    let verification: [String]
    let nextStep: String
    let status: String
    let savedAt: String
    let sequence: Int

    var savedDate: Date? { WorkLogDate.parse(savedAt) }
}

enum WorkLogStatus: String, Decodable {
    case started
    case executionRecorded = "execution_recorded"
    case executionError = "execution_error"
    case outcomeUnknown = "outcome_unknown"

    var label: String {
        switch self {
        case .started: "Started"
        case .executionRecorded: "Execution recorded"
        case .executionError: "Execution error"
        case .outcomeUnknown: "Outcome unknown"
        }
    }
}

enum WorkLogValue: Decodable {
    case string(String)
    case number(Double)
    case boolean(Bool)
    case null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let boolean = try? value.decode(Bool.self) { self = .boolean(boolean) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else { self = .string(try value.decode(String.self)) }
    }

    var displayText: String? {
        switch self {
        case .string(let value): value
        case .number(let value): value == value.rounded() ? String(format: "%.0f", value) : String(value)
        case .boolean(let value): value ? "Yes" : "No"
        case .null: nil
        }
    }
}

struct WorkLogDetail: Identifiable {
    let id: String
    let label: String
    let value: String
}

struct WorkLogEvent: Decodable, Identifiable {
    let id: String
    let sequence: Int
    let revision: Int
    let tool: String
    let startedAt: String
    let endedAt: String?
    let status: WorkLogStatus
    let mayHaveSideEffects: Bool
    let metadata: [String: WorkLogValue]
    let result: [String: WorkLogValue]?
    let reviewedAt: String?

    var startedDate: Date? { WorkLogDate.parse(startedAt) }
    var unresolved: Bool {
        reviewedAt == nil && (status == .executionError || status == .outcomeUnknown)
    }
    var requiresReview: Bool { unresolved && mayHaveSideEffects }

    var details: [WorkLogDetail] {
        let metadataFields = [("path", "Path"), ("cwd", "Working folder"), ("action", "Action"), ("skillId", "Skill"), ("stagePath", "Staging path"), ("stagePhase", "Save phase")]
        let resultFields = [("path", "Saved path"), ("bytes", "Bytes"), ("replacements", "Replacements"), ("exitCode", "Exit code"), ("truncated", "Output truncated")]
        return metadataFields.compactMap { key, label in
            guard let value = metadata[key]?.displayText else { return nil }
            return WorkLogDetail(id: "metadata.\(key)", label: label, value: value)
        } + resultFields.compactMap { key, label in
            guard let value = result?[key]?.displayText else { return nil }
            return WorkLogDetail(id: "result.\(key)", label: label, value: value)
        }
    }
}

struct WorkLogPage: Decodable {
    let revision: Int
    let folderPath: String?
    let checkpoint: WorkCheckpoint?
    let summary: WorkRecoverySummary
    let events: [WorkLogEvent]
    let nextBeforeSequence: Int?

    var checkpointNeedsReview: Bool {
        guard let checkpoint else { return false }
        return checkpoint.sequence < summary.latestSequence
    }

    func appending(_ older: Self) -> Self {
        guard older.revision == revision else { return self }
        var seen = Set<String>()
        let combined = (events + older.events).filter { seen.insert($0.id).inserted }
        return Self(revision: revision, folderPath: folderPath, checkpoint: checkpoint,
                    summary: summary, events: combined, nextBeforeSequence: older.nextBeforeSequence)
    }

    func recoveryText(chatName: String, currentRevision: Int) -> String {
        let archived = revision != currentRevision
        var lines = [
            "Chat2Local recovery summary — \(chatName)",
            "\(archived ? "Archived" : "Current") folder revision \(revision)",
            "Saved folder: \(folderPath ?? "No folder recorded")"
        ]
        if archived { lines.append("Current folder revision: \(currentRevision)") }
        lines.append("Choose a folder manually in Chat2Local before continuing in a new chat.")
        lines.append("Inspect uncertain actions before repeating them. Recorded execution does not confirm that a chat received the result.")
        if let checkpoint {
            lines += ["", "Last checkpoint: \(checkpoint.savedAt)", "Goal: \(checkpoint.goal)", "Status: \(checkpoint.status)"]
            if checkpointNeedsReview {
                lines.append("This checkpoint is older than later recorded work; review the log before continuing.")
            }
            if !checkpoint.completed.isEmpty {
                lines += ["Completed:"] + checkpoint.completed.map { "• \($0)" }
            }
            if !checkpoint.verification.isEmpty {
                lines += ["Verification:"] + checkpoint.verification.map { "• \($0)" }
            }
            lines.append("Next step: \(checkpoint.nextStep)")
        } else {
            lines += ["", "No checkpoint saved for this folder revision."]
        }
        lines += ["", "Active actions: \(summary.activeOperations)", "Failed or uncertain actions: \(summary.unresolvedOperations)"]
        if !events.isEmpty {
            lines += ["", "Loaded work log (newest first):"]
            lines += events.map { event in
                let action = "• \(event.startedAt) — \(event.tool): \(event.status.label)\(event.requiresReview ? "; review required" : "")"
                let staging = event.details.filter { $0.id == "metadata.stagePath" || $0.id == "metadata.stagePhase" }
                    .map { "  \($0.label): \($0.value)" }
                return ([action] + staging).joined(separator: "\n")
            }
        }
        if nextBeforeSequence != nil { lines.append("More history is available in Chat2Local.") }
        return WorkRecoveryRedaction.redact(lines.joined(separator: "\n"))
    }
}

/// A final copy boundary for titles, paths, and authored prose. This catches
/// common patterns; it cannot establish that arbitrary text contains no secrets.
private enum WorkRecoveryRedaction {
    static func redact(_ value: String) -> String {
        var result = value.replacingOccurrences(
            of: #"(?s)-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----.*?-----END (?:[A-Z ]*PRIVATE KEY)-----"#,
            with: "[redacted]", options: .regularExpression
        )
        result = redactURLs(result)
        let patterns: [(String, String)] = [
            (#"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b"#, "[redacted]"),
            (#"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"#, "[redacted]"),
            (#"(?i)\b(Bearer\s+)[A-Za-z0-9._~+/=-]+"#, "$1[redacted]"),
            (#"(?i)(["'])([a-z0-9_]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization)[a-z0-9_]*)\1(\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,}\]]+)"#, "$1$2$1$3\"[redacted]\""),
            (#"(?i)\b([a-z0-9_]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization)[a-z0-9_]*)\b(\s*[=:]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;]+)"#, "$1$2[redacted]")
        ]
        for (pattern, replacement) in patterns {
            result = result.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        return result
    }

    private static func redactURLs(_ value: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: #"(?i)\b[a-z][a-z0-9+.-]*://[^\s<>"'`]+"#) else { return value }
        var result = value
        let matches = expression.matches(in: value, range: NSRange(value.startIndex..., in: value))
        for match in matches.reversed() {
            guard let range = Range(match.range, in: result) else { continue }
            let matched = String(result[range])
            let punctuation = matched.range(of: #"[).,;!\]}]+$"#, options: .regularExpression).map { String(matched[$0]) } ?? ""
            let address = String(matched.dropLast(punctuation.count))
            var replacement = "[redacted URL]"
            if var components = URLComponents(string: address) {
                components.user = nil
                components.password = nil
                components.query = nil
                components.fragment = nil
                replacement = components.string ?? replacement
            }
            result.replaceSubrange(range, with: replacement + punctuation)
        }
        return result
    }
}

struct WorkLogRevision: Decodable, Identifiable {
    let revision: Int
    let folderPath: String?
    let lastSavedAt: String?

    var id: Int { revision }

    func label(currentRevision: Int) -> String {
        "\(revision == currentRevision ? "Current" : "Archived") revision \(revision) — \(folderPath ?? "No folder selected")"
    }
}

struct WorkLogRevisions: Decodable {
    let revisions: [WorkLogRevision]

    func includingCurrent(_ chat: ChatFolder) -> [WorkLogRevision] {
        guard !revisions.contains(where: { $0.revision == chat.revision }) else { return revisions }
        return [WorkLogRevision(revision: chat.revision, folderPath: chat.folderPath, lastSavedAt: chat.recovery?.lastSavedAt)] + revisions
    }
}

struct WorkLogClearResponse: Decodable {
    let removed: Int
}

enum WorkLogDate {
    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

struct TunnelStatus: Decodable {
    let enabled: Bool
    let connected: Bool
    let provider: String?
    let tunnelId: String?
    let publicEndpoint: String?
    let state: String
    let accessConfigured: Bool
    let error: String?
}

struct APIErrorResponse: Decodable {
    let error: String?
    let message: String?

    static func explanation(data: Data, statusCode: Int) -> String {
        if let response = try? JSONDecoder().decode(Self.self, from: data) {
            if let message = response.message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
                return message
            }
            switch response.error {
            case "chat_busy":
                return "This chat is using its folder. Wait for its current tool to finish, then try again."
            case "revision_conflict":
                return "This chat’s folder changed. Review its current folder and try again."
            default:
                break
            }
        }
        return "Chat2Local returned an error (\(statusCode))."
    }
}
