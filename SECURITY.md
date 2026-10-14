# 日記加密與安全限制

## 密碼與鎖定

Windows 與 iPad 首次開啟新版時須建立獨立日記密碼（至少 12 個字元、最多 1024 UTF-8 位元組）。請使用密碼管理器產生的長密碼或隨機多詞密碼。沒有預設密碼、密碼提示、復原金鑰或忘記密碼重設流程。**忘記密碼將無法復原內容。** 密碼不會自動存入 DPAPI 或 Keychain。

兩版在閒置 5 分鐘、切到背景時鎖定，並提供手動鎖定。Windows 也在鎖定系統、休眠、重新載入或 renderer 結束時鎖定。解鎖期間切到背景會使該次解鎖失效。鎖定時清除畫面內容、解除明文與金鑰參照；Windows 的主程序同時拒絕未解鎖的儲存請求。

錯誤嘗試採 1–30 秒遞增等待，僅是程式內的輔助防護；重新啟動可以重設等待。複製檔案後的離線猜測由下列 KDF 與密碼強度抵抗，不能以介面的等待時間阻擋。

## 加密格式

- Windows：Node crypto scrypt，N=131072、r=8、p=1、隨機 16-byte salt，衍生 32-byte 金鑰。AES-256-GCM 使用每次新產生的 12-byte nonce、16-byte tag，AAD 綁定版本、演算法參數與 salt。整份日記 JSON（包含日期、心情、體重）加密於 `userData/diary-vault.bin`。所有讀寫經主程序，來源須為受信任的主 frame。寫入先同步暫存檔，再在同目錄原子替換；同一時間只允許一個 App 程序與一條寫入佇列。
- iPad：CommonCrypto PBKDF2-HMAC-SHA256，600,000 次、隨機 16-byte salt，衍生 256-bit 包裝金鑰。CryptoKit AES-GCM 包裝新的隨機 256-bit 資料金鑰，AAD 綁定格式與 salt。包裝檔位於 Application Support 的 `diary-password-key-v2.json`，使用原子寫入及完整檔案保護。內文、心情、體重以 AES-GCM 加密於 SwiftData；日期、筆數等資料庫中繼資訊仍不是密文。
- 不使用密碼雜湊比對來假裝加密：正確密碼必須能通過 GCM 驗證才可取得內容或資料金鑰。

## 舊資料遷移

Windows 僅在首次設定時讀取舊 DPAPI 檔，或在完全沒有檔案時讀取舊 localStorage。新密文先解密驗證，再原子替換舊檔。成功後移除舊 localStorage 項目。新版本不再使用 DPAPI 解開新版密文。失敗不以空白日記覆寫原檔。

iPad 先把新資料金鑰包裝到密碼檔；遷移期間將舊金鑰另行以新金鑰加密保存，讓中斷後可繼續。所有記錄先驗證及準備好新密文，才修改 SwiftData 並儲存。儲存成功後刪除舊 Keychain 金鑰及遷移用的包裝金鑰。加密記錄存在但舊金鑰遺失時，拒絕另造舊金鑰。遷移尚未完成前，舊資料仍受原本較弱的保護。

**刪除明文欄位或檔案不代表安全抹除。** 既存的 SQLite/WAL、Chromium localStorage 儲存頁、SSD 殘留、系統快照、雲端或其他備份仍可能包含舊明文或舊金鑰。程式不會擅自刪除使用者的外部備份，也不宣稱能可靠抹除 SSD。

遷移後，先確認可重新解鎖並建立新版的加密備份，再依備份服務的功能移除不再需要的舊備份。Windows 備份新版 `diary-vault.bin`；iPad 必須備份完整 App 資料（資料庫與 `diary-password-key-v2.json` 缺一不可）。還原時必須保留相同的一組檔案。不要僅備份 SwiftData 資料庫。

## 威脅範圍

此設計增加鎖定狀態下檔案被複製後的解密成本，避免同一 Windows 帳戶可僅靠 DPAPI 直接解開新版日記。它不阻止檔案被刪除、以舊版還原或損毀；請保留加密備份。

已控制裝置的惡意程式仍可能替換 App、側錄密碼、截圖，或讀取解鎖期間的記憶體。JavaScript/Swift 的字串、IPC、UI、記憶體管理與系統交換檔亦不能保證所有複本立即歸零。Windows 明確清零持有的 key Buffer，iPad 釋放 SymmetricKey 並清零可控制的暫存 Data；這不是防病毒保證。請搭配受支援的系統、磁碟加密與可信任的安裝來源。

## 驗證

在 `windows` 執行：

```sh
node --check main.js
node --check vault.js
node --check preload.js
node --check app/app.js
node --test tests/security.test.js
```

自動測試包含真正的 scrypt/AES-GCM round trip、錯誤密碼、salt/nonce/ciphertext/tag 竄改、寫入失敗、來源驗證、鎖定後存取、排隊儲存、DPAPI 遷移流程、解鎖與背景鎖定競態、renderer 清除明文。Electron、DPAPI 和 DOM 使用替身；不能當作 Windows 整合測試。

發佈前仍需 Windows Electron 及 Apple 裝置驗證：

1. 新安裝、明文舊版、原加密舊版，分別設定密碼、關閉、重開、解鎖；資料完整且密碼錯誤不變更檔案。
2. 切換視窗／App、鎖定系統、休眠、閒置 5 分鐘及在解鎖中切換背景；不可看到舊內容或自動解鎖。
3. 輸入後立即關閉，重開應保留已接受的儲存；模擬磁碟滿、唯讀、遷移中斷，確認不覆寫唯一可用資料。
4. iPad 確認 CommonCrypto 與 SwiftData 建置、包裝檔完整檔案保護、舊 Keychain 金鑰在成功遷移後移除，以及完整 App 備份還原。
5. 背景畫面預覽應遮蔽內容。Apple 平台尚未在此 Linux 開發環境編譯或執行，不應未驗證即發佈。
