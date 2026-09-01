import { hapticEngine, AnswerCode } from "./vibration";
import { wakeLockManager } from "./wakeLock";

export interface AudioProcessingState {
  isRecording: boolean;
  isProcessing: boolean;
  lastCode: AnswerCode | null;
  statusMessage: string;
  audioLevel: number;
}

export class AudioAssistantClient {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private audioStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private stateChangeCallback?: (state: AudioProcessingState) => void;

  private state: AudioProcessingState = {
    isRecording: false,
    isProcessing: false,
    lastCode: null,
    statusMessage: "اضغط الزر لبدء الاستماع للسؤال",
    audioLevel: 0,
  };

  public onStateChange(cb: (state: AudioProcessingState) => void) {
    this.stateChangeCallback = cb;
    cb(this.state);
  }

  private updateState(updates: Partial<AudioProcessingState>) {
    this.state = { ...this.state, ...updates };
    if (this.stateChangeCallback) {
      this.stateChangeCallback(this.state);
    }
  }

  public getState(): AudioProcessingState {
    return this.state;
  }

  /**
   * Start recording microphone audio
   */
  public async startListening(): Promise<boolean> {
    try {
      if (this.state.isRecording) return true;

      // Haptic confirmation of microphone activation
      hapticEngine.trigger('START');

      // Request screen wakelock so screen stays awake
      await wakeLockManager.requestWakeLock();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.audioStream = stream;
      this.audioChunks = [];

      // Setup audio level analyzer for visual feedback
      this.setupAudioAnalyzer(stream);

      // Determine supported mimeType
      const mimeTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg",
      ];
      let selectedMime = "";
      for (const m of mimeTypes) {
        if (MediaRecorder.isTypeSupported(m)) {
          selectedMime = m;
          break;
        }
      }

      this.mediaRecorder = selectedMime
        ? new MediaRecorder(stream, { mimeType: selectedMime })
        : new MediaRecorder(stream);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.processRecordedAudio();
      };

      this.mediaRecorder.start(250); // collect in 250ms chunks

      this.updateState({
        isRecording: true,
        isProcessing: false,
        statusMessage: "جاري الاستماع للسؤال والخيارات...",
      });

      return true;
    } catch (err: any) {
      console.error("Microphone error:", err);
      hapticEngine.trigger('ERROR');
      this.updateState({
        isRecording: false,
        isProcessing: false,
        statusMessage: "يرجى منح صلاحية المايكروفون",
      });
      return false;
    }
  }

  /**
   * Stop recording and immediately process audio with Gemini
   */
  public stopListening(): void {
    if (!this.state.isRecording || !this.mediaRecorder) return;

    hapticEngine.trigger('STOP');
    this.updateState({
      isRecording: false,
      isProcessing: true,
      statusMessage: "جاري تحليل السؤال واختيار الإجابة...",
    });

    if (this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => track.stop());
      this.audioStream = null;
    }

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
  }

  /**
   * Process the collected audio chunks
   */
  private async processRecordedAudio() {
    try {
      if (this.audioChunks.length === 0) {
        this.updateState({
          isProcessing: false,
          statusMessage: "لم يتم تسجيل أي صوت. اضغط وحاول ثانية.",
        });
        hapticEngine.trigger('0');
        return;
      }

      const mimeType = this.mediaRecorder?.mimeType || "audio/webm";
      const audioBlob = new Blob(this.audioChunks, { type: mimeType });

      // Convert audio blob to base64
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = (reader.result as string).split(",")[1];

        // Soft processing haptic feedback
        hapticEngine.trigger('PROCESSING');

        try {
          const response = await fetch("/api/gemini", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              audioBase64: base64Data,
              mimeType: mimeType,
            }),
          });

          const data = await response.json();
          const code = (data.code as AnswerCode) || "0";

          // Trigger Tactile Haptic Vibration Engine!
          hapticEngine.trigger(code);

          this.updateState({
            isProcessing: false,
            lastCode: code,
            statusMessage: `تم تحديد الإجابة: [${code}] - تم إرسال الهزازات`,
          });
        } catch (fetchErr) {
          console.error("Fetch Gemini error:", fetchErr);
          hapticEngine.trigger('ERROR');
          this.updateState({
            isProcessing: false,
            lastCode: '0',
            statusMessage: "خطأ في الاتصال بالنموذج. أعد المحاولة.",
          });
        }
      };

      reader.readAsDataURL(audioBlob);
    } catch (err) {
      console.error("Audio processing failed:", err);
      hapticEngine.trigger('ERROR');
      this.updateState({
        isProcessing: false,
        statusMessage: "حدث خطأ أثناء معالجة الصوت",
      });
    }
  }

  /**
   * Process custom text question directly (for testing without voice)
   */
  public async processTextQuestion(questionText: string): Promise<void> {
    this.updateState({
      isProcessing: true,
      statusMessage: "جاري تحليل السؤال النصي...",
    });
    hapticEngine.trigger('PROCESSING');

    try {
      const response = await fetch("/api/gemini", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: questionText,
        }),
      });

      const data = await response.json();
      const code = (data.code as AnswerCode) || "0";

      // Trigger Haptic Vibration Engine
      hapticEngine.trigger(code);

      this.updateState({
        isProcessing: false,
        lastCode: code,
        statusMessage: `تمت الإجابة: [${code}] - تم تفعيل الهزاز`,
      });
    } catch (err) {
      console.error("Text question error:", err);
      hapticEngine.trigger('ERROR');
      this.updateState({
        isProcessing: false,
        lastCode: '0',
        statusMessage: "خطأ في الاتصال",
      });
    }
  }

  /**
   * Setup Audio visualizer analyzer
   */
  private setupAudioAnalyzer(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkVolume = () => {
        if (!this.state.isRecording) return;
        this.analyser?.getByteFrequencyData(dataArray);
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
    } catch (e) {
      console.warn("Visualizer setup error:", e);
    }
  }
}

export const audioAssistant = new AudioAssistantClient();
