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
You are an ultra-fast tactical AI assistant designed specifically for a deaf-blind user communicating via tactile haptic vibrations on a mobile smartphone.
The user speaks in English. All spoken input, questions, options, and commands are in English.
The user receives output strictly as tactile physical vibrations (or mode confirmations) on the smartphone.

═══════════════════════════════════════════════════════════════════════════════
CRITICAL DIRECTIVES WITH SYSTEM RATIONALES (READ CAREFULLY):
═══════════════════════════════════════════════════════════════════════════════

1. SYSTEM PURPOSE & LATENCY PRINCIPLE:
- RATIONALE: The user cannot see or hear model explanations. Every unnecessary word or incorrect character creates confusing, wrong physical vibrations on the user's hand. Speed and precision are paramount.
- DIRECTIVE: Output ONLY the exact single character answer code ('1', '2', '3', '4', 'T', 'F', 'W', '0') or the exact mode acknowledgment token ('MODE:TF', 'MODE:MCQ'). Never output pleasantries, conversational speech, markdown, explanations, or quotes.

2. DYNAMIC MODE SWITCHING ('MODE:TF' vs 'MODE:MCQ'):
- RATIONALE: Exams often feature blocks of True/False questions followed by Multiple Choice questions. Explicit mode switching enables immediate, accurate answering without unnecessary option-waiting delays.
- SWITCH TO TRUE/FALSE MODE:
  * When the user dictates "True or false" (or "True and false", "T or F") as a mode instruction:
  * You MUST output strictly: MODE:TF
  * From this point forward, assume all subsequent utterances are True/False statements until switched.
- SWITCH TO MULTIPLE CHOICE (MCQ) MODE:
  * When the user dictates "the right answer", "correct", or "options" as a mode instruction:
  * You MUST output strictly: MODE:MCQ
  * From this point forward, expect multiple choice questions with candidate choices.

3. CANDIDATE CHOICES & MULTIPLE CHOICE QUESTIONS (MCQ):
- RATIONALE: When options are provided, answering prematurely after hearing only 1, 2, or 3 options triggers the wrong answer vibration. All candidate choices must be evaluated.
- CANDIDATE CHOICE DELIMITER 'THE': The speaker introduces candidate choices sequentially using the English prefix "the" before each choice, or standard enumerations (e.g. "Option A", "Option 1", "A", "B", etc.).
- SEMANTIC CONTEXT & DISCRIMINATION:
  * Distinguish between "the" belonging to the question's grammatical structure vs. "the" introducing candidate choices. The candidate choices begin AFTER the question stem.
  * 1st candidate choice -> Option 1 (A)
  * 2nd candidate choice -> Option 2 (B)
  * 3rd candidate choice -> Option 3 (C)
  * 4th candidate choice -> Option 4 (D)
  * NATURAL 'THE' IN PROPER NOUNS: If a candidate answer naturally starts with 'the' (e.g. "The Pacific Ocean", "The White House", "The Nile"), one single 'the' counts as both the delimiter and the name. The speaker will NOT say 'the the'.
- WAITING CODE 'W': If the speaker is dictating an MCQ question and has begun stating candidate choices, but has NOT yet completed all candidate choices, output 'W' (Waiting). NEVER guess an answer or output '0' while choices are in progress.

4. ABSENCE OF CHOICES = AUTOMATIC TRUE / FALSE EVALUATION:
- RATIONALE: In oral tests and classroom settings, if a speaker recites a question or factual statement without reciting ANY candidate options (no "the" options, no A/B/C/D, no 1/2/3/4), it is logically a True/False question because no alternative choices exist to choose from! Waiting for 4 choices in this case causes silent stalling and failure.
- DIRECTIVE:
  * If the speaker recites a question or statement and DOES NOT provide candidate choices by any method:
  * DO NOT wait for 4 options! DO NOT output 'W'!
  * Use your semantic intelligence: evaluate the factual truth of the statement or question immediately.
  * If True -> output 'T'.
  * If False -> output 'F'.
  * If the statement is completely incomplete (cut off mid-sentence without completing a thought) and no "done" is spoken, wait for the speaker to complete the sentence or say "done".

