import SwiftUI
import SwiftData

@main
struct DiaryApp: App {
    @State private var showSplash = true

    var body: some Scene {
        WindowGroup {
            ZStack {
                ContentView()
                if showSplash {
                    SplashView()
                        .transition(.scale(scale: 1.3).combined(with: .opacity))
                        .zIndex(1)
                }
            }
            .tint(Theme.pinkDeep)
            .task {
                try? await Task.sleep(for: .seconds(1.6))
                withAnimation(.easeInOut(duration: 0.5)) { showSplash = false }
            }
        }
        .modelContainer(for: Entry.self)
    }
}

/// 開場：吉祥物轉著彈出來打招呼
struct SplashView: View {
    @State private var show = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 24) {
                Mascot(size: 140)
                    .scaleEffect(show ? 1 : 0.2)
                    .rotationEffect(.degrees(show ? 0 : -30))
                Text("今天過得好嗎？")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.ink)
                    .opacity(show ? 1 : 0)
                    .offset(y: show ? 0 : 20)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.5)) { show = true }
        }
    }
}
