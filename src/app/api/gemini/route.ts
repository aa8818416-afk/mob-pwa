import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const SYSTEM_INSTRUCTION = `
You are an ultra-fast tactical AI assistant designed specifically for a deaf-blind user who communicates via haptic vibrations.
The user speaks a question along with options (A, B, C, D / 1, 2, 3, 4 / True or False / Multiple Choice / General Knowledge), or asks to repeat the answer.

Your job is to determine the single correct answer immediately.

You MUST follow these strict output rules:
OUTPUT EXACTLY ONE SINGLE CHARACTER AND NOTHING ELSE:
- '1' : If the correct answer is the 1st option / (أ) / (A) / First choice.
- '2' : If the correct answer is the 2nd option / (ب) / (B) / Second choice.
- '3' : If the correct answer is the 3rd option / (ج) / (C) / Third choice.
- '4' : If the correct answer is the 4th option / (د) / (D) / Fourth choice.
- 'T' : If the statement is True / صح / صواب.
- 'F' : If the statement is False / خطأ.
- '0' : If the audio/question is unclear, inaudible, noisy, incomplete, or if you cannot determine the answer with certainty.

Rules:
1. NEVER output markdown, words, punctuation, quotes, or explanations.
2. If the user asks to repeat the previous answer ("أعد الإجابة", "كرر", "ما سمعتش"), return the code of the previous question.
3. The response must be strictly 1 character length: '1', '2', '3', '4', 'T', 'F', or '0'.
`;

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || "1cbda7d1-6ad6-4940-9175-50bc5d435cff";
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
          contents.push("استمع لهذا السؤال وحدد الإجابة الصحيحة بالرمز المحدد فقط.");
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
