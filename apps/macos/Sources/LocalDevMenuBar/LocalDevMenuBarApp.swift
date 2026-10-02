import AppKit
import SwiftUI

@MainActor
final class LocalDevAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppModel.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppModel.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

@main
@MainActor
struct LocalDevMenuBarApp: App {
    @NSApplicationDelegateAdaptor(LocalDevAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            LocalDevMenu(model: model)
        } label: {
            Image(systemName: "folder")
                .accessibilityLabel("Chat2Local chat folders")
        }
        .menuBarExtraStyle(.window)

        Window("Chat2Local", id: "local-dev") {
            LocalDevView(model: model)
        }
        .defaultSize(width: 780, height: 620)
        .windowResizability(.contentMinSize)
    }
}
