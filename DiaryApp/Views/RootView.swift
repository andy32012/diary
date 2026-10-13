import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            TimelineView()
                .tabItem { Label("日記", systemImage: "book") }
            CalendarView()
                .tabItem { Label("月曆", systemImage: "calendar") }
        }
    }
}
