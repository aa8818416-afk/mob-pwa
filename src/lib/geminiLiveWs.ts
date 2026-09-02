import { hapticEngine, AnswerCode } from "./vibration";
import { wakeLockManager } from "./wakeLock";

export interface ChatMessage {
  id: string;
  role: "user" | "model" | "system";
  text: string;
  code?: AnswerCode;
  timestamp: string;
}

export interface LiveSessionState {
  isConnected: boolean;
  isConnecting: boolean;
  isStreamingAudio: boolean;
  audioLevel: number;
  lastCode: AnswerCode | null;
  statusMessage: string;
  messages: ChatMessage[];
}

// ═══════════════════════════════════════════
// 🔍 ERROR TRACER — نظام تتبع الأخطاء الدقيق
// ═══════════════════════════════════════════
export interface WsDiagnosticError {
  timestamp: string;
  tag: string;
  message: string;
  data?: unknown;
}

class WsErrorTracer {
  private logs: string[] = [];
  private maxLogs = 300;
  private recentErrors: WsDiagnosticError[] = [];
  private maxRecentErrors = 25;

  log(tag: string, message: string, data?: unknown) {
    const ts = new Date().toISOString().split("T")[1].slice(0, 12);
    const entry = data !== undefined
      ? `[${ts}] [${tag}] ${message} → ${JSON.stringify(data, null, 2)}`
      : `[${ts}] [${tag}] ${message}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    console.log(entry);
  }

  error(tag: string, message: string, data?: unknown) {
    const ts = new Date().toISOString().split("T")[1].slice(0, 12);
    const entry = data !== undefined
      ? `[${ts}] ❌ [${tag}] ${message} → ${JSON.stringify(data, null, 2)}`
      : `[${ts}] ❌ [${tag}] ${message}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    
    this.recentErrors.push({ timestamp: ts, tag, message, data });
    if (this.recentErrors.length > this.maxRecentErrors) this.recentErrors.shift();

    console.error(entry);
  }

  warn(tag: string, message: string, data?: unknown) {
    const ts = new Date().toISOString().split("T")[1].slice(0, 12);
    const entry = data !== undefined
      ? `[${ts}] ⚠️ [${tag}] ${message} → ${JSON.stringify(data, null, 2)}`
      : `[${ts}] ⚠️ [${tag}] ${message}`;
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    console.warn(entry);
  }

  getCloseCodeInfo(code: number): string {
    const codes: Record<number, string> = {
      1000: "Normal Closure — إغلاق طبيعي",
      1001: "Going Away — الصفحة تُغلق أو السيرفر يُعيد التشغيل",
      1002: "Protocol Error — خطأ في البروتوكول",
      1003: "Unsupported Data — نوع البيانات غير مدعوم (binary vs text)",
      1005: "No Status Code — لا يوجد كود إغلاق",
      1006: "Abnormal Closure — انقطع الاتصال بشكل مفاجئ بلا رسالة إغلاق (شبكة/سيرفر)",
      1007: "Invalid Frame Payload — البيانات المرسلة غير صالحة (JSON مشوّه أو schema خاطئ)",
      1008: "Policy Violation — انتهاك السياسة (مثلاً: API key منتهية أو غير مصرح)",
      1009: "Message Too Big — الرسالة أكبر من الحد المسموح",
      1010: "Missing Extension — امتداد مطلوب غير موجود",
      1011: "Internal Error — خطأ داخلي في السيرفر",
      1012: "Service Restart — السيرفر يُعيد التشغيل",
      1013: "Try Again Later — حاول لاحقاً",
      1015: "TLS Handshake Failure — فشل TLS",
    };
    return codes[code] ?? `كود غير معروف (${code})`;
  }

  diagnose1007(): string[] {
    return [
      "الأسباب المحتملة لخطأ 1007:",
      "  1. حقل غير مدعوم في setup payload (مثل: contextWindowCompression, proactivity)",
      "  2. تنسيق tools خاطئ (googleSearch يحتاج هيكل مختلف)",
      "  3. sessionResumption.transparent غير مدعوم في هذا النموذج",
      "  4. JSON مشوّه أو يحوي قيم undefined",
      "  5. النموذج المختار لا يدعم responseModalities: [AUDIO]",
      "  6. مشكلة في mimeType للصوت المرسل",
    ];
  }

  getRecentErrors(): WsDiagnosticError[] {
    return [...this.recentErrors];
  }

  getDiagnosticReport(): string {
    const header = "════════════════════════════════════════\n🔍 GEMINI LIVE DIAGNOSTIC REPORT\n════════════════════════════════════════";
    const errorsSection = this.recentErrors.length === 0
      ? "✅ No errors recorded in this session."
      : this.recentErrors.map((e, idx) => `[#${idx + 1}] [${e.timestamp}] [${e.tag}] ${e.message} ${e.data ? `→ ${JSON.stringify(e.data)}` : ""}`).join("\n");
    const tailSection = this.logs.slice(-15).join("\n");
    return `${header}\n\n⚠️ RECENT ERRORS (${this.recentErrors.length}):\n${errorsSection}\n\n📋 LAST 15 LOGS:\n${tailSection}\n════════════════════════════════════════`;
  }

