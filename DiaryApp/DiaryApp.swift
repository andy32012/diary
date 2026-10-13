import SwiftUI
import SwiftData

@main
struct DiaryApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(for: Entry.self)
    }
}
