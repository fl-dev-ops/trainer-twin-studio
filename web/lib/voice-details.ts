import { z } from "zod";

/**
 * A voice's details (the voice library, like skills): what the persona picker and the copilot choose by. Client-safe.
 * Voices keep their id and name; personas point at them and never copy or rename one.
 */
/** The 30 languages VoxCPM2 speaks (ISO 639-1). A voice's language is the one it sounds native in. */
export const VOICE_LANGUAGES = [
  ["ar", "Arabic"], ["my", "Burmese"], ["zh", "Chinese"], ["da", "Danish"], ["nl", "Dutch"], ["en", "English"],
  ["fi", "Finnish"], ["fr", "French"], ["de", "German"], ["el", "Greek"], ["he", "Hebrew"], ["hi", "Hindi"],
  ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"], ["km", "Khmer"], ["ko", "Korean"], ["lo", "Lao"],
  ["ms", "Malay"], ["no", "Norwegian"], ["pl", "Polish"], ["pt", "Portuguese"], ["ru", "Russian"], ["es", "Spanish"],
  ["sw", "Swahili"], ["sv", "Swedish"], ["tl", "Tagalog"], ["th", "Thai"], ["tr", "Turkish"], ["vi", "Vietnamese"],
] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number][0];
const LANGUAGE_CODES = VOICE_LANGUAGES.map(([code]) => code) as [VoiceLanguage, ...VoiceLanguage[]];
export const languageName = (code: string | null | undefined) => VOICE_LANGUAGES.find(([value]) => value === code)?.[1] ?? code ?? "";

export const VOICE_GENDERS = ["female", "male"] as const;
export const VOICE_AGES = ["young", "middle-aged", "older"] as const;
/** Suggestions only: an accent is a few words ("British", "Indian English", "Russian-accented English"). */
export const VOICE_ACCENTS = [
  "American", "British", "Australian", "Irish", "Scottish", "South African", "Indian English",
  "Arabic-accented English", "Russian-accented English", "French-accented English", "German-accented English",
] as const;

export type VoiceGender = (typeof VOICE_GENDERS)[number];
export type VoiceAge = (typeof VOICE_AGES)[number];

/** Each field optional; null clears it. */
export const voiceDetailsSchema = z.strictObject({
  language: z.enum(LANGUAGE_CODES).optional(),
  gender: z.enum(VOICE_GENDERS).nullable().optional(),
  age: z.enum(VOICE_AGES).nullable().optional(),
  accent: z.string().trim().max(40).transform((value) => value || null).nullable().optional(),
});
export type VoiceDetails = z.infer<typeof voiceDetailsSchema>;

/** "English · female · middle-aged · British" ("Female · …" without the language), or "" when nothing is set. */
export function voiceDetailsLabel(voice: { language?: string | null; gender?: string | null; age?: string | null; accent?: string | null }, withLanguage = true) {
  const parts = [withLanguage ? languageName(voice.language) : null, voice.gender, voice.age, voice.accent].filter((part): part is string => Boolean(part));
  return parts.map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join(" · ");
}

/** What a voice says when previewed: a short phone line in its own language. */
const PREVIEW_LINES: Record<VoiceLanguage, string> = {
  ar: "مرحباً، شكراً على الاتصال. عندي بضع دقائق، فأخبرني ما الموضوع.",
  my: "မင်္ဂလာပါ၊ ဖုန်းဆက်တာ ကျေးဇူးတင်ပါတယ်။ မိနစ်အနည်းငယ်ပဲ အချိန်ရှိတယ်၊ ဘာအကြောင်းလဲ ပြောပါ။",
  zh: "你好，谢谢你打来电话。我有几分钟时间，说说是什么事吧。",
  da: "Hej, tak fordi du ringer. Jeg har et par minutter, så fortæl mig, hvad det drejer sig om.",
  nl: "Hallo, bedankt voor het bellen. Ik heb een paar minuten, dus vertel maar waar het over gaat.",
  en: "Hi, thanks for calling. I've got a few minutes, so tell me what this is about.",
  fi: "Hei, kiitos soitosta. Minulla on muutama minuutti, joten kerro, mistä on kyse.",
  fr: "Bonjour, merci de votre appel. J'ai quelques minutes, alors dites-moi de quoi il s'agit.",
  de: "Hallo, danke für Ihren Anruf. Ich habe ein paar Minuten, also sagen Sie mir, worum es geht.",
  el: "Γεια σας, ευχαριστώ που καλέσατε. Έχω λίγα λεπτά, πείτε μου τι συμβαίνει.",
  he: "שלום, תודה שהתקשרת. יש לי כמה דקות, אז ספר לי במה מדובר.",
  hi: "नमस्ते, फ़ोन करने के लिए धन्यवाद। मेरे पास कुछ मिनट हैं, बताइए क्या बात है।",
  id: "Halo, terima kasih sudah menelepon. Saya punya beberapa menit, jadi ceritakan ada apa.",
  it: "Salve, grazie per la chiamata. Ho qualche minuto, mi dica di cosa si tratta.",
  ja: "もしもし、お電話ありがとうございます。少し時間がありますので、ご用件をどうぞ。",
  km: "សួស្តី អរគុណដែលបានទូរស័ព្ទមក។ ខ្ញុំមានពេលប៉ុន្មាននាទី សូមប្រាប់ខ្ញុំថាមានរឿងអ្វី។",
  ko: "안녕하세요, 전화 주셔서 감사합니다. 몇 분 정도 시간이 있으니 무슨 일인지 말씀해 주세요.",
  lo: "ສະບາຍດີ, ຂອບໃຈທີ່ໂທມາ. ຂ້ອຍມີເວລາສອງສາມນາທີ, ບອກຂ້ອຍແດ່ວ່າແມ່ນເລື່ອງຫຍັງ.",
  ms: "Helo, terima kasih kerana menelefon. Saya ada beberapa minit, jadi beritahu saya apa halnya.",
  no: "Hei, takk for at du ringer. Jeg har noen minutter, så fortell meg hva det gjelder.",
  pl: "Dzień dobry, dziękuję za telefon. Mam kilka minut, więc proszę powiedzieć, o co chodzi.",
  pt: "Olá, obrigado por ligar. Tenho alguns minutos, então diga-me do que se trata.",
  ru: "Здравствуйте, спасибо за звонок. У меня есть несколько минут, расскажите, в чём дело.",
  es: "Hola, gracias por llamar. Tengo unos minutos, así que cuénteme de qué se trata.",
  sw: "Habari, asante kwa kupiga simu. Nina dakika chache, kwa hiyo niambie ni kuhusu nini.",
  sv: "Hej, tack för att du ringer. Jag har några minuter, så berätta vad det gäller.",
  tl: "Hello, salamat sa pagtawag. May ilang minuto ako, kaya sabihin mo kung tungkol saan ito.",
  th: "สวัสดี ขอบคุณที่โทรมา มีเวลาสักสองสามนาที บอกมาได้เลยว่าเรื่องอะไร",
  tr: "Merhaba, aradığınız için teşekkürler. Birkaç dakikam var, ne hakkında olduğunu söyleyin.",
  vi: "Xin chào, cảm ơn bạn đã gọi. Tôi có vài phút, bạn cho tôi biết có chuyện gì nhé.",
};
export const previewLine = (language: string | null | undefined) => PREVIEW_LINES[(language ?? "en") as VoiceLanguage] ?? PREVIEW_LINES.en;
