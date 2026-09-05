import { hapticEngine, AnswerCode } from "./vibration";
import { wakeLockManager } from "./wakeLock";

export interface ChatMessage {
  id: string;
  role: "user" | "model" | "system";
  text: string;
  code?: AnswerCode;
  timestamp: string;
}

export type QuestionMode = "AUTO" | "TRUE_FALSE" | "MCQ";

export interface LiveSessionState {
  isConnected: boolean;
  isConnecting: boolean;
  isStreamingAudio: boolean;
  audioLevel: number;
  lastCode: AnswerCode | null;
  statusMessage: string;
  messages: ChatMessage[];
  questionMode: QuestionMode;
  voiceName: string;
  thinkingBudget: number | "dynamic";
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
You are an intelligent, ultra-fast AI voice assistant designed for a deaf-blind tactile assistance system.
You understand English (standard, accented, or broken/ESL English) and Arabic fluently.

CRITICAL FIRST-TOKEN EVALUATION RULE:
The deaf-blind user's smartphone is physically connected to a tactile vibration motor that automatically triggers based on the VERY FIRST token/word of your response.
If you say anything else first (such as a greeting, conversational preamble, wrong option number, or explanation), the tactile motor will immediately trigger on that wrong token and the user will feel the WRONG answer!

THEREFORE, YOUR RESPONSE MUST STRICTLY COMPLY WITH:
1. For Multiple Choice questions (candidate choices 1, 2, 3, 4 or A, B, C, D):
   - Your VERY FIRST word MUST be strictly the correct choice number enclosed in brackets: [1], [2], [3], or [4].
   - Only options 1, 2, 3, and 4 are valid options.
2. For True or False questions:
   - Your VERY FIRST word MUST be strictly the correct letter enclosed in brackets: [T] or [F].
   - [T] for True / صواب / صح, and [F] for False / خطأ / غير صحيح.
3. Spoken Explanation:
   - IMMEDIATELY after stating the bracketed code as your first token, provide a concise 1 to 2 sentence spoken explanation in natural speech (in the same language the question was asked) explaining why that choice is correct.

EXAMPLES:
- User: "What is the capital of Egypt? 1 London 2 Cairo 3 Paris 4 Berlin"
  Model: "[2] Option 2 is correct, Cairo is the capital of Egypt."
- User: "True or false, water boils at 100 degrees Celsius?"
  Model: "[T] True, water boils at 100 degrees Celsius at sea level."
- User: "The earth is flat. True or false?"
  Model: "[F] False, the Earth is spherical."
- User: "What is the powerhouse of the cell? 1 Ribosome 2 Mitochondria 3 Nucleus 4 Cytoplasm"
  Model: "[2] Option 2 is correct, mitochondria generate cellular energy."

MODE CONTROLS:
- If the user says "True or false" / "T or F": Output "[MODE:TF] Switched to True or False mode."
- If the user says "Multiple choice" / "options" / "correct": Output "[MODE:MCQ] Switched to Multiple Choice mode."

CASUAL CONVERSATION & GREETINGS:
- If the user greets you or makes casual remarks (not a test question): Respond warmly and concisely in 1 to 2 sentences. Never stay silent.
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
  private activeAudioSources: AudioBufferSourceNode[] = [];

  // 🔊 Voice and Thinking Configuration
  private selectedVoice: string = "Aoede";
  private selectedThinkingBudget: number | "dynamic" = "dynamic";

  // 🎯 Question Mode Engine (AUTO | TRUE_FALSE | MCQ)
  private currentQuestionMode: QuestionMode = "AUTO";

  private state: LiveSessionState = {
    isConnected: false,
    isConnecting: false,
    isStreamingAudio: false,
    audioLevel: 0,
    lastCode: null,
    statusMessage: "اضغط زر البداية لفتح الاتصال الحي والاستماع",
    messages: [],
    questionMode: "AUTO",
    voiceName: "Aoede",
    thinkingBudget: "dynamic",
  };

  // 🔄 Auto-Reconnect Engine
  private isManualStop: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isReconnecting: boolean = false;

  // 💬 User Turn Aggregator
  private currentUserTurnMessageId: string | null = null;

