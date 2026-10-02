import AppKit
import SwiftUI

struct LocalDevView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Chat folders").font(.largeTitle.weight(.semibold))
                    Text("Ask a chat to use Chat2Local, match its code here, and choose a folder. Several chats can use the same folder.")
                        .font(.body).foregroundStyle(.secondary)
                }
                ConnectionView(model: model)
                if let error = model.connectionError {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Chat2Local is offline. \(model.daemonError ?? error)", systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.orange)
                        if model.canRestartLocalDevService || model.daemonLaunchInFlight {
                            HStack {
                                Button("Restart Chat2Local service") {
                                    Task { await model.restartLocalDevService() }
                                }
                                .buttonStyle(.bordered)
                                .disabled(!model.canRestartLocalDevService)
                                if model.daemonLaunchInFlight { ProgressView().controlSize(.small) }
                            }
                        }
                    }
                }
                if model.chats.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("No chats yet", systemImage: "bubble.left.and.bubble.right")
                            .font(.headline)
                        Text("A chat appears after it uses a Chat2Local tool. The chat’s reply will include a code so you can find it here.")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(22).localDevCard()
                } else {
                    LazyVStack(spacing: 14) {
                        ForEach(model.chats) { chat in
                            ChatFolderView(model: model, chat: chat)
                        }
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await model.refresh() } } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(model.refreshing)
                .keyboardShortcut("r", modifiers: .command)
            }
        }
        .frame(minWidth: 620, minHeight: 420)
    }
}

private struct ConnectionView: View {
    @ObservedObject var model: AppModel

    private var tunnel: TunnelStatus? { model.snapshot?.tunnel }
    private var connected: Bool { tunnel?.connected == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "link")
                    .foregroundStyle(connected ? Color.green : Color.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text("ChatGPT connection").font(.headline)
                    Text(connected ? "Connected to this Mac" : tunnel?.state == "starting" ? "Connecting…" : "Connect to use this Mac’s local tools and skills.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if model.tunnelActionInFlight {
                    ProgressView().controlSize(.small)
                } else {
                    Button(connected ? "Disconnect ChatGPT" : "Connect ChatGPT") {
                        Task {
                            if connected { await model.disconnectChatGPT() }
                            else { await model.connectChatGPT() }
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.connectionError != nil || model.snapshot == nil || tunnel?.state == "starting")
                }
            }
            if let error = model.tunnelActionError ?? tunnel?.error {
                Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
            }
            ConnectionSettingsView(model: model)
        }
        .padding(18).localDevCard()
    }
}

private struct ConnectionSettingsView: View {
    @ObservedObject var model: AppModel
    @State private var expanded = false
    @State private var tunnelId = ""
    @State private var runtimeKey = ""
    @State private var clientPath: String?

    var body: some View {
        DisclosureGroup("Connection settings", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 13) {
                Text("Enter the tunnel ID and runtime key for your ChatGPT connection.")
                    .font(.callout).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Tunnel ID").font(.caption.weight(.medium))
                    TextField("tunnel_…", text: $tunnelId)
                        .textFieldStyle(.roundedBorder)
                        .font(.callout.monospaced())
                        .accessibilityLabel("Tunnel ID")
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text("Runtime key").font(.caption.weight(.medium))
                    SecureField("Enter runtime key", text: $runtimeKey)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Runtime key")
                    Text("Stored securely in macOS Keychain. Enter the key again to change settings.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text("Tunnel client (optional)").font(.caption.weight(.medium))
                    if let path = clientPath {
                        Text(path).font(.caption.monospaced()).textSelection(.enabled)
                    } else {
                        Text("Use the installed tunnel-client.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("Choose executable…", action: chooseExecutable)
                        if clientPath != nil {
                            Button("Use installed client") { clientPath = nil }
                        }
                    }.buttonStyle(.bordered)
                }
                HStack {
                    Button("Save settings") { save(connect: false) }
                        .buttonStyle(.bordered)
                    Button("Save and connect") { save(connect: true) }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.connectionError != nil || model.snapshot == nil)
                }
                if let error = model.tunnelSettingsError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
                if let status = model.tunnelSettingsStatus {
                    Text(status).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.top, 12)
            .disabled(model.tunnelActionInFlight)
        }
        .font(.callout)
        .onAppear {
            if tunnelId.isEmpty { tunnelId = model.snapshot?.tunnel.tunnelId ?? "" }
            clientPath = model.savedTunnelClientPath
        }
        .onChange(of: model.snapshot?.tunnel.tunnelId) { _, value in
            if tunnelId.isEmpty { tunnelId = value ?? "" }
        }
    }

    private func chooseExecutable() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = true
        panel.prompt = "Use executable"
        panel.message = "Choose the tunnel-client executable for this connection."
        if panel.runModal() == .OK { clientPath = panel.url?.path }
    }

    private func save(connect: Bool) {
        Task {
            if await model.saveTunnelSettings(tunnelId: tunnelId, runtimeKey: runtimeKey, clientPath: clientPath, connect: connect) {
                runtimeKey = ""
            }
        }
    }
}

