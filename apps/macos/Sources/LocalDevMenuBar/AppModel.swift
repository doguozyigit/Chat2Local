import AppKit
import Combine
import Foundation
import LocalDevApiAuth

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published private(set) var snapshot: StatusSnapshot?
    @Published private(set) var connectionError: String?
    @Published private(set) var refreshing = false
    @Published private(set) var updatingChatIDs: Set<String> = []
    @Published private(set) var chatErrors: [String: String] = [:]
    @Published private(set) var tunnelActionInFlight = false
    @Published private(set) var tunnelActionError: String?
    @Published private(set) var tunnelSettingsError: String?
    @Published private(set) var tunnelSettingsStatus: String?
    @Published private(set) var savedTunnelClientPath: String?
    @Published private(set) var workLogPages: [String: WorkLogPage] = [:]
    @Published private(set) var workLogRevisions: [String: [WorkLogRevision]] = [:]
    @Published private(set) var workLogErrors: [String: String] = [:]
    @Published private(set) var loadingWorkLogIDs: Set<String> = []
    @Published private(set) var clearingWorkLogIDs: Set<String> = []
    @Published private(set) var daemonLaunchInFlight = false
    @Published private(set) var daemonError: String?

    // Match the bundled service's explicitly configured local port.
    private static let apiBaseURL = "http://127.0.0.1:\(LocalDevApiAuth.configuredPort)"
    private static let tunnelEnabledKey = "LocalDevOpenAITunnelAdopted"
    private static let manualTunnelSettingsKey = "LocalDevManualTunnelSettingsSaved"
    private static let tunnelClientPathKey = "LocalDevTunnelClientPath"
    private var refreshTask: Task<Void, Never>?
    private var daemonProcess: Process?
    private var tunnelCredentials: LegacyTunnelCredentials?
    private var tunnelFailures = 0
    private var tunnelRetryAt: Date?
    private var workLogLoadTokens: [String: UUID] = [:]
    private var serviceGeneration = 0
    private var stopping = false

    var chats: [ChatFolder] { snapshot?.chats ?? [] }
    var connectedChatCount: Int { chats.filter { $0.folderPath != nil }.count }
    var canRestartLocalDevService: Bool {
        !stopping && bundledDaemonAvailable && DaemonRecoveryPolicy.shouldLaunch(
            serviceHealthy: snapshot != nil && connectionError == nil,
            ownedProcessRunning: daemonProcess?.isRunning == true,
            launchInFlight: daemonLaunchInFlight
        )
    }

    init() {
        savedTunnelClientPath = UserDefaults.standard.string(forKey: Self.tunnelClientPathKey)
    }

    func start() {
        guard refreshTask == nil else { return }
        stopping = false
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            if !Task.isCancelled && self.connectionError != nil {
                await self.restartLocalDevService()
            }
            while !Task.isCancelled {
                await self.refresh()
                await self.reconnectTunnelIfNeeded()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        stopping = true
        serviceGeneration += 1
        refreshTask?.cancel()
        refreshTask = nil
        daemonProcess?.terminationHandler = nil
        if let daemonProcess, daemonProcess.isRunning {
            daemonProcess.terminate()
        }
        daemonProcess = nil
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let data = try await request(path: "/v1/status", timeout: 3)
            snapshot = try JSONDecoder().decode(StatusSnapshot.self, from: data)
            connectionError = nil
            daemonError = nil
        } catch {
            connectionError = error.localizedDescription
        }
    }

    func loadWorkLog(for chat: ChatFolder, revision: Int, beforeSequence: Int? = nil, refreshRevisions: Bool = false) async {
        guard !clearingWorkLogIDs.contains(chat.id) else { return }
        let token = UUID()
        workLogLoadTokens[chat.id] = token
        loadingWorkLogIDs.insert(chat.id)
        workLogErrors[chat.id] = nil
        if beforeSequence == nil { workLogPages[chat.id] = nil }
        defer {
            if workLogLoadTokens[chat.id] == token {
                loadingWorkLogIDs.remove(chat.id)
                workLogLoadTokens[chat.id] = nil
            }
        }
        do {
            let basePath = workLogPath(for: chat)
            if refreshRevisions {
                let data = try await request(path: basePath + "/revisions", timeout: 10)
                let revisions = try JSONDecoder().decode(WorkLogRevisions.self, from: data)
                guard workLogLoadTokens[chat.id] == token, !Task.isCancelled else { return }
                workLogRevisions[chat.id] = revisions.revisions
            }
            var query = "?revision=\(revision)&limit=50"
            if let beforeSequence { query += "&beforeSequence=\(beforeSequence)" }
            let data = try await request(path: basePath + query, timeout: 10)
            let page = try JSONDecoder().decode(WorkLogPage.self, from: data)
            guard page.revision == revision else {
                throw LocalDevClientError.server("The work log’s folder revision changed. Reload the history and try again.")
            }
            guard workLogLoadTokens[chat.id] == token, !Task.isCancelled else { return }
            if beforeSequence != nil, let existing = workLogPages[chat.id] {
                workLogPages[chat.id] = existing.appending(page)
            } else {
                workLogPages[chat.id] = page
            }
        } catch {
            guard workLogLoadTokens[chat.id] == token, !Task.isCancelled else { return }
            workLogErrors[chat.id] = error.localizedDescription
        }
    }

    func clearCompletedWorkLog(for chat: ChatFolder, revision: Int) async {
        guard !loadingWorkLogIDs.contains(chat.id), !clearingWorkLogIDs.contains(chat.id) else { return }
        clearingWorkLogIDs.insert(chat.id)
        workLogErrors[chat.id] = nil
        do {
            let expectedRevision = chats.first { $0.id == chat.id }?.revision ?? chat.revision
            let data = try await request(
                path: workLogPath(for: chat) + "/clear", method: "POST",
                body: ["revision": revision, "expectedRevision": expectedRevision], timeout: 10
            )
            _ = try JSONDecoder().decode(WorkLogClearResponse.self, from: data)
            clearingWorkLogIDs.remove(chat.id)
            await loadWorkLog(for: chat, revision: revision, refreshRevisions: true)
            await refresh()
        } catch {
            clearingWorkLogIDs.remove(chat.id)
            workLogErrors[chat.id] = error.localizedDescription
        }
    }

    private func workLogPath(for chat: ChatFolder) -> String {
        let identifier = chat.id.addingPercentEncoding(withAllowedCharacters:
            CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))!
        return "/v1/chats/\(identifier)/work-log"
    }

    func restartLocalDevService() async {
        guard canRestartLocalDevService else { return }
        daemonLaunchInFlight = true
        let generation = serviceGeneration
        defer { daemonLaunchInFlight = false }
        // Check the service again after the click, so an external service that
        // became healthy since the last poll is never replaced or duplicated.
        do {
            let data = try await request(path: "/v1/status", timeout: 3)
            let status = try JSONDecoder().decode(StatusSnapshot.self, from: data)
            guard serviceGeneration == generation, !stopping, !Task.isCancelled else { return }
            snapshot = status
            connectionError = nil
            daemonError = nil
            return
        } catch {
            guard serviceGeneration == generation, !stopping, !Task.isCancelled else { return }
            connectionError = error.localizedDescription
        }
        guard DaemonRecoveryPolicy.shouldLaunch(serviceHealthy: false,
            ownedProcessRunning: daemonProcess?.isRunning == true, launchInFlight: false) else { return }
        // A termination callback can still be queued on the main actor.
        daemonProcess?.terminationHandler = nil
        daemonProcess = nil
        launchBundledDaemonIfAvailable()
        await refresh()
    }

    func chooseFolder(for chat: ChatFolder) {
        guard connectionError == nil, !updatingChatIDs.contains(chat.id) else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Use this folder"
        panel.message = "Choose the folder for \(chat.displayName)."
        if let path = chat.folderPath {
            panel.directoryURL = URL(fileURLWithPath: path, isDirectory: true)
        }
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        Task {
            await updateFolder(for: chat, path: folder.path)
        }
    }

    func disconnectFolder(for chat: ChatFolder) async {
        await updateFolder(for: chat, path: nil)
    }

    private func updateFolder(for chat: ChatFolder, path: String?) async {
        guard !updatingChatIDs.contains(chat.id) else { return }
        updatingChatIDs.insert(chat.id)
        chatErrors[chat.id] = nil
        defer { updatingChatIDs.remove(chat.id) }
        do {
            let identifier = chat.id.addingPercentEncoding(withAllowedCharacters:
                CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))!
            let route = path == nil ? "disconnect" : "folder"
            var body: [String: Any] = ["expectedRevision": chat.revision]
            if let path { body["folderPath"] = path }
            _ = try await request(
                path: "/v1/chats/\(identifier)/\(route)",
                method: path == nil ? "POST" : "PUT",
                body: body,
                timeout: 10
            )
            await refresh()
        } catch {
            chatErrors[chat.id] = error.localizedDescription
            await refresh()
        }
    }

    func connectChatGPT() async {
        guard !tunnelActionInFlight else { return }
        tunnelActionInFlight = true
        tunnelActionError = nil
        defer { tunnelActionInFlight = false }
        do {
            try await startTunnel()
            UserDefaults.standard.set(true, forKey: Self.tunnelEnabledKey)
            tunnelFailures = 0
            tunnelRetryAt = nil
            if tunnelSettingsStatus != nil { tunnelSettingsStatus = "Connection settings saved securely." }
            await refresh()
        } catch {
            tunnelActionError = error.localizedDescription
        }
    }

    func disconnectChatGPT() async {
        guard !tunnelActionInFlight else { return }
        tunnelActionInFlight = true
        tunnelActionError = nil
        defer { tunnelActionInFlight = false }
        do {
            _ = try await request(path: "/v1/tunnel/stop", method: "POST", timeout: 10)
            UserDefaults.standard.set(false, forKey: Self.tunnelEnabledKey)
            tunnelFailures = 0
            tunnelRetryAt = nil
            await refresh()
        } catch {
            tunnelActionError = error.localizedDescription
        }
    }

    /// Returns whether the private settings were saved, even if connecting fails.
    func saveTunnelSettings(tunnelId: String, runtimeKey: String, clientPath: String?, connect: Bool) async -> Bool {
        guard !tunnelActionInFlight else { return false }
        tunnelActionInFlight = true
        tunnelSettingsError = nil
        tunnelSettingsStatus = nil
        tunnelActionError = nil
        defer { tunnelActionInFlight = false }
        var saved = false
        do {
            let settings = try TunnelConnectionSettings.validate(tunnelId: tunnelId, runtimeKey: runtimeKey, clientPath: clientPath)
            try await Task.detached(priority: .utility) {
                try KeychainStore.saveManualTunnelConnection(StoredTunnelConnection(tunnelId: settings.tunnelId, runtimeKey: settings.runtimeKey))
            }.value
            UserDefaults.standard.set(settings.clientPath, forKey: Self.tunnelClientPathKey)
            UserDefaults.standard.set(true, forKey: Self.manualTunnelSettingsKey)
            savedTunnelClientPath = settings.clientPath
            tunnelCredentials = LegacyTunnelCredentials(tunnelId: settings.tunnelId, runtimeApiKey: settings.runtimeKey, clientPath: settings.clientPath, legacyTunnelRunning: false)
            saved = true
            tunnelSettingsStatus = snapshot?.tunnel.connected == true
                ? "Settings saved. Reconnect ChatGPT to use them."
                : "Settings saved. Connect ChatGPT when you’re ready."
            if connect {
                // Starting an already connected tunnel preserves its old process.
                // Stop first so this explicit action applies the saved settings.
                _ = try await request(path: "/v1/tunnel/stop", method: "POST", timeout: 10)
                try await startTunnel()
                UserDefaults.standard.set(true, forKey: Self.tunnelEnabledKey)
                tunnelFailures = 0
                tunnelRetryAt = nil
                tunnelSettingsStatus = "Connection settings saved securely."
                await refresh()
            }
        } catch {
            tunnelSettingsError = error.localizedDescription
        }
        return saved
    }

    private func reconnectTunnelIfNeeded() async {
        guard !tunnelActionInFlight, connectionError == nil,
              let tunnel = snapshot?.tunnel,
              TunnelReconnectPolicy.shouldReconnect(
                enabled: UserDefaults.standard.bool(forKey: Self.tunnelEnabledKey),
                state: tunnel.state,
                retryAt: tunnelRetryAt,
                now: Date()
              ) else { return }
        tunnelActionInFlight = true
        defer { tunnelActionInFlight = false }
        do {
            try await startTunnel()
            tunnelFailures = 0
            tunnelRetryAt = nil
            tunnelActionError = nil
            await refresh()
        } catch {
            tunnelFailures += 1
            tunnelRetryAt = Date().addingTimeInterval(TunnelReconnectPolicy.delay(afterFailure: tunnelFailures))
            tunnelActionError = error.localizedDescription
        }
    }

    private func startTunnel() async throws {
        let credentials = try await loadTunnelCredentials()
        var body: [String: Any] = [
            "tunnelId": credentials.tunnelId,
            "runtimeKey": credentials.runtimeApiKey,
            "adoptLegacy": credentials.legacyTunnelRunning,
        ]
        if let path = credentials.clientPath { body["clientPath"] = path }
        _ = try await request(path: "/v1/tunnel/start", method: "POST", body: body, timeout: 25)
    }

    private func loadTunnelCredentials() async throws -> LegacyTunnelCredentials {
        if let tunnelCredentials { return tunnelCredentials }
        let manualSettingsSaved = UserDefaults.standard.bool(forKey: Self.manualTunnelSettingsKey)
        let clientPath = savedTunnelClientPath
        let credentials = try await Task.detached(priority: .utility) {
            if manualSettingsSaved {
                guard let stored = try KeychainStore.loadManualTunnelConnection() else {
                    throw LocalDevClientError.server("The saved connection could not be loaded. Open Connection settings and save it again.")
                }
                let settings = try TunnelConnectionSettings.validate(tunnelId: stored.tunnelId, runtimeKey: stored.runtimeKey, clientPath: clientPath)
                return LegacyTunnelCredentials(tunnelId: settings.tunnelId, runtimeApiKey: settings.runtimeKey, clientPath: settings.clientPath, legacyTunnelRunning: false)
            }
            if let existing = try LegacyTunnelMigration.loadExistingCredentials() { return existing }
            if let id = try KeychainStore.loadTunnelId(),
               let key = try KeychainStore.loadTunnelRuntimeKey(),
               !id.isEmpty, !key.isEmpty {
                return LegacyTunnelCredentials(tunnelId: id, runtimeApiKey: key, clientPath: nil, legacyTunnelRunning: false)
            }
            throw LocalDevClientError.server("Set up this connection in Connection settings, then choose Save and connect.")
        }.value
        tunnelCredentials = credentials
        return credentials
    }

    private func request(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil,
        timeout: TimeInterval
    ) async throws -> Data {
        guard let url = URL(string: Self.apiBaseURL + path) else {
            throw LocalDevClientError.server("The Chat2Local address is invalid.")
        }
        var request = URLRequest(url: url)
        LocalDevApiAuth.authorize(&request)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw LocalDevClientError.server("Chat2Local returned an unreadable response.")
        }
        guard (200..<300).contains(response.statusCode) else {
            throw LocalDevClientError.server(APIErrorResponse.explanation(data: data, statusCode: response.statusCode))
        }
        return data
    }

    private func launchBundledDaemonIfAvailable() {
        guard daemonProcess == nil,
              let node = Bundle.main.url(forResource: "node", withExtension: nil),
              let daemon = Bundle.main.url(forResource: "local-devd", withExtension: "mjs") else { return }
        let process = Process()
        process.executableURL = node
        process.arguments = [daemon.path]
        var environment = ProcessInfo.processInfo.environment
        environment["LOCAL_DEV_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment["LOCAL_DEV_PORT"] = String(LocalDevApiAuth.configuredPort)
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] terminated in
            Task { @MainActor [weak self] in
                self?.handleDaemonTermination(terminated)
            }
        }
        daemonProcess = process
        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            if daemonProcess === process { daemonProcess = nil }
            connectionError = "Could not start Chat2Local: \(error.localizedDescription)"
            daemonError = connectionError
        }
    }

    private var bundledDaemonAvailable: Bool {
        Bundle.main.url(forResource: "node", withExtension: nil) != nil &&
        Bundle.main.url(forResource: "local-devd", withExtension: "mjs") != nil
    }

    private func handleDaemonTermination(_ process: Process) {
        guard DaemonRecoveryPolicy.shouldReportTermination(isCurrentProcess: daemonProcess === process, stopping: stopping) else { return }
        daemonProcess = nil
        daemonError = "The Chat2Local service stopped unexpectedly. Restart it to review saved work and interrupted actions."
        connectionError = daemonError
    }
}

enum LocalDevClientError: LocalizedError {
    case server(String)

    var errorDescription: String? {
        switch self {
        case .server(let message): message
        }
    }
}
