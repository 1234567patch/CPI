// CPI - Copilot Interceptor
// GCM(토큰 발급)과 별도로 동작하는 Copilot API 요청 인터셉터
// GCM에서 발급한 토큰을 읽어와서, SillyTavern의 Copilot 요청을
// 올바른 엔드포인트 + VSCode 위장 헤더로 변환합니다.
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "CPI";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const COPILOT_API_BASE = "https://api.githubcopilot.com";
const COPILOT_INTERNAL_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

const defaultSettings = {
    enabled: true,
    useVscodeHeaders: true,
    chatVersion: "0.26.4",
    codeVersion: "1.100.0",
};

// ============================================================
// GCM 토큰 읽기
// ============================================================
function getGcmToken() {
    const gcm = extension_settings["GCM"];
    return gcm?.token || "";
}

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = JSON.parse(JSON.stringify(defaultSettings));
    }
    return extension_settings[extensionName];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ============================================================
// Copilot 인터셉터
// ============================================================
const Interceptor = {
    tidToken: "",
    tidTokenExpiry: 0,
    machineId: "",
    sessionId: "",
    originalFetch: null,
    active: false,

    /** tid 토큰 발급/갱신 */
    async refreshTidToken(apiKey) {
        if (!apiKey) return "";

        if (this.tidToken && Date.now() < this.tidTokenExpiry - 60000) {
            return this.tidToken;
        }

        try {
            const res = await this.originalFetch.call(window, COPILOT_INTERNAL_TOKEN_URL, {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
            });

            if (!res.ok) {
                console.error("[CPI] tid 토큰 갱신 실패:", res.status);
                return "";
            }

            const data = await res.json();
            if (data.token && data.expires_at) {
                this.tidToken = data.token;
                this.tidTokenExpiry = data.expires_at * 1000;
                console.log("[CPI] tid 토큰 갱신 성공");
                return this.tidToken;
            }

            return "";
        } catch (e) {
            console.error("[CPI] tid 토큰 갱신 오류:", e);
            return "";
        }
    },

    /** VSCode 위장 헤더 생성 */
    buildVscodeHeaders() {
        const s = getSettings();
        const chatVer = s.chatVersion || "0.26.4";
        const codeVer = s.codeVersion || "1.100.0";

        if (!this.machineId) {
            this.machineId = Array.from({ length: 64 }, () =>
                Math.floor(Math.random() * 16).toString(16)
            ).join("");
        }
        if (!this.sessionId) {
            this.sessionId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString())
                + Date.now().toString();
        }

        return {
            "Copilot-Integration-Id": "vscode-chat",
            "Editor-Plugin-Version": `copilot-chat/${chatVer}`,
            "Editor-Version": `vscode/${codeVer}`,
            "User-Agent": `GitHubCopilotChat/${chatVer}`,
            "Vscode-Machineid": this.machineId,
            "Vscode-Sessionid": this.sessionId,
            "X-Github-Api-Version": "2025-10-01",
            "X-Initiator": "user",
            "X-Interaction-Id": crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
            "X-Interaction-Type": "conversation-panel",
            "X-Request-Id": crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
            "X-Vscode-User-Agent-Library-Version": "electron-fetch",
        };
    },

    /** Copilot API에 직접 요청 */
    async interceptAndSend(requestBody) {
        const token = getGcmToken();
        if (!token) {
            throw new Error("[CPI] GCM에 저장된 토큰이 없습니다. GCM에서 먼저 토큰을 발급받으세요.");
        }

        const s = getSettings();
        const url = `${COPILOT_API_BASE}/chat/completions`;

        const headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        };

        if (s.useVscodeHeaders) {
            const tidToken = await this.refreshTidToken(token);
            headers["Authorization"] = `Bearer ${tidToken || token}`;
            Object.assign(headers, this.buildVscodeHeaders());
        } else {
            headers["Authorization"] = `Bearer ${token}`;
            headers["Copilot-Integration-Id"] = "vscode-chat";
        }

        // body 정리
        const body = { ...requestBody };
        delete body.custom_url;
        delete body.api_key_custom;
        delete body.reverse_proxy;
        delete body.proxy_password;
        for (const key of Object.keys(body)) {
            if (body[key] === undefined) delete body[key];
        }

        console.log("[CPI] 요청 전송:", url, "모델:", body.model);

        const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
        return await this.originalFetch.call(window, proxyUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            credentials: "omit",
        });
    },

    /** fetch monkey-patch 설치 */
    install() {
        if (this.active) return;
        this.originalFetch = window.fetch;
        const self = this;

        window.fetch = async function (...args) {
            const [url, options] = args;

            if (!getSettings().enabled) {
                return self.originalFetch.apply(window, args);
            }

            const urlStr = typeof url === "string" ? url : url?.url || "";
            const isTarget =
                urlStr.includes("/api/backends/chat-completions/generate") ||
                urlStr.includes("/api/backends/custom/generate");

            if (!isTarget) {
                return self.originalFetch.apply(window, args);
            }

            // body 파싱
            let requestBody;
            try {
                const bodyText = typeof options?.body === "string"
                    ? options.body
                    : await options?.body?.text?.() || "{}";
                requestBody = JSON.parse(bodyText);
            } catch {
                return self.originalFetch.apply(window, args);
            }

            // Copilot URL인지 확인
            const customUrl = requestBody.custom_url || "";
            if (!customUrl.includes("githubcopilot.com")) {
                return self.originalFetch.apply(window, args);
            }

            // GCM 토큰 확인
            if (!getGcmToken()) {
                console.warn("[CPI] GCM 토큰 없음, 원본 요청으로 전달");
                return self.originalFetch.apply(window, args);
            }

            console.log("[CPI] Copilot 요청 인터셉트!");

            try {
                const response = await self.interceptAndSend(requestBody);
                if (!response.ok) {
                    const errText = await response.clone().text();
                    console.error("[CPI] 응답 오류:", response.status, errText);
                }
                return response;
            } catch (error) {
                console.error("[CPI] 인터셉트 실패:", error);
                toastr.error(`[CPI] ${error.message}`);
                return self.originalFetch.apply(window, args);
            }
        };

        this.active = true;
        console.log("[CPI] 인터셉터 설치 완료");
    },

    uninstall() {
        if (!this.active || !this.originalFetch) return;
        window.fetch = this.originalFetch;
        this.active = false;
        console.log("[CPI] 인터셉터 제거됨");
    },

    reset() {
        this.tidToken = "";
        this.tidTokenExpiry = 0;
        this.machineId = "";
        this.sessionId = "";
    },
};