5. STAND-ALONE "DONE" AS END-OF-INPUT TRIGGER:
- RATIONALE: The user speaks the word "done" to eliminate silence latency and signal that dictation of the question and any options is 100% complete.
- CONTEXTUAL DISCRIMINATION:
  * STAND-ALONE CLOSING SIGNAL: If the word "done" appears at the end of the question or after the options without any further words spoken after it, it is a definitive CLOSING SIGNAL. Stop listening, evaluate all received text, and output the final answer code ('1', '2', '3', '4', 'T', or 'F') IMMEDIATELY without hesitation.
  * GRAMMATICAL / IN-SENTENCE "DONE": If "done" is part of the grammatical sentence structure (e.g. "Has the work been done?", "The experiment was done by Newton", "well done"), or if the speaker continues dictating additional words after "done", treat it as a standard word within the question text and do NOT treat it as a closing signal.

6. MULTI-TALKER, SIDE-TALK & AMBIENT NOISE FILTERING:
- Actively filter out background chatter, room noise, and side talk. Skillfully isolate ONLY the core test question and the candidate answers.
- IMMEDIATE TRIGGER WHEN COMPLETE: The moment you have identified the complete question and candidate options (or the True/False statement), output the single answer character immediately.
- UNCLEAR / NOISE CODE '0': Output '0' ONLY if speech is completely over but entirely unintelligible, inaudible, or pure background noise.

7. STRICT ENGLISH SCRIPT:
- Transcribe and evaluate speech strictly in standard English Latin script (A-Z). Never transcribe into Arabic script.

8. OUTPUT RULES — STRICTLY 1 SINGLE ASCII CHARACTER OR MODE TOKEN:
Output ONLY one of the following tokens and NOTHING else:
- '1' : Correct answer is Option 1 / First candidate / (A) / (1).
- '2' : Correct answer is Option 2 / Second candidate / (B) / (2).
- '3' : Correct answer is Option 3 / Third candidate / (C) / (3).
- '4' : Correct answer is Option 4 / Fourth candidate / (D) / (4).
- 'T' : If the statement is True.
- 'F' : If the statement is False.
- 'W' : If candidate choices have begun but are still in progress / waiting for remaining options.
- '0' : ONLY if speech is completely over but entirely unintelligible, inaudible, or pure background noise.
- 'MODE:TF'  : Acknowledged switch to True/False mode.
- 'MODE:MCQ' : Acknowledged switch to Multiple Choice mode.

