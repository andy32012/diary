import SwiftUI

enum Theme {
    static let pink = Color(red: 1.00, green: 0.71, blue: 0.78)
    static let peach = Color(red: 1.00, green: 0.85, blue: 0.73)
    static let mint = Color(red: 0.74, green: 0.93, blue: 0.85)
    static let lavender = Color(red: 0.82, green: 0.78, blue: 0.98)
    static let cream = Color(red: 1.00, green: 0.98, blue: 0.94)
    static let ink = Color(red: 0.36, green: 0.29, blue: 0.35)

    static let moodColors: [Color] = [lavender, Color(red: 0.75, green: 0.86, blue: 1.0), peach, mint, pink]

    static func moodColor(_ mood: Int) -> Color {
        moodColors[min(max(mood, 1), 5) - 1]
    }

    static let background = LinearGradient(colors: [cream, pink.opacity(0.35), lavender.opacity(0.35)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
}

/// 按下去會縮一下再「啵」彈回來的按鈕樣式
struct BouncyButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.88 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.45), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == BouncyButtonStyle {
    static var bouncy: BouncyButtonStyle { BouncyButtonStyle() }
}