private struct ChatFolderView: View {
    @ObservedObject var model: AppModel
    let chat: ChatFolder
    @State private var showingWorkLog = false

    private var busy: Bool { model.updatingChatIDs.contains(chat.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(chat.displayName).font(.headline).lineLimit(2)
                    Text("Code: \(chat.setupCode)")
                        .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer(minLength: 20)
                if busy { ProgressView().controlSize(.small) }
                else {
                    Text(chat.folderPath == nil ? "Choose a folder" : "Folder connected")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(chat.folderPath == nil ? Color.secondary : Color.green)
                }
            }
            if let path = chat.folderPath {
                Label {
                    Text(path).font(.callout.monospaced()).textSelection(.enabled)
                } icon: {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                }
                Text("This chat can use local tools and skills in this folder.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Choose the folder this chat can work in.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                if chat.recovery?.reviewRequired == true {
                    Button { showingWorkLog = true } label: {
                        Label("Review interrupted work", systemImage: "exclamationmark.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.orange)
                    .disabled(model.connectionError != nil)
                } else if let date = chat.recovery?.lastSavedDate {
                    Label {
                        Text("Last saved \(date, style: .relative) ago")
                    } icon: {
                        Image(systemName: "checkmark.circle")
                    }
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Button("View work log") { showingWorkLog = true }
                    .buttonStyle(.bordered)
                    .disabled(model.connectionError != nil)
            }
            .font(.caption)
            HStack(spacing: 10) {
                Button(chat.folderPath == nil ? "Choose folder" : "Change folder") {
                    model.chooseFolder(for: chat)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || model.connectionError != nil)
                if chat.folderPath != nil {
                    Button("Disconnect folder") {
                        Task { await model.disconnectFolder(for: chat) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy || model.connectionError != nil)
                }
                Spacer()
                if let date = contactDate {
                    Text("Last contact \(date, style: .relative) ago")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = model.chatErrors[chat.id] {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .localDevCard()
        .sheet(isPresented: $showingWorkLog) {
            WorkLogView(model: model, chat: chat)
        }
    }

    private var contactDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: chat.lastSeenAt) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: chat.lastSeenAt)
    }
}

private struct WorkLogView: View {
    @ObservedObject var model: AppModel
    let chat: ChatFolder
    @Environment(\.dismiss) private var dismiss
    @State private var selectedRevision: Int
    @State private var showingClearConfirmation = false
    @State private var revisionToClear: Int?
    @State private var copied = false

    init(model: AppModel, chat: ChatFolder) {
        self.model = model
        self.chat = chat
        _selectedRevision = State(initialValue: chat.revision)
    }

    private var page: WorkLogPage? {
        guard let page = model.workLogPages[chat.id], page.revision == selectedRevision else { return nil }
        return page
    }
    private var currentChat: ChatFolder { model.chats.first { $0.id == chat.id } ?? chat }
    private var currentRevision: Int { currentChat.revision }
    private var busy: Bool {
        model.loadingWorkLogIDs.contains(chat.id) || model.clearingWorkLogIDs.contains(chat.id)
    }
    private var revisions: [WorkLogRevision] {
        WorkLogRevisions(revisions: model.workLogRevisions[chat.id] ?? []).includingCurrent(currentChat)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Work log").font(.title2.weight(.semibold))
                    Text(chat.displayName).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Picker("Folder history", selection: $selectedRevision) {
                ForEach(revisions) { revision in
                    Text(revision.label(currentRevision: currentRevision)).tag(revision.revision)
                }
            }
            .disabled(busy)
            if selectedRevision != currentRevision {
                Label("Archived folder history. Choose a folder manually before using this context in another chat.", systemImage: "archivebox")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error = model.workLogErrors[chat.id] {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let page {
                        WorkCheckpointView(page: page)
                        Divider()
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Recorded actions").font(.headline)
                            Text("Execution records describe local work. They do not confirm that a chat received a result.")
                                .font(.caption).foregroundStyle(.secondary)
                            if page.events.isEmpty {
                                Text("No recorded actions for this folder revision.")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                            ForEach(page.events) { event in
                                WorkLogEventView(event: event)
                            }
                            if let before = page.nextBeforeSequence {
                                Button("Load older actions") {
                                    Task { await model.loadWorkLog(for: chat, revision: selectedRevision, beforeSequence: before) }
                                }
                                .disabled(busy)
                            }
                        }
                    }
                    if busy {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(model.clearingWorkLogIDs.contains(chat.id) ? "Clearing completed history…" : "Loading work log…")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            }
            Divider()
            HStack(spacing: 10) {
                Button("Copy recovery summary") {
                    guard let page else { return }
                    NSPasteboard.general.clearContents()
                    copied = NSPasteboard.general.setString(page.recoveryText(chatName: chat.displayName, currentRevision: currentRevision), forType: .string)
                }
                .buttonStyle(.borderedProminent)
                .disabled(page == nil || busy)
                if copied { Text("Copied").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Reload") { reload() }.disabled(busy)
                Button("Clear completed history", role: .destructive) {
                    revisionToClear = selectedRevision
                    showingClearConfirmation = true
                }
                .disabled(page == nil || busy)
            }
        }
        .padding(24)
        .frame(width: 760, height: 600)
        .task { await model.loadWorkLog(for: chat, revision: selectedRevision, refreshRevisions: true) }
        .onChange(of: selectedRevision) { _, revision in
            copied = false
            Task { await model.loadWorkLog(for: chat, revision: revision) }
        }
        .confirmationDialog("Clear completed history for folder revision \(revisionToClear ?? selectedRevision)?", isPresented: $showingClearConfirmation, titleVisibility: .visible) {
            Button("Clear completed history", role: .destructive) {
                guard let revision = revisionToClear else { return }
                copied = false
                Task { await model.clearCompletedWorkLog(for: chat, revision: revision) }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Pending actions, actions requiring review, and the saved checkpoint will be kept.")
        }
    }

    private func reload() {
        copied = false
        Task { await model.loadWorkLog(for: chat, revision: selectedRevision, refreshRevisions: true) }
    }
}

private struct WorkCheckpointView: View {
    let page: WorkLogPage

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Last checkpoint").font(.headline)
                Spacer()
                if let date = page.checkpoint?.savedDate {
                    Text(date, format: .dateTime.month().day().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if page.summary.reviewRequired {
                Label("Review interrupted work before repeating an action. Some actions may already have taken effect.", systemImage: "exclamationmark.circle")
                    .font(.callout).foregroundStyle(.orange)
            }
            if page.summary.activeOperations > 0 {
                Text("\(page.summary.activeOperations) action(s) are still in progress.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if page.summary.unresolvedOperations > 0 {
                Text("Failed or uncertain actions: \(page.summary.unresolvedOperations)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let checkpoint = page.checkpoint {
                Text(checkpoint.goal).font(.callout).textSelection(.enabled)
                if page.checkpointNeedsReview {
                    Text("This checkpoint is older than later recorded work. Review the actions below before continuing.")
                        .font(.caption).foregroundStyle(.orange)
                }
                checkpointList("Completed", items: checkpoint.completed)
                checkpointList("Verification", items: checkpoint.verification)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Next step").font(.caption.weight(.semibold))
                    Text(checkpoint.nextStep).font(.callout).textSelection(.enabled)
                }
            } else {
                Text("No checkpoint saved for this folder revision.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func checkpointList(_ title: String, items: [String]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.caption.weight(.semibold))
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Text("• \(item)").font(.callout).textSelection(.enabled)
                }
            }
        }
    }
}

private struct WorkLogEventView: View {
    let event: WorkLogEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(event.tool).font(.callout.weight(.medium))
                Spacer()
                Text(event.status.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(event.unresolved ? Color.orange : Color.secondary)
            }
            if let date = event.startedDate {
                Text(date, format: .dateTime.month().day().hour().minute().second())
                    .font(.caption).foregroundStyle(.secondary)
            }
            if event.requiresReview {
                Text("Review required. This action may already have changed files or other state.")
                    .font(.caption).foregroundStyle(.orange)
            }
            if !event.details.isEmpty {
                DisclosureGroup("Details") {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(event.details) { detail in
                            HStack(alignment: .top, spacing: 8) {
                                Text("\(detail.label):").foregroundStyle(.secondary)
                                Text(detail.value).textSelection(.enabled)
                            }
                        }
                    }
                    .padding(.top, 4)
                }
                .font(.caption)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .localDevCard()
    }
}

struct LocalDevMenu: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack {
                Text("Chat2Local").font(.headline)
                Spacer()
                Circle().fill(model.connectionError == nil && model.snapshot != nil ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                Text(model.connectionError != nil ? "Offline" : model.snapshot == nil ? "Starting" : "Ready")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text("\(model.connectedChatCount) of \(model.chats.count) chats have a folder")
                .font(.callout).foregroundStyle(.secondary)
            Button("Choose chat folders") {
                openWindow(id: "local-dev")
                dismiss()
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity)
            HStack {
                Button("Refresh") { Task { await model.refresh() } }
                    .disabled(model.refreshing)
                Spacer()
                Button("Quit") {
                    model.stop()
                    NSApplication.shared.terminate(nil)
                }
            }.font(.caption)
        }.padding(16).frame(width: 300)
    }
}

private extension View {
    func localDevCard() -> some View {
        background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.07), lineWidth: 1))
    }
}