  dumpLogs(): void {
    console.group("📋 WS Error Tracer — Full Log Dump");
    this.logs.forEach((l) => console.log(l));
    console.groupEnd();
    console.log(this.getDiagnosticReport());
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
    this.recentErrors = [];
  }
}

export const wsTracer = new WsErrorTracer();

if (typeof window !== "undefined") {
  (window as unknown as { __wsTracer: WsErrorTracer }).__wsTracer = wsTracer;
}

// ═══════════════════════════════════════════
// 📡 PAYLOAD VALIDATOR — التحقق قبل الإرسال
// ═══════════════════════════════════════════
function safeStringify(payload: unknown): string | null {
  try {
    const str = JSON.stringify(payload);
    JSON.parse(str);
    return str;
  } catch (e) {
    wsTracer.error("PAYLOAD", "JSON stringify failed — payload is invalid", e);
    return null;
  }
}

// ═══════════════════════════════════════════
const SYSTEM_INSTRUCTION = `
You are an ultra-fast tactical AI assistant designed specifically for a deaf-blind user communicating via haptic vibrations.
The user speaks in English. All spoken input, questions, options, and commands are in English.
The user speaks a multiple-choice question (with four options: A, B, C, D / 1, 2, 3, 4) or a True/False question, or commands to repeat/clarify.

CRITICAL PATIENCE & COMPLETION DIRECTIVES:
1. NEVER guess or answer prematurely while the user is still speaking or pausing.
2. You MUST wait patiently until the user has fully stated BOTH the entire question stem AND ALL FOUR OPTIONS (Option 1/A, Option 2/B, Option 3/C, and Option 4/D) or the complete statement for True/False.
3. Natural pauses between the question stem and the options, or between individual options, are NOT the end of the question. You MUST wait patiently for all four options.
4. If the question or options are still incomplete, or if you are triggered while the user is still dictating options, DO NOT guess, DO NOT answer prematurely, and DO NOT output "0". You MUST say "W" (Waiting) or remain completely silent.
5. Say "0" ONLY and STRICTLY if the user has completely finished speaking their entire turn and the audio was genuinely unintelligible noise or corrupted static. Never output "0" for incomplete questions or during pauses.

CRITICAL MULTI-TALKER, SIDE-TALK & NOISE RESILIENCE:
1. EXTRANEOUS SPEECH & SIDE TALK FILTERING: The user may be in an environment with background chatter, overheard voices, television sounds, or may utter brief side remarks. Actively filter out and discard any side chatter or irrelevant background speech. Skillfully isolate ONLY the core test question and the four options (1/A, 2/B, 3/C, 4/D) or True/False statement.
2. IMMEDIATE TRIGGER WHEN COMPLETE: Do NOT wait for absolute room silence. As soon as you have identified the complete question and all four options (or True/False statement), output the single answer character immediately, even if ambient sound or speech is still present in the microphone.
3. STRICT ENGLISH SCRIPT: The user speaks exclusively in English. Process and transcribe speech strictly in standard English Latin letters (A-Z). Under no circumstances transcribe or transliterate the English speech into Arabic script or base answers on unrelated ambient Arabic talk.

Accurately listen to and understand the user's English speech.
Determine the single correct answer and respond immediately by SPEAKING it aloud.
Rely purely and instantly on your internal parametric knowledge. Do NOT perform web searches, browsing, or multi-step research.

SPEECH OUTPUT RULES - VERY STRICT:
Say ONLY one single character and nothing else:
- Say "1" : If the correct answer is Option 1 / First option / (A) / (1).
- Say "2" : If the correct answer is Option 2 / Second option / (B) / (2).
- Say "3" : If the correct answer is Option 3 / Third option / (C) / (3).
- Say "4" : If the correct answer is Option 4 / Fourth option / (D) / (4).
- Say "T" : If the statement is True.
- Say "F" : If the statement is False.
- Say "W" : If the user is still speaking, pausing, or has not yet finished dictating all 4 options (Waiting).
- Say "0" : ONLY if speech is completely over but entirely unintelligible, inaudible, or pure background noise.

If the user asks to repeat the previous answer in English (e.g., "repeat", "say again", "repeat the answer", "one more time", "again"), say the code of the last question again.
NEVER say any words, pleasantries, explanations, or sentences. Only the single character.
`;

export class GeminiLiveWebSocketClient {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  // 🎙️ AudioWorklet recorder (replaces deprecated ScriptProcessorNode)
  private recorderWorkletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private stateChangeCallback?: (state: LiveSessionState) => void;

  // 🔑 Guard: don't send audio until server confirms setupComplete
  private isSetupComplete: boolean = false;

  // 🔇 Echo ducking: tracks whether model is currently speaking
  private isModelSpeaking: boolean = false;