  // 🤖 Model Turn Aggregator & Single Decision Lock (قفل الإجابة والهزاز لمرة واحدة فقط لكل جولة)
  private currentModelTurnMessageId: string | null = null;
  private hasAnsweredCurrentTurn: boolean = false;

  // 🔄 Soft Reset Engine (تصفير الذاكرة بين الأسئلة تلقائياً دون مقاطعة الهزاز أو المايك)
  private isSoftResetting: boolean = false;
  private softResetTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedApiKey: string = "";
  private cachedModelName: string = "";
  private questionTurnCount: number = 0;

  // 🧠 Memory of last definitive answer for local replay ('1' | '2' | '3' | '4' | 'T' | 'F')
  private lastDefinitiveAnswer: AnswerCode | null = null;

  constructor() {
    this.setupNetworkListeners();
    if (typeof window !== "undefined") {
      (window as unknown as { __geminiLiveClient: unknown }).__geminiLiveClient = this;
    }
  }

  /** ضبط صوت النموذج (Aoede, Kore, Puck, Zephyr) */
  public setVoiceName(voice: string): void {
    this.selectedVoice = voice;
    this.updateState({ voiceName: voice });
    wsTracer.log("CONFIG", `Voice changed to: ${voice}`);
  }

  /** ضبط ميزانية وسرعة التفكير (dynamic أو 2000 أو أي رقم) */
  public setThinkingBudget(budget: number | "dynamic"): void {
    this.selectedThinkingBudget = budget;
    this.updateState({ thinkingBudget: budget });
    wsTracer.log("CONFIG", `Thinking budget changed to: ${budget}`);
  }

  /** ⚡ إيقاف فوري لكافة مصادر الصوت النشطة وتفريغ البافر عند المقاطعة (Barge-in) */
  public stopAllBufferedAudio(): void {
    if (this.activeAudioSources.length > 0) {
      wsTracer.log("AUDIO", `Stopping ${this.activeAudioSources.length} active audio sources immediately`);
      for (const src of this.activeAudioSources) {
        try {
          src.stop();
          src.disconnect();
        } catch (_) {}
      }
      this.activeAudioSources = [];
    }
    if (this.playbackContext) {
      this.nextPlayTime = this.playbackContext.currentTime;
    }
    this._setModelSpeaking(false);
  }

  public initStandbyWakeWord(): void {
    // Standby wake word disabled
  }