// ============================================================
// UI 업데이트
// ============================================================
function updateStatus() {
    const s = getSettings();
    const token = getGcmToken();
    const el = $("#cpi_status");

    if (!s.enabled) {
        el.text("❌ 비활성").css("color", "#f44336");
    } else if (!token) {
        el.text("⚠️ GCM 토큰 없음 — GCM에서 먼저 토큰을 발급받으세요").css("color", "#FF9800");
    } else if (Interceptor.active) {
        el.text("✅ 활성 — Copilot 요청을 자동 변환 중").css("color", "#4CAF50");
    } else {
        el.text("⚠️ 설정은 켜져 있지만 인터셉터 미설치").css("color", "#FF9800");
    }
}


// ============================================================
// 초기화
// ============================================================
jQuery(async () => {
    const html = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(html);

    // 이벤트
    $("#cpi_enabled").on("change", function () {
        const s = getSettings();
        s.enabled = $(this).prop("checked");
        saveSettings();
        if (s.enabled) {
            Interceptor.install();
            toastr.success("[CPI] 인터셉터 활성화");
        } else {
            Interceptor.uninstall();
            toastr.info("[CPI] 인터셉터 비활성화");
        }
        updateStatus();
    });

    $("#cpi_use_vscode_headers").on("change", function () {
        const s = getSettings();
        s.useVscodeHeaders = $(this).prop("checked");
        saveSettings();
    });

    $("#cpi_chat_version").on("change", function () {
        const s = getSettings();
        s.chatVersion = $(this).val().trim() || "0.26.4";
        saveSettings();
        Interceptor.reset();
    });

    $("#cpi_code_version").on("change", function () {
        const s = getSettings();
        s.codeVersion = $(this).val().trim() || "1.100.0";
        saveSettings();
        Interceptor.reset();
    });

    $("#cpi_reset_session").on("click", () => {
        Interceptor.reset();
        toastr.info("[CPI] 세션 초기화됨");
        updateStatus();
    });

    // 설정 로드
    const s = getSettings();
    if (s.enabled === undefined) s.enabled = true;
    if (s.useVscodeHeaders === undefined) s.useVscodeHeaders = true;
    if (!s.chatVersion) s.chatVersion = "0.26.4";
    if (!s.codeVersion) s.codeVersion = "1.100.0";

    $("#cpi_enabled").prop("checked", s.enabled);
    $("#cpi_use_vscode_headers").prop("checked", s.useVscodeHeaders);
    $("#cpi_chat_version").val(s.chatVersion);
    $("#cpi_code_version").val(s.codeVersion);

    // 자동 시작
    if (s.enabled) {
        Interceptor.install();
    }
    updateStatus();

    console.log("[CPI] Copilot Interceptor 로드 완료");
});