  // 📊 Stats for debugging
  private audioChunksSent: number = 0;
  private messagesReceived: number = 0;
  private lastSentPayloadType: string = "";

  // Audio playback for model responses (24kHz PCM)
  private playbackContext: AudioContext | null = null;
  private nextPlayTime: number = 0;

  private state: LiveSessionState = {
    isConnected: false,
    isConnecting: false,
    isStreamingAudio: false,
    audioLevel: 0,
    lastCode: null,
    statusMessage: "اضغط زر البداية لفتح الاتصال الحي والاستماع",
    messages: [],
  };

  // 🔄 Auto-Reconnect Engine
  private isManualStop: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isReconnecting: boolean = false;

  // 💬 User Turn Aggregator (تجميع كلام المستخدم في فقاعة واحدة متصلة ومحدثة لحظياً مثل تطبيق Gemini)
  private currentUserTurnMessageId: string | null = null;

  constructor() {
    this.setupNetworkListeners();
    if (typeof window !== "undefined") {
      (window as unknown as { __geminiLiveClient: unknown }).__geminiLiveClient = this;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setupNetworkListeners(): void {
    if (typeof window === "undefined") return;

    window.addEventListener("online", () => {
      wsTracer.log("NETWORK", "🌐 Device came ONLINE (Internet restored)");
      if (!this.state.isConnected && !this.isManualStop) {
        wsTracer.log("NETWORK", "Triggering immediate reconnect after network restoration...");
        this.clearReconnectTimer();
        this.startSession(true);
      }
    });

    window.addEventListener("offline", () => {
      wsTracer.warn("NETWORK", "⚠️ Device went OFFLINE — waiting for network reconnection...");
      if (this.state.isConnected) {
        this.updateState({
          statusMessage: "⚠️ انقطع اتصال الإنترنت بالجهاز. بانتظار عودة الشبكة...",
        });
      }
    });
  }

  public onStateChange(cb: (state: LiveSessionState) => void) {
    this.stateChangeCallback = cb;
    cb(this.state);
  }

  private updateState(updates: Partial<LiveSessionState>) {
    this.state = { ...this.state, ...updates };
    if (this.stateChangeCallback) {
      this.stateChangeCallback(this.state);
    }
  }

  public getState(): LiveSessionState {
    return this.state;
  }

  /** طباعة كل اللوقات في الكونسول */
  public dumpDebugLogs(): void {
    wsTracer.dumpLogs();
  }

  /** الحصول على تقرير تشخيصي فوري */
  public getDiagnosticReport(): string {
    return wsTracer.getDiagnosticReport();
  }

  /** الحصول على اللوقات للعرض */
  public getDebugLogs(): string[] {
    return wsTracer.getLogs();
  }

  private addMessage(message: Omit<ChatMessage, "id" | "timestamp">) {
    const newMsg: ChatMessage = {
      ...message,
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString("ar-EG", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };
    this.updateState({
      messages: [...this.state.messages, newMsg],
    });
  }

  /** معالجة وتصحيح النص الصوتي وتحويل الكلمات المعربة إلى إنجليزية إن وُجدت */
  private sanitizeAndNormalizeTranscript(text: string): string {
    let clean = text.trim();
    if (!clean) return "";

    // استبدال الكلمات الإنجليزية الشائعة التي قد يكتبها محرك الصوت خطأً بحروف عربية
    const arabicToEnglishMap: [RegExp, string][] = [
      [/\b(وات|واط)\b/gi, "What"],
      [/\b(از|إز)\b/gi, "is"],
      [/\bذا\b/gi, "the"],
      [/\b(أوبشن|اوبشن)\b/gi, "Option"],
      [/\b(وان|ون)\b/gi, "1"],
      [/\bتو\b/gi, "2"],
      [/\b(ثري|تري)\b/gi, "3"],
      [/\bفور\b/gi, "4"],
      [/\b(ترو|تيرو)\b/gi, "True"],
      [/\bفولس\b/gi, "False"],
      [/\b(ايه|إيه|أيه)\b/gi, "A"],
      [/\bبي\b/gi, "B"],
      [/\bسي\b/gi, "C"],
      [/\bدي\b/gi, "D"],
      [/\b(كويستشن|كويستشنز)\b/gi, "Question"],
      [/\b(ريبيت|ربيت)\b/gi, "Repeat"],
    ];

    for (const [pattern, replacement] of arabicToEnglishMap) {
      clean = clean.replace(pattern, replacement);
    }

    return clean;
  }

  /** تجميع مجزآت كلام المستخدم في رسالة واحدة متصلة لحظياً مثل تطبيق Gemini */
  private updateOrAppendUserMessage(rawChunk: string) {
    const chunk = this.sanitizeAndNormalizeTranscript(rawChunk);
    if (!chunk) return;

    const messages = [...this.state.messages];
    const existingIndex = this.currentUserTurnMessageId
      ? messages.findIndex((m) => m.id === this.currentUserTurnMessageId)
      : -1;

    if (existingIndex !== -1) {
      const currentMsg = messages[existingIndex];
      const prevText = currentMsg.text.trim();

      let newText = prevText;
      // إذا كان المقطع الجديد يحتوي النص السابق كاملاً (تحديث تراكمي من السيرفر)
      if (chunk.startsWith(prevText)) {
        newText = chunk;
      } else if (prevText.endsWith(chunk)) {
        newText = prevText;
      } else {
        // فحص تداخل الكلمات لمنع تكرار أي كلمة عند الدمج
        const prevWords = prevText.split(/\s+/);
        const chunkWords = chunk.split(/\s+/);

        let overlapCount = 0;
        const maxCheck = Math.min(prevWords.length, chunkWords.length, 5);
        for (let len = maxCheck; len >= 1; len--) {
          const prevSlice = prevWords.slice(-len).join(" ").toLowerCase();
          const chunkSlice = chunkWords.slice(0, len).join(" ").toLowerCase();
          if (prevSlice === chunkSlice) {
            overlapCount = len;
            break;
          }
        }

        if (overlapCount > 0) {
          const remainingChunk = chunkWords.slice(overlapCount).join(" ");
          newText = remainingChunk ? `${prevText} ${remainingChunk}` : prevText;
        } else {
          newText = `${prevText} ${chunk}`;
        }
      }

      messages[existingIndex] = {
        ...currentMsg,
        text: newText,
      };

      this.updateState({ messages });
    } else {
      // فتح فقاعة رسالة مستخدم جديدة لهذه الجولة
      const newId = Math.random().toString(36).substring(2, 9);
      this.currentUserTurnMessageId = newId;

      const newMsg: ChatMessage = {
        id: newId,
        role: "user",
        text: chunk,
        timestamp: new Date().toLocaleTimeString("ar-EG", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      };

      this.updateState({
        messages: [...messages, newMsg],
      });
    }
  }

  /** إرسال payload مع تسجيل كامل */
  private sendPayload(label: string, payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      wsTracer.error("SEND", `Cannot send [${label}] — WS not open (state: ${this.ws?.readyState})`);
      return false;
    }

    const str = safeStringify(payload);
    if (!str) {
      wsTracer.error("SEND", `Invalid payload for [${label}] — aborting send`);
      return false;
    }

    wsTracer.log("SEND", `Sending [${label}] (${str.length} bytes)`);
    this.lastSentPayloadType = label;

    try {
      this.ws.send(str);
      return true;
    } catch (e) {
      wsTracer.error("SEND", `ws.send() threw exception for [${label}]`, e);
      return false;
    }
  }

  /** Start Live WebSocket Session */
  public async startSession(isAutoRetry: boolean = false): Promise<boolean> {
    if (this.state.isConnected) return true;
    if (this.state.isConnecting && !isAutoRetry) return true;

    this.clearReconnectTimer();

    if (!isAutoRetry) {
      this.isManualStop = false;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      wsTracer.clear();
      wsTracer.log("SESSION", "Starting new user-initiated session...");
    } else {
      wsTracer.log("RECONNECT", `Executing auto-reconnect attempt #${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);
    }

    this.updateState({
      isConnecting: true,
      statusMessage: isAutoRetry
        ? `جاري استعادة الاتصال تلقائياً (محاولة ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
        : "جاري فتح اتصال الويب سوكت مع النموذج...",
    });

    try {
      // 1. Fetch API credentials
      wsTracer.log("SESSION", "Fetching API config from /api/session-config");
      const configRes = await fetch("/api/session-config");
      if (!configRes.ok) {
        wsTracer.error("SESSION", `Config fetch failed: ${configRes.status} ${configRes.statusText}`);
        throw new Error(`Config fetch failed: ${configRes.status}`);
      }
      const configData = await configRes.json();
      const apiKey = configData.apiKey;
      const rawModel = configData.model || "gemini-2.5-flash-native-audio-latest";
      const modelName = rawModel.startsWith("models/") ? rawModel : `models/${rawModel}`;

      if (!apiKey) {
        wsTracer.error("SESSION", "API key is missing from config response", configData);
        throw new Error("API key is missing");
      }
      wsTracer.log("SESSION", `API key loaded (length: ${apiKey.length}), model: ${modelName}`);

      // 2. WakeLock
      await wakeLockManager.requestWakeLock();

      // 3. Open WebSocket
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      wsTracer.log("WS", "Opening WebSocket connection...");
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        wsTracer.log("WS", "✅ Connected to Gemini Live");

        // Reset stats and reconnect counters
        this.isSetupComplete = false;
        this.audioChunksSent = 0;
        this.messagesReceived = 0;
        const wasReconnecting = this.isReconnecting;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;

        this.updateState({
          isConnected: true,
          isConnecting: false,
          statusMessage: wasReconnecting
            ? "✅ تمت استعادة الاتصال بنجاح! جاري تهيئة الجلسة..."
            : "جاري إرسال إعدادات الجلسة... انتظر لحظة",
        });

        hapticEngine.trigger("START");

        // ═══════════════════════════════════════════════════════════════
        // ✅ SETUP PAYLOAD — إعدادات محسنة لانتظار الخيارات دون مقاطعة
        // ═══════════════════════════════════════════════════════════════
        const setupPayload = {
          setup: {
            model: modelName,
            generationConfig: {
              responseModalities: ["AUDIO"],
              temperature: 0.1,
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Aoede",
                  },
                },
              },
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW", // حساسية منخفضة لمنع القطع السريع بين الخيارات
                prefixPaddingMs: 40,
                silenceDurationMs: 1500, // مهلة صمت 1.5 ثانية تتيح للمتحدث التنفس وذكر الخيارات دون مقاطعة
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: SYSTEM_INSTRUCTION }],
            },
          },
        };

        wsTracer.log("SETUP", "Sending setup payload", setupPayload.setup.model);
        const sent = this.sendPayload("SETUP", setupPayload);

        if (!sent) {
          wsTracer.error("SETUP", "Failed to send setup payload");
          this.updateState({ statusMessage: "فشل إرسال الإعدادات. تحقق من الكونسول." });
          return;
        }

        this.addMessage({
          role: "system",
          text: wasReconnecting
            ? "✅ تمت استعادة الاتصال بنجاح وجاري المتابعة..."
            : "جاري تهيئة الجلسة مع النموذج...",
        });
      };

