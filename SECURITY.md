# 日記加密與安全限制

## 密碼與鎖定

Windows 與 iPad 首次開啟新版時須建立獨立日記密碼（至少 12 個字元、最多 1024 UTF-8 位元組）。建立時會擋下容易被猜到的密碼：連續數字或字母、鍵盤連打、重複字元、常見單字（含簡單的 leet 替換，例如 `P@ssw0rd`）、年份與月日。兩版使用相同的規則與常數（`windows/app/password-policy.js`、`ipad/Diary.swiftpm/PasswordPolicy.swift`），估計值低於 45 bits 即拒絕。用幾個不相關的詞組成一句話就能通過，而且好記。這項檢查只在建立密碼時進行；目前沒有更改密碼的功能，所以既有的密碼不受影響。

沒有預設密碼、密碼提示、復原金鑰或忘記密碼重設流程。**忘記密碼將無法復原內容。** 密碼不會自動存入 DPAPI 或 Keychain。

兩版在閒置 5 分鐘、切到背景時鎖定，並提供手動鎖定。Windows 也在鎖定系統、休眠、重新載入或 renderer 結束時鎖定。解鎖期間切到背景會使該次解鎖失效。鎖定時清除畫面內容、解除明文與金鑰參照；Windows 的主程序同時拒絕未解鎖的儲存請求。

錯誤嘗試採 1–30 秒遞增等待，僅是程式內的輔助防護；重新啟動可以重設等待。複製檔案後的離線猜測由下列 KDF 與密碼強度抵抗，不能以介面的等待時間阻擋。

## 加密格式

- Windows：Node crypto scrypt，N=131072、r=8、p=1、隨機 16-byte salt，衍生 32-byte 金鑰。AES-256-GCM 使用每次新產生的 12-byte nonce、16-byte tag，AAD 綁定版本、演算法參數與 salt。整份日記 JSON（包含日期、心情、體重）加密於 `userData/diary-vault.bin`。所有讀寫經主程序，來源須為受信任的主 frame。寫入先同步暫存檔，再在同目錄原子替換；同一時間只允許一個 App 程序與一條寫入佇列。每次成功解鎖時，把當下的密文另存為 `diary-vault.bin.bak`（同一把金鑰的密文）。主檔遺失、格式錯誤或 GCM 驗證失敗，而同一個密碼能開啟備份時，會把壞掉的主檔改名為 `diary-vault.bin.damaged` 保留，再從備份還原並提示使用者；上次解鎖之後的修改可能沒有保留。
- iPad：金鑰檔版本 3 以 scrypt（N=131072、r=8、p=1，與 Windows 相同；純 Swift 實作，依 RFC 7914 測試向量驗證）從密碼與隨機 16-byte salt 衍生 256-bit 包裝金鑰，再以 CryptoKit AES-GCM 包裝隨機 256-bit 資料金鑰。AAD 綁定格式、scrypt 參數、遷移階段（`pending`／`complete`）與 salt，所以竄改階段會讓解鎖失敗。金鑰檔位於 Application Support 的 `diary-password-key-v2.json`（沿用檔名），使用原子寫入及完整檔案保護。內文、心情、體重分別以 AES-GCM 加密於 SwiftData，AAD 綁定記錄 UUID、欄位名稱與建立日期，密文無法搬到別的記錄、欄位或日期。加密前先加上長度並補零：內文補到 1024 bytes 起跳的 2 的冪次，心情與體重補到 32 bytes，所以密文大小不會透露字數或體重位數。日期、筆數、記錄 UUID 等資料庫中繼資訊仍不是密文。
- 不使用密碼雜湊比對來假裝加密：正確密碼必須能通過 GCM 驗證才可取得內容或資料金鑰。

## 舊資料遷移

Windows 僅在首次設定時讀取舊 DPAPI 檔，或在完全沒有檔案時讀取舊 localStorage。新密文先解密驗證，再原子替換舊檔。成功後移除舊 localStorage 項目，並透過 Chromium 清除 localStorage 儲存區；之後每次以已加密的日記啟動時也會再清一次。新版本不再使用 DPAPI 解開新版密文。失敗不以空白日記覆寫原檔。

iPad 版本 2 的金鑰檔（PBKDF2 600,000 次）在第一次以正確密碼解鎖時，會把同一把資料金鑰改用 scrypt 重新包裝成版本 3 的 `pending` 階段。新安裝也從 `pending` 開始。遷移期間舊 Keychain 金鑰另行以新金鑰加密保存，讓中斷後可繼續。只有還沒綁定記錄的資料才會遷移：明文欄位、舊版密文，以及缺少 UUID 的記錄。每筆新密文都先解開比對成功，才在同一次 SwiftData 儲存中寫入並清除舊欄位。某一筆無法解密時跳過該筆、保留原始資料，畫面顯示「無法解密」並提示筆數，不會讓整本日記無法解鎖。全部遷移成功後才刪除舊 Keychain 金鑰，並把金鑰檔改為 `complete`。從此之後，明文或未綁定的記錄一律拒絕，不再遷移。加密記錄存在但舊金鑰或金鑰檔遺失時，拒絕另造金鑰。遷移完成前，舊資料仍受原本較弱的保護。

**刪除明文欄位或檔案不代表安全抹除。** 既存的 SQLite/WAL 空閒頁、Chromium localStorage 的 leveldb 紀錄、SSD 殘留、系統快照、雲端或其他備份仍可能包含舊明文或舊金鑰。程式不會擅自刪除使用者的外部備份，也不宣稱能可靠抹除 SSD。iPad 沒有在遷移後重建 SQLite：SwiftData 沒有提供安全的 VACUUM 方式，而且無法在此環境於裝置上驗證，資料庫損毀的風險大於清除殘留的好處。

