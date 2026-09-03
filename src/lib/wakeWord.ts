/**
 * Standby Wake Word Listener for Deaf-Blind Tactile Assistant
 * Listens locally via Web Speech API when session is idle/stopped.
 * Triggers start when user says "how start can".
 */

export class StandbyWakeWordManager {
  private recognition: any = null;
  private isStandbyActive: boolean = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private onStartCallback: (() => void) | null = null;

  public isSupported(): boolean {
    if (typeof window === "undefined") return false;
    return !!(
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    );
  }

  public isListening(): boolean {
    return this.isStandbyActive;
  }

  public startListening(onStart: () => void): void {
    if (typeof window === "undefined" || !this.isSupported()) {
      return;
    }

    this.onStartCallback = onStart;
    this.isStandbyActive = true;
    this.clearRestartTimer();

    this.initAndStart();
  }

  public stopListening(): void {
    this.isStandbyActive = false;
    this.clearRestartTimer();

    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {
        // ignore already stopped
      }
      this.recognition = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private initAndStart(): void {
    if (!this.isStandbyActive) return;

    try {
      const SpeechRecognitionClass =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;

      if (!SpeechRecognitionClass) return;

      if (this.recognition) {
        try {
          this.recognition.stop();
        } catch {
          // ignore
        }
      }

      const recog = new SpeechRecognitionClass();
      recog.continuous = true;
      recog.interimResults = true;
      recog.lang = "en-US";
      recog.maxAlternatives = 1;

      recog.onresult = (event: any) => {
        if (!this.isStandbyActive) return;

        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          transcript += event.results[i][0].transcript;
        }

        const clean = transcript.toLowerCase().trim();

        // Check for wake command: "how start can" or "how can start"
        const isStartCommand =
          /\bhow\s+(start\s+can|can\s+start)\b/i.test(clean) ||
          clean.includes("how start can") ||
          clean.includes("how can start");

        if (isStartCommand) {
          this.stopListening();
          if (this.onStartCallback) {
            this.onStartCallback();
          }
        }
      };

      recog.onerror = (event: any) => {
        // Ignore expected non-fatal events like no-speech
        if (event.error === "no-speech" || event.error === "audio-capture") {
          return;
        }
      };

      recog.onend = () => {
        // If still in standby, restart to keep listening continuously
        if (this.isStandbyActive) {
          this.clearRestartTimer();
          this.restartTimer = setTimeout(() => {
            this.initAndStart();
          }, 400);
        }
      };

      recog.start();
      this.recognition = recog;
    } catch (e) {
      // Fallback: retry after a short pause if still active
      if (this.isStandbyActive) {
        this.clearRestartTimer();
        this.restartTimer = setTimeout(() => {
          this.initAndStart();
        }, 1000);
      }
    }
  }
}

export const standbyWakeWordManager = new StandbyWakeWordManager();
