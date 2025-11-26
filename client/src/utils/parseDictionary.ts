export const parseDictionary = (text: string): string[] =>
  text.split('\n').map((line) => line.trim()).filter(Boolean);
