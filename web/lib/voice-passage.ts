/** Fixed passages trainers read aloud when cloning their voice.
 *  One is chosen per session; the same text is stored as the reference
 *  transcript. Five variants so repeat clones don't sound rehearsed. */
export const VOICE_PASSAGES = [
  "Cooking at home is easily one of my favourite things to do after a long and tiring day. I enjoy trying simple new recipes from many different parts of the world. A good meal always brings people together, no matter how busy the day has been.",
  "On weekends I like to walk through the old part of the city, watching the markets wake up. Vendors call out their freshest produce while the smell of fresh bread drifts from every corner bakery. It is a small ritual that keeps me grounded.",
  "The best conversations often happen on long drives with no particular destination. You talk about work, family, old dreams, and plans that never happened. By the time the road ends, you understand the person beside you a little better.",
  "I have always believed that learning something new keeps the mind young. Last year I picked up the guitar, and my neighbours have patiently survived every wrong note since. Progress is slow, but the joy of playing is worth every stumble.",
  "Rainy afternoons are perfect for reading by the window with a strong cup of tea. The world slows down, the pages turn easily, and a single afternoon can carry you across continents and centuries without ever leaving your chair.",
];

export function randomPassage(exclude?: string): string {
  const pool = exclude ? VOICE_PASSAGES.filter((p) => p !== exclude) : VOICE_PASSAGES;
  return pool[Math.floor(Math.random() * pool.length)];
}
