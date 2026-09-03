import { hapticEngine, AnswerCode } from "./vibration";
import { wakeLockManager } from "./wakeLock";
import { standbyWakeWordManager } from "./wakeWord";

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
You are an ultra-fast tactical AI assistant designed specifically for a deaf-blind user communicating via tactile haptic vibrations on a mobile smartphone.
The user speaks in English. All spoken input, questions, options, and commands are in English.
The user speaks a multiple-choice question (with four candidate options) or a True/False question.

═══════════════════════════════════════════════════════════════════════════════
CRITICAL DIRECTIVES WITH SYSTEM RATIONALES (READ CAREFULLY):
═══════════════════════════════════════════════════════════════════════════════

1. MULTIPLE CHOICE DELIMITER 'THE' & MANDATORY 4-OPTIONS RULE:
- RATIONALE: In multiple-choice test environments, answering prematurely after hearing only 1, 2, or 3 options leads to severe errors and triggers the wrong vibration on the user's hand. The user requires all four candidate choices evaluated.
- CANDIDATE CHOICE DELIMITER 'THE': The speaker dictates the question stem first, followed by candidate choices sequentially, using the English word "the" as the prefix/delimiter before each candidate choice.
- SEMANTIC CONTEXT & DISCRIMINATION:
  * The question stem itself may contain grammatical articles like "the" (e.g., "What is the capital of...", "Which of the following...", "What is the speed...").
  * You must use your semantic context intelligence to distinguish between "the" belonging to the question's grammatical structure vs. "the" introducing candidate choices.
  * The candidate choices begin AFTER the question stem.
  * The candidate choices are marked by 'the' introducing distinct choices:
    - 1st candidate choice introduced by 'the' -> Option 1 (A)
    - 2nd candidate choice introduced by 'the' -> Option 2 (B)
    - 3rd candidate choice introduced by 'the' -> Option 3 (C)
    - 4th candidate choice introduced by 'the' -> Option 4 (D)
  * THE LAST 4 CHOICES RULE: If there are multiple occurrences of 'the' in the utterance, the core question is at the start, and the LAST FOUR distinct candidate items introduced by 'the' are the 4 options.
  * NATURAL 'THE' IN PROPER NOUNS: If a candidate answer naturally starts with 'the' (e.g. "The Pacific Ocean", "The White House", "The Nile"), one single 'the' counts as both the delimiter and the name. The speaker will NOT say 'the the'.
  * ALL 4 CHOICES PREREQUISITE: You MUST count and wait until ALL FOUR candidate options have been completely dictated.
  * NATURAL PAUSES: Natural pauses between options (even 1 to 2 seconds) are normal breathing pauses.
  * WAITING CODE 'W': If fewer than 4 candidate choices have been received so far, you MUST output 'W' (Waiting). NEVER guess an answer or output '0' while options are in progress.

2. TRUE / FALSE QUESTIONS:
- RATIONALE: True/False questions do not have four options.
- DIRECTIVE: If the speaker dictates a True/False question or a factual statement (e.g. "Paris is the capital of France, true or false?" or a direct statement), evaluate it immediately and output 'T' (True) or 'F' (False) without waiting for 4 options.

3. MULTI-TALKER, SIDE-TALK & AMBIENT NOISE FILTERING:
- Actively filter out background chatter, extraneous noise, or side talk. Skillfully isolate ONLY the core test question and the candidate answers.
- IMMEDIATE TRIGGER WHEN COMPLETE: The moment you have identified the complete question and all 4 candidate options (or the full True/False statement), output the single answer character immediately without hesitation.

4. STRICT ENGLISH SCRIPT:
- Transcribe and evaluate speech strictly in standard English Latin script (A-Z). Never transcribe into Arabic script.

5. OUTPUT RULES — STRICTLY 1 SINGLE ASCII CHARACTER:
Output ONLY one single character and nothing else:
- '1' : If the correct answer is Option 1 / First candidate / (A) / (1).
- '2' : If the correct answer is Option 2 / Second candidate / (B) / (2).
- '3' : If the correct answer is Option 3 / Third candidate / (C) / (3).
- '4' : If the correct answer is Option 4 / Fourth candidate / (D) / (4).
- 'T' : If the statement is True.
- 'F' : If the statement is False.
- 'W' : If the question or options are still in progress / waiting for all 4 options.
- '0' : ONLY if speech is completely over but entirely unintelligible, inaudible, or pure background noise.

