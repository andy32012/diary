import SwiftUI

struct RootView: View {
    @State private var showSplash = true

    var body: some View {
        ZStack {
            TabView {
                DiaryListView()
                    .tabItem { Label("日記", systemImage: "book.fill") }
                CalendarView()
                    .tabItem { Label("月曆", systemImage: "calendar") }
            }
            .tint(Theme.pink)

            if showSplash {
                SplashView()
                    .transition(.asymmetric(insertion: .identity,
                                            removal: .scale(scale: 1.3).combined(with: .opacity)))
                    .zIndex(1)
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(.easeInOut(duration: 0.5)) { showSplash = false }
        }
    }
}
