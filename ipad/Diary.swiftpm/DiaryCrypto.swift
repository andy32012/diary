import CryptoKit
import Foundation
import Security

enum DiaryCryptoError: LocalizedError {
    case keychain(OSStatus)
    case invalidKey
    case invalidCiphertext
    case invalidUTF8

    var errorDescription: String? {
        switch self {
        case .keychain(let status): "無法讀取安全金鑰（Keychain 錯誤 \(status)）。"
        case .invalidKey: "日記加密金鑰格式錯誤。"
        case .invalidCiphertext: "加密資料格式錯誤。"
        case .invalidUTF8: "解密後的日記資料格式錯誤。"
        }
    }
}

/// AES-GCM 加密；256 位元金鑰只存在 iOS Keychain。
enum DiaryCrypto {
    private static let keyCache = KeyCache()

    static func encrypt(_ plaintext: String) throws -> Data {
        let box = try AES.GCM.seal(Data(plaintext.utf8), using: keyCache.get { try loadOrCreateKey() })
        guard let combined = box.combined else {
            throw DiaryCryptoError.invalidCiphertext
        }
        return combined
    }

    static func decrypt(_ ciphertext: Data) throws -> String {
        let box = try AES.GCM.SealedBox(combined: ciphertext)
        let plaintext = try AES.GCM.open(box, using: keyCache.get { try loadOrCreateKey() })
        guard let value = String(data: plaintext, encoding: .utf8) else {
            throw DiaryCryptoError.invalidUTF8
        }
        return value
    }

    private final class KeyCache: @unchecked Sendable {
        private let lock = NSLock()
        private var cachedKey: SymmetricKey?

        func get(load: () throws -> SymmetricKey) throws -> SymmetricKey {
            lock.lock()
            defer { lock.unlock() }
            if let cachedKey { return cachedKey }
            let key = try load()
            cachedKey = key
            return key
        }
    }

    private static func loadOrCreateKey() throws -> SymmetricKey {
        let service = Bundle.main.bundleIdentifier ?? "com.hixuanye.diary"
        let account = "local-data-encryption-key-v1"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess {
            guard let data = result as? Data, data.count == 32 else {
                throw DiaryCryptoError.invalidKey
            }
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound else {
            throw DiaryCryptoError.keychain(status)
        }

        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
            kSecValueData as String: data
        ]
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return key
        }
        // Another app launch may have created the key between lookup and insert.
        if addStatus == errSecDuplicateItem {
            return try loadOrCreateKey()
        }
        throw DiaryCryptoError.keychain(addStatus)
    }
}
