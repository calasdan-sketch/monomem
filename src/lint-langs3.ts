// "Ignore all previous instructions" in seven more languages (2026-11-23): Czech, Swedish, Indonesian, Vietnamese, Greek,
// Hebrew and Thai. The same shape as lint-evasion2.ts: a verb, an optional "all / the", a word for "previous", a word for
// "instructions", in either order. Latin and Greek text is read without accents (so "předchozí" and "προηγούμενες" match the
// plain spellings); Hebrew and Thai are matched as written. Pattern matching, not understanding: other languages and rewordings
// still pass (published in docs/attack-expansion-2026-11-23.md).

const q = (words: string): string => String.raw`(?:(?:${words})\s+){0,3}`;
function ov(verbs: string, quant: string, adjs: string, nouns: string): RegExp {
  return new RegExp(String.raw`(?<![\p{L}])(?:${verbs})\s+${q(quant)}(?:(?:${adjs})\s+(?:${nouns})|(?:${nouns})\s+(?:${adjs}))(?![\p{L}])`, "iu");
}

const NO_MARKS: RegExp[] = [
  ov("ignoruj|ignorujte|zapomen|zapomente|ignorovat|zahod|zahodte", "vsechny|vse|vsechna|tve|vase|ty|tyto|veskere", "predchozi|drivejsi|puvodni|vyse\\s+uvedene|systemove", "instrukce|pokyny|prikazy|pravidla|zadani|upozorneni|vytky"),
  ov("ignorera|ignorerar|glom|glomma|strunta\\s+i|bortse\\s+fran", "alla|all|dina|de|dessa|samtliga|varje", "tidigare|foregaende|ovanstaende|ursprungliga|systemets", "instruktioner|instruktionerna|anvisningar|regler|reglerna|direktiv|kommandon|meddelanden"),
  ov("abaikan|lupakan|jangan\\s+ikuti|hiraukan|kesampingkan", "semua|seluruh|segala|setiap|kamu|anda", "sebelumnya|terdahulu|di\\s+atas|awal|asli", "instruksi|perintah|aturan|arahan|petunjuk|pesan"),
  /(?<![\p{L}])(?:bo\s+qua|quen|lang\s+quen|phot\s+lo|khong\s+lam\s+theo)\s+(?:(?:tat\s+ca|moi|het|toan\s+bo)\s+){0,2}(?:(?:cac|nhung)\s+)?(?:huong\s+dan|chi\s+dan|chi\s+thi|lenh|quy\s+tac|yeu\s+cau)\s+(?:(?:da\s+cho\s+)?truoc\s+(?:do|day)|ben\s+tren|phia\s+tren|ban\s+dau)(?![\p{L}])/iu,
  ov("αγνοησε|αγνοηστε|ξεχασε|ξεχαστε|παρακαμψε|αψηφησε", "ολες|ολα|ολους|τις|τα|τους|τις\\s+δικες\\s+σου|αυτες", "προηγουμενες|προηγουμενα|προηγουμενους|παλιες|αρχικες|παραπανω|συστημικες", "οδηγιες|εντολες|κανονες|οδηγιων|οδηγιεσ|κατευθυντηριες|μηνυματα"),
];
const AS_WRITTEN: RegExp[] = [
  /(?:התעלם|התעלמו|תתעלם|שכח|שכחו|אל\s+תקשיב\s+ל)\s+(?:מכל\s+|מ|את\s+כל\s+|כל\s+)?(?:ה)?(?:הוראות|הנחיות|פקודות|כללים)\s+(?:ה)?(?:קודמות|קודמים|הקודמות|הקודמים|הראשונות|שלמעלה)/u,
  /(?:התעלם|התעלמו|תתעלם|שכח)\s+מ(?:כל\s+)?ה(?:הוראות|הנחיות|פקודות|כללים)\s+ה(?:קודמות|קודמים|שלמעלה)/u,
  /(?:ไม\u0e48ต\u0e49อง(?:ทำตาม|สนใจ|เช\u0e37\u0e48อ)|เพ\u0e34กเฉย(?:ต\u0e48อ)?|ละเว\u0e49น|ล\u0e37ม|อย\u0e48าทำตาม)\s*(?:คำส\u0e31\u0e48ง|คำแนะนำ|กฎ|ข\u0e49อกำหนด|คำช\u0e35\u0e49แจง)[^\n]{0,14}?(?:ก\u0e48อนหน\u0e49า|ท\u0e35\u0e48ผ\u0e48านมา|ข\u0e49างต\u0e49น|เด\u0e34ม)/u,
];

/** "instruction override" for the override sentence in Czech, Swedish, Indonesian, Vietnamese, Greek, Hebrew or Thai, or null. `raw` is the text as received. */
export function scanThirdLanguages(raw: string): string | null {
  const light = raw.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu, "").replace(/\u0e4d\u0e32/g, "\u0e33").toLowerCase().replace(/\s+/g, " "); // NFKC splits sara am (U+0E33); the patterns keep it whole
  const plain = light.normalize("NFD").replace(/\p{M}+/gu, "").replace(/ς/g, "σ").replace(/đ/g, "d").replace(/ı/g, "i").replace(/ł/g, "l");
  for (const re of NO_MARKS) if (re.test(plain)) return "instruction override";
  if (/[\u0590-\u05ff\u0e00-\u0e7f]/.test(light)) for (const re of AS_WRITTEN) if (re.test(light)) return "instruction override";
  return null;
}
