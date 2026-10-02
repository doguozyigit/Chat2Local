import Foundation

@main
struct ChatFolderModelsCheck {
    static func main() throws {
        let payload = #"""
        {
          "version": "0.3.0", "startedAt": "2026-10-01T12:00:00Z",
          "apiUrl": "http://127.0.0.1:43127", "mcpUrl": "http://127.0.0.1:43127/mcp",
          "chats": [
            { "id": "one", "title": null, "setupCode": "ABCD", "folderPath": "/tmp/shared", "revision": 1, "createdAt": "2026-10-01T12:00:00Z", "lastSeenAt": "2026-10-01T12:01:00.000Z" },
            { "id": "two", "title": "Second chat", "setupCode": "EFGH", "folderPath": "/tmp/shared", "revision": 3, "createdAt": "2026-10-01T12:00:00Z", "lastSeenAt": "2026-10-01T12:01:00Z", "recovery": { "lastSavedAt": "2026-10-01T12:00:45Z", "checkpointStatus": "in_progress", "activeOperations": 0, "unresolvedOperations": 1, "reviewRequired": true, "latestSequence": 4 } },
            { "id": "three", "title": " ", "setupCode": "IJKL", "folderPath": null, "revision": 0, "createdAt": "2026-10-01T12:00:00Z", "lastSeenAt": "2026-10-01T12:01:00Z" }
          ],
          "tunnel": { "enabled": false, "connected": false, "provider": "openai", "tunnelId": null, "publicEndpoint": null, "state": "off", "accessConfigured": false, "error": null }
        }
        """#
        let status = try JSONDecoder().decode(StatusSnapshot.self, from: Data(payload.utf8))
        precondition(status.chats.count == 3)
        precondition(status.chats[0].displayName == "Chat ABCD")
        precondition(status.chats[1].displayName == "Second chat")
        precondition(status.chats[2].displayName == "Chat IJKL")
        precondition(status.chats[0].folderPath == status.chats[1].folderPath)
        precondition(status.chats[1].revision == 3)
        precondition(status.chats[2].folderPath == nil)
        precondition(status.chats[0].recovery == nil, "Older service status remains readable")
        precondition(status.chats[1].recovery?.reviewRequired == true)
        precondition(status.chats[1].recovery?.latestSequence == 4)
        precondition(status.chats[1].recovery?.lastSavedDate != nil)
        let busy = Data(#"{"error":"chat_busy","message":"Wait for the current tool to finish."}"#.utf8)
        precondition(APIErrorResponse.explanation(data: busy, statusCode: 409) == "Wait for the current tool to finish.")
        let changed = Data(#"{"error":"revision_conflict","message":"The folder selection changed."}"#.utf8)
        precondition(APIErrorResponse.explanation(data: changed, statusCode: 409) == "The folder selection changed.")
        let missingMessage = Data(#"{"error":"chat_busy"}"#.utf8)
        precondition(APIErrorResponse.explanation(data: missingMessage, statusCode: 409).contains("current tool"))
        precondition(APIErrorResponse.explanation(data: Data(), statusCode: 500) == "Chat2Local returned an error (500).")
        print("Chat folder model checks passed")
    }
}