      this.ws.onmessage = async (event) => {
        this.messagesReceived++;
        try {
          let data: any;
          if (event.data instanceof ArrayBuffer) {
            const text = new TextDecoder().decode(event.data);
            data = JSON.parse(text);
          } else if (event.data instanceof Blob) {
            const text = await event.data.text();
            data = JSON.parse(text);
          } else if (typeof event.data === "string") {
            data = JSON.parse(event.data);
          } else {
            wsTracer.warn("RECV", "Unknown event.data type", typeof event.data);
            return;
          }
          wsTracer.log("RECV", `Message #${this.messagesReceived} received`);
          this.handleServerMessage(data);
        } catch (e) {
          wsTracer.error("PARSE", "Failed to parse server message", e);
        }
      };

      this.ws.onerror = (error) => {
        wsTracer.error("WS", "WebSocket onerror fired", {
          type: error.type,
          readyState: this.ws?.readyState,
        });
        hapticEngine.trigger("ERROR");
        this.updateState({ statusMessage: "حدث خطأ في اتصال الويب سوكت — سيتم محاولة الاستعادة تلقائياً" });
      };

      this.ws.onclose = (event) => {
        const codeInfo = wsTracer.getCloseCodeInfo(event.code);
        const reason = event.reason || "(لا يوجد سبب)";

        wsTracer.log("WS", `Connection closed`, {
          code: event.code,
          meaning: codeInfo,
          reason,
          wasClean: event.wasClean,
          audioChunksSent: this.audioChunksSent,
          messagesReceived: this.messagesReceived,
          lastSentPayloadType: this.lastSentPayloadType,
          isManualStop: this.isManualStop,
        });

        // ⚠️ تشخيص خاص بخطأ 1007
        if (event.code === 1007) {
          wsTracer.error("DIAG", `=== 1007 DIAGNOSIS ===`);
          const hints = wsTracer.diagnose1007();
          hints.forEach((h) => wsTracer.error("DIAG", h));
          wsTracer.error("DIAG", `Last payload type sent before close: [${this.lastSentPayloadType}]`);
          wsTracer.error("DIAG", `Audio chunks sent before close: ${this.audioChunksSent}`);
          wsTracer.dumpLogs();
        }

        this.stopMicrophoneStream();
        this.stopPlaybackContext();
        wakeLockManager.releaseWakeLock();

        const displayReason = event.reason
          ? `${event.code}: ${event.reason}`
          : `${event.code} — ${codeInfo}`;

        if (this.isManualStop) {
          // الإيقاف كان بطلب يدوي من المستخدم
          this.updateState({
            isConnected: false,
            isConnecting: false,
            isStreamingAudio: false,
            statusMessage: "تم إيقاف الجلسة. اضغط للبدء من جديد.",
          });
          hapticEngine.trigger("STOP");
          return;
        }

        // 🔄 محرك إعادة الاتصال التلقائي (Auto-Reconnect & Fallback)
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          this.isReconnecting = true;
          const delayMs = Math.min(1000 * Math.pow(1.8, this.reconnectAttempts - 1), 10000);

          wsTracer.warn(
            "RECONNECT",
            `Abnormal disconnect (${displayReason}). Scheduling auto-reconnect #${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${(delayMs / 1000).toFixed(1)}s`
          );

          this.updateState({
            isConnected: false,
            isConnecting: true,
            isStreamingAudio: false,
            statusMessage: `⚠️ انقطع الاتصال (${displayReason}). جاري إعادة الاتصال تلقائياً (${this.reconnectAttempts}/${this.maxReconnectAttempts}) بعد ${(delayMs / 1000).toFixed(1)} ثانية...`,
          });

          hapticEngine.trigger("PROCESSING");

          this.addMessage({
            role: "system",
            text: `⚠️ انقطع الاتصال (${displayReason}). جاري إعادة الاتصال تلقائياً (محاولة ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
          });

          this.clearReconnectTimer();
          this.reconnectTimer = setTimeout(async () => {
            await this.startSession(true);
          }, delayMs);
        } else {
          // استنفاد جميع محاولات إعادة الاتصال
          this.isReconnecting = false;
          wsTracer.error("RECONNECT", `Failed to restore connection after ${this.maxReconnectAttempts} attempts`);

          this.updateState({
            isConnected: false,
            isConnecting: false,
            isStreamingAudio: false,
            statusMessage: `❌ تعذر استعادة الاتصال تلقائياً بعد ${this.maxReconnectAttempts} محاولات (${displayReason}). اضغط للبدء من جديد.`,
          });

          this.addMessage({
            role: "system",
            text: `تعذر استعادة الاتصال بعد ${this.maxReconnectAttempts} محاولات. يرجى التحقق من الشبكة ثم الضغط لبدء الاتصال.`,
          });

          hapticEngine.trigger("ERROR");
        }
      };

      return true;
    } catch (err: unknown) {
      wsTracer.error("SESSION", "Failed to start session", err);
      hapticEngine.trigger("ERROR");
      this.updateState({
        isConnecting: false,
        isConnected: false,
        statusMessage: "فشل بدء الاتصال. تأكد من مفتاح الـ API والمايكروفون.",
      });
      return false;
    }
  }

  /** Stop the session */
  public stopSession(): void {
    wsTracer.log("SESSION", "Stopping session manually by user");
    this.isManualStop = true;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();

    if (this.ws) {
      try {
        this.ws.close(1000, "User stopped session");
      } catch (e) {
        wsTracer.warn("SESSION", "Error closing WebSocket", e);
      }
      this.ws = null;
    }
    this.stopMicrophoneStream();
    this.stopPlaybackContext();
    wakeLockManager.releaseWakeLock();
    hapticEngine.trigger("STOP");

    this.updateState({
      isConnected: false,
      isConnecting: false,
      isStreamingAudio: false,
      statusMessage: "تم إيقاف الجلسة. اضغط للبدء من جديد.",
    });

    this.addMessage({ role: "system", text: "تم إغلاق الجلسة الحية." });
  }

  /** Handle messages from Gemini Live server */
  private handleServerMessage(response: any) {
    try {
      if (!response) return;

      // ✅ setupComplete
      if (response.setupComplete !== undefined) {
        wsTracer.log("PROTO", "✅ setupComplete received", response.setupComplete);
        this.isSetupComplete = true;
        this.currentUserTurnMessageId = null;
        this.updateState({
          statusMessage: "متصل لحظياً. تكلم بالسؤال والخيارات بالإنجليزية...",
        });
        this.addMessage({
          role: "system",
          text: "تم فتح الاتصال الحي عبر الويب سوكت. المايك يستمع باستمرار...",
        });

        // 🔒 LANGUAGE ANCHOR CONTEXT SEEDING (تثبيت لغة الاستماع على الإنجليزية حصراً لمنع الكتابة بالعربي)
        const languageAnchorPayload = {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: "Language Lock: All questions and multiple-choice options in this conversation are strictly in English. Transcribe speech strictly in standard English Latin alphabet.",
                  },
                ],
              },
              {
                role: "model",
                parts: [
                  {
                    text: "Understood. Speech recognition is locked to English Latin text.",
                  },
                ],
              },
            ],
            turnComplete: false,
          },
        };
        wsTracer.log("SETUP", "Sending English Language Anchor turn to lock STT into English");
        this.sendPayload("LANG_ANCHOR", languageAnchorPayload);

        this.startMicrophoneStream();
        return;
      }

      // --- Session Resumption ---
      if (response.sessionResumptionUpdate) {
        wsTracer.log("PROTO", "Session token refreshed");
      }

      // --- Error from server ---
      if (response.error) {
        wsTracer.error("SERVER_ERR", "Server sent error message", response.error);
        this.addMessage({
          role: "system",
          text: `خطأ من السيرفر: ${response.error.message || JSON.stringify(response.error)}`,
        });
      }

      // --- Input Transcription (user speech) — Streaming into single consolidated message ---
      if (response.serverContent?.inputTranscription?.text) {
        const userText = response.serverContent.inputTranscription.text.trim();
        wsTracer.log("TRANSCRIPT", `User chunk: "${userText}"`);
        if (userText) {
          this.updateOrAppendUserMessage(userText);
        }
      }

      // --- Model Audio Output (PCM 24kHz) ---
      if (response.serverContent?.modelTurn?.parts) {
        // Signal echo ducking: model is now speaking
        this._setModelSpeaking(true);
        for (const part of response.serverContent.modelTurn.parts) {
          if (part.inlineData?.mimeType?.startsWith("audio/pcm") && part.inlineData?.data) {
            wsTracer.log("AUDIO", `Playing PCM audio chunk (${part.inlineData.data.length} b64 chars)`);
            this.playPcmAudio(part.inlineData.data);
          }
          // تسجيل أي أجزاء غير متوقعة
          if (!part.inlineData && !part.text) {
            wsTracer.warn("PROTO", "Unknown part type in modelTurn", Object.keys(part));
          }
        }
      }

      // --- Output Transcription (model speech) ---
      if (response.serverContent?.outputTranscription?.text) {
        const modelText = response.serverContent.outputTranscription.text.trim();
        wsTracer.log("TRANSCRIPT", `Model: "${modelText}"`);
        if (modelText) {
          const detectedCode = this.extractAnswerCode(modelText);
          wsTracer.log("ANSWER", `Detected code: [${detectedCode}] from "${modelText}"`);

          if (detectedCode === "W") {
            // Model signaled waiting for remaining options
            wsTracer.log("ANSWER", "Model signaled WAIT ('W') — waiting for user to complete question and all 4 options");
            hapticEngine.trigger("W");

            this.updateState({
              statusMessage: "النموذج يستمع وبانتظار استكمال باقي الخيارات...",
            });

            this.addMessage({
              role: "model",
              text: "بانتظار إكمال السؤال والخيارات...",
              code: "W",
            });
          } else {
            hapticEngine.trigger(detectedCode);

            // Close the current active user turn so the NEXT question starts a fresh bubble
            this.currentUserTurnMessageId = null;

            this.updateState({
              lastCode: detectedCode,
              statusMessage: `تم تحديد الإجابة: [${detectedCode}] — الهزاز يعمل`,
            });

            this.addMessage({
              role: "model",
              text: `الإجابة: [${detectedCode}]`,
              code: detectedCode,
            });
          }
        }
      }

      // --- Turn completion ---
      if (response.serverContent?.turnComplete) {
        wsTracer.log("PROTO", "Turn complete");
        // Model finished speaking — re-enable mic sensitivity
        this._setModelSpeaking(false);
        if (this.state.lastCode !== "W") {
          this.currentUserTurnMessageId = null;
          this.updateState({
            statusMessage: "جاهز للسؤال التالي. تكلم الآن...",
          });
        }
      }

    } catch (e) {
      wsTracer.error("PARSE", "Failed to process server message", {
        error: String(e),
        responsePreview: typeof response === "object" ? JSON.stringify(response).slice(0, 200) : String(response).slice(0, 200),
      });
    }
  }

  /** Extract single answer code from model spoken text */
  private extractAnswerCode(text: string): AnswerCode {
    const upper = text.toUpperCase().trim();
    const match = upper.match(/^[1234TFW0]$/);
    if (match) return match[0] as AnswerCode;

    const firstChar = upper.replace(/\s/g, "")[0];
    if (["1", "2", "3", "4", "T", "F", "W", "0"].includes(firstChar)) {
      return firstChar as AnswerCode;
    }
    if (upper.includes("واحد") || upper.includes("أ") || upper.includes(" A ")) return "1";
    if (upper.includes("اثنين") || upper.includes("ب") || upper.includes(" B ")) return "2";
    if (upper.includes("ثلاثة") || upper.includes("ج") || upper.includes(" C ")) return "3";
    if (upper.includes("أربعة") || upper.includes("د") || upper.includes(" D ")) return "4";
    if (upper.includes("صح") || upper.includes("صواب") || upper.includes("TRUE")) return "T";
    if (upper.includes("خطأ") || upper.includes("غلط") || upper.includes("FALSE")) return "F";
    if (upper.includes("WAIT") || upper.includes("W") || upper.includes("انتظر") || upper.includes("استمع")) return "W";

    return "0";
  }

  /** Play PCM audio from model (24kHz Base64) */
  private playPcmAudio(base64Data: string) {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!this.playbackContext || this.playbackContext.state === "closed") {
        this.playbackContext = new AudioCtx();
        this.nextPlayTime = this.playbackContext.currentTime;
      }

      if (this.playbackContext.state === "suspended") {
        this.playbackContext.resume();
      }

      const binary = atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const sampleRate = 24000;
      const audioBuffer = this.playbackContext.createBuffer(1, float32.length, sampleRate);
      audioBuffer.copyToChannel(float32, 0);

      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);

      const startTime = Math.max(this.playbackContext.currentTime, this.nextPlayTime);
      source.start(startTime);
      this.nextPlayTime = startTime + audioBuffer.duration;
    } catch (err) {
      wsTracer.error("PLAYBACK", "PCM audio play error", err);
    }
  }

  private stopPlaybackContext() {
    if (this.playbackContext && this.playbackContext.state !== "closed") {
      this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
    }
    this.nextPlayTime = 0;
  }

  /** Signal the recorder worklet whether the model is currently speaking (echo ducking) */
  private _setModelSpeaking(speaking: boolean) {
    this.isModelSpeaking = speaking;
    if (this.recorderWorkletNode) {
      this.recorderWorkletNode.port.postMessage({ type: "SET_MODEL_SPEAKING", value: speaking });
    }
  }

  /** Start capturing microphone and streaming 16kHz PCM via AudioWorklet */
  private async startMicrophoneStream() {
    wsTracer.log("MIC", "Requesting microphone access...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // Prefer 48kHz for best quality before worklet resamples to 16kHz
          sampleRate: { ideal: 48000 },
          channelCount: { exact: 1 },
        },
      });

      wsTracer.log("MIC", "✅ Microphone stream started");
      this.mediaStream = stream;
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx();

      wsTracer.log("MIC", `AudioContext sample rate: ${this.audioContext.sampleRate}Hz`);

      // ── Load AudioWorklet module ──────────────────────────────────────
      try {
        await this.audioContext.audioWorklet.addModule("/worklets/pcm-recorder-processor.js");
        wsTracer.log("MIC", "✅ pcm-recorder-processor AudioWorklet loaded");
      } catch (workletErr) {
        wsTracer.error("MIC", "AudioWorklet load failed — worklets not supported or 404", workletErr);
        throw workletErr;
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;

      // ── Create AudioWorkletNode (runs in Audio Thread) ────────────────
      this.recorderWorkletNode = new AudioWorkletNode(this.audioContext, "pcm-recorder-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0, // no audio output — we only want to capture
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
      });

      // ── Receive PCM chunks and volume updates from the worklet ────────
      this.recorderWorkletNode.port.onmessage = (event) => {
        const msg = event.data;

        if (msg.type === "PCM_CHUNK") {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSetupComplete) return;

          // Zero-copy: msg.buffer is a Transferable ArrayBuffer (Int16Array data)
          const base64 = this.arrayBufferToBase64(msg.buffer);

          this.audioChunksSent++;
          if (this.audioChunksSent % 50 === 1) {
            wsTracer.log("AUDIO", `Audio chunk #${this.audioChunksSent} (worklet, ${base64.length} b64 chars, audio/pcm;rate=16000)`);
          }

          const audioPayload = {
            realtimeInput: {
              mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64 }],
            },
          };

