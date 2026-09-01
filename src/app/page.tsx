"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Sliders,
  Sparkles,
  Smartphone,
  RotateCcw,
  Info,
  MessageSquare,
  Trash2,
  Radio,
  User,
  Bot,
} from "lucide-react";
import {
  hapticEngine,
  VIBRATION_PATTERNS,
  AnswerCode,
} from "@/lib/vibration";
import {
  geminiLiveWs,
  LiveSessionState,
  ChatMessage,
} from "@/lib/geminiLiveWs";

export default function Home() {
  const [sessionState, setSessionState] = useState<LiveSessionState>({
    isConnected: false,
    isConnecting: false,
    isStreamingAudio: false,
    audioLevel: 0,
    lastCode: null,
    statusMessage: "اضغط زر البداية في المنتصف لفتح الاتصال الحي والاستماع",
    messages: [],
  });

  const [isVibrating, setIsVibrating] = useState<boolean>(false);
  const [activeVibrateCode, setActiveVibrateCode] = useState<AnswerCode | null>(null);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [vibrationSpeed, setVibrationSpeed] = useState<number>(1.0);
  const [hasVibrationAPI, setHasVibrationAPI] = useState<boolean>(true);
  const [showTester, setShowTester] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 1. Subscribe to Live WebSocket Session State
    geminiLiveWs.onStateChange((state: LiveSessionState) => {
      setSessionState(state);
    });

    // 2. Subscribe to Haptic Engine Pulses
    hapticEngine.setCallback((active: boolean, code?: AnswerCode) => {
      setIsVibrating(active);
      if (active && code) {
        setActiveVibrateCode(code);
      } else if (!active) {
        setActiveVibrateCode(null);
      }
    });

    // 3. Check Vibration API support
    if (typeof window !== "undefined") {
      setHasVibrationAPI("vibrate" in navigator);
    }

    // 4. Register PWA Service Worker
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.log("SW register error:", err);
      });
    }
  }, []);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessionState.messages]);

  // Handle Main Center Button Click (Start / Stop Persistent WebSocket Session)
  const handleMainButtonClick = async () => {
    if (sessionState.isConnecting) return;

    if (sessionState.isConnected) {
      geminiLiveWs.stopSession();
    } else {
      await geminiLiveWs.startSession();
    }
  };

  // Toggle Sound Beep Simulator
  const handleToggleSound = () => {
    const nextVal = !soundEnabled;
    setSoundEnabled(nextVal);
    hapticEngine.setSoundSimulator(nextVal);
  };

  // Change Vibration Speed Multiplier
  const handleSpeedChange = (multiplier: number) => {
    setVibrationSpeed(multiplier);
    hapticEngine.setSpeedMultiplier(multiplier);
  };

  // Test custom vibration code directly
  const testPattern = (code: AnswerCode) => {
    hapticEngine.trigger(code);
  };

  const currentPatternConfig = sessionState.lastCode
    ? VIBRATION_PATTERNS[sessionState.lastCode]
    : null;

  return (
    <main className="flex-1 flex flex-col min-h-screen bg-[#090D16] text-slate-100 selection:bg-cyan-500 selection:text-black">
      {/* Top App Bar */}
      <header className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between backdrop-blur-md bg-[#090D16]/80 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              بصيرة لمسية <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1">
                <Radio className="w-3 h-3 animate-pulse text-emerald-400" />
                Live WebSocket
              </span>
            </h1>
            <p className="text-xs text-slate-400">مساعد الصم والمكفوفين الذكي</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Sound Simulator Button */}
          <button
            onClick={handleToggleSound}
            title={soundEnabled ? "صوت النبضات مفعل" : "صوت النبضات معطل"}
            className={`p-2.5 rounded-xl border transition-all ${
              soundEnabled
                ? "bg-cyan-950/40 border-cyan-500/40 text-cyan-400"
                : "bg-slate-900 border-slate-800 text-slate-500"
            }`}
          >
            {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>

          {/* Settings Toggle */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2.5 rounded-xl border transition-all ${
              showSettings
                ? "bg-amber-950/40 border-amber-500/40 text-amber-400"
                : "bg-slate-900 border-slate-800 text-slate-400"
            }`}
          >
            <Sliders className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 max-w-lg mx-auto w-full">
        
        {/* Device Vibration Support Badge */}
        {!hasVibrationAPI && (
          <div className="w-full mb-4 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
            <Info className="w-4 h-4 shrink-0" />
            <span>الجهاز الحالي لا يدعم الهزاز الفيزيائي. تم تفعيل المحاكي الصوتي والمرئي للنبضات.</span>
          </div>
        )}

        {/* Current State / Feedback Display */}
        <div className="text-center mb-6 w-full">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-slate-900/90 border border-slate-800 text-slate-300 text-sm mb-3">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                sessionState.isConnected
                  ? "bg-emerald-400 animate-ping"
                  : sessionState.isConnecting
                  ? "bg-amber-400 animate-pulse"
                  : "bg-slate-500"
              }`}
            />
            {sessionState.isConnected
              ? "الاتصال الحي مفتوح • المايكروفون يستمع"
              : sessionState.isConnecting
              ? "جاري فتح اتصال الويب سوكت..."
              : "غير متصل (اضغط للبدء)"}
          </div>

          <p className="text-base sm:text-lg font-medium text-slate-200 px-4">
            {sessionState.statusMessage}
          </p>
        </div>

        {/* ==================================================== */}
        {/* THE MAIN CENTRAL TACTILE BUTTON (زر البداية/الإيقاف) */}
        {/* ==================================================== */}
        <div className="relative flex items-center justify-center my-4">
          {/* Continuous Ripple Wave Rings when Live Connected */}
          {sessionState.isConnected && (
            <>
              <div className="absolute w-72 h-72 rounded-full border-2 border-emerald-500/30 animate-ping opacity-60 pointer-events-none" />
              <div className="absolute w-88 h-88 rounded-full border border-emerald-500/20 animate-pulse pointer-events-none" />
            </>
          )}

          {/* Vibration Active Glow */}
          {isVibrating && (
            <div className="absolute -inset-4 rounded-full bg-cyan-400/30 blur-xl animate-pulse pointer-events-none" />
          )}

          <button
            id="main-tactile-btn"
            onClick={handleMainButtonClick}
            disabled={sessionState.isConnecting}
            className={`relative w-64 h-64 sm:w-72 sm:h-72 rounded-full flex flex-col items-center justify-center gap-3 transition-all transform active:scale-95 select-none focus:outline-none ${
              sessionState.isConnected
                ? "bg-gradient-to-b from-emerald-600 to-teal-800 tactile-glow-emerald ring-4 ring-emerald-400/50"
                : sessionState.isConnecting
                ? "bg-gradient-to-b from-amber-600 to-amber-700 tactile-glow-amber ring-4 ring-amber-400/50"
                : isVibrating
                ? "bg-gradient-to-b from-cyan-400 to-blue-600 tactile-glow ring-4 ring-cyan-300"
                : "bg-gradient-to-b from-cyan-600 to-blue-800 tactile-glow ring-2 ring-cyan-500/40 hover:ring-cyan-400"
            }`}
          >
            {/* Big Center Icon */}
            <div className="p-4 rounded-full bg-black/20 backdrop-blur-sm">
              {sessionState.isConnected ? (
                <Mic className="w-16 h-16 text-white animate-bounce" />
              ) : sessionState.isConnecting ? (
                <RotateCcw className="w-16 h-16 text-white animate-spin" />
              ) : (
                <MicOff className="w-16 h-16 text-white" />
              )}
            </div>

            {/* Action Text inside Button */}
            <div className="text-center px-4">
              <span className="block text-2xl font-black text-white tracking-wider">
                {sessionState.isConnected
                  ? "متصل (اضغط للإغلاق)"
                  : sessionState.isConnecting
                  ? "جاري الاتصال..."
                  : "اضغط لبدء الجلسة"}
              </span>
              <span className="text-xs text-white/80 font-medium">
                {sessionState.isConnected
                  ? "تكلم بالسؤال وسيهتز الهاتف بالإجابة"
                  : "يفتح اتصال ويب سوكت مستمر"}
              </span>
            </div>

            {/* Live Audio Level indicator bar inside button */}
            {sessionState.isConnected && (
              <div className="w-32 h-1.5 bg-black/40 rounded-full overflow-hidden mt-1">
                <div
                  className="h-full bg-white transition-all duration-75"
                  style={{ width: `${Math.min(100, sessionState.audioLevel * 1.5)}%` }}
                />
              </div>
            )}
          </button>
        </div>

        {/* Last Detected Answer Code Card */}
        {sessionState.lastCode && currentPatternConfig && (
          <div className="w-full mt-4 p-4 rounded-2xl bg-slate-900/90 border border-cyan-500/40 shadow-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-cyan-500/20 border border-cyan-500/50 flex items-center justify-center text-2xl font-black text-cyan-400">
                {sessionState.lastCode}
              </div>
              <div>
                <p className="text-xs text-slate-400">آخر إجابة مستلمة</p>
                <p className="text-sm font-bold text-white">
                  {currentPatternConfig.labelAr}
                </p>
                <p className="text-xs text-cyan-300">
                  {currentPatternConfig.descriptionAr}
                </p>
              </div>
            </div>

            {/* Replay Vibration Button */}
            <button
              onClick={() => hapticEngine.replayLast()}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              إعادة الهزة
            </button>
          </div>
        )}

        {/* ==================================================== */}
        {/* LIVE CHAT & TRANSCRIPT LOG (سجل الشات المباشر) */}
        {/* ==================================================== */}
        <div className="w-full mt-6 p-4 rounded-3xl bg-slate-900/80 border border-slate-800 shadow-xl flex flex-col">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
            <h3 className="text-xs font-bold text-slate-200 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-cyan-400" />
              سجل الشات وتحويل الصوت الحي (Live Transcript)
            </h3>
            {sessionState.messages.length > 0 && (
              <button
                onClick={() => geminiLiveWs.clearChat()}
                className="text-slate-500 hover:text-rose-400 text-xs flex items-center gap-1 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                مسح
              </button>
            )}
          </div>

          {/* Messages Scroll Area */}
          <div className="space-y-3 max-h-56 overflow-y-auto pr-1 text-xs">
            {sessionState.messages.length === 0 ? (
              <p className="text-center text-slate-500 py-6">
                لا يوجد رسائل بعد. ابدأ الجلسة وتحدث بالسؤال والخيارات.
              </p>
            ) : (
              sessionState.messages.map((msg: ChatMessage) => (
                <div
                  key={msg.id}
                  className={`p-3 rounded-2xl flex flex-col gap-1 ${
                    msg.role === "user"
                      ? "bg-slate-800/80 border border-slate-700/60 text-slate-200 mr-4"
                      : msg.role === "model"
                      ? "bg-cyan-950/40 border border-cyan-500/30 text-cyan-200 ml-4"
                      : "bg-slate-950/60 text-slate-400 text-[11px] text-center"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className="flex items-center gap-1.5">
                      {msg.role === "user" && <User className="w-3.5 h-3.5 text-blue-400" />}
                      {msg.role === "model" && <Bot className="w-3.5 h-3.5 text-cyan-400" />}
                      {msg.role === "user" ? "المستخدم" : msg.role === "model" ? "النموذج اللمسي" : "النظام"}
                    </span>
                    <span className="text-[10px] text-slate-500">{msg.timestamp}</span>
                  </div>

                  <p className="text-xs leading-relaxed font-medium">{msg.text}</p>

                  {msg.code && (
                    <div className="mt-1 flex items-center justify-between pt-1 border-t border-cyan-500/20">
                      <span className="text-cyan-400 font-bold">
                        {VIBRATION_PATTERNS[msg.code]?.labelAr}
                      </span>
                      <button
                        onClick={() => hapticEngine.trigger(msg.code as AnswerCode)}
                        className="text-[10px] px-2 py-0.5 rounded bg-cyan-900/60 text-cyan-300 hover:bg-cyan-800"
                      >
                        إعادة الهزة
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* ==================================================== */}
        {/* SETTINGS & CALIBRATION DRAWER */}
        {/* ==================================================== */}
        {showSettings && (
          <div className="w-full mt-4 p-5 rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-200">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" />
                إعدادات وسرعة الهزاز
              </h3>
              <span className="text-xs text-slate-400">سرعة: {vibrationSpeed}x</span>
            </div>

            {/* Speed Multiplier */}
            <div>
              <label className="text-xs text-slate-400 block mb-2">سرعة وطول مدة الهزة</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "بطيء وقوي (1.3x)", val: 1.3 },
                  { label: "عادي (1.0x)", val: 1.0 },
                  { label: "سريع (0.8x)", val: 0.8 },
                ].map((item) => (
                  <button
                    key={item.val}
                    onClick={() => handleSpeedChange(item.val)}
                    className={`py-2 px-1 text-xs rounded-xl border transition-all font-medium ${
                      vibrationSpeed === item.val
                        ? "bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold"
                        : "bg-slate-800/60 border-slate-700/60 text-slate-400 hover:bg-slate-800"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ==================================================== */}
        {/* MANUAL VIBRATION TESTER (قاموس واختبار الهزات) */}
        {/* ==================================================== */}
        <div className="w-full mt-4">
          <button
            onClick={() => setShowTester(!showTester)}
            className="w-full py-3 px-4 rounded-2xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 text-xs font-semibold text-slate-300 flex items-center justify-between transition-all"
          >
            <span className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-cyan-400" />
              قاموس واختبار أنماط الهزاز (اضغط للتجربة)
            </span>
            <span className="text-cyan-400 text-xs">{showTester ? "إخفاء" : "عرض"}</span>
          </button>

          {showTester && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-4 rounded-2xl bg-slate-900/40 border border-slate-800/60 animate-in fade-in duration-150">
              {(
                [
                  { code: "1", label: "خيار (أ)", sub: "هزة واحدة" },
                  { code: "2", label: "خيار (ب)", sub: "هزتان" },
                  { code: "3", label: "خيار (ج)", sub: "3 هزات" },
                  { code: "4", label: "خيار (د)", sub: "4 هزات" },
                  { code: "T", label: "صـح (True)", sub: "هزة طويلة" },
                  { code: "F", label: "خـطـأ (False)", sub: "هزتان طويلتان" },
                  { code: "0", label: "غير واضح", sub: "نبضات سريعة" },
                  { code: "START", label: "بدء المايك", sub: "نبضة تشغيل" },
                ] as const
              ).map((item) => (
                <button
                  key={item.code}
                  onClick={() => testPattern(item.code as AnswerCode)}
                  className={`p-3 rounded-xl border text-center transition-all flex flex-col items-center justify-center gap-1 active:scale-95 ${
                    activeVibrateCode === item.code
                      ? "bg-cyan-500/30 border-cyan-400 text-cyan-300 shadow-lg shadow-cyan-500/20 scale-105"
                      : "bg-slate-900/80 border-slate-800 hover:border-slate-700 text-slate-200"
                  }`}
                >
                  <span className="text-sm font-black text-cyan-400">{item.label}</span>
                  <span className="text-[10px] text-slate-400">{item.sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Footer Info */}
      <footer className="p-4 border-t border-slate-900 text-center text-xs text-slate-500">
        <p>TactileAI • اتصال WebSocket مباشر • تحويل الصوت 16kHz PCM • اهتزاز لحظي</p>
      </footer>
    </main>
  );
}
