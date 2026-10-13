import SwiftUI

/// 開場動畫：吉祥物彈出來打招呼
struct SplashView: View {
    @State private var show = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 20) {
                Mascot(size: 110)
                    .scaleEffect(show ? 1 : 0.2)
                    .rotationEffect(.degrees(show ? 0 : -30))
                Text("今天過得好嗎？")
                    .font(.system(.title2, design: .rounded, weight: .bold))
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
