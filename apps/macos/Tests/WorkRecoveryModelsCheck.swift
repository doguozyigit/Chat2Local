import Foundation

@main
struct WorkRecoveryModelsCheck {
    static func main() throws {
        let payload = #"""
        {
          "revision": 2, "folderPath": "/tmp/earlier-project",
          "checkpoint": { "goal": "Finish the document", "completed": ["Draft saved"], "verification": ["Read the draft"], "nextStep": "Review the headings", "status": "in_progress", "savedAt": "2026-10-01T12:00:00.000Z", "sequence": 3 },
          "summary": { "lastSavedAt": "2026-10-01T12:00:02Z", "checkpointStatus": "in_progress", "activeOperations": 0, "unresolvedOperations": 1, "reviewRequired": true, "latestSequence": 6 },
          "events": [
            { "id": "uncertain", "sequence": 6, "revision": 2, "tool": "run_command", "startedAt": "2026-10-01T12:00:01Z", "endedAt": null, "status": "outcome_unknown", "mayHaveSideEffects": true, "metadata": { "cwd": "/tmp/earlier-project", "stagePath": ".local-dev-save-fixture.tmp", "stagePhase": "stageCreated", "stageDevice": "fixture-device", "stageInode": "fixture-inode", "kind": "command", "count": 2, "privatePayload": "fixture-secret", "optional": null }, "result": null, "reviewedAt": null },
            { "id": "saved", "sequence": 4, "revision": 2, "tool": "write_file", "startedAt": "2026-10-01T12:00:00Z", "endedAt": "2026-10-01T12:00:02Z", "status": "execution_recorded", "mayHaveSideEffects": true, "metadata": { "bytes": 42, "created": true }, "result": { "success": true, "bytes": 42, "truncated": false, "rawText": "fixture-secret" }, "reviewedAt": null }
          ],
          "nextBeforeSequence": 4
        }
        """#
        let page = try JSONDecoder().decode(WorkLogPage.self, from: Data(payload.utf8))
        precondition(page.revision == 2)
        precondition(page.checkpoint?.savedDate != nil)
        precondition(page.events[0].status == .outcomeUnknown)
        precondition(page.events[0].requiresReview)
        precondition(!page.events[1].requiresReview)
        precondition(page.events[0].details.map(\.value) == ["/tmp/earlier-project", ".local-dev-save-fixture.tmp", "stageCreated"])
        precondition(page.events[1].details.map(\.value) == ["42", "No"])
        precondition(page.nextBeforeSequence == 4)
        precondition(page.checkpointNeedsReview)

        let summary = page.recoveryText(chatName: "Document chat", currentRevision: 4)
        precondition(summary.contains("Archived folder revision 2"))
        precondition(summary.contains("/tmp/earlier-project"))
        precondition(summary.contains("Current folder revision: 4"))
        precondition(summary.contains("Choose a folder manually"))
        precondition(summary.contains("Finish the document"))
        precondition(summary.contains("Review the headings"))
        precondition(summary.contains("Outcome unknown"))
        precondition(summary.contains("older than later recorded work"))
        precondition(!summary.contains("fixture-secret"), "Copied recovery text excludes event payloads")
        precondition(summary.contains("More history is available"))
        precondition(summary.contains("Staging path: .local-dev-save-fixture.tmp"))
        precondition(summary.contains("Save phase: stageCreated"))
        precondition(!summary.contains("fixture-device") && !summary.contains("fixture-inode"), "Copied staging context omits low-level file identity")

        let currentText = page.recoveryText(chatName: "Document chat", currentRevision: 2)
        precondition(currentText.contains("Current folder revision 2"))
        precondition(!currentText.contains("Archived folder revision"))

        let apiKey = "sk-" + "proj-" + String(repeating: "a", count: 24)
        let gitHubKey = "gh" + "p_" + String(repeating: "b", count: 24)
        let jwt = "ey" + "Jheader.payload.signature"
        let privateKey = "-----BEGIN " + "PRIVATE KEY-----\nfixture-private-key\n-----END PRIVATE KEY-----"
        let sensitive = WorkLogPage(revision: 2, folderPath: "/tmp/password=fixture-path-secret",
            checkpoint: WorkCheckpoint(goal: #"{"token":"fixture-json-secret"} https://owner:fixture-url-secret@example.test/project?token=fixture-query-secret#fragment"#,
                completed: [privateKey], verification: ["Bearer fixture-bearer-secret", apiKey, gitHubKey, jwt],
                nextStep: "api_key = 'fixture spaced secret'", status: "in_progress", savedAt: "2026-10-01T12:00:00Z", sequence: 3),
            summary: page.summary, events: [], nextBeforeSequence: nil)
        let safeCopy = sensitive.recoveryText(chatName: "password=fixture-title-secret", currentRevision: 2)
        for secret in ["fixture-title-secret", "fixture-path-secret", "fixture-json-secret", "fixture-url-secret", "fixture-query-secret", "fixture-bearer-secret", "fixture spaced secret", "fixture-private-key", apiKey, gitHubKey, jwt] {
            precondition(!safeCopy.contains(secret), "Recovery copy must redact common sensitive patterns from the final text")
        }
        precondition(safeCopy.contains("https://example.test/project"), "URL redaction keeps useful noncredential context")
        precondition(safeCopy.contains("[redacted]"))

        let older = try JSONDecoder().decode(WorkLogPage.self, from: Data(#"{"revision":2,"folderPath":"/tmp/earlier-project","checkpoint":null,"summary":{"lastSavedAt":null,"checkpointStatus":null,"activeOperations":0,"unresolvedOperations":0,"reviewRequired":false,"latestSequence":6},"events":[{"id":"saved","sequence":4,"revision":2,"tool":"write_file","startedAt":"2026-10-01T12:00:00Z","endedAt":"2026-10-01T12:00:02Z","status":"execution_recorded","mayHaveSideEffects":true,"metadata":{},"result":null,"reviewedAt":null},{"id":"old","sequence":1,"revision":2,"tool":"read_file","startedAt":"2026-10-01T11:00:00Z","endedAt":"2026-10-01T11:00:01Z","status":"execution_error","mayHaveSideEffects":false,"metadata":{},"result":null,"reviewedAt":null}],"nextBeforeSequence":null}"#.utf8))
        let combined = page.appending(older)
        precondition(combined.events.map(\.id) == ["uncertain", "saved", "old"], "Pagination keeps newest order without duplicates")
        precondition(combined.checkpoint?.goal == "Finish the document")
        precondition(combined.summary.reviewRequired)
        precondition(combined.nextBeforeSequence == nil)
        precondition(older.events[1].unresolved)
        precondition(!older.events[1].requiresReview, "Read errors are unresolved without a side-effect warning")
        let failedWrite = WorkLogEvent(id: "failed", sequence: 7, revision: 2, tool: "write_file", startedAt: "2026-10-01T12:00:00Z", endedAt: nil, status: .executionError, mayHaveSideEffects: true, metadata: [:], result: nil, reviewedAt: nil)
        precondition(failedWrite.requiresReview, "Failed actions with possible side effects need review")
        let pending = WorkLogEvent(id: "pending", sequence: 8, revision: 2, tool: "run_command", startedAt: "2026-10-01T12:00:00Z", endedAt: nil, status: .started, mayHaveSideEffects: true, metadata: [:], result: nil, reviewedAt: nil)
        precondition(!pending.unresolved && !pending.requiresReview, "Active actions are distinct from settled uncertain actions")

        let revisions = try JSONDecoder().decode(WorkLogRevisions.self, from: Data(#"{"revisions":[{"revision":2,"folderPath":"/tmp/earlier-project","lastSavedAt":"2026-10-01T12:00:02Z"},{"revision":4,"folderPath":null,"lastSavedAt":null}]}"#.utf8))
        precondition(revisions.revisions[0].label(currentRevision: 4).contains("Archived"))
        precondition(revisions.revisions[1].label(currentRevision: 4).contains("Current"))
        let disconnected = try JSONDecoder().decode(ChatFolder.self, from: Data(#"{"id":"chat","title":null,"setupCode":"TEST","folderPath":null,"revision":4,"createdAt":"2026-10-01T12:00:00Z","lastSeenAt":"2026-10-01T12:00:00Z"}"#.utf8))
        let archivedOnly = WorkLogRevisions(revisions: [revisions.revisions[0]])
        let withCurrent = archivedOnly.includingCurrent(disconnected)
        precondition(withCurrent[0].revision == 4 && withCurrent[0].folderPath == nil, "A disconnected current folder must not inherit an archived path")
        precondition(revisions.includingCurrent(disconnected).count == 2, "The picker must not duplicate a current revision")
        let cleared = try JSONDecoder().decode(WorkLogClearResponse.self, from: Data(#"{"removed":2}"#.utf8))
        precondition(cleared.removed == 2)
        print("Work recovery model checks passed")
    }
}
