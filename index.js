// CPI - Copilot Interceptor
// GCM(토큰 발급)과 별도로 동작하는 Copilot API 요청 인터셉터
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "CPI";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const COPILOT_API_BASE = "https://api.githubcopilot.com";
const COPILOT_INTERNAL_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

const defaultSettings = {
    enabled: true,
    useVscodeHeaders: true,
    removePrefill: true,
    basicAuthCompat: false,
    debugLog: true,
    chatVersion: "0.26.4",
    codeVersion: "1.100.0",
};

const LOG_MAX = 200;

// ============================================================
// 디버그 로그 시스템
// ============================================================
const DebugLog = {
    entries: [],

    add(level, ...args) {
        const s = getSettings();
        const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
        const msg = args.map(a =>
            typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)
        ).join(" ");

        const entry = { time, level, msg };
        this.entries.push(entry);
        if (this.entries.length > LOG_MAX) this.entries.shift();

        // 콘솔에도 출력
        if (level === "ERROR") console.error(`[CPI] ${msg}`);
        else if (level === "WARN") console.warn(`[CPI] ${msg}`);
        else console.log(`[CPI] ${msg}`);

        // UI 업데이트
        if (s.debugLog) this.render();
    },

    info(...args) { this.add("INFO", ...args); },
    warn(...args) { this.add("WARN", ...args); },
    error(...args) { this.add("ERROR", ...args); },

    /** 요청/응답 상세 로그 */
    request(method, url, headers, body) {
        this.add("REQ", `━━━ 요청 ━━━`);
        this.add("REQ", `${method} ${url}`);

        // 헤더 (Authorization은 마스킹)
        const safeHeaders = { ...headers };
        if (safeHeaders["Authorization"]) {
            safeHeaders["Authorization"] = safeHeaders["Authorization"].substring(0, 20) + "...";
        }
        this.add("REQ", `헤더: ${JSON.stringify(safeHeaders)}`);

        // body 전체를 그대로 출력 (Termux 스타일)
        const safeBody = { ...body };
        // messages 내용을 그대로 보여줌
        this.add("REQ", `BODY:\n${JSON.stringify(safeBody, null, 2)}`);
    },

    response(status, statusText, bodyPreview) {
        this.add("RES", `━━━ 응답 ━━━`);
        this.add("RES", `상태: ${status} ${statusText || ""}`);
        if (bodyPreview) {
            this.add("RES", `내용: ${bodyPreview.substring(0, 200)}${bodyPreview.length > 200 ? "..." : ""}`);
        }
    },

    render() {
        const el = $("#cpi_log_content");
        if (!el.length) return;

        const colorMap = {
            INFO: "#8bc34a",
            WARN: "#FF9800",
            ERROR: "#f44336",
            REQ: "#64b5f6",
            RES: "#ce93d8",
        };

        const html = this.entries.map(e => {
            const color = colorMap[e.level] || "#ccc";
            // 줄바꿈을 보존
            const formatted = escapeHtml(e.msg).replace(/\n/g, "<br>");
            return `<div style="margin:1px 0;"><span style="color:#666;">[${e.time}]</span> <span style="color:${color};font-weight:bold;">[${e.level}]</span> <span style="color:#ddd;">${formatted}</span></div>`;
        }).join("");

        el.html(html);
        el.scrollTop(el[0]?.scrollHeight || 0);
    },

    clear() {
        this.entries = [];
        this.render();
    },
};

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

    async refreshTidToken(apiKey) {
        if (!apiKey) return "";

        if (this.tidToken && Date.now() < this.tidTokenExpiry - 60000) {
            DebugLog.info("tid 토큰 캐시 사용 (만료:", new Date(this.tidTokenExpiry).toLocaleTimeString(), ")");
            return this.tidToken;
        }

        try {
            DebugLog.info("tid 토큰 갱신 요청...");
            const res = await this.originalFetch.call(window, COPILOT_INTERNAL_TOKEN_URL, {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
            });

            if (!res.ok) {
                DebugLog.error("tid 토큰 갱신 실패:", res.status);
                return "";
            }

            const data = await res.json();
            if (data.token && data.expires_at) {
                this.tidToken = data.token;
                this.tidTokenExpiry = data.expires_at * 1000;
                DebugLog.info("tid 토큰 갱신 성공, 만료:", new Date(this.tidTokenExpiry).toLocaleString());
                return this.tidToken;
            }

            DebugLog.error("tid 응답에 유효한 토큰 없음");
            return "";
        } catch (e) {
            DebugLog.error("tid 토큰 갱신 오류:", String(e));
            return "";
        }
    },

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

    async interceptAndSend(requestBody) {
        const token = getGcmToken();
        if (!token) {
            throw new Error("GCM에 저장된 토큰이 없습니다.");
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
            DebugLog.info("VSCode 위장 헤더 적용됨");
        } else {
            headers["Authorization"] = `Bearer ${token}`;
            headers["Copilot-Integration-Id"] = "vscode-chat";
            DebugLog.info("최소 헤더 모드");
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

        // 프리필 제거 (토글)
        if (s.removePrefill && body.messages && body.messages.length > 0) {
            let removed = 0;
            while (
                body.messages.length > 1 &&
                body.messages[body.messages.length - 1].role === "assistant"
            ) {
                const r = body.messages.pop();
                const preview = typeof r.content === "string"
                    ? r.content.substring(0, 50)
                    : "(complex)";
                DebugLog.warn(`프리필 제거: [${r.role}] ${preview}`);
                removed++;
            }
            if (removed > 0) DebugLog.info(`총 ${removed}개 assistant 프리필 메시지 제거됨`);
        }

        // 디버그: 요청 상세 로그
        DebugLog.request("POST", url, headers, body);

        // 프록시 요청
        const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
        const credentials = s.basicAuthCompat ? "include" : "omit";
        DebugLog.info(`credentials: ${credentials}`);

        const startTime = Date.now();
        const response = await this.originalFetch.call(window, proxyUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            credentials,
        });

        const elapsed = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.clone().text();
            DebugLog.response(response.status, response.statusText, errText);
            DebugLog.error(`요청 실패 (${elapsed}ms)`);
        } else {
            DebugLog.response(response.status, response.statusText, "(스트리밍 응답)");
            DebugLog.info(`요청 성공 (${elapsed}ms)`);
        }

        return response;
    },

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

            let requestBody;
            try {
                const bodyText = typeof options?.body === "string"
                    ? options.body
                    : await options?.body?.text?.() || "{}";
                requestBody = JSON.parse(bodyText);
            } catch {
                return self.originalFetch.apply(window, args);
            }

            const customUrl = requestBody.custom_url || "";
            if (!customUrl.includes("githubcopilot.com")) {
                return self.originalFetch.apply(window, args);
            }

            if (!getGcmToken()) {
                DebugLog.warn("GCM 토큰 없음, 원본 요청으로 전달");
                return self.originalFetch.apply(window, args);
            }

            DebugLog.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            DebugLog.info("Copilot 요청 인터셉트!");

            try {
                return await self.interceptAndSend(requestBody);
            } catch (error) {
                DebugLog.error("인터셉트 실패:", String(error));
                toastr.error(`[CPI] ${error.message}`);
                return self.originalFetch.apply(window, args);
            }
        };

        this.active = true;
        DebugLog.info("인터셉터 설치 완료");
    },

    uninstall() {
        if (!this.active || !this.originalFetch) return;
        window.fetch = this.originalFetch;
        this.active = false;
        DebugLog.info("인터셉터 제거됨");
    },

    reset() {
        this.tidToken = "";
        this.tidTokenExpiry = 0;
        this.machineId = "";
        this.sessionId = "";
        DebugLog.info("세션/토큰 초기화됨");
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

    // --- 인터셉터 토글 ---
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

    // --- VSCode 헤더 토글 ---
    $("#cpi_use_vscode_headers").on("change", function () {
        const s = getSettings();
        s.useVscodeHeaders = $(this).prop("checked");
        saveSettings();
    });

    // --- 프리필 제거 토글 ---
    $("#cpi_remove_prefill").on("change", function () {
        const s = getSettings();
        s.removePrefill = $(this).prop("checked");
        saveSettings();
        DebugLog.info("프리필 자동 제거:", s.removePrefill ? "ON" : "OFF");
    });

    // --- basicAuth 호환 토글 ---
    $("#cpi_basic_auth_compat").on("change", function () {
        const s = getSettings();
        s.basicAuthCompat = $(this).prop("checked");
        saveSettings();
        DebugLog.info("basicAuth 호환 모드:", s.basicAuthCompat ? "ON" : "OFF");
    });

    // --- 디버그 로그 토글 ---
    $("#cpi_debug_log").on("change", function () {
        const s = getSettings();
        s.debugLog = $(this).prop("checked");
        saveSettings();
        if (s.debugLog) {
            $("#cpi_log_panel").slideDown(150);
            DebugLog.render();
        } else {
            $("#cpi_log_panel").slideUp(150);
        }
    });

    // --- 버전 설정 ---
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

    // --- 버튼 ---
    $("#cpi_reset_session").on("click", () => {
        Interceptor.reset();
        toastr.info("[CPI] 세션 초기화됨");
        updateStatus();
    });

    $("#cpi_clear_log").on("click", () => {
        DebugLog.clear();
        toastr.info("[CPI] 로그 초기화됨");
    });

    // --- 설정 로드 ---
    const s = getSettings();
    if (s.enabled === undefined) s.enabled = true;
    if (s.useVscodeHeaders === undefined) s.useVscodeHeaders = true;
    if (s.removePrefill === undefined) s.removePrefill = true;
    if (s.basicAuthCompat === undefined) s.basicAuthCompat = false;
    if (s.debugLog === undefined) s.debugLog = true;
    if (!s.chatVersion) s.chatVersion = "0.26.4";
    if (!s.codeVersion) s.codeVersion = "1.100.0";

    $("#cpi_enabled").prop("checked", s.enabled);
    $("#cpi_use_vscode_headers").prop("checked", s.useVscodeHeaders);
    $("#cpi_remove_prefill").prop("checked", s.removePrefill);
    $("#cpi_basic_auth_compat").prop("checked", s.basicAuthCompat);
    $("#cpi_debug_log").prop("checked", s.debugLog);
    $("#cpi_chat_version").val(s.chatVersion);
    $("#cpi_code_version").val(s.codeVersion);

    if (!s.debugLog) {
        $("#cpi_log_panel").hide();
    }

    // 자동 시작
    if (s.enabled) {
        Interceptor.install();
    }
    updateStatus();

    DebugLog.info("CPI (Copilot Interceptor) 로드 완료");
});
