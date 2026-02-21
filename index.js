// CPI - Copilot Interceptor
// OpenAI (/chat/completions) 또는 Anthropic (/v1/messages) 엔드포인트 선택 가능
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
    trimAssistant: true,
    forceLastUser: true,
    basicAuthCompat: false,
    debugLog: true,
    endpoint: "anthropic",  // "openai", "anthropic", "passthrough"
    token: "",  // 직접 입력한 Copilot 토큰 (비어있으면 GCM 폴백)
    chatVersion: "0.26.4",
    codeVersion: "1.100.0",
};

const LOG_MAX = 500;

// ============================================================
// 디버그 로그
// ============================================================
const DebugLog = {
    entries: [],

    add(level, ...args) {
        const s = getSettings();
        const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
        const msg = args.map(a =>
            typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)
        ).join(" ");

        this.entries.push({ time, level, msg });
        if (this.entries.length > LOG_MAX) this.entries.shift();

        if (level === "ERROR") console.error(`[CPI] ${msg}`);
        else if (level === "WARN") console.warn(`[CPI] ${msg}`);
        else console.log(`[CPI] ${msg}`);

        if (s.debugLog) this.render();
    },

    info(...a) { this.add("INFO", ...a); },
    warn(...a) { this.add("WARN", ...a); },
    error(...a) { this.add("ERROR", ...a); },

    request(method, url, headers, body) {
        this.add("REQ", `━━━ 요청 ━━━`);
        this.add("REQ", `${method} ${url}`);
        this.add("REQ", `모델: ${body?.model || "?"} | stream: ${body?.stream} | temp: ${body?.temperature ?? "?"} | max_tokens: ${body?.max_tokens ?? "?"}`);

        const safe = { ...headers };
        if (safe["Authorization"]) safe["Authorization"] = safe["Authorization"].substring(0, 20) + "...";
        this.add("REQ", `헤더: ${JSON.stringify(safe)}`);

        // messages 개별 출력
        const msgs = body?.messages || [];
        if (msgs.length > 0) {
            this.add("REQ", `━━━ Messages (${msgs.length}개) ━━━`);
            msgs.forEach((m, i) => {
                const c = typeof m.content === "string" ? m.content
                    : Array.isArray(m.content) ? m.content.map(b => b.text || "").join("") 
                    : JSON.stringify(m.content);
                this.add("REQ", `[${i}] role=${m.role} (${c.length}자)\n${c}`);
            });
            this.add("REQ", `━━━ Messages 끝 ━━━`);
        }

        // system (Anthropic 포맷)
        if (body?.system) {
            const sysText = Array.isArray(body.system) ? body.system.map(s => s.text || "").join("") : String(body.system);
            this.add("REQ", `━━━ System (${sysText.length}자) ━━━\n${sysText}`);
        }

        const params = { ...body };
        delete params.messages;
        delete params.system;
        this.add("REQ", `기타: ${JSON.stringify(params)}`);
    },

    response(status, statusText, bodyPreview) {
        this.add("RES", `━━━ 응답 ━━━`);
        this.add("RES", `상태: ${status} ${statusText || ""}`);
        if (bodyPreview) {
            this.add("RES", `내용: ${bodyPreview.substring(0, 300)}${bodyPreview.length > 300 ? "..." : ""}`);
        }
    },

    render() {
        const el = $("#cpi_log_content");
        if (!el.length) return;
        const colors = { INFO: "#8bc34a", WARN: "#FF9800", ERROR: "#f44336", REQ: "#64b5f6", RES: "#ce93d8" };
        const html = this.entries.map(e => {
            const c = colors[e.level] || "#ccc";
            const f = escapeHtml(e.msg).replace(/\n/g, "<br>");
            return `<div style="margin:1px 0;"><span style="color:#666;">[${e.time}]</span> <span style="color:${c};font-weight:bold;">[${e.level}]</span> <span style="color:#ddd;">${f}</span></div>`;
        }).join("");
        el.html(html);
        el.scrollTop(el[0]?.scrollHeight || 0);
    },

    clear() { this.entries = []; this.render(); },
};

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// 유틸
// ============================================================
/** 토큰: SillyTavern 연결 프로필의 API key에서 읽기 */
let _cachedApiKey = "";

