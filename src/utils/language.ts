const SUPPORTED_WHISPER_LANGUAGES = [
  'en',
  'zh',
  'de',
  'es',
  'ru',
  'ko',
  'fr',
  'ja',
  'pt',
  'tr',
  'pl',
  'ca',
  'nl',
  'ar',
  'sv',
  'it',
  'id',
  'hi',
  'fi',
  'vi',
  'he',
  'uk',
  'el',
  'ms',
  'cs',
  'ro',
  'da',
  'hu',
  'ta',
  'no',
  'th',
  'ur',
  'hr',
  'bg',
  'lt',
  'la',
  'mi',
  'ml',
  'cy',
  'sk',
  'te',
  'fa',
  'lv',
  'bn',
  'sr',
  'az',
  'sl',
  'kn',
  'et',
  'mk',
  'br',
  'eu',
  'is',
  'hy',
  'ne',
  'mn',
  'bs',
  'kk',
  'sq',
  'sw',
  'gl',
  'mr',
  'pa',
  'si',
  'km',
  'sn',
  'yo',
  'so',
  'af',
  'oc',
  'ka',
  'be',
  'tg',
  'sd',
  'gu',
  'am',
  'yi',
  'lo',
  'uz',
  'fo',
  'ht',
  'ps',
  'tk',
  'nn',
  'mt',
  'sa',
  'lb',
  'my',
  'bo',
  'tl',
  'mg',
  'as',
  'tt',
  'haw',
  'ln',
  'ha',
  'ba',
  'jw',
  'su',
  'yue',
] as const;

const SUPPORTED_WHISPER_LANGUAGE_SET = new Set<string>(SUPPORTED_WHISPER_LANGUAGES);

export function normalizeWhisperLanguage(language?: string): string | undefined {
  if (!language) {
    return undefined;
  }

  const trimmed = language.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (SUPPORTED_WHISPER_LANGUAGE_SET.has(normalized)) {
    return normalized;
  }

  const [primary] = normalized.split(/[-_]/);
  if (primary && SUPPORTED_WHISPER_LANGUAGE_SET.has(primary)) {
    return primary;
  }

  return undefined;
}

const ISO_LANGUAGE_CODE_REGEX = /^[a-z]{2,3}$/;

export function normalizeIsoLanguageCode(language?: string): string | undefined {
  if (!language) {
    return undefined;
  }

  const trimmed = language.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  const [primary] = normalized.split(/[-_]/);
  if (!primary) {
    return undefined;
  }

  return ISO_LANGUAGE_CODE_REGEX.test(primary) ? primary : undefined;
}
