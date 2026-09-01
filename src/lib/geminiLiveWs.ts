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

const SYSTEM_INSTRUCTION = `
You are an ultra-fast tactical AI assistant designed specifically for a deaf-blind user communicating via haptic vibrations.
The user will speak a multiple-choice question, true/false question, or ask you to repeat/clarify.

Determine the single correct answer and respond immediately.

OUTPUT RULES - VERY STRICT:
OUTPUT EXACTLY ONE SINGLE CHARACTER AND NOTHING ELSE:
- '1' : If the correct answer is Option 1 / (أ) / (A) / First option.
- '2' : If the correct answer is Option 2 / (ب) / (B) / Second option.
- '3' : If the correct answer is Option 3 / (ج) / (C) / Third option.
- '4' : If the correct answer is Option 4 / (د) / (D) / Fourth option.
- 'T' : If the statement is True / صح / صواب.
- 'F' : If the statement is False / خطأ.
- '0' : If the audio was unclear, inaudible, noisy, or incomplete.

If the user asks "أعد الإجابة" or "كرر" (repeat), output the code of the last question.
NEVER output any words, pleasantries, punctuation, or markdown. Only the single character.
`;

export class GeminiLiveWebSocketClient {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private stateChangeCallback?: (state: LiveSessionState) => void;

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

  /**
   * Start Live WebSocket Session and Audio Stream
   */
  public async startSession(): Promise<boolean> {
    if (this.state.isConnected || this.state.isConnecting) return true;

    this.updateState({
      isConnecting: true,
      statusMessage: "جاري فتح اتصال الويب سوكت مع النموذج...",
    });

    try {
      // 1. Fetch API credentials from session config endpoint
      const configRes = await fetch("/api/session-config");
      const configData = await configRes.json();
      const apiKey = configData.apiKey;
      const modelName = configData.model || "models/gemini-2.5-flash-native-audio-latest";

      // 2. Request WakeLock to keep screen and connection alive
      await wakeLockManager.requestWakeLock();

      // 3. Connect to Gemini Multimodal Live WebSocket
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("WebSocket connected to Gemini Live");
        this.updateState({
          isConnected: true,
          isConnecting: false,
          statusMessage: "متصل لحظياً. المايكروفون يستمع للسؤال...",
        });

        // Haptic feedback confirming connection
        hapticEngine.trigger("START");

        // Send Setup Payload
        const setupPayload = {
          setup: {
            model: modelName,
            generationConfig: {
              responseModalities: ["TEXT"],
              temperature: 0.2,
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                prefixPaddingMs: 40,
                silenceDurationMs: 800,
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: SYSTEM_INSTRUCTION }],
            },
          },
        };

        this.ws?.send(JSON.stringify(setupPayload));

        this.addMessage({
          role: "system",
          text: "تم فتح الاتصال الحي عبر الويب سوكت. المايك يستمع باستمرار...",
        });

