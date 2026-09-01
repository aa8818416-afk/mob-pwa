import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY || "1cbda7d1-6ad6-4940-9175-50bc5d435cff";
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-native-audio-latest";

  return NextResponse.json({
    apiKey,
    model: model.startsWith("models/") ? model : `models/${model}`,
  });
}
