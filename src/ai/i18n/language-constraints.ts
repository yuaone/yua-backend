// 📂 src/ai/i18n/language-constraints.ts
// SSOT — per-locale "respond in this language" instruction text.
//
// Why it exists:
//   prompt-runtime.buildLanguageConstraint() used to hard-code only `ko`
//   and `en` with every other locale falling through to a generic English
//   fallback. That meant a Japanese user setting the UI to ja still got an
//   English-worded instruction to respond in the user's detected language
//   — the model ends up guessing. This file is the single source of truth
//   for the per-locale instruction, keyed by the frontend locale code
//   (matches yua-web/src/i18n/config.ts LOCALES).
//
// Design rules:
//   - Every value is a complete standalone instruction — no template
//     concatenation. This keeps cost/quality predictable and lets each
//     locale phrase it idiomatically.
//   - All 11 locales explicitly repeat the "don't translate code / IDs /
//     API names" guard so `respond in $LOCALE` never clobbers code blocks.
//   - Frontend sends the cookie value (BCP-47 like `zh-CN`, `pt-BR`) so
//     this file MUST use the exact same keys to avoid silent fallthrough.
//   - Adding a new UI locale = add one row here + one row in
//     yua-web/src/i18n/config.ts LOCALE_META. No other files change.

export type UiLocale =
  | "ko"
  | "en"
  | "ja"
  | "zh-CN"
  | "fr"
  | "de"
  | "es"
  | "pt-BR"
  | "it"
  | "id"
  | "hi";

export const UI_LOCALES: readonly UiLocale[] = [
  "ko",
  "en",
  "ja",
  "zh-CN",
  "fr",
  "de",
  "es",
  "pt-BR",
  "it",
  "id",
  "hi",
] as const;

export function isUiLocale(v: unknown): v is UiLocale {
  return typeof v === "string" && (UI_LOCALES as readonly string[]).includes(v);
}

/**
 * Per-locale system-prompt language constraint. Each entry is a full
 * sentence (or two) written IN the target language. The model sees this
 * verbatim in the system prompt.
 *
 * Every entry MUST include:
 *   1. "Respond in {language}" directive.
 *   2. "Do NOT translate code blocks, identifiers, keywords, or API names"
 *      guard — phrased natively.
 */
export const LANGUAGE_CONSTRAINTS: Record<UiLocale, string> = {
  ko:
    "자연어 설명은 반드시 한국어로 작성해야 한다. " +
    "코드 블록, 식별자, 키워드, API 이름은 번역하지 말고 원문을 그대로 유지해야 한다.",

  en:
    "All natural language explanations must be written in English. " +
    "Do not translate code blocks, identifiers, keywords, or API names. Keep them exactly as-is.",

  ja:
    "自然言語の説明は必ず日本語で記述してください。" +
    "コードブロック、識別子、キーワード、API名は翻訳せず、原文のまま保持してください。",

  "zh-CN":
    "所有自然语言解释必须用简体中文书写。" +
    "不要翻译代码块、标识符、关键字或 API 名称,请保持原文不变。",

  fr:
    "Toutes les explications en langage naturel doivent être rédigées en français. " +
    "Ne traduisez pas les blocs de code, identifiants, mots-clés ou noms d'API — conservez-les tels quels.",

  de:
    "Alle natürlichsprachlichen Erklärungen müssen auf Deutsch verfasst sein. " +
    "Übersetze keine Codeblöcke, Bezeichner, Schlüsselwörter oder API-Namen — belasse sie genau wie sie sind.",

  es:
    "Todas las explicaciones en lenguaje natural deben escribirse en español. " +
    "No traduzcas bloques de código, identificadores, palabras clave ni nombres de API; mantenlos exactamente como están.",

  "pt-BR":
    "Todas as explicações em linguagem natural devem ser escritas em português brasileiro. " +
    "Não traduza blocos de código, identificadores, palavras-chave ou nomes de API — mantenha-os exatamente como estão.",

  it:
    "Tutte le spiegazioni in linguaggio naturale devono essere scritte in italiano. " +
    "Non tradurre i blocchi di codice, gli identificatori, le parole chiave o i nomi delle API — mantienili esattamente come sono.",

  id:
    "Semua penjelasan bahasa alami harus ditulis dalam Bahasa Indonesia. " +
    "Jangan menerjemahkan blok kode, pengidentifikasi, kata kunci, atau nama API — biarkan persis seperti aslinya.",

  hi:
    "सभी प्राकृतिक भाषा स्पष्टीकरण हिंदी में लिखे जाने चाहिए। " +
    "कोड ब्लॉक, पहचानकर्ता, कीवर्ड, या API नामों का अनुवाद न करें — उन्हें वैसा ही रखें जैसा वे हैं।",
};

/**
 * Legacy ISO 639-1 codes (what the style detector emits) → canonical
 * UI locale. Used as a fallback when the request doesn't carry an
 * explicit UI locale header / cookie. Any ISO code not mapped here
 * falls through to `undefined` → no constraint injected.
 */
const ISO_TO_UI: Record<string, UiLocale> = {
  ko: "ko",
  en: "en",
  ja: "ja",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  fr: "fr",
  de: "de",
  es: "es",
  pt: "pt-BR",
  "pt-br": "pt-BR",
  it: "it",
  id: "id",
  hi: "hi",
};

export function normalizeToUiLocale(raw: unknown): UiLocale | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (isUiLocale(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (ISO_TO_UI[lower]) return ISO_TO_UI[lower];
  // Try the primary subtag (e.g. `en-GB` → `en`).
  const primary = lower.split("-")[0];
  if (ISO_TO_UI[primary]) return ISO_TO_UI[primary];
  return undefined;
}

/**
 * The canonical resolver used by prompt-runtime.
 *
 * Resolution order:
 *   1. Explicit UI locale (from `NEXT_LOCALE` cookie, passed in as
 *      `uiLocale` on the prompt meta).
 *   2. Detected content-language ISO code (from the style detector on
 *      the user's incoming message).
 *   3. undefined → caller omits the block entirely.
 *
 * Never throws. Returns the raw instruction string the caller can splice
 * into the system prompt.
 */
export function resolveLanguageConstraint(params: {
  uiLocale?: string | null;
  detectedLanguage?: string | null;
}): string | undefined {
  const fromUi = normalizeToUiLocale(params.uiLocale);
  if (fromUi) return LANGUAGE_CONSTRAINTS[fromUi];
  const fromDetected = normalizeToUiLocale(params.detectedLanguage);
  if (fromDetected) return LANGUAGE_CONSTRAINTS[fromDetected];
  return undefined;
}