function getToken(requestBody) {
    // 0. CPI 설정에 직접 입력한 토큰 (최우선)
    const s = getSettings();
    if (s.token && s.token.trim()) {
        return s.token.trim();
    }
    // 1. SillyTavern 연결 프로필 API key 필드
    const fields = ['api_key_custom', 'api_key', 'reverse_proxy_password', 'proxy_password'];
    for (const f of fields) {
        const val = requestBody?.[f];
        if (val && typeof val === "string" && val.trim()) {
            _cachedApiKey = val.trim();
            DebugLog.info(`토큰: ${f} (${val.substring(0, 10)}...)`);
            return _cachedApiKey;
        }
    }
    // 2. custom_include_headers에서 Authorization 추출
    const headers = requestBody?.custom_include_headers;
    if (headers && typeof headers === "object") {
        const auth = headers["Authorization"] || headers["authorization"];
        if (auth) {
            const token = auth.replace(/^Bearer\s+/i, "").trim();
            if (token) {
                _cachedApiKey = token;
                DebugLog.info(`토큰: custom_include_headers (${token.substring(0, 10)}...)`);
                return _cachedApiKey;
            }
        }
        for (const [k, v] of Object.entries(headers)) {
            if (typeof v === "string" && v.startsWith("gho_")) {
                _cachedApiKey = v.trim();
                DebugLog.info(`토큰: custom_include_headers.${k} (${v.substring(0, 10)}...)`);
                return _cachedApiKey;
            }
        }
    }
    // 3. 캐시된 토큰
    if (_cachedApiKey) return _cachedApiKey;
    // 4. GCM 폴백
    const gcm = extension_settings["GCM"]?.token;
    if (gcm) {
        DebugLog.info(`토큰: GCM 폴백 (${gcm.substring(0, 10)}...)`);
        return gcm;
    }
    return "";
}

function hasAnyToken() {
    const s = getSettings();
    return !!(s.token?.trim() || _cachedApiKey || extension_settings["GCM"]?.token);
}

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = JSON.parse(JSON.stringify(defaultSettings));
    }
    return extension_settings[extensionName];
}

function saveSettings() { saveSettingsDebounced(); }

