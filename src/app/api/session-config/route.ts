import { NextResponse } from "next/server";

function resolveLiveModelName(modelName?: string | null): string {
  if (!modelName) return "models/gemini-2.5-flash-native-audio-latest";
  const name = modelName.trim();
  if (name.startsWith("models/")) return name;
  return `models/${name}`;
}

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY || "";
  const model = resolveLiveModelName(process.env.GEMINI_MODEL);

  return NextResponse.json({
    apiKey,
    model,
  });
}