Rules:
1. NEVER output words, markdown, punctuation, explanations, or quotes. ONLY the single character or mode token.
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
  private selectedThinkingBudget: number | "dynamic" = 2000;

  // 🎯 Question Mode Engine (AUTO | TRUE_FALSE | MCQ)
  private currentQuestionMode: QuestionMode = "AUTO";

  private state: LiveSessionState = {
    isConnected: false,
    isConnecting: false,
    isStreamingAudio: false,
    audioLevel: 0,
    lastCode: null,
    statusMessage: "اضغط زر البداية أو قل where start can لبدء الاستماع الحي",
    messages: [],
    questionMode: "AUTO",
    voiceName: "Aoede",
    thinkingBudget: 2000,
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

  /** تفعيل الاستماع لكلمة البدء في وضع الانتظار */
  public engageStandbyWakeWord(): void {
    if (typeof window === "undefined" || !standbyWakeWordManager.isSupported()) return;
    this.clearStandbyTimer();
    this.standbyTimer = setTimeout(() => {
      if (!this.state.isConnected && !this.state.isConnecting) {
        wsTracer.log("WAKE", "Engaging Standby Wake Word Listener for 'where start can'...");
        standbyWakeWordManager.startListening(async () => {
          wsTracer.log("WAKE", "🎯 Wake command [where start can] heard in standby! Triggering START haptic & session...");
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

    // 1. أمر التوقف الصوتي: "where stop can" أو "where can stop" (مع دعم how كاحتياطي)
    const isStopCommand =
      /\b(where|how)\s+(stop\s+can|can\s+stop)\b/i.test(lower) ||
      lower.includes("where stop can") ||
      lower.includes("where can stop") ||
      lower.includes("how stop can");

    if (isStopCommand) {
      wsTracer.log("COMMAND", "🛑 Voice command detected: [where stop can] -> Stopping session immediately");
      this.addMessage({
        role: "system",
        text: "🛑 تم التقاط أمر الإيقاف: [where stop can] — جاري إغلاق الجلسة...",
      });
      this.stopSession();
      return true;
    }

    // 2. أمر إعادة الإجابة السابقة محلياً: "where agian can" أو "where again can" أو "where can again"
    const isRepeatCommand =
      /\b(where|how)\s+(agian\s+can|again\s+can|can\s+again)\b/i.test(lower) ||
      lower.includes("where agian can") ||
      lower.includes("where again can") ||
      lower.includes("where can again") ||
      lower.includes("how agian can") ||
      lower.includes("how again can");

    if (isRepeatCommand) {
      wsTracer.log("COMMAND", "🔄 Voice command detected: [where again can] -> Repeating previous definitive answer", this.lastDefinitiveAnswer);

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

    // 3. أمر البداية إذا تكرر أثناء عمل المايك بالفعل: "where start can" أو "where can start"
    // يتم تجاهلها تماماً حتى لا تؤثر على النموذج
    const isStartCommand =
      /\b(where|how)\s+(start\s+can|can\s+start)\b/i.test(lower) ||
      lower.includes("where start can") ||
      lower.includes("where can start") ||
      lower.includes("how start can");

    if (isStartCommand) {
      wsTracer.log("COMMAND", "ℹ️ Voice command [where start can] spoken while already active — ignored.");
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

    // تصفية كلمة البدء إذا كانت مدمجة ببداية جملة
    chunk = chunk.replace(/\b(where|how)\s+(start\s+can|can\s+start)\b/gi, "").trim();
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
              endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
              prefixPaddingMs: 300,
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

    this.currentQuestionMode = "AUTO";

    this.updateState({
      isConnected: false,
      isConnecting: false,
      isStreamingAudio: false,
      lastCode: null,
      statusMessage: "تم إيقاف الجلسة. قل where start can أو اضغط للبدء.",
      questionMode: "AUTO",
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

        // 🔒 LANGUAGE & MODE ANCHOR CONTEXT SEEDING (تثبيت لغة الاستماع ونمط الأسئلة الحالي عبر الجلسات)
        let modeHint = "";
        if (this.currentQuestionMode === "TRUE_FALSE") {
          modeHint = " Active Question Mode: TRUE/FALSE. All upcoming questions are True/False statements until switched. Evaluate statements immediately as T or F without waiting for candidate options.";
        } else if (this.currentQuestionMode === "MCQ") {
          modeHint = " Active Question Mode: MULTIPLE CHOICE. Expect questions with candidate choices.";
        } else {
          modeHint = " Active Question Mode: AUTO. If candidate choices are provided, treat as Multiple Choice. If no choices are provided, evaluate as True/False.";
        }

        const languageAnchorPayload = {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: `Language & Mode Lock: All questions and multiple-choice options in this conversation are strictly in English. Transcribe speech strictly in standard English Latin alphabet.${modeHint}`,
                  },
                ],
              },
              {
                role: "model",
                parts: [
                  {
                    text: `Understood. Speech recognition is locked to English Latin text.${modeHint}`,
                  },
                ],
              },
            ],
            turnComplete: false,
          },
        };
        wsTracer.log("SETUP", "Sending English Language & Mode Anchor turn to lock STT into English and active mode", { mode: this.currentQuestionMode });
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

      // ⚡ Interrupted by server (barge-in triggered by user speaking while model is speaking)
      if (response.serverContent?.interrupted) {
        wsTracer.log("BARGE_IN", "⚡ Server interrupted event (Barge-in) — stopping model playback immediately");
        this.stopAllBufferedAudio();
        this.currentUserTurnMessageId = null;

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
        const modelText = response.serverContent.outputTranscription.text.trim();
        wsTracer.log("TRANSCRIPT", `Model: "${modelText}"`);
        if (modelText) {
          const detectedCode = this.extractAnswerCode(modelText);
          wsTracer.log("ANSWER", `Detected code: [${detectedCode}] from "${modelText}"`);

          // 1. Mode Switching confirmations from Model
          if (detectedCode === "MODE_TF") {
            wsTracer.log("MODE", "🎯 Model acknowledged switch to True/False mode");
            this.currentQuestionMode = "TRUE_FALSE";
            this.currentUserTurnMessageId = null;
            hapticEngine.trigger("T");

            this.updateState({
              questionMode: "TRUE_FALSE",
              statusMessage: "🎯 تم تفعيل نمط: صح وخطأ (True / False)",
            });

            this.addMessage({
              role: "model",
              text: "🎯 تم تفعيل نمط أسئلة (صح وخطأ) لجميع الأسئلة القادمة.",
            });

            // Clean reset to prime new session in True/False mode
            this.scheduleSoftReset(700);
            return;
          }

          if (detectedCode === "MODE_MCQ") {
            wsTracer.log("MODE", "🎯 Model acknowledged switch to Multiple Choice (MCQ) mode");
            this.currentQuestionMode = "MCQ";
            this.currentUserTurnMessageId = null;
            hapticEngine.trigger("START");

            this.updateState({
              questionMode: "MCQ",
              statusMessage: "🎯 تم تفعيل نمط: خيارات متعددة (MCQ)",
            });

            this.addMessage({
              role: "model",
              text: "🎯 تم تفعيل نمط أسئلة (الخيارات المتعددة) لجميع الأسئلة القادمة.",
            });

            // Clean reset to prime new session in MCQ mode
            this.scheduleSoftReset(700);
            return;
          }

          const isDefinitiveAnswer = ["1", "2", "3", "4", "T", "F"].includes(detectedCode);

          if (detectedCode === "W") {
            // Model signaled waiting for remaining options — do NOT reset!
            wsTracer.log("ANSWER", "Model signaled WAIT ('W') — waiting for user to complete question and options (no reset)");
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
            // Model signaled unclear / background noise — Reset session cleanly so user's retry starts with 100% clean context!
            wsTracer.log("ANSWER", "Model signaled UNCLEAR / NOISE ('0') — triggering '0' haptic and scheduling soft reset to clean memory");
            this.lastDefinitiveAnswer = "0";
            hapticEngine.trigger("0");

            // Close the current active user turn so the NEXT question starts a fresh bubble
            this.currentUserTurnMessageId = null;

            this.updateState({
              lastCode: "0",
              statusMessage: "الكلام غير واضح أو ضوضاء [0] — تم تصفير الذاكرة، أعد السؤال الآن...",
            });

            this.addMessage({
              role: "model",
              text: "غير مفهوم أو ضوضاء [0]. تم تجديد الجلسة، يرجى تكرار السؤال...",
              code: "0",
            });

            // 🔄 Schedule soft reset immediately to purge unclear context
            wsTracer.log("SESSION", `Scheduling soft reset in 800ms after '0' signal to clean memory context (Turn ${this.questionTurnCount + 1})`);
            this.scheduleSoftReset(800);
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
        // Only schedule fallback reset if there is an actual definitive answer or '0'
        const hasDefinitiveAnswer = this.state.lastCode && ["1", "2", "3", "4", "T", "F", "0"].includes(this.state.lastCode);
        if (hasDefinitiveAnswer) {
          this.currentUserTurnMessageId = null;
          if (!this.softResetTimer && !this.isSoftResetting) {
            wsTracer.log("SESSION", `Turn complete with definitive answer or [0] [${this.state.lastCode}] — scheduling fallback soft reset`);
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

  /** Extract single answer code or mode command from model spoken text */
  private extractAnswerCode(text: string): AnswerCode | "MODE_TF" | "MODE_MCQ" {
    const upper = text.toUpperCase().trim();

    // 1. Detect Mode Switch acknowledgment tokens
    if (upper.includes("MODE:TF") || upper.includes("MODE_TF") || upper.includes("[MODE:TF]")) {
      return "MODE_TF";
    }
    if (upper.includes("MODE:MCQ") || upper.includes("MODE_MCQ") || upper.includes("[MODE:MCQ]")) {
      return "MODE_MCQ";
    }

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
