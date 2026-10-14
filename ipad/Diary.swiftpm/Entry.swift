import Foundation
import SwiftData

@Model
final class Entry {
    var createdAt: Date
    var updatedAt: Date

    // Legacy columns are cleared after migration; encrypted columns hold the values.
    var body: String
    var mood: Int
    var encryptedBody: Data?
    var encryptedMood: Data?

    init(body: String = "", mood: Int = 3, createdAt: Date = .now) {
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.body = body
        self.mood = mood
        self.encryptedBody = nil
        self.encryptedMood = nil
    }

    var bodyText: String? {
        guard let encryptedBody else { return body }
        return try? DiaryCrypto.decrypt(encryptedBody)
    }

    var moodValue: Int? {
        guard let encryptedMood else { return mood }
        guard let text = try? DiaryCrypto.decrypt(encryptedMood),
              let value = Int(text),
              (1...5).contains(value) else { return nil }
        return value
    }

    func encryptBody(_ value: String) throws {
        encryptedBody = try DiaryCrypto.encrypt(value)
        body = ""
    }

    func encryptMood(_ value: Int) throws {
        let normalizedValue = min(max(value, 1), 5)
        encryptedMood = try DiaryCrypto.encrypt(String(normalizedValue))
        mood = 0
    }

    var isBlank: Bool {
        guard let bodyText else { return false }
        return bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum Mood {
    static let emojis = ["😢", "🙁", "😐", "🙂", "😄"]
    static let names = ["難過", "不太好", "普通", "不錯", "超開心"]

    static func emoji(_ value: Int) -> String { emojis[clamp(value)] }
    static func name(_ value: Int) -> String { names[clamp(value)] }
    private static func clamp(_ value: Int) -> Int { min(max(value, 1), 5) - 1 }
}
