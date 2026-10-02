enum DaemonRecoveryPolicy {
    static func shouldLaunch(serviceHealthy: Bool, ownedProcessRunning: Bool, launchInFlight: Bool) -> Bool {
        !serviceHealthy && !ownedProcessRunning && !launchInFlight
    }

    static func shouldReportTermination(isCurrentProcess: Bool, stopping: Bool) -> Bool {
        isCurrentProcess && !stopping
    }
}
