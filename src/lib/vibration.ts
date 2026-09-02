/**
 * Haptic Vibration Engine for Deaf-Blind Tactile Communication
 */

export type AnswerCode = '1' | '2' | '3' | '4' | 'T' | 'F' | '0' | 'W' | 'START' | 'STOP' | 'PROCESSING' | 'ERROR';

export interface VibrationPatternConfig {
  pattern: number[];
  label: string;
  labelAr: string;
  descriptionAr: string;
}

export const VIBRATION_PATTERNS: Record<AnswerCode, VibrationPatternConfig> = {
  '1': {
    pattern: [350],
    label: 'Option 1 (A)',
    labelAr: 'الخيار (أ) / الأول',
    descriptionAr: 'هزة واحدة واضحة',
  },
  '2': {
    pattern: [300, 180, 300],
    label: 'Option 2 (B)',
    labelAr: 'الخيار (ب) / الثاني',
    descriptionAr: 'هزتان متتاليتان',
  },
  '3': {
    pattern: [280, 160, 280, 160, 280],
    label: 'Option 3 (C)',
    labelAr: 'الخيار (ج) / الثالث',
    descriptionAr: 'ثلاث هزات متتالية',
  },
  '4': {
    pattern: [250, 140, 250, 140, 250, 140, 250],
    label: 'Option 4 (D)',
    labelAr: 'الخيار (د) / الرابع',
    descriptionAr: 'أربع هزات متتالية',
  },
  'T': {
    pattern: [700],
    label: 'True / Yes',
    labelAr: 'صـح (True)',
    descriptionAr: 'هزة واحدة طويلة',
  },
  'F': {
    pattern: [450, 200, 450],
    label: 'False / No',
    labelAr: 'خـطـأ (False)',
    descriptionAr: 'هزتان طويلتان',
  },
  'W': {
    pattern: [50, 100, 50],
    label: 'Waiting for Options',
    labelAr: 'بانتظار إكمال السؤال والخيارات',
    descriptionAr: 'نبضتان خفيفتان تفيدان بأن النموذج يستمع وبانتظار باقي الخيارات',
  },
  '0': {
    pattern: [80, 70, 80, 70, 80, 70, 80, 70, 80],
    label: 'Unclear / Repeat',
    labelAr: 'غير مفهوم / أعد السؤال',
    descriptionAr: 'نبضات سريعة متتالية لتنبيه المستخدم بالإعادة',
  },
  'START': {
    pattern: [120],
    label: 'Start Listening',
    labelAr: 'بدء الاستماع',
    descriptionAr: 'نبضة خفيفة لتأكيد تشغيل المايك',
  },
  'STOP': {
    pattern: [80, 80, 80],
    label: 'Stop Listening',
    labelAr: 'إيقاف الاستماع',
    descriptionAr: 'نبضتان خفيفتان',
  },
  'PROCESSING': {
    pattern: [60, 100, 60],
    label: 'Processing',
    labelAr: 'جاري التحليل والتفكير',
    descriptionAr: 'نبضات ناعمة',
  },
  'ERROR': {
    pattern: [400, 100, 400],
    label: 'Error',
    labelAr: 'خطأ بالاتصال',
    descriptionAr: 'تنبيه اهتزازي بالخطأ',
  },
};

class HapticEngine {
  private isVibrationSupported: boolean = false;
  private audioCtx: AudioContext | null = null;
  private onVibrateCallback?: (isActive: boolean, code?: AnswerCode) => void;
  private speedMultiplier: number = 1.0;
  private soundSimulatorEnabled: boolean = true;
  private lastTriggeredCode: AnswerCode | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.isVibrationSupported = 'vibrate' in navigator;
    }
  }

  public setCallback(cb: (isActive: boolean, code?: AnswerCode) => void) {
    this.onVibrateCallback = cb;
  }

  public setSpeedMultiplier(multiplier: number) {
    this.speedMultiplier = Math.max(0.5, Math.min(2.0, multiplier));
  }

  public setSoundSimulator(enabled: boolean) {
    this.soundSimulatorEnabled = enabled;
  }

  public getLastTriggered(): AnswerCode | null {
    return this.lastTriggeredCode;
  }

  public isSupported(): boolean {
    return this.isVibrationSupported;
  }

  /**
   * Play vibration pattern with simulated web audio beeps if enabled
   */
  public trigger(code: AnswerCode): void {
    const config = VIBRATION_PATTERNS[code];
    if (!config) return;

    this.lastTriggeredCode = code;

    // Apply speed/duration multiplier
    const scaledPattern = config.pattern.map((dur) => Math.round(dur * this.speedMultiplier));

    // 1. Physical Vibration (Android / Supported devices)
    if (typeof window !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(scaledPattern);
      } catch (e) {
        console.warn('Navigator vibrate error:', e);
      }
    }

    // 2. Audio Beep Simulator (for testing & desktop devices)
    if (this.soundSimulatorEnabled && typeof window !== 'undefined') {
      this.playAudioBeeps(scaledPattern, code);
    }

    // 3. Trigger UI Visual Pulse Animation
    if (this.onVibrateCallback) {
      this.onVibrateCallback(true, code);
      const totalDuration = scaledPattern.reduce((acc, curr) => acc + curr, 0);
      setTimeout(() => {
        if (this.onVibrateCallback) {
          this.onVibrateCallback(false, code);
        }
      }, totalDuration);
    }
  }

  /**
   * Replays the last triggered code (e.g. on repeat)
   */
  public replayLast(): void {
    if (this.lastTriggeredCode) {
      this.trigger(this.lastTriggeredCode);
    } else {
      this.trigger('0');
    }
  }

  /**
   * Plays synchronized sound beeps matching the vibration pattern
   */
  private playAudioBeeps(pattern: number[], code: AnswerCode): void {
    try {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new AudioContextClass();
      }

      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      let currentTime = this.audioCtx.currentTime;
      const freq = code === '0' || code === 'ERROR' ? 220 : code === 'T' ? 660 : 440;

      for (let i = 0; i < pattern.length; i++) {
        const durationSec = pattern[i] / 1000;
        const isBuzz = i % 2 === 0; // Even indices are active vibration pulses

        if (isBuzz) {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();

          osc.type = code === '0' ? 'sawtooth' : 'sine';
          osc.frequency.setValueAtTime(freq, currentTime);

          gain.gain.setValueAtTime(0.3, currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, currentTime + durationSec);

          osc.connect(gain);
          gain.connect(this.audioCtx.destination);

          osc.start(currentTime);
          osc.stop(currentTime + durationSec);
        }

        currentTime += durationSec;
      }
    } catch (err) {
      console.warn('Audio feedback failed:', err);
    }
  }
}

export const hapticEngine = new HapticEngine();