// ============================================================
// OpenAI → Anthropic 포맷 변환
// ============================================================
function convertToAnthropicFormat(messages, model, params) {
    const openAIChats = structuredClone(messages);

    // 1) 첫 assistant 등장 전까지의 메시지를 system 파라미터로 추출
    let splitIndex = openAIChats.findIndex(m => m.role === "assistant");
    if (splitIndex === -1) {
        splitIndex = Math.max(0, openAIChats.length - 1);
    }

    let systemText = "";
    for (let i = 0; i < splitIndex; i++) {
        const content = typeof openAIChats[i].content === "string"
            ? openAIChats[i].content.trim() : "";
        if (!content) continue;
        if (systemText) systemText += "\n\n";
        systemText += content;
    }
    openAIChats.splice(0, splitIndex);

    // 2) 첫 메시지가 user가 아니면 더미 추가
    if (openAIChats.length === 0 || openAIChats[0].role !== "user") {
        openAIChats.unshift({ role: "user", content: "Start" });
    }

    // 3) messages 변환 (같은 role 연속 병합 + system→user 변환)
    const anthropicMessages = [];
    for (const msg of openAIChats) {
        const content = (typeof msg.content === "string" ? msg.content : "").trim();
        if (!content) continue;  // 빈 메시지 스킵
        const last = anthropicMessages.length > 0 ? anthropicMessages[anthropicMessages.length - 1] : null;

        if (msg.role === "system") {
            const text = "system: " + content;
            if (last?.role === "user") {
                last.content[0].text += "\n\n" + text;
            } else {
                anthropicMessages.push({ role: "user", content: [{ type: "text", text }] });
            }
        } else if (msg.role === "user" || msg.role === "assistant") {
            if (last?.role === msg.role) {
                last.content[0].text += "\n\n" + content;
            } else {
                anthropicMessages.push({ role: msg.role, content: [{ type: "text", text: content }] });
            }
        }
    }

    // 4) messages가 비어있으면 더미
    if (anthropicMessages.length === 0) {
        anthropicMessages.push({ role: "user", content: [{ type: "text", text: "Start" }] });
    }

    // 5) 마지막이 user인지 확인
    if (anthropicMessages[anthropicMessages.length - 1].role !== "user") {
        anthropicMessages.push({ role: "user", content: [{ type: "text", text: "Continue" }] });
    }

    // 6) user↔assistant 교대 검증 — 연속 같은 role 있으면 병합
    const validated = [];
    for (const msg of anthropicMessages) {
        const last = validated.length > 0 ? validated[validated.length - 1] : null;
        if (last && last.role === msg.role) {
            last.content[0].text += "\n\n" + msg.content[0].text;
        } else {
            validated.push(msg);
        }
    }

    // 7) body 구성
    const body = {
        model: model,
        messages: validated,
        max_tokens: params.max_tokens || 8192,
    };

    if (systemText) {
        body.system = [{ type: "text", text: systemText }];
    }

    // temperature 클램핑 (Anthropic: 0.0~1.0)
    if (params.temperature != null) {
        body.temperature = Math.min(Math.max(params.temperature, 0), 1.0);
    }
    // top_p: temperature 없을 때만
    if (params.temperature == null && params.top_p != null) {
        body.top_p = Math.min(Math.max(params.top_p, 0), 1.0);
    }
    if (params.stream != null) body.stream = params.stream;

    return body;
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
            DebugLog.info("tid 토큰 캐시 사용");
            return this.tidToken;
        }
        try {
            DebugLog.info("tid 토큰 갱신 요청...");
            const res = await this.originalFetch.call(window, COPILOT_INTERNAL_TOKEN_URL, {
                method: "GET",
                headers: { "Accept": "application/json", "Authorization": `Bearer ${apiKey}` },
            });
            if (!res.ok) { DebugLog.error("tid 갱신 실패:", res.status); return ""; }
            const data = await res.json();
            if (data.token && data.expires_at) {
                this.tidToken = data.token;
                this.tidTokenExpiry = data.expires_at * 1000;
                DebugLog.info("tid 토큰 갱신 성공");
                return this.tidToken;
            }
            return "";
        } catch (e) { DebugLog.error("tid 오류:", String(e)); return ""; }
    },

    buildVscodeHeaders() {
        const s = getSettings();
        const chatVer = s.chatVersion || "0.26.4";
        const codeVer = s.codeVersion || "1.100.0";
        if (!this.machineId) {
            this.machineId = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        }
        if (!this.sessionId) {
            this.sessionId = (crypto.randomUUID?.() || Date.now().toString()) + Date.now().toString();
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
            "X-Interaction-Id": crypto.randomUUID?.() || Date.now().toString(),
            "X-Interaction-Type": "conversation-panel",
            "X-Request-Id": crypto.randomUUID?.() || Date.now().toString(),
            "X-Vscode-User-Agent-Library-Version": "electron-fetch",
        };
    },

    async interceptAndSend(requestBody) {
        const token = getToken(requestBody);
        if (!token) throw new Error("토큰 없음 — API key 또는 GCM 토큰 필요");

        const s = getSettings();
        const isAnthropic = s.endpoint === "anthropic";
        const isPassthrough = s.endpoint === "passthrough";
        const url = isAnthropic
            ? `${COPILOT_API_BASE}/v1/messages`
            : `${COPILOT_API_BASE}/chat/completions`;

        DebugLog.info(`엔드포인트: ${s.endpoint} → ${url}`);

        // 헤더
        const headers = { "Content-Type": "application/json" };

        if (isAnthropic) {
            headers["Accept"] = "application/json";
        } else {
            headers["Accept"] = "text/event-stream";
        }

        if (s.useVscodeHeaders) {
            const tidToken = await this.refreshTidToken(token);
            headers["Authorization"] = `Bearer ${tidToken || token}`;
            Object.assign(headers, this.buildVscodeHeaders());
            DebugLog.info("VSCode 위장 헤더 적용");
        } else {
            headers["Authorization"] = `Bearer ${token}`;
            headers["Copilot-Integration-Id"] = "vscode-chat";
        }

        // body 정리 (공통)
        let body = { ...requestBody };
        delete body.custom_url;
        delete body.api_key_custom;
        delete body.reverse_proxy;
        delete body.proxy_password;
        for (const key of Object.keys(body)) {
            if (body[key] === undefined) delete body[key];
        }

        if (isPassthrough) {
            // === 패스스루: SillyTavern 전용 파라미터만 제거하고 그대로 전달 ===
            delete body.chat_completion_source;
            delete body.user_name;
            delete body.char_name;
            delete body.group_names;
            delete body.include_reasoning;
            delete body.reasoning_effort;
            delete body.enable_web_search;
            delete body.request_images;
            delete body.request_image_resolution;
            delete body.request_image_aspect_ratio;
            delete body.custom_prompt_post_processing;
            delete body.custom_include_body;
            delete body.custom_exclude_body;
            delete body.custom_include_headers;
            delete body.type;
            DebugLog.info("패스스루 모드: SillyTavern 파라미터 정리 후 전달");

        } else if (isAnthropic) {
            // === Anthropic 포맷 변환 ===
            DebugLog.info("OpenAI → Anthropic 포맷 변환 중...");

            // 변환 전 원본 로그
            if (body.messages?.length > 0) {
                const roles = body.messages.map((m, i) => `[${i}]${m.role}`).join(" ");
                DebugLog.info(`변환 전 roles: ${roles}`);
            }

            // 원본 messages role 확인 (변환 전)
            if (body.messages?.length > 0) {
                const roleMap = body.messages.map((m, i) => `[${i}]${m.role}`).join(" ");
                DebugLog.info(`원본 roles: ${roleMap}`);
            }

            const model = body.model || "claude-sonnet-4.5";
            const params = {
                max_tokens: body.max_tokens || 8192,
                temperature: body.temperature,
                top_p: body.top_p,
                stream: body.stream,
            };

            body = convertToAnthropicFormat(body.messages || [], model, params);
            DebugLog.info(`변환 완료: system ${body.system ? "있음" : "없음"}, messages ${body.messages.length}개`);

        } else {
            // === OpenAI 포맷 보정 ===

            // temperature + top_p 동시 전송 방지
            if (body.temperature != null && body.top_p != null) {
                DebugLog.warn(`top_p 제거 (temperature와 동시 사용 불가)`);
                delete body.top_p;
            }

            // SillyTavern 전용 파라미터 정리
            delete body.chat_completion_source;
            delete body.user_name;
            delete body.char_name;
            delete body.group_names;
            delete body.include_reasoning;
            delete body.reasoning_effort;
            delete body.enable_web_search;
            delete body.request_images;
            delete body.custom_prompt_post_processing;
            delete body.custom_include_body;
            delete body.custom_exclude_body;
            delete body.custom_include_headers;
            delete body.type;

            // 프리필 제거
            if (s.removePrefill && body.messages?.length > 0) {
                let removed = 0;
                while (body.messages.length > 1 && body.messages[body.messages.length - 1].role === "assistant") {
                    const r = body.messages.pop();
                    DebugLog.warn(`프리필 제거: [${r.role}]`);
                    removed++;
                }
                if (removed > 0) DebugLog.info(`${removed}개 프리필 제거됨`);
            }

            // assistant trailing whitespace trim
            if (s.trimAssistant && body.messages?.length > 0) {
                for (const m of body.messages) {
                    if (m.role === "assistant" && typeof m.content === "string") {
                        const orig = m.content;
                        m.content = m.content.trimEnd();
                        if (orig !== m.content) {
                            DebugLog.warn(`assistant 끝 공백 제거 (${orig.length} → ${m.content.length}자)`);
                        }
                    }
                }
            }

            // 마지막 메시지 user 강제
            if (s.forceLastUser && body.messages?.length > 0) {
                const last = body.messages[body.messages.length - 1];
                if (last.role !== "user") {
                    DebugLog.warn(`마지막 role 변환: ${last.role} → user`);
                    last.role = "user";
                }
            }
        }

        // 디버그 로그
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
            DebugLog.response(response.status, response.statusText, "(응답 수신)");
            DebugLog.info(`요청 성공 (${elapsed}ms)`);
        }

        // Anthropic 응답을 OpenAI 포맷으로 변환 (SillyTavern이 파싱할 수 있도록)
        if (isAnthropic && response.ok) {
            return this.convertAnthropicResponse(response, body.stream);
        }

        return response;
    },

    /**
     * Anthropic 응답을 OpenAI Chat Completion 포맷으로 변환
     * SillyTavern은 OpenAI 포맷을 기대하므로
     */
    async convertAnthropicResponse(response, isStream) {
        if (isStream) {
            // 스트리밍: Anthropic SSE → OpenAI SSE 변환
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            const stream = new ReadableStream({
                async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                        controller.close();
                        return;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split("\n");

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        const dataStr = line.substring(6).trim();
                        if (!dataStr) continue;

                        try {
                            const event = JSON.parse(dataStr);

                            if (event.type === "content_block_delta" && event.delta?.text) {
                                const openAIChunk = {
                                    choices: [{ delta: { content: event.delta.text }, index: 0 }],
                                };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                            } else if (event.type === "message_stop") {
                                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                            }
                        } catch { /* skip */ }
                    }
                },
            });

            return new Response(stream, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        } else {
            // 비스트리밍: Anthropic JSON → OpenAI JSON 변환
            const data = await response.json();
            const text = (data.content || [])
                .filter(b => b.type === "text")
                .map(b => b.text)
                .join("");

            const openAIResponse = {
                choices: [{
                    message: { role: "assistant", content: text },
                    index: 0,
                    finish_reason: data.stop_reason === "end_turn" ? "stop" : data.stop_reason,
                }],
                model: data.model,
                usage: data.usage ? {
                    prompt_tokens: data.usage.input_tokens,
                    completion_tokens: data.usage.output_tokens,
                    total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
                } : undefined,
            };

            DebugLog.info(`Anthropic→OpenAI 응답 변환: ${text.length}자`);

            return new Response(JSON.stringify(openAIResponse), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
    },

    install() {
        if (this.active) return;
        this.originalFetch = window.fetch;
        const self = this;

        window.fetch = async function (...args) {
            const [url, options] = args;
            if (!getSettings().enabled) return self.originalFetch.apply(window, args);

            const urlStr = typeof url === "string" ? url : url?.url || "";
            const isTarget = urlStr.includes("/api/backends/chat-completions/generate") ||
                urlStr.includes("/api/backends/custom/generate");
            if (!isTarget) return self.originalFetch.apply(window, args);

            let requestBody;
            try {
                const bodyText = typeof options?.body === "string" ? options.body : await options?.body?.text?.() || "{}";
                requestBody = JSON.parse(bodyText);
            } catch { return self.originalFetch.apply(window, args); }

            if (!(requestBody.custom_url || "").includes("githubcopilot.com")) return self.originalFetch.apply(window, args);
            
            const token = getToken(requestBody);
            if (!token) { DebugLog.warn("토큰 없음 — API key 또는 GCM 필요"); return self.originalFetch.apply(window, args); }

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
// UI
// ============================================================
function updateStatus() {
    const s = getSettings();
    const el = $("#cpi_status");

    if (!s.enabled) {
        el.text("❌ 비활성").css("color", "#f44336");
    } else if (!hasAnyToken()) {
        el.text("⚠️ 토큰 없음 — API key 입력 또는 GCM 발급 필요").css("color", "#FF9800");
    } else if (Interceptor.active) {
        el.text(`✅ 활성 — ${s.endpoint === "anthropic" ? "Anthropic (/v1/messages)" : s.endpoint === "passthrough" ? "패스스루 (/chat/completions)" : "OpenAI (/chat/completions)"}`).css("color", "#4CAF50");
    } else {
        el.text("⚠️ 인터셉터 미설치").css("color", "#FF9800");
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
        s.enabled ? Interceptor.install() : Interceptor.uninstall();
        s.enabled ? toastr.success("[CPI] 활성화") : toastr.info("[CPI] 비활성화");
        updateStatus();
    });

    $("#cpi_endpoint").on("change", function () {
        const s = getSettings();
        s.endpoint = $(this).val();
        saveSettings();
        DebugLog.info("엔드포인트:", s.endpoint);
        // OpenAI 전용 옵션 표시/숨김
        $(".cpi-openai-only").toggle(s.endpoint === "openai");
        updateStatus();
    });

    $("#cpi_use_vscode_headers").on("change", function () {
        const s = getSettings(); s.useVscodeHeaders = $(this).prop("checked"); saveSettings();
    });
    $("#cpi_remove_prefill").on("change", function () {
        const s = getSettings(); s.removePrefill = $(this).prop("checked"); saveSettings();
        DebugLog.info("프리필 제거:", s.removePrefill ? "ON" : "OFF");
    });
    $("#cpi_trim_assistant").on("change", function () {
        const s = getSettings(); s.trimAssistant = $(this).prop("checked"); saveSettings();
        DebugLog.info("assistant trim:", s.trimAssistant ? "ON" : "OFF");
    });
    $("#cpi_force_last_user").on("change", function () {
        const s = getSettings(); s.forceLastUser = $(this).prop("checked"); saveSettings();
        DebugLog.info("마지막 user 강제:", s.forceLastUser ? "ON" : "OFF");
    });
    $("#cpi_basic_auth_compat").on("change", function () {
        const s = getSettings(); s.basicAuthCompat = $(this).prop("checked"); saveSettings();
        DebugLog.info("basicAuth:", s.basicAuthCompat ? "ON" : "OFF");
    });
    $("#cpi_debug_log").on("change", function () {
        const s = getSettings(); s.debugLog = $(this).prop("checked"); saveSettings();
        s.debugLog ? $("#cpi_log_panel").slideDown(150) && DebugLog.render() : $("#cpi_log_panel").slideUp(150);
    });
    $("#cpi_chat_version").on("change", function () {
        const s = getSettings(); s.chatVersion = $(this).val().trim() || "0.26.4"; saveSettings(); Interceptor.reset();
    });
    $("#cpi_code_version").on("change", function () {
        const s = getSettings(); s.codeVersion = $(this).val().trim() || "1.100.0"; saveSettings(); Interceptor.reset();
    });
    $("#cpi_reset_session").on("click", () => { Interceptor.reset(); toastr.info("[CPI] 세션 초기화"); updateStatus(); });
    $("#cpi_clear_log").on("click", () => { DebugLog.clear(); toastr.info("[CPI] 로그 초기화"); });
    $("#cpi_token").on("change", function () {
        const s = getSettings();
        s.token = $(this).val().trim();
        saveSettings();
        updateStatus();
        DebugLog.info(`토큰 ${s.token ? "설정됨" : "제거됨 (GCM 폴백)"}`);
    });

    // 설정 로드
    const s = getSettings();
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }

    $("#cpi_enabled").prop("checked", s.enabled);
    $("#cpi_endpoint").val(s.endpoint);
    $("#cpi_token").val(s.token || "");
    $("#cpi_use_vscode_headers").prop("checked", s.useVscodeHeaders);
    $("#cpi_remove_prefill").prop("checked", s.removePrefill);
    $("#cpi_trim_assistant").prop("checked", s.trimAssistant);
    $("#cpi_force_last_user").prop("checked", s.forceLastUser);
    $("#cpi_basic_auth_compat").prop("checked", s.basicAuthCompat);
    $("#cpi_debug_log").prop("checked", s.debugLog);
    $("#cpi_chat_version").val(s.chatVersion);
    $("#cpi_code_version").val(s.codeVersion);

    $(".cpi-openai-only").toggle(s.endpoint === "openai");
    if (!s.debugLog) $("#cpi_log_panel").hide();

    if (s.enabled) Interceptor.install();
    updateStatus();
    DebugLog.info("CPI 로드 완료");
});
