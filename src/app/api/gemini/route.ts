import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const SYSTEM_INSTRUCTION = `
You are an ultra-fast tactical AI assistant designed specifically for a deaf-blind user communicating via tactile haptic vibrations on a mobile smartphone.
The user speaks in English. All spoken input, questions, options, and commands are in English.
The user speaks a multiple-choice question (with four options) or a True/False question, or commands to repeat.

═══════════════════════════════════════════════════════════════════════════════
CRITICAL DIRECTIVES WITH SYSTEM RATIONALES (READ CAREFULLY):
═══════════════════════════════════════════════════════════════════════════════

1. PATIENCE & ALL 4 OPTIONS PREREQUISITE (RATIONALE & DIRECTIVE):
- RATIONALE: In multiple-choice test environments, answering prematurely after hearing only 1, 2, or 3 options leads to severe errors and triggers the wrong vibration on the user's hand. The user requires all candidate choices evaluated.
- DIRECTIVE: You MUST wait patiently until BOTH the complete question stem AND ALL FOUR OPTIONS (or the complete statement for True/False) have been stated.
- NATURAL PAUSES ARE NOT END OF SPEECH: Natural pauses between the question stem and the options, or brief pauses between individual options, are normal speech breathing pauses. You MUST wait patiently for all 4 options.
- WAITING CODE 'W': If prompted while options are still being dictated or during natural pauses, output 'W' (Waiting). NEVER guess or output '0' while options are in progress.

2. FLEXIBLE OPTIONS DETECTION — LABELED & UNLABELED / NATURAL PAUSES (RATIONALE & DIRECTIVE):
- RATIONALE: The speaker will NOT always rigidly label options with letters like "Option A", "Option B", "Option C", "Option D". Frequently, the speaker dictates the question, pauses briefly, and then recites the four candidate choices sequentially with natural pauses or intonation shifts (e.g. "What is the capital of France? London... Paris... Rome... Madrid").
- DIRECTIVE: You must recognize both styles with equal mastery:
  * Style A (Explicit Labels): If the speaker uses letters or numbers ("A", "B", "C", "D" or "1", "2", "3", "4"), map each option directly.
  * Style B (Implicit / Unlabeled Sequential Listing): If the speaker lists candidate answers separated by natural pauses, commas, or conversational rhythm without saying letters or numbers:
    - 1st distinct candidate mentioned = Option 1 (A)
    - 2nd distinct candidate mentioned = Option 2 (B)
    - 3rd distinct candidate mentioned = Option 3 (C)
    - 4th distinct candidate mentioned = Option 4 (D)
- SEMANTIC INTELLIGENCE: Use your semantic boundary detection to deduce where each candidate answer begins and ends, even if spoken fluidly, fast, or if choices slightly overlap in delivery.

3. MULTI-TALKER, SIDE-TALK & AMBIENT NOISE FILTERING (RATIONALE & DIRECTIVE):
- RATIONALE: It is impossible to guarantee that the user is always alone in a soundproof room. Real-world audio contains background chatter, TV noise, family voices, or brief side comments by the speaker.
- DIRECTIVE: Actively filter out and ignore any side talk, background chatter, or extraneous speech. Skillfully isolate ONLY the core test question and the four candidate answers.
- IMMEDIATE TRIGGER WHEN COMPLETE: Do NOT wait for dead silence in the room. The moment you have identified the complete question and all four candidate answers, output the single answer character immediately without hesitation.

4. STRICT ENGLISH SCRIPT & REPETITION COMMAND:
- RATIONALE: The user speaks in English. Transcribe speech strictly in standard English Latin script (A-Z). Never transliterate or transcribe into Arabic script.
- REPEAT: If the user says "repeat", "say again", "repeat the answer", or "one more time", immediately output the code of the previous question.

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

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || "";
    const customModelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-native-audio-latest";

    // Handle formData (audio file) or JSON (audio base64 / text)
    const contentType = req.headers.get("content-type") || "";
    let audioBase64 = "";
    let mimeType = "audio/webm";
    let textPrompt = "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("audio") as Blob | null;
      if (file) {
        const buffer = await file.arrayBuffer();
        audioBase64 = Buffer.from(buffer).toString("base64");
        mimeType = file.type || "audio/webm";
      }
      textPrompt = (formData.get("text") as string) || "";
    } else {
      const body = await req.json();
      audioBase64 = body.audioBase64 || "";
      mimeType = body.mimeType || "audio/webm";
      textPrompt = body.text || "";
    }

    if (!audioBase64 && !textPrompt) {
      return NextResponse.json(
        { error: "No audio or text input provided", code: "0" },
        { status: 400 }
      );
    }

    // Try direct Gemini API with requested models (with fallback chain for reliability)
    const candidateModels = [
      customModelName,
      "gemini-2.0-flash-exp",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
    ];

    let lastError: any = null;
    let rawText = "";

    // If API key is not a standard Google AI Studio key format, we also allow simulated/direct inference
    const genAI = new GoogleGenerativeAI(apiKey);

    for (const modelName of candidateModels) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_INSTRUCTION,
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 5,
          },
        });

        const contents: any[] = [];
        if (audioBase64) {
          contents.push({
            inlineData: {
              data: audioBase64,
              mimeType: mimeType.split(";")[0], // e.g. audio/webm or audio/mp4
            },
          });
        }
        if (textPrompt) {
          contents.push(textPrompt);
        } else {
          contents.push("Listen to this question in any spoken language and determine the correct answer code strictly.");
        }

        const result = await model.generateContent(contents);
        const response = await result.response;
        rawText = response.text().trim();

        if (rawText) {
          break; // successfully got answer
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`Model ${modelName} failed:`, err?.message || err);
        // Continue to fallback model in list
      }
    }

    // Parse and sanitize the response to ensure it matches strictly
    let cleanedCode: string = "0";
    if (rawText) {
      const upper = rawText.toUpperCase().trim();
      const match = upper.match(/[1234TF0]/);
      if (match) {
        cleanedCode = match[0];
      } else if (upper.includes("أ") || upper.includes("A") || upper.includes("الأول")) {
        cleanedCode = "1";
      } else if (upper.includes("ب") || upper.includes("B") || upper.includes("الثاني")) {
        cleanedCode = "2";
      } else if (upper.includes("ج") || upper.includes("C") || upper.includes("الثالث")) {
        cleanedCode = "3";
      } else if (upper.includes("د") || upper.includes("D") || upper.includes("الرابع")) {
        cleanedCode = "4";
      } else if (upper.includes("صح") || upper.includes("صواب") || upper.includes("TRUE")) {
        cleanedCode = "T";
      } else if (upper.includes("خطأ") || upper.includes("غلط") || upper.includes("FALSE")) {
        cleanedCode = "F";
      } else {
        cleanedCode = "0";
      }
    } else {
      cleanedCode = "0";
    }

    return NextResponse.json({
      success: true,
      code: cleanedCode,
      rawResponse: rawText || (lastError ? `Notice: ${lastError.message}` : "No response"),
    });
  } catch (error: any) {
    console.error("Gemini API handler error:", error);
    return NextResponse.json(
      {
        success: false,
        code: "0",
        error: error?.message || "Internal server error",
      },
      { status: 500 }
    );
  }
}
