"""Replace invisible/bidi/tag characters in text files with visible ASCII escapes (backslash-u).
Built from chr(92) so this script itself contains no escape sequences. usage: python scripts/escape-hidden.py <files...>"""
import re, sys
BS = chr(92)
HIDDEN = re.compile("[\U000E0000-\U000E007F​-‏‪-‮⁠-⁤⁦-⁩﻿­]")
def esc(m):
    cp = ord(m.group(0))
    return f"{BS}u{{{cp:X}}}" if cp > 0xFFFF else f"{BS}u{cp:04X}"
for path in sys.argv[1:]:
    s = open(path, encoding="utf8").read()
    fixed, n = HIDDEN.subn(esc, s)
    if n:
        open(path, "w", encoding="utf8", newline="\n").write(fixed)
        print(f"{path}: escaped {n} hidden character(s)")