        // 4. Start Microphone Streaming (16kHz PCM)
        this.startMicrophoneStream();
      };

      this.ws.onmessage = (event) => {
        this.handleServerMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        hapticEngine.trigger("ERROR");
        this.updateState({
          statusMessage: "حدث خطأ في اتصال الويب سوكت",
        });
      };

      this.ws.onclose = (event) => {
        console.log("WebSocket Closed:", event.code, event.reason);
        this.stopMicrophoneStream();
        wakeLockManager.releaseWakeLock();
        this.updateState({
          isConnected: false,
          isConnecting: false,
          isStreamingAudio: false,
          statusMessage: "تم إغلاق الاتصال. اضغط للبدء من جديد.",
        });
        hapticEngine.trigger("STOP");
      };

      return true;
    } catch (err: any) {
      console.error("Failed to start live session:", err);
      hapticEngine.trigger("ERROR");
      this.updateState({
        isConnecting: false,
        isConnected: false,
        statusMessage: "فشل بدء الاتصال. يرجى مراجعة المفتاح أو المايكروفون.",
      });
      return false;
    }
  }

  /**
   * Stop the Live Session and close WebSocket
   */
  public stopSession(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.stopMicrophoneStream();
    wakeLockManager.releaseWakeLock();
    hapticEngine.trigger("STOP");

    this.updateState({
      isConnected: false,
      isConnecting: false,
      isStreamingAudio: false,
      statusMessage: "تم إيقاف الجلسة",
    });

    this.addMessage({
      role: "system",
      text: "تم إغلاق الجلسة الحية.",
    });
  }

  /**
   * Handle incoming messages from Gemini Live WebSocket
   */
  private handleServerMessage(data: string) {
    try {
      const response = JSON.parse(data);

      // 1. Check for user audio transcription (STT)
      if (response.serverContent?.userTurn?.parts) {
        for (const part of response.serverContent.userTurn.parts) {
          if (part.text && part.text.trim()) {
            this.addMessage({
              role: "user",
              text: part.text.trim(),
            });
          }
        }
      }

      // 2. Check for model generated output
      if (response.serverContent?.modelTurn?.parts) {
        for (const part of response.serverContent.modelTurn.parts) {
          if (part.text) {
            const rawText = part.text.trim();
            const upper = rawText.toUpperCase();
            
            // Extract the target code
            let detectedCode: AnswerCode = "0";
            const match = upper.match(/[1234TF0]/);
            if (match) {
              detectedCode = match[0] as AnswerCode;
            } else if (upper.includes("أ") || upper.includes("A")) {
              detectedCode = "1";
            } else if (upper.includes("ب") || upper.includes("B")) {
              detectedCode = "2";
            } else if (upper.includes("ج") || upper.includes("C")) {
              detectedCode = "3";
            } else if (upper.includes("د") || upper.includes("D")) {
              detectedCode = "4";
            } else if (upper.includes("صح") || upper.includes("TRUE")) {
              detectedCode = "T";
            } else if (upper.includes("خطأ") || upper.includes("FALSE")) {
              detectedCode = "F";
            }

            // TRIGGER HAPTIC ENGINE IMMEDIATELY! 📳
            hapticEngine.trigger(detectedCode);

            this.updateState({
              lastCode: detectedCode,
              statusMessage: `تم تحديد الإجابة: [${detectedCode}] - تم إرسال الهزاز`,
            });

            this.addMessage({
              role: "model",
              text: `الإجابة المحددة: [${detectedCode}]`,
              code: detectedCode,
            });
          }
        }
      }
    } catch (e) {
      console.warn("Failed to parse live server message:", e);
    }
  }

  /**
   * Start capturing microphone and downsampling to 16kHz PCM chunks
   */
  private async startMicrophoneStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.mediaStream = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();

      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;

      // ScriptProcessorNode for real-time PCM streaming
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);

      const inputSampleRate = this.audioContext.sampleRate;
      const targetSampleRate = 16000;

      this.processorNode.onaudioprocess = (e) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // 1. Resample from hardware sampleRate to 16kHz
        const resampledData = this.resampleAudio(
          inputData,
          inputSampleRate,
          targetSampleRate
        );

        // 2. Convert Float32Array to 16-bit PCM (Int16Array)
        const pcm16 = new Int16Array(resampledData.length);
        for (let i = 0; i < resampledData.length; i++) {
          const s = Math.max(-1, Math.min(1, resampledData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // 3. Convert Int16Array to Base64
        const base64PCM = this.arrayBufferToBase64(pcm16.buffer);

        // 4. Send realtimeInput chunk over WebSocket
        const audioPayload = {
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm;rate=16000",
                data: base64PCM,
              },
            ],
          },
        };

        this.ws.send(JSON.stringify(audioPayload));
      };

      this.sourceNode.connect(this.analyser);
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);

      // Start audio visualizer
      this.startVisualizer();

      this.updateState({
        isStreamingAudio: true,
      });
    } catch (err) {
      console.error("Microphone capture failed:", err);
      hapticEngine.trigger("ERROR");
      this.updateState({
        statusMessage: "تعذر تشغيل المايكروفون. يرجى منح الإذن.",
      });
    }
  }

  /**
   * Stop microphone audio stream
   */
  private stopMicrophoneStream() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.updateState({
      isStreamingAudio: false,
      audioLevel: 0,
    });
  }

  /**
   * Visualizer level ticker
   */
  private startVisualizer() {
    if (!this.analyser) return;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const checkVolume = () => {
      if (!this.state.isStreamingAudio || !this.analyser) return;
      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;
      const normalized = Math.min(100, Math.round((avg / 128) * 100));

      this.updateState({ audioLevel: normalized });
      this.animFrameId = requestAnimationFrame(checkVolume);
    };

    checkVolume();
  }

  /**
   * Resamples Float32 audio buffer to 16,000 Hz
   */
  private resampleAudio(
    input: Float32Array,
    inputRate: number,
    targetRate: number
  ): Float32Array {
    if (inputRate === targetRate) return input;
    const ratio = inputRate / targetRate;
    const newLength = Math.round(input.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetInput = 0;

    while (offsetResult < result.length) {
      const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < input.length; i++) {
        accum += input[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetInput = nextOffsetInput;
    }

    return result;
  }

  /**
   * Helper to convert ArrayBuffer to Base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Clear Chat History
   */
  public clearChat() {
    this.updateState({ messages: [] });
  }
}

export const geminiLiveWs = new GeminiLiveWebSocketClient();