  private clearSoftResetTimer(): void {
    if (this.softResetTimer) {
      clearTimeout(this.softResetTimer);
      this.softResetTimer = null;
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

  /** تجميع مجزآت كلام المستخدم في رسالة واحدة متصلة لحظياً وبشكل انسيابي بدون تعليق */
  private updateOrAppendUserMessage(rawChunk: string) {
    if (!rawChunk || !rawChunk.trim()) return;

    const chunk = rawChunk;
    const messages = [...this.state.messages];
    const existingIndex = this.currentUserTurnMessageId
      ? messages.findIndex((m) => m.id === this.currentUserTurnMessageId)
      : -1;

    if (existingIndex !== -1) {
      const currentMsg = messages[existingIndex];
      const prevText = currentMsg.text;

      let newText: string;
      if (chunk.startsWith(prevText)) {
        newText = chunk;
      } else {
        const needsSpace = prevText.length > 0 &&
          !prevText.endsWith(" ") &&
          !chunk.startsWith(" ") &&
          !/^[,.?!،؛]/.test(chunk);
        newText = needsSpace ? `${prevText} ${chunk}` : `${prevText}${chunk}`;
      }

      messages[existingIndex] = {
        ...currentMsg,
        text: newText,
      };

      this.updateState({ messages });
    } else {
      const newId = Math.random().toString(36).substring(2, 9);
      this.currentUserTurnMessageId = newId;

      const newMsg: ChatMessage = {
        id: newId,
        role: "user",
        text: chunk.trimStart(),
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

  /** تجميع شريحة كلام النموذج في رسالة واحدة واستخراج كود الإجابة لمرة واحدة فقط وقفل الهزاز */
  private updateOrAppendModelMessage(rawChunk: string) {
    if (!rawChunk || !rawChunk.trim()) return;

    const messages = [...this.state.messages];
    const existingIndex = this.currentModelTurnMessageId
      ? messages.findIndex((m) => m.id === this.currentModelTurnMessageId)
      : -1;

    let fullText = "";
    if (existingIndex !== -1) {
      const currentMsg = messages[existingIndex];
      const prevText = currentMsg.text;
      if (rawChunk.startsWith(prevText)) {
        fullText = rawChunk;
      } else {
        const needsSpace = prevText.length > 0 &&
          !prevText.endsWith(" ") &&
          !rawChunk.startsWith(" ") &&
          !/^[,.?!،؛]/.test(rawChunk);
        fullText = needsSpace ? `${prevText} ${rawChunk}` : `${prevText}${rawChunk}`;
      }
      messages[existingIndex] = {
        ...currentMsg,
        text: fullText,
      };
    } else {
      const newId = Math.random().toString(36).substring(2, 9);
      this.currentModelTurnMessageId = newId;
      fullText = rawChunk.trimStart();
      const newMsg: ChatMessage = {
        id: newId,
        role: "model",
        text: fullText,
        timestamp: new Date().toLocaleTimeString("ar-EG", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      };
      messages.push(newMsg);
    }

    // فحص كود الإجابة إن لم يتم استخراجه وقفله بالفعل لهذه الجولة
    if (!this.hasAnsweredCurrentTurn) {
      const detected = this.extractAnswerCode(fullText);
      if (detected) {
        if (detected === "MODE_TF") {
          wsTracer.log("MODE", "🎯 Model acknowledged switch to True/False mode");
          this.currentQuestionMode = "TRUE_FALSE";
          this.hasAnsweredCurrentTurn = true;
          hapticEngine.trigger("T");
          this.updateState({
            questionMode: "TRUE_FALSE",
            statusMessage: "🎯 تم تفعيل نمط: صح وخطأ (True / False)",
          });
        } else if (detected === "MODE_MCQ") {
          wsTracer.log("MODE", "🎯 Model acknowledged switch to Multiple Choice (MCQ) mode");
          this.currentQuestionMode = "MCQ";
          this.hasAnsweredCurrentTurn = true;
          hapticEngine.trigger("START");
          this.updateState({
            questionMode: "MCQ",
            statusMessage: "🎯 تم تفعيل نمط: خيارات متعددة (MCQ)",
          });
        } else {
          // كود إجابة قطعي محدد حصرياً: [1, 2, 3, 4, T, F]
          wsTracer.log("ANSWER", `🎯 Definitive Answer Code detected on first token: [${detected}]`);
          this.hasAnsweredCurrentTurn = true;
          this.lastDefinitiveAnswer = detected;
          hapticEngine.trigger(detected);

          this.updateState({
            lastCode: detected,
            statusMessage: `تم تحديد الإجابة: [${detected}] — الهزاز يعمل`,
          });

          const msgIdx = messages.findIndex((m) => m.id === this.currentModelTurnMessageId);
          if (msgIdx !== -1) {
            messages[msgIdx].code = detected;
          }
        }
      }
    }

    this.updateState({ messages });
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

      this.cachedApiKey = apiKey;
      this.cachedModelName = modelName;
      this.questionTurnCount = 0;

      // 2. WakeLock
      await wakeLockManager.requestWakeLock();

      // 3. Connect WebSocket
      this.connectWebSocket(apiKey, modelName, false);
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

  /**
   * 🔌 Establish WebSocket Connection (Used for initial session, auto-reconnect, and seamless soft-reset)
   */
  private connectWebSocket(apiKey: string, modelName: string, isSoftReset: boolean) {
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    wsTracer.log("WS", isSoftReset ? "🔄 Opening fresh WebSocket connection for next question (Soft Reset)..." : "Opening WebSocket connection...");
    
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      wsTracer.log("WS", isSoftReset ? "✅ Connected for next question (fresh 0-token memory)" : "✅ Connected to Gemini Live (v1beta)");

      this.isSetupComplete = false;
      this.audioChunksSent = 0;
      this.messagesReceived = 0;
      const wasReconnecting = this.isReconnecting;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.isSoftResetting = false;

      this.updateState({
        isConnected: true,
        isConnecting: false,
        statusMessage: isSoftReset
          ? `جاهز للسؤال [${this.questionTurnCount + 1}] (ذاكرة نقية)... تكلم الآن`
          : wasReconnecting
          ? "✅ تمت استعادة الاتصال بنجاح! جاري تهيئة الجلسة..."
          : "جاري إرسال إعدادات الجلسة... انتظر لحظة",
      });

      if (!isSoftReset) {
        hapticEngine.trigger("START");
      }

      // ═══════════════════════════════════════════════════════════════
      // ✅ SETUP PAYLOAD (v1beta with thinkingConfig & configurable voice)
      // ═══════════════════════════════════════════════════════════════
      const generationConfig: Record<string, unknown> = {
        responseModalities: ["AUDIO"],
        temperature: 0.1,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.selectedVoice,
            },
          },
        },
      };

      if (this.selectedThinkingBudget !== "dynamic") {
        generationConfig.thinkingConfig = {
          thinkingBudget: typeof this.selectedThinkingBudget === "number"
            ? this.selectedThinkingBudget
            : parseInt(String(this.selectedThinkingBudget), 10),
        };
      }

      const setupPayload = {
        setup: {
          model: modelName,
          generationConfig,
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
              prefixPaddingMs: 300,
              silenceDurationMs: 600,
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

      if (!isSoftReset) {
        this.addMessage({
          role: "system",
          text: wasReconnecting
            ? "✅ تمت استعادة الاتصال بنجاح وجاري المتابعة..."
            : "جاري تهيئة الجلسة مع النموذج...",
        });
      }
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
      if (!this.isSoftResetting) {
        hapticEngine.trigger("ERROR");
        this.updateState({ statusMessage: "حدث خطأ في اتصال الويب سوكت — سيتم محاولة الاستعادة تلقائياً" });
      }
    };

    this.ws.onclose = (event) => {
      // 🛡️ Soft Reset Guard: If this close was intentional for resetting context, DO NOT stop mic or haptic motor!
      if (this.isSoftResetting) {
        wsTracer.log("WS", "Soft reset close acknowledged — preserving microphone stream, worklet, and haptic motor.");
        return;
      }

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
  }

  /**
   * 🔄 Soft Reset for Next Question:
   * Keeps microphone stream running, allows hardware haptics to finish completely,
   * and starts a 100% clean context session with Gemini Live for the next question.
   */
  public softResetSessionForNextTurn(): void {
    if (this.isManualStop) return;

    this.questionTurnCount++;
    wsTracer.log("SESSION", `🔄 Initiating seamless soft reset for question #${this.questionTurnCount + 1} (clean 0-token memory)...`);
    this.isSoftResetting = true;
    this.isSetupComplete = false;
    this.currentUserTurnMessageId = null;
    this.clearSoftResetTimer();

    // Release model speaking ducking so mic is completely active
    this._setModelSpeaking(false);

    // 1. Cleanly detach ALL event listeners from old WebSocket before closing.
    // This prevents ghost 'onclose' / 'onerror' events from firing after the new socket opens,
    // which previously corrupted connection state and prevented soft reset on question 2+!
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      oldWs.onclose = null;
      try {
        oldWs.close(1000, "Soft reset for next turn");
      } catch (e) {
        wsTracer.warn("SESSION", "WS close notice during soft reset", e);
      }
    }

    this.updateState({
      lastCode: null,
      statusMessage: `جاري تجهيز الذاكرة للسؤال [${this.questionTurnCount + 1}] (ذاكرة نقية)...`,
    });

    const apiKey = this.cachedApiKey;
    const modelName = this.cachedModelName || "models/gemini-2.5-flash-native-audio-latest";

    if (!apiKey) {
      this.isSoftResetting = false;
      this.startSession(false);
      return;
    }

    // 2. Open fresh WebSocket for the next question
    this.connectWebSocket(apiKey, modelName, true);
  }

  /** جدولة إعادة الضبط السلسة بعد الإجابة */
  private scheduleSoftReset(delayMs: number = 700) {
    this.clearSoftResetTimer();
    this.softResetTimer = setTimeout(() => {
      // ⚡ CRITICAL: Nullify timer reference immediately so future turns can schedule cleanly!
      this.softResetTimer = null;
      this.softResetSessionForNextTurn();
    }, delayMs);
  }

  /** Stop the session */
  public stopSession(): void {
    wsTracer.log("SESSION", "Stopping session manually by user");
    this.isManualStop = true;
    this.isSoftResetting = false;
    this.clearSoftResetTimer();
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.questionTurnCount = 0;

    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      oldWs.onclose = null;
      try {
        oldWs.close(1000, "User stopped session");
      } catch (e) {
        wsTracer.warn("SESSION", "Error closing WebSocket", e);
      }
    }
    this.stopMicrophoneStream();
    this.stopPlaybackContext();
    wakeLockManager.releaseWakeLock();
    hapticEngine.trigger("STOP");

    this.currentQuestionMode = "AUTO";

    this.updateState({
      isConnected: false,
      isConnecting: false,
      isStreamingAudio: false,
      lastCode: null,
      statusMessage: "تم إيقاف الجلسة. اضغط على الزر للبدء.",
      questionMode: "AUTO",
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

        const isSoftResetSetup = this.state.isStreamingAudio; // mic already running = soft reset

        this.updateState({
          statusMessage: isSoftResetSetup
            ? `جاهز للسؤال [${this.questionTurnCount + 1}] (ذاكرة نقية)... تكلم الآن`
            : "متصل لحظياً. تكلم بالسؤال والخيارات بالإنجليزية...",
        });

        if (!isSoftResetSetup) {
          this.addMessage({
            role: "system",
            text: "تم فتح الاتصال الحي عبر الويب سوكت. المايك يستمع باستمرار...",
          });
        }

        // Only start mic if this is NOT a soft reset (mic is already streaming during soft reset)
        if (!isSoftResetSetup) {
          this.startMicrophoneStream();
        }
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

      // ⚡ Interrupted by server (barge-in triggered by user speaking while model is speaking)
      if (response.serverContent?.interrupted) {
        wsTracer.log("BARGE_IN", "⚡ Server interrupted event (Barge-in) — stopping model playback immediately");
        this.stopAllBufferedAudio();
        this.currentUserTurnMessageId = null;
        this.currentModelTurnMessageId = null;
        this.hasAnsweredCurrentTurn = false;

        const messages = [...this.state.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "model") {
            if (!messages[i].text.endsWith("...")) {
              messages[i] = { ...messages[i], text: messages[i].text + "..." };
              this.updateState({ messages });
            }
            break;
          }
        }
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
        const modelText = response.serverContent.outputTranscription.text;
        wsTracer.log("TRANSCRIPT", `Model chunk: "${modelText}"`);
        if (modelText) {
          this.updateOrAppendModelMessage(modelText);
        }
      }

      // --- Turn completion ---
      if (response.serverContent?.turnComplete) {
        wsTracer.log("PROTO", "Turn complete");
        // Model finished speaking — re-enable mic sensitivity
        this._setModelSpeaking(false);

        // إذا كان النموذج قد حسم إجابة قطعية (1, 2, 3, 4, T, F) في هذه الجولة
        if (this.hasAnsweredCurrentTurn && this.lastDefinitiveAnswer) {
          this.currentUserTurnMessageId = null;
          this.currentModelTurnMessageId = null;
          this.hasAnsweredCurrentTurn = false;
          wsTracer.log("SESSION", `Turn complete with definitive answer [${this.lastDefinitiveAnswer}] — scheduling soft reset for fresh context`);
          this.scheduleSoftReset(700);
        } else {
          this.currentModelTurnMessageId = null;
          this.hasAnsweredCurrentTurn = false;
        }
      }

    } catch (e) {
      wsTracer.error("PARSE", "Failed to process server message", {
        error: String(e),
        responsePreview: typeof response === "object" ? JSON.stringify(response).slice(0, 200) : String(response).slice(0, 200),
      });
    }
  }

  /**
   * استخراج كود الإجابة من بداية كلام النموذج حصراً.
   * الخيارات المقبولة حصراً: 1, 2, 3, 4 للخيارات، أو T, F لصح وخطأ.
   * لا يُرجع 0 ولا W إطلاقاً منعاً للأخطاء الزائفة.
   */
  private extractAnswerCode(text: string): AnswerCode | "MODE_TF" | "MODE_MCQ" | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();

    // 1. أوامر تبديل النمط
    if (upper.includes("MODE:TF") || upper.includes("MODE_TF")) {
      return "MODE_TF";
    }
    if (upper.includes("MODE:MCQ") || upper.includes("MODE_MCQ")) {
      return "MODE_MCQ";
    }

    // 2. فحص الأقواس في البداية: [1], [2], [3], [4], [T], [F]
    const bracketMatch = upper.match(/^\[([1-4TF])\]/);
    if (bracketMatch) {
      return bracketMatch[1] as AnswerCode;
    }

    const nearStartBracket = upper.slice(0, 20).match(/\[([1-4TF])\]/);
    if (nearStartBracket) {
      return nearStartBracket[1] as AnswerCode;
    }

    // 3. مطابقة الحرف أو الرقم كأول رمز
    const firstWordMatch = upper.match(/^([1-4TF])\b/);
    if (firstWordMatch) {
      return firstWordMatch[1] as AnswerCode;
    }

    // 4. مطابقة كلمات البداية الصريحة بالإنجليزية والعربية
    if (/^(TRUE|صحيح|صح|صواب)\b/i.test(upper)) return "T";
    if (/^(FALSE|خطأ|خاطئ|غلط)\b/i.test(upper)) return "F";
    if (/^(OPTION\s*1|CHOICE\s*1|الخيار\s*الأول|الخيار\s*1|واحد)\b/i.test(upper)) return "1";
    if (/^(OPTION\s*2|CHOICE\s*2|الخيار\s*الثاني|الخيار\s*2|اثنين|إثنين)\b/i.test(upper)) return "2";
    if (/^(OPTION\s*3|CHOICE\s*3|الخيار\s*الثالث|الخيار\s*3|ثلاثة)\b/i.test(upper)) return "3";
    if (/^(OPTION\s*4|CHOICE\s*4|الخيار\s*الرابع|الخيار\s*4|أربعة|اربعة)\b/i.test(upper)) return "4";

    return null;
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

      // Track active audio source so it can be halted instantly on interruption (Barge-in)
      this.activeAudioSources.push(source);
      source.onended = () => {
        const idx = this.activeAudioSources.indexOf(source);
        if (idx !== -1) this.activeAudioSources.splice(idx, 1);
        if (this.activeAudioSources.length === 0) {
          this._setModelSpeaking(false);
        }
      };
    } catch (err) {
      wsTracer.error("PLAYBACK", "PCM audio play error", err);
    }
  }

  private stopPlaybackContext() {
    this.stopAllBufferedAudio();
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
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          // @ts-ignore - Android Chrome hardware DSP
          googEchoCancellation: true,
          // @ts-ignore
          googAutoGainControl: true,
          // @ts-ignore
          googNoiseSuppression: true,
          sampleRate: { ideal: 48000 },
        } as MediaTrackConstraints,
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

      // ── Receive PCM chunks, volume updates, and barge-in from the worklet ────────
      this.recorderWorkletNode.port.onmessage = (event) => {
        const msg = event.data;

        if (msg.type === "BARGE_IN") {
          wsTracer.log("BARGE_IN", "🎤 Local barge-in detected in AudioWorklet — stopping active model playback");
          this.stopAllBufferedAudio();
        } else if (msg.type === "PCM_CHUNK") {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSetupComplete) return;

          // 🛡️ Mobile backpressure protection: drop chunks if WebSocket buffer is clogged
          if (this.ws.bufferedAmount > 16384) {
            wsTracer.warn("NET", `WebSocket bufferedAmount high (${this.ws.bufferedAmount} bytes) — dropping audio chunk to prevent network lag`);
            return;
          }

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
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isSetupComplete) {
      try {
        this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        wsTracer.log("MIC", "Sent audioStreamEnd signal to server");
      } catch (e) {
        wsTracer.warn("MIC", "Failed to send audioStreamEnd", e);
      }
    }
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
    this.lastDefinitiveAnswer = null;
    this.questionTurnCount = 0;
    this.currentQuestionMode = "AUTO";
    this.updateState({ lastCode: null, messages: [], questionMode: "AUTO" });
  }
}

export const geminiLiveWs = new GeminiLiveWebSocketClient();
