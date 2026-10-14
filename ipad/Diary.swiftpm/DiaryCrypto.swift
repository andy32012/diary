import CryptoKit
import CommonCrypto
import Foundation
import Security

enum DiaryCryptoError: LocalizedError {
    case keychain(OSStatus), invalidKey, invalidCiphertext, invalidUTF8, locked, password, missingKey
    var errorDescription: String? {
        switch self {
        case .keychain(let status): "無法讀取安全金鑰（\(status)）。"
        case .invalidKey: "日記金鑰格式錯誤。"
        case .invalidCiphertext: "密碼錯誤或加密資料損壞。"
        case .invalidUTF8: "日記資料格式錯誤。"
        case .locked: "日記已鎖定。"
        case .password: "請使用至少 12 個字元的長密碼，最多 1024 UTF-8 位元組。"
        case .missingKey: "找不到舊日記金鑰。已停止遷移，原始資料仍保留。"
        }
    }
}

/// Password wraps a random data key. Neither the password nor the unwrapped key is persisted.
enum DiaryCrypto {
    private static let state = KeyState()
    private static let rounds = 600_000
    private static let aad = Data("diary:key-envelope:v2:pbkdf2-sha256:600000".utf8)
    private struct Envelope: Codable {
        let version: Int
        let iterations: Int
        let salt: Data
        let wrappedKey: Data
        let wrappedLegacyKey: Data?
    }
    private final class KeyState: @unchecked Sendable {
        let mutex = NSLock()
        var key: SymmetricKey?
        var legacy: SymmetricKey?
        var generation = 0
        var failures = 0
        var retryAt = Date.distantPast
    }
    private static func envelopeURL() throws -> URL {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return folder.appendingPathComponent("diary-password-key-v2.json")
    }
    static func needsSetup() throws -> Bool {
        !FileManager.default.fileExists(atPath: try envelopeURL().path)
    }
    static func lock() {
        state.mutex.lock(); defer { state.mutex.unlock() }
        state.generation += 1
        state.key = nil; state.legacy = nil
    }
    private static func currentKey() throws -> SymmetricKey {
        state.mutex.lock(); defer { state.mutex.unlock() }
        guard let key = state.key else { throw DiaryCryptoError.locked }
        return key
    }
    static func encrypt(_ plaintext: String) throws -> Data {
        let box = try AES.GCM.seal(Data(plaintext.utf8), using: currentKey())
        guard let data = box.combined else { throw DiaryCryptoError.invalidCiphertext }
        return data
    }
    static func decrypt(_ ciphertext: Data) throws -> String {
        let key = try currentKey()
        let box = try AES.GCM.SealedBox(combined: ciphertext)
        let data: Data
        do { data = try AES.GCM.open(box, using: key) }
        catch {
            state.mutex.lock(); let legacy = state.legacy; state.mutex.unlock()
            guard let legacy else { throw error }
            data = try AES.GCM.open(box, using: legacy)
        }
        guard let text = String(data: data, encoding: .utf8) else { throw DiaryCryptoError.invalidUTF8 }
        return text
    }
    private static func derive(_ password: String, salt: Data) throws -> SymmetricKey {
        guard !password.isEmpty, password.utf8.count <= 1024 else { throw DiaryCryptoError.password }
        var bytes = Array(password.utf8)
        var output = [UInt8](repeating: 0, count: 32)
        defer {
            bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
            output.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
        }
        let status = bytes.withUnsafeBytes { pw in
            salt.withUnsafeBytes { saltBytes in
                output.withUnsafeMutableBytes { out in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw.bindMemory(to: Int8.self).baseAddress!, bytes.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress!, salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(rounds),
                        out.bindMemory(to: UInt8.self).baseAddress!, 32)
                }
            }
        }
        guard status == kCCSuccess else { throw DiaryCryptoError.invalidKey }
        return SymmetricKey(data: output)
    }
    private static var legacyQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Bundle.main.bundleIdentifier ?? "com.hixuanye.diary",
         kSecAttrAccount as String: "local-data-encryption-key-v1"]
    }
    private static func legacyKey(hasEncryptedRecords: Bool) throws -> SymmetricKey? {
        var query = legacyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess {
            guard let data = result as? Data, data.count == 32 else { throw DiaryCryptoError.invalidKey }
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound else { throw DiaryCryptoError.keychain(status) }
        guard !hasEncryptedRecords else { throw DiaryCryptoError.missingKey }
        return nil
    }
    // Called on a worker task; the generation check prevents backgrounding from re-unlocking.
    static func unlock(password: String, hasEncryptedRecords: Bool) throws {
        state.mutex.lock()
        let generation = state.generation
        let allowed = Date() >= state.retryAt
        state.mutex.unlock()
        guard allowed else { throw NSError(domain: "Diary", code: 1, userInfo: [NSLocalizedDescriptionKey: "嘗試過於頻繁，請稍後再試（最長 30 秒）。"]) }
        do {
            let url = try envelopeURL()
            let key: SymmetricKey
            var legacy: SymmetricKey?
            if FileManager.default.fileExists(atPath: url.path) {
                let values = try url.resourceValues(forKeys: [.fileSizeKey])
                guard (values.fileSize ?? Int.max) <= 4096 else { throw DiaryCryptoError.invalidCiphertext }
                let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
                guard envelope.version == 2, envelope.iterations == rounds, envelope.salt.count == 16, envelope.wrappedKey.count == 60 else { throw DiaryCryptoError.invalidCiphertext }
                let wrapping = try derive(password, salt: envelope.salt)
                var raw = try AES.GCM.open(AES.GCM.SealedBox(combined: envelope.wrappedKey), using: wrapping, authenticating: aad + envelope.salt)
                defer { raw.resetBytes(in: 0..<raw.count) }
                guard raw.count == 32 else { throw DiaryCryptoError.invalidKey }
                key = SymmetricKey(data: raw)
                if let wrappedLegacy = envelope.wrappedLegacyKey {
                    var old = try AES.GCM.open(AES.GCM.SealedBox(combined: wrappedLegacy), using: key, authenticating: Data("diary:migration-key:v2".utf8))
                    defer { old.resetBytes(in: 0..<old.count) }
                    guard old.count == 32 else { throw DiaryCryptoError.invalidKey }
                    legacy = SymmetricKey(data: old)
                }
            } else {
                guard password.count >= 12 else { throw DiaryCryptoError.password }
                legacy = try legacyKey(hasEncryptedRecords: hasEncryptedRecords)
                key = SymmetricKey(size: .bits256)
                var salt = Data(count: 16)
                let status = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
                guard status == errSecSuccess else { throw DiaryCryptoError.keychain(status) }
                let wrapping = try derive(password, salt: salt)
                var raw = key.withUnsafeBytes { Data($0) }
                defer { raw.resetBytes(in: 0..<raw.count) }
                let box = try AES.GCM.seal(raw, using: wrapping, authenticating: aad + salt)
                guard let combined = box.combined else { throw DiaryCryptoError.invalidCiphertext }
                let verified = try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: wrapping, authenticating: aad + salt)
                guard verified == raw else { throw DiaryCryptoError.invalidKey }
                var wrappedLegacy: Data?
                if let legacy {
                    var old = legacy.withUnsafeBytes { Data($0) }
                    defer { old.resetBytes(in: 0..<old.count) }
                    wrappedLegacy = try AES.GCM.seal(old, using: key, authenticating: Data("diary:migration-key:v2".utf8)).combined
                    guard wrappedLegacy != nil else { throw DiaryCryptoError.invalidKey }
                }
                let encoded = try JSONEncoder().encode(Envelope(version: 2, iterations: rounds, salt: salt, wrappedKey: combined, wrappedLegacyKey: wrappedLegacy))
                state.mutex.lock()
                defer { state.mutex.unlock() }
                guard generation == state.generation else { throw DiaryCryptoError.locked }
                // Keep the legacy Keychain key until the database migration is committed.
                try encoded.write(to: url, options: [.atomic, .completeFileProtection])
            }
            state.mutex.lock(); defer { state.mutex.unlock() }
            guard generation == state.generation else { throw DiaryCryptoError.locked }
            state.key = key; state.legacy = legacy; state.failures = 0; state.retryAt = .distantPast
        } catch {
            state.mutex.lock()
            state.failures += 1
            state.retryAt = Date().addingTimeInterval(min(30, pow(2, Double(min(state.failures - 1, 5)))))
            state.mutex.unlock()
            if error is CryptoKitError { throw DiaryCryptoError.invalidCiphertext }
            throw error
        }
    }
    /// Only call after all records validate and ModelContext.save succeeds.
    static func finishMigration() throws {
        _ = try currentKey()
        guard !needsSetupChecked() else { throw DiaryCryptoError.invalidKey }
        let status = SecItemDelete(legacyQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DiaryCryptoError.keychain(status) }
        let url = try envelopeURL()
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
        if envelope.wrappedLegacyKey != nil {
            let final = Envelope(version: envelope.version, iterations: envelope.iterations, salt: envelope.salt, wrappedKey: envelope.wrappedKey, wrappedLegacyKey: nil)
            try JSONEncoder().encode(final).write(to: url, options: [.atomic, .completeFileProtection])
        }
        state.mutex.lock(); state.legacy = nil; state.mutex.unlock()
    }
    private static func needsSetupChecked() -> Bool { (try? needsSetup()) ?? true }
}
