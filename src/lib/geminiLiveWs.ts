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
// 🔍 ERROR TRACER — نظام تتبع الأخطاء
// ═══════════════════════════════════════════
class WsErrorTracer {
  private logs: string[] = [];
  private maxLogs = 200;

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
      1006: "Abnormal Closure — انقطع الاتصال بشكل مفاجئ بلا رسالة إغلاق",
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

  dumpLogs(): void {
    console.group("📋 WS Error Tracer — Full Log Dump");
    this.logs.forEach((l) => console.log(l));
    console.groupEnd();
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
  }
}

export const wsTracer = new WsErrorTracer();

// ═══════════════════════════════════════════
// 📡 PAYLOAD VALIDATOR — التحقق قبل الإرسال
// ═══════════════════════════════════════════
function safeStringify(payload: unknown): string | null {
  try {
    const str = JSON.stringify(payload);
    // تحقق من أن JSON صالح بالكامل
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
The user will speak a multiple-choice question, true/false question, or ask to repeat/clarify.

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
- Say "0" : If the audio was unclear, inaudible, noisy, or incomplete.

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
  public async startSession(): Promise<boolean> {
    if (this.state.isConnected || this.state.isConnecting) return true;

    wsTracer.clear();
    wsTracer.log("SESSION", "Starting new session...");

    this.updateState({
      isConnecting: true,
      statusMessage: "جاري فتح اتصال الويب سوكت مع النموذج...",
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

        // Reset stats
        this.isSetupComplete = false;
        this.audioChunksSent = 0;
        this.messagesReceived = 0;

        this.updateState({
          isConnected: true,
          isConnecting: false,
          statusMessage: "جاري إرسال إعدادات الجلسة... انتظر لحظة",
        });

        hapticEngine.trigger("START");

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
                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                prefixPaddingMs: 30,
                silenceDurationMs: 400,
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
          text: "جاري تهيئة الجلسة مع النموذج...",
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
          // event.error is usually null in browser WS errors
        });
        hapticEngine.trigger("ERROR");
        this.updateState({ statusMessage: "حدث خطأ في اتصال الويب سوكت — راجع الكونسول" });
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
        });

        // ⚠️ تشخيص خاص بخطأ 1007
        if (event.code === 1007) {
          wsTracer.error("DIAG", `=== 1007 DIAGNOSIS ===`);
          const hints = wsTracer.diagnose1007();
          hints.forEach((h) => wsTracer.error("DIAG", h));
          wsTracer.error("DIAG", `Last payload type sent before close: [${this.lastSentPayloadType}]`);
          wsTracer.error("DIAG", `Audio chunks sent before close: ${this.audioChunksSent}`);

          // طباعة كل اللوقات للمساعدة في التشخيص
          wsTracer.dumpLogs();
        }

        this.stopMicrophoneStream();
        this.stopPlaybackContext();
        wakeLockManager.releaseWakeLock();

        // عرض سبب الإغلاق من السيرفر إن وُجد (مفيد جداً لتشخيص 1007)
        const displayReason = event.reason
          ? `${event.code}: ${event.reason}`
          : `${event.code} — ${codeInfo}`;

        this.updateState({
          isConnected: false,
          isConnecting: false,
          isStreamingAudio: false,
          statusMessage: `⚠️ إغلاق الاتصال (${displayReason}). اضغط للبدء من جديد.`,
        });


        hapticEngine.trigger("STOP");
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
    wsTracer.log("SESSION", "Stopping session manually");
    if (this.ws) {
      this.ws.close(1000, "User stopped session");
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
        this.updateState({
          statusMessage: "متصل لحظياً. تكلم بالسؤال والخيارات...",
        });
        this.addMessage({
          role: "system",
          text: "تم فتح الاتصال الحي عبر الويب سوكت. المايك يستمع باستمرار...",
        });
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

      // --- Input Transcription (user speech) ---
      if (response.serverContent?.inputTranscription?.text) {
        const userText = response.serverContent.inputTranscription.text.trim();
        wsTracer.log("TRANSCRIPT", `User: "${userText}"`);
        if (userText) {
          this.addMessage({ role: "user", text: userText });
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

          hapticEngine.trigger(detectedCode);

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

      // --- Turn completion ---
      if (response.serverContent?.turnComplete) {
        wsTracer.log("PROTO", "Turn complete");
        // Model finished speaking — re-enable mic sensitivity
        this._setModelSpeaking(false);
        this.updateState({
          statusMessage: "جاهز للسؤال التالي. تكلم الآن...",
        });
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
    const match = upper.match(/^[1234TF0]$/);
    if (match) return match[0] as AnswerCode;

    const firstChar = upper.replace(/\s/g, "")[0];
    if (["1", "2", "3", "4", "T", "F", "0"].includes(firstChar)) {
      return firstChar as AnswerCode;
    }
    if (upper.includes("واحد") || upper.includes("أ") || upper.includes(" A ")) return "1";
    if (upper.includes("اثنين") || upper.includes("ب") || upper.includes(" B ")) return "2";
    if (upper.includes("ثلاثة") || upper.includes("ج") || upper.includes(" C ")) return "3";
    if (upper.includes("أربعة") || upper.includes("د") || upper.includes(" D ")) return "4";
    if (upper.includes("صح") || upper.includes("صواب") || upper.includes("TRUE")) return "T";
    if (upper.includes("خطأ") || upper.includes("غلط") || upper.includes("FALSE")) return "F";

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
    this.updateState({ messages: [] });
  }
}

export const geminiLiveWs = new GeminiLiveWebSocketClient();
