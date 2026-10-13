import Foundation
import SwiftData

@Model
final class Entry {
    var createdAt: Date
    var updatedAt: Date
    var body: String
    var mood: Int   // 1...5

    init(body: String = "", mood: Int = 3, createdAt: Date = .now) {
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.body = body
        self.mood = mood
    }

    var isBlank: Bool {
        body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum Mood {
    static let emojis = ["😢", "🙁", "😐", "🙂", "😄"]
    static let names = ["難過", "不太好", "普通", "不錯", "超開心"]

    static func emoji(_ value: Int) -> String { emojis[clamp(value)] }
    static func name(_ value: Int) -> String { names[clamp(value)] }
    private static func clamp(_ value: Int) -> Int { min(max(value, 1), 5) - 1 }
}
