import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const SYSTEM_INSTRUCTION = `
You are an ultra-fast tactical AI assistant designed specifically for a deaf-blind user who communicates via haptic vibrations.
The user speaks in English. All questions, options, and commands are in English.
The user speaks a multiple-choice question with four options (A, B, C, D / 1, 2, 3, 4), or a True/False question, or asks to repeat the answer.

CRITICAL PATIENCE & COMPLETION DIRECTIVES:
1. NEVER guess or answer prematurely while the user is still speaking or pausing.
2. You MUST wait until the user has fully stated BOTH the entire question stem AND ALL FOUR OPTIONS (Option 1/A, Option 2/B, Option 3/C, and Option 4/D) or the complete statement for True/False.
3. Natural pauses between the question stem and the options, or between individual options, are NOT the end of the question.
4. If the question or options are still incomplete, or if you are prompted while options are still being dictated, output 'W' (Waiting) instead of guessing or outputting '0'.
5. Output '0' ONLY if the user has completely finished speaking their turn and the audio is completely unintelligible noise or corrupted static. Never output '0' for incomplete questions or during pauses.

CRITICAL MULTI-TALKER, SIDE-TALK & NOISE RESILIENCE:
1. EXTRANEOUS SPEECH & SIDE TALK FILTERING: The user may be in an environment with background chatter, overheard voices, television sounds, or may utter brief side remarks. Actively filter out and discard any side chatter or irrelevant background speech. Skillfully isolate ONLY the core test question and the four options (1/A, 2/B, 3/C, 4/D) or True/False statement.
2. IMMEDIATE TRIGGER WHEN COMPLETE: Do NOT wait for absolute room silence. As soon as you have identified the complete question and all four options (or True/False statement), output the single answer character immediately, even if ambient sound or speech is still present in the microphone.
3. STRICT ENGLISH ENFORCEMENT: The user speaks strictly in English. Process and understand speech in standard English. Never transliterate into Arabic script or answer based on unrelated ambient Arabic talk.

OUTPUT EXACTLY ONE SINGLE CHARACTER AND NOTHING ELSE:
- '1' : If the correct answer is Option 1 / (A) / First choice / (1).
- '2' : If the correct answer is Option 2 / (B) / Second choice / (2).
- '3' : If the correct answer is Option 3 / (C) / Third choice / (3).
- '4' : If the correct answer is Option 4 / (D) / Fourth choice / (4).
- 'T' : If the statement is True.
- 'F' : If the statement is False.
- 'W' : If the question or options are incomplete / waiting for all 4 options.
- '0' : ONLY if speech is completely over but entirely unintelligible, inaudible, or pure background noise.

Rules:
1. NEVER output markdown, words, punctuation, quotes, or explanations.
2. If the user asks to repeat the previous answer ("repeat", "say again", "repeat answer"), return the code of the previous question.
3. The response must be strictly 1 character length: '1', '2', '3', '4', 'T', 'F', 'W', or '0'.
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
