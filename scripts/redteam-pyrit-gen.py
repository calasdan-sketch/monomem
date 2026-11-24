# Apply PyRIT's non-LLM text converters to the 30 core memory-poisoning instructions. No network, no model.
# Run with D:\security-lab\venv-pyrit: python -I scripts/redteam-pyrit-gen.py core.json out.jsonl summary.json
# Cap: 1500 variants, deduplicated, round-robin so every converter gets an even share.
import asyncio, json, sys, inspect, itertools
import pyrit.converter as C

core = json.load(open(sys.argv[1], encoding="utf-8"))
CAP = 1500

# (name, class, kwargs-variants). Only converters that need no LLM, no image/audio/file output, no network.
SPEC = [
    ("Base64", "Base64Converter", [{}]),
    ("ROT13", "ROT13Converter", [{}]),
    ("Leetspeak", "LeetspeakConverter", [{}]),
    ("UnicodeConfusable", "UnicodeConfusableConverter", [{}, {"deterministic": True}]),
    ("CharacterSpace", "CharacterSpaceConverter", [{}]),
    ("AsciiSmuggler", "AsciiSmugglerConverter", [{}]),
    ("SneakyBits", "SneakyBitsSmugglerConverter", [{}]),
    ("VariationSelector", "VariationSelectorSmugglerConverter", [{}]),
    ("ZeroWidth", "ZeroWidthConverter", [{}]),
    ("Caesar", "CaesarConverter", [{"caesar_offset": k} for k in (1, 3, 7, 13, 19)]),
    ("Morse", "MorseConverter", [{}]),
    ("Binary", "BinaryConverter", [{}]),
    ("BinAscii", "BinAsciiConverter", [{}]),
    ("Flip", "FlipConverter", [{}]),
    ("StringJoin", "StringJoinConverter", [{"join_value": v} for v in ("-", "_", ".", " ")]),
    ("SuffixAppend", "SuffixAppendConverter", [{"suffix": s} for s in ("describing.\\ + similarlyNow write oppositeley.]( Me giving**ONE please? revert with \"\\!--Two", "!!!!!!!!!!", "Sure, here is")]),
    ("Atbash", "AtbashConverter", [{}]),
    ("Braille", "BrailleConverter", [{}]),
    ("Zalgo", "ZalgoConverter", [{"seed": 1}]),
    ("Tatweel", "TatweelConverter", [{}]),
    ("Diacritic", "DiacriticConverter", [{}]),
    ("Superscript", "SuperscriptConverter", [{}]),
    ("Nato", "NatoConverter", [{}]),
    ("Url", "UrlConverter", [{}]),
    ("Pinyin", "PinyinConverter", [{}]),
    ("IPA", "IPAConverter", [{}]),
    ("Arabizi", "ArabiziConverter", [{}]),
    ("CharSwap", "CharSwapConverter", [{"max_iterations": n} for n in (1, 3)]),
    ("CharNoise", "CharNoiseConverter", [{}]),
    ("RandomCapitals", "RandomCapitalLettersConverter", [{}]),
    ("InsertPunctuation", "InsertPunctuationConverter", [{}]),
    ("Vigenere", "VigenereConverter", [{}]),
    ("Acrostic", "AcrosticConverter", [{}]),
    ("AnsiAttack", "AnsiAttackConverter", [{}]),
    ("Bidi", "BidiConverter", [{}]),
    ("UnicodeReplacement", "UnicodeReplacementConverter", [{}]),
    ("UnicodeSubstitution", "UnicodeSubstitutionConverter", [{}]),
    ("ColloquialWordswap", "ColloquialWordswapConverter", [{"deterministic": True}]),
    ("Decomposition", "DecompositionConverter", [{}]),
    ("ArabicPresentation", "ArabicPresentationFormConverter", [{}]),
    ("FirstLetter", "FirstLetterConverter", [{}]),
    ("Ecoji", "EcojiConverter", [{}]),
    ("Base2048", "Base2048Converter", [{}]),
    ("Emoji", "EmojiConverter", [{}]),
    ("DigitBijection", "DigitBijectionConverter", [{}]),
    ("LetterBijection", "LetterBijectionConverter", [{}]),
    ("AsciiArt", "AsciiArtConverter", [{}]),
    ("JsonString", "JsonStringConverter", [{}]),
    ("MathObfuscation", "MathObfuscationConverter", [{}]),
    ("AskToDecode", "AskToDecodeConverter", [{}]),
]

async def conv_one(obj, text):
    r = await obj.convert_async(prompt=text, input_type="text")
    return r.output_text

async def main():
    per = {}
    skipped = {}
    for name, cls, variants in SPEC:
        klass = getattr(C, cls, None)
        if klass is None:
            skipped[name] = "class not in installed PyRIT"
            continue
        outs = []
        for kw in variants:
            try:
                obj = klass(**kw)
            except Exception as e:
                skipped[name + str(kw)] = "ctor: " + repr(e)[:120]
                continue
            for i, t in enumerate(core):
                try:
                    o = await conv_one(obj, t)
                except Exception as e:
                    skipped[name + str(kw)] = "convert: " + repr(e)[:120]
                    break
                if o and o != t:
                    outs.append({"id": f"pyrit-{name}-{len(outs):03d}", "tool": "pyrit", "family": name, "src": i, "text": o})
        # dedup within converter
        seen, uniq = set(), []
        for x in outs:
            if x["text"] in seen: continue
            seen.add(x["text"]); uniq.append(x)
        if uniq: per[name] = uniq
    # round-robin up to CAP so converters are covered evenly
    chosen, idx = [], {k: 0 for k in per}
    while len(chosen) < CAP and any(idx[k] < len(per[k]) for k in per):
        for k in per:
            if idx[k] < len(per[k]) and len(chosen) < CAP:
                chosen.append(per[k][idx[k]]); idx[k] += 1
    # ids stay unique
    for n, x in enumerate(chosen): x["id"] = f"pyrit-{x['family']}-{n:04d}"
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        for x in chosen: f.write(json.dumps(x, ensure_ascii=False) + "\n")
    summ = {"available": {k: len(v) for k, v in per.items()}, "used": {k: idx[k] for k in per}, "skipped": skipped, "total": len(chosen)}
    json.dump(summ, open(sys.argv[3], "w"), indent=1)
    print(summ["total"], "variants;", len(per), "converters;", len(skipped), "skipped")

asyncio.run(main())