遷移後，先確認可重新解鎖並建立新版的加密備份，再依備份服務的功能移除不再需要的舊備份。Windows 備份新版 `diary-vault.bin`（`.bak` 只是本機的上一版）；iPad 必須備份完整 App 資料（資料庫與 `diary-password-key-v2.json` 缺一不可）。還原時必須保留相同的一組檔案。不要僅備份 SwiftData 資料庫。

## 執行環境加固

- Windows：一般情況下頁面從自訂的 `app://diary/` 協定載入，只提供 `index.html`、`app.js`、`style.css`、`password-policy.js` 四個檔案；只有還需要讀取舊 localStorage 的第一次遷移才使用 `file://`。CSP 另外禁止表單送出（`form-action 'none'`）。拒絕所有權限請求，關閉拼字檢查，打包後關閉 DevTools。`setContentProtection(true)` 讓截圖、錄影與視訊會議的畫面分享拍不到視窗內容。打包時以 Electron fuses 關閉 `RunAsNode`、`NODE_OPTIONS`、`--inspect` 類參數，並啟用內嵌 ASAR 完整性檢查與只從 ASAR 載入。`GrantFileProtocolExtraPrivileges` 維持預設，因為第一次遷移仍需 `file://`。
- iPad：拒絕第三方鍵盤，系統鍵盤不受影響。偵測到螢幕錄影、AirPlay 或畫面鏡像時，以遮蔽畫面取代日記內容。iOS 不允許 App 阻止一般截圖。

程式碼簽章需要憑證，尚未設定。發佈前請以 electron-builder 的簽章設定（例如 `CSC_LINK`／`CSC_KEY_PASSWORD` 環境變數或 Azure Trusted Signing）簽署執行檔，並只從可信任的管道提供下載。App 不會自動檢查更新：版本檢查需要連線，會讓外部伺服器知道有人在使用這個 App。請自行追蹤 Electron 安全更新並重新打包。

## 威脅範圍

此設計增加鎖定狀態下檔案被複製後的解密成本，避免同一 Windows 帳戶可僅靠 DPAPI 直接解開新版日記。它不阻止檔案被刪除、以舊版還原或損毀；請保留加密備份。iPad 的記錄綁定可阻止密文被搬移或偽造，但無法阻止有資料庫寫入權的人刪除記錄、把單筆記錄換回同一筆的舊密文，或把整個金鑰檔換回舊版本。

已控制裝置的惡意程式仍可能替換 App、側錄密碼、截圖，或讀取解鎖期間的記憶體。Windows 的畫面保護無法阻止實體相機或舊版 Windows 上的擷取。JavaScript/Swift 的字串、IPC、UI、記憶體管理與系統交換檔亦不能保證所有複本立即歸零。Windows 明確清零持有的 key Buffer，iPad 釋放 SymmetricKey 並清零可控制的暫存資料；這不是防病毒保證。請搭配受支援的系統、磁碟加密與可信任的安裝來源。

打包工具 electron-builder 26 仍有一個中度弱點：`sprintf-js` 的 DoS，經由 `@electron/get` → `global-agent` → `roarr` 引入，目前沒有修正版。它只在打包時使用，不會隨 App 發佈。

## 驗證

在 `windows` 執行：

```sh
node --check main.js
node --check vault.js
node --check preload.js
node --check app/app.js
node --check app/password-policy.js
node --test tests/security.test.js
npm audit --package-lock-only
```

自動測試包含：真正的 scrypt/AES-GCM round trip、錯誤密碼、salt/nonce/ciphertext/tag 竄改、寫入失敗、來源驗證、鎖定後存取、排隊儲存、DPAPI 遷移流程、解鎖與背景鎖定競態、renderer 清除明文；另外也測試密碼強度規則、從 `.bak` 還原損壞或遺失的主檔、`app://` 檔案白名單、權限拒絕、畫面保護、拼字檢查與 DevTools 設定，以及遷移後清除 localStorage。Electron、DPAPI 和 DOM 使用替身，不能當作 Windows 整合測試。iPad 的 scrypt 以逐行對照的 JavaScript 版本，比對 RFC 7914 測試向量與 Node 內建 scrypt；Swift 程式本身尚未在 Apple 平台編譯。

發佈前仍需 Windows Electron 及 Apple 裝置驗證：

1. 新安裝、明文舊版、原加密舊版，分別設定密碼、關閉、重開、解鎖；資料完整且密碼錯誤不變更檔案。
2. 切換視窗／App、鎖定系統、休眠、閒置 5 分鐘及在解鎖中切換背景；不可看到舊內容或自動解鎖。
3. 輸入後立即關閉，重開應保留已接受的儲存；模擬磁碟滿、唯讀、遷移中斷，確認不覆寫唯一可用資料。
4. Windows：打包版能啟動（fuses 與 ASAR 完整性）、`app://` 頁面正常載入、截圖與畫面分享時視窗呈黑色、刪除主檔或改壞一個位元組後可從 `.bak` 還原。
5. iPad：以 Xcode 或 Swift Playgrounds 建置；從版本 2 金鑰檔升級到版本 3、新安裝、遷移中斷後再解鎖；量測 scrypt 解鎖時間（Debug 建置會明顯較慢）；改壞單筆記錄後仍可解鎖並顯示「無法解密」；第三方鍵盤被拒絕；螢幕錄影時畫面被遮蔽；完整 App 備份還原。
6. 背景畫面預覽應遮蔽內容。Apple 平台尚未在此 Linux 開發環境編譯或執行，不應未驗證即發佈。