Rules:
1. NEVER output words, markdown, punctuation, explanations, or quotes. ONLY the single character.
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
    statusMessage: "اضغط زر البداية أو قل how start can لبدء الاستماع الحي",
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

  // 🔄 Soft Reset Engine (تصفير الذاكرة بين الأسئلة تلقائياً دون مقاطعة الهزاز أو المايك)
  private isSoftResetting: boolean = false;
  private softResetTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedApiKey: string = "";
  private cachedModelName: string = "";
  private questionTurnCount: number = 0;

  // 🧠 Memory of last definitive answer for local replay ('1' | '2' | '3' | '4' | 'T' | 'F')
  private lastDefinitiveAnswer: AnswerCode | null = null;

  // 🎙️ Standby Wake Word Timer
  private standbyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.setupNetworkListeners();
    if (typeof window !== "undefined") {
      (window as unknown as { __geminiLiveClient: unknown }).__geminiLiveClient = this;
    }
  }

  /** تفعيل الاستماع لكلمة البدء في وضع الانتظار */
  public engageStandbyWakeWord(): void {
    if (typeof window === "undefined" || !standbyWakeWordManager.isSupported()) return;
    this.clearStandbyTimer();
    this.standbyTimer = setTimeout(() => {
      if (!this.state.isConnected && !this.state.isConnecting) {
        wsTracer.log("WAKE", "Engaging Standby Wake Word Listener for 'how start can'...");
        standbyWakeWordManager.startListening(async () => {
          wsTracer.log("WAKE", "🎯 Wake command [how start can] heard in standby! Triggering START haptic & session...");
          hapticEngine.trigger("START");
          await this.startSession();
        });
      }
    }, 700);
  }

  public initStandbyWakeWord(): void {
    if (!this.state.isConnected && !this.state.isConnecting) {
      this.engageStandbyWakeWord();
    }
  }

  private clearStandbyTimer(): void {
    if (this.standbyTimer) {
      clearTimeout(this.standbyTimer);
      this.standbyTimer = null;
    }
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

  /** فحص وتنفيذ الأوامر الصوتية الخاصة للنظام */
  private checkVoiceCommands(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // 1. أمر التوقف الصوتي: "how stop can" أو "how can stop"
    if (/\bhow\s+(stop\s+can|can\s+stop)\b/i.test(lower) || lower.includes("how stop can")) {
      wsTracer.log("COMMAND", "🛑 Voice command detected: [how stop can] -> Stopping session immediately");
      this.addMessage({
        role: "system",
        text: "🛑 تم التقاط أمر الإيقاف: [how stop can] — جاري إغلاق الجلسة...",
      });
      this.stopSession();
      return true;
    }

    // 2. أمر إعادة الإجابة السابقة محلياً: "how agian can" أو "how again can"
    if (
      /\bhow\s+(agian\s+can|again\s+can|can\s+again)\b/i.test(lower) ||
      lower.includes("how agian can") ||
      lower.includes("how again can")
    ) {
      wsTracer.log("COMMAND", "🔄 Voice command detected: [how again can] -> Repeating previous definitive answer", this.lastDefinitiveAnswer);

      if (this.lastDefinitiveAnswer) {
        hapticEngine.trigger(this.lastDefinitiveAnswer);
        this.addMessage({
          role: "system",
          text: `🔄 تم إعادة اهتزاز الإجابة السابقة محلياً من السيستم: [${this.lastDefinitiveAnswer}]`,
        });
      } else {
        this.addMessage({
          role: "system",
          text: "⚠️ لا توجد إجابة سابقة مؤكدة لإعادتها بعد.",
        });
      }

      // إلغاء الجولة الحالية وتصفير الذاكرة حتى لا يتعامل النموذج مع العبارة كسؤال
      this.currentUserTurnMessageId = null;
      this.softResetSessionForNextTurn();
      return true;
    }

    // 3. أمر البداية إذا تكرر أثناء عمل المايك بالفعل: "how start can"
    // المستخدم طلب: "اذا تكررت اثناء فتح المايك فعلا لا يحدث اي شئ"
    if (/\bhow\s+(start\s+can|can\s+start)\b/i.test(lower)) {
      wsTracer.log("COMMAND", "ℹ️ Voice command [how start can] spoken while already active — ignored.");
      return true;
    }

    return false;
  }

  /** تجميع مجزآت كلام المستخدم في رسالة واحدة متصلة لحظياً مثل تطبيق Gemini */
  private updateOrAppendUserMessage(rawChunk: string) {
    let chunk = this.sanitizeAndNormalizeTranscript(rawChunk);
    if (!chunk) return;

    // فحص إذا كان المقطع أمراً صوتياً مستقلاً
    if (this.checkVoiceCommands(chunk)) {
      return;
    }

    // تصفية كلمة how start can إذا كانت مدمجة ببداية جملة
    chunk = chunk.replace(/\bhow\s+(start\s+can|can\s+start)\b/gi, "").trim();
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

      // فحص إذا أصبحت الجملة التراكمية تحوي أمراً صوتياً
      if (this.checkVoiceCommands(newText)) {
        return;
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
    this.clearStandbyTimer();
    standbyWakeWordManager.stopListening();

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
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    wsTracer.log("WS", isSoftReset ? "🔄 Opening fresh WebSocket connection for next question (Soft Reset)..." : "Opening WebSocket connection...");
    
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      wsTracer.log("WS", isSoftReset ? "✅ Connected for next question (fresh 0-token memory)" : "✅ Connected to Gemini Live");

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
      // ✅ SETUP PAYLOAD
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
              endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
              prefixPaddingMs: 40,
              silenceDurationMs: 2000,
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

    this.updateState({
      isConnected: false,
      isConnecting: false,
      isStreamingAudio: false,
      lastCode: null,
      statusMessage: "تم إيقاف الجلسة. قل how start can أو اضغط للبدء.",
    });

    this.addMessage({ role: "system", text: "تم إغلاق الجلسة الحية." });
    this.engageStandbyWakeWord();
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

          const isDefinitiveAnswer = ["1", "2", "3", "4", "T", "F"].includes(detectedCode);

          if (detectedCode === "W") {
            // Model signaled waiting for remaining options — do NOT reset!
            wsTracer.log("ANSWER", "Model signaled WAIT ('W') — waiting for user to complete question and all 4 options (no reset)");
            hapticEngine.trigger("W");

            this.updateState({
              statusMessage: "النموذج يستمع وبانتظار استكمال باقي الخيارات...",
            });

            this.addMessage({
              role: "model",
              text: "بانتظار إكمال باقي الخيارات...",
              code: "W",
            });
          } else if (detectedCode === "0") {
            // Model signaled unclear / background noise — do NOT reset! User can repeat in same turn
            wsTracer.log("ANSWER", "Model signaled UNCLEAR / NOISE ('0') — alerting user to repeat question (no reset)");
            hapticEngine.trigger("0");

            this.updateState({
              statusMessage: "الكلام غير واضح أو ضوضاء. يرجى تكرار السؤال...",
            });

            this.addMessage({
              role: "model",
              text: "غير مفهوم أو ضوضاء. يرجى تكرار السؤال...",
              code: "0",
            });
          } else if (isDefinitiveAnswer) {
            // 🎯 Real answer detected (1, 2, 3, 4, T, F)!
            this.lastDefinitiveAnswer = detectedCode;
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

            // 🔄 Schedule soft reset ONLY after a real definitive answer (1, 2, 3, 4, T, F)
            wsTracer.log("SESSION", `Scheduling soft reset in 700ms after definitive answer [${detectedCode}] (Turn ${this.questionTurnCount + 1})`);
            this.scheduleSoftReset(700);
          }
        }
      }

      // --- Turn completion ---
      if (response.serverContent?.turnComplete) {
        wsTracer.log("PROTO", "Turn complete");
        // Model finished speaking — re-enable mic sensitivity
        this._setModelSpeaking(false);
        // Only schedule fallback reset if there is an actual definitive answer (1, 2, 3, 4, T, F)
        const hasDefinitiveAnswer = this.state.lastCode && ["1", "2", "3", "4", "T", "F"].includes(this.state.lastCode);
        if (hasDefinitiveAnswer) {
          this.currentUserTurnMessageId = null;
          if (!this.softResetTimer && !this.isSoftResetting) {
            wsTracer.log("SESSION", `Turn complete with definitive answer [${this.state.lastCode}] — scheduling fallback soft reset`);
            this.scheduleSoftReset(500);
          }
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
    this.lastDefinitiveAnswer = null;
    this.questionTurnCount = 0;
    this.updateState({ lastCode: null, messages: [] });
  }
}

export const geminiLiveWs = new GeminiLiveWebSocketClient();