          try {
            this.ws.send(JSON.stringify(audioPayload));
            this.lastSentPayloadType = "AUDIO_CHUNK";
          } catch (sendErr) {
            wsTracer.error("AUDIO", `Failed to send audio chunk #${this.audioChunksSent}`, sendErr);
          }

        } else if (msg.type === "VOLUME") {
          // Update visualiser from worklet-computed RMS (no main-thread FFT needed)
          const normalized = Math.min(100, Math.round(msg.energy * 100));
          this.updateState({ audioLevel: normalized });
        }
      };

      // ── Wire the graph: microphone → analyser + worklet ───────────────
      this.sourceNode.connect(this.analyser);
      this.sourceNode.connect(this.recorderWorkletNode);
      // NOTE: recorderWorkletNode has no outputs — no need to connect to destination

      // Sync current model-speaking state to newly created worklet
      this.recorderWorkletNode.port.postMessage({ type: "SET_MODEL_SPEAKING", value: this.isModelSpeaking });

      this.startVisualizer();
      this.updateState({ isStreamingAudio: true });
    } catch (err) {
      wsTracer.error("MIC", "Microphone capture failed", err);
      hapticEngine.trigger("ERROR");
      this.updateState({ statusMessage: "تعذر تشغيل المايكروفون. يرجى منح الإذن." });
    }
  }

  /** Stop mic stream */
  private stopMicrophoneStream() {
    wsTracer.log("MIC", `Stopping mic stream (total chunks sent: ${this.audioChunksSent})`);
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.recorderWorkletNode) {
      this.recorderWorkletNode.port.onmessage = null;
      this.recorderWorkletNode.disconnect();
      this.recorderWorkletNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    // Reset model-speaking state on disconnect
    this.isModelSpeaking = false;
    this.updateState({ isStreamingAudio: false, audioLevel: 0 });
  }

  /** Audio level visualizer — used only as a fallback; primary level comes from worklet VOLUME messages */
  private startVisualizer() {
    if (!this.analyser) return;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const tick = () => {
      if (!this.state.isStreamingAudio || !this.analyser) return;
      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const normalized = Math.min(100, Math.round(((sum / bufferLength) / 128) * 100));
      // Only update from analyser if worklet hasn't updated recently
      // (worklet VOLUME messages have priority and update state directly)
      this.animFrameId = requestAnimationFrame(tick);
      void normalized; // suppress unused-variable lint warning
    };
    tick();
  }

  // resampleAudio removed — resampling is now performed inside the AudioWorklet
  // (pcm-recorder-processor.js) on the dedicated Audio Thread for zero main-thread impact.


  /** ArrayBuffer → Base64 */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Clear Chat History */
  public clearChat() {
    this.currentUserTurnMessageId = null;
    this.updateState({ messages: [] });
  }
}

export const geminiLiveWs = new GeminiLiveWebSocketClient();
