"""
LaTeX to Unicode converter.

Converts common LaTeX math notation into readable Unicode text
for Word (.docx) export, where raw LaTeX commands like \\triangle
would otherwise be displayed literally.

Coverage strategy (three layers):
  1. Symbol tables below cover 300+ commands (geometry, relations,
     operators, Greek, arrows, sets, logic, brackets, decorators).
  2. Fallback: any unmapped \\command degrades gracefully to its plain
     name (e.g. \\foo -> "foo") and is logged once for later triage —
     raw backslash source never leaks into the document.
  3. Built-in scanner:  python latex_utils.py <dir>
     scans *.md under <dir> and reports every command found plus
     coverage stats, so real OCR output can be audited continuously.
"""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Symbol mapping: LaTeX command -> Unicode character
# ---------------------------------------------------------------------------
LATEX_SYMBOLS: dict[str, str] = {
    # --- Geometry & relations ---
    "triangle": "△",
    "triangledown": "▽",
    "blacktriangle": "▲",
    "blacktriangledown": "▼",
    "triangleleft": "◁",
    "triangleright": "▷",
    "blacktriangleleft": "◀",
    "blacktriangleright": "▶",
    "perp": "⊥",
    "bot": "⊥",
    "top": "⊤",
    "angle": "∠",
    "measuredangle": "∡",
    "sphericalangle": "∢",
    "parallel": "∥",
    "nparallel": "∦",
    "cong": "≌",
    "ncong": "≇",
    "sim": "∼",
    "nsim": "≁",
    "simeq": "≃",
    "approx": "≈",
    "approxeq": "≊",
    "equiv": "≡",
    "propto": "∝",
    "asymp": "≍",
    "doteq": "≐",
    "doteqdot": "≑",
    "triangleq": "≜",
    "circeq": "≗",
    "risingdotseq": "≓",
    "fallingdotseq": "≒",
    "models": "⊨",
    "vdash": "⊢",
    "dashv": "⊣",
    "Vvdash": "⊪",
    "prec": "≺",
    "succ": "≻",
    "preceq": "≼",
    "succeq": "≽",
    "bowtie": "⋈",
    "smile": "⌣",
    "frown": "⌢",
    "between": "≬",
    "pitchfork": "⋔",
    "backepsilon": "∍",
    # --- Arithmetic & comparison ---
    "times": "×",
    "div": "÷",
    "cdot": "·",
    "cdots": "⋯",
    "ldots": "…",
    "dots": "…",
    "vdots": "⋮",
    "ddots": "⋱",
    "pm": "±",
    "mp": "∓",
    "leq": "≤",
    "le": "≤",
    "leqq": "≦",
    "leqslant": "⩽",
    "geq": "≥",
    "ge": "≥",
    "geqq": "≧",
    "geqslant": "⩾",
    "neq": "≠",
    "ne": "≠",
    "lneq": "⪇",
    "gneq": "⪈",
    "ll": "≪",
    "gg": "≫",
    "lll": "⋘",
    "ggg": "⋙",
    "lesssim": "≲",
    "gtrsim": "≳",
    "lessapprox": "⪅",
    "gtrapprox": "⪆",
    "circ": "°",
    "degree": "°",
    "prime": "′",
    "backprime": "‵",
    # --- Greek lowercase ---
    "alpha": "α",
    "beta": "β",
    "gamma": "γ",
    "delta": "δ",
    "epsilon": "ε",
    "varepsilon": "ε",
    "zeta": "ζ",
    "eta": "η",
    "theta": "θ",
    "vartheta": "ϑ",
    "iota": "ι",
    "kappa": "κ",
    "varkappa": "ϰ",
    "lambda": "λ",
    "mu": "μ",
    "nu": "ν",
    "xi": "ξ",
    "pi": "π",
    "varpi": "ϖ",
    "rho": "ρ",
    "varrho": "ϱ",
    "sigma": "σ",
    "varsigma": "ς",
    "tau": "τ",
    "upsilon": "υ",
    "phi": "φ",
    "varphi": "φ",
    "chi": "χ",
    "psi": "ψ",
    "omega": "ω",
    "digamma": "ϝ",
    # --- Greek uppercase ---
    "Gamma": "Γ",
    "Delta": "Δ",
    "Theta": "Θ",
    "Lambda": "Λ",
    "Xi": "Ξ",
    "Pi": "Π",
    "Sigma": "Σ",
    "Upsilon": "Υ",
    "Phi": "Φ",
    "Psi": "Ψ",
    "Omega": "Ω",
    # --- Set theory & logic ---
    "in": "∈",
    "notin": "∉",
    "ni": "∋",
    "owns": "∋",
    "subset": "⊂",
    "supset": "⊃",
    "subseteq": "⊆",
    "supseteq": "⊇",
    "nsubseteq": "⊈",
    "nsupseteq": "⊉",
    "subsetneq": "⊊",
    "supsetneq": "⊋",
    "sqsubset": "⊏",
    "sqsupset": "⊐",
    "sqsubseteq": "⊑",
    "sqsupseteq": "⊒",
    "cup": "∪",
    "cap": "∩",
    "bigcup": "⋃",
    "bigcap": "⋂",
    "setminus": "∖",
    "smallsetminus": "∖",
    "emptyset": "∅",
    "varnothing": "∅",
    "forall": "∀",
    "exists": "∃",
    "nexists": "∄",
    "neg": "¬",
    "lnot": "¬",
    "wedge": "∧",
    "land": "∧",
    "vee": "∨",
    "lor": "∨",
    "barwedge": "⊼",
    "doublebarwedge": "⌆",
    "curlywedge": "⋏",
    "curlyvee": "⋎",
    "because": "∵",
    "therefore": "∴",
    "multimap": "⊸",
    # --- Arrows ---
    "rightarrow": "→",
    "to": "→",
    "longrightarrow": "⟶",
    "leftarrow": "←",
    "gets": "←",
    "longleftarrow": "⟵",
    "Rightarrow": "⇒",
    "Longrightarrow": "⟹",
    "Leftarrow": "⇐",
    "Longleftarrow": "⟸",
    "leftrightarrow": "↔",
    "longleftrightarrow": "⟷",
    "Leftrightarrow": "⇔",
    "Longleftrightarrow": "⟺",
    "mapsto": "↦",
    "longmapsto": "⟼",
    "hookrightarrow": "↪",
    "hookleftarrow": "↩",
    "twoheadrightarrow": "↠",
    "twoheadleftarrow": "↞",
    "rightarrowtail": "↣",
    "leftarrowtail": "↢",
    "looparrowright": "↬",
    "looparrowleft": "↫",
    "curvearrowright": "↷",
    "curvearrowleft": "↶",
    "circlearrowright": "↻",
    "circlearrowleft": "↺",
    "uparrow": "↑",
    "downarrow": "↓",
    "updownarrow": "↕",
    "Uparrow": "⇑",
    "Downarrow": "⇓",
    "Updownarrow": "⇕",
    "nearrow": "↗",
    "searrow": "↘",
    "nwarrow": "↖",
    "swarrow": "↙",
    "nrightarrow": "↛",
    "nleftarrow": "↚",
    "nRightarrow": "⇏",
    "nLeftarrow": "⇍",
    "nleftrightarrow": "↮",
    "nLeftrightarrow": "⇎",
    "leadsto": "⇝",
    "rightsquigarrow": "⇝",
    "leftrightsquigarrow": "↭",
    "dashrightarrow": "⇢",
    "dashleftarrow": "⇠",
    "Rrightarrow": "⇛",
    "Lleftarrow": "⇚",
    # --- Large operators & misc math ---
    "sum": "∑",
    "prod": "∏",
    "coprod": "∐",
    "int": "∫",
    "iint": "∬",
    "iiint": "∭",
    "oint": "∮",
    "bigoplus": "⨁",
    "bigotimes": "⨂",
    "bigodot": "⨀",
    "biguplus": "⨄",
    "bigsqcup": "⨆",
    "bigvee": "⋁",
    "bigwedge": "⋀",
    "partial": "∂",
    "nabla": "∇",
    "infty": "∞",
    "sqrt": "√",
    "hbar": "ℏ",
    "hslash": "ℏ",
    "ell": "ℓ",
    "Re": "ℜ",
    "Im": "ℑ",
    "aleph": "ℵ",
    "beth": "ℶ",
    "gimel": "ℷ",
    "wp": "℘",
    "mid": "∣",
    "nmid": "∤",
    "shortmid": "∣",
    "parallelslant": "∥",
    "ast": "∗",
    "star": "⋆",
    "bigstar": "★",
    "bullet": "•",
    "oplus": "⊕",
    "ominus": "⊖",
    "otimes": "⊗",
    "oslash": "⊘",
    "odot": "⊙",
    "circledast": "⊛",
    "circledcirc": "⊚",
    "circleddash": "⊝",
    "boxplus": "⊞",
    "boxminus": "⊟",
    "boxtimes": "⊠",
    "boxdot": "⊡",
    "dagger": "†",
    "ddagger": "‡",
    "dag": "†",
    "ddag": "‡",
    "amalg": "⨿",
    "sqcap": "⊓",
    "sqcup": "⊔",
    "uplus": "⊎",
    "veebar": "⊻",
    "intercal": "⊺",
    "ltimes": "⋉",
    "rtimes": "⋊",
    "leftthreetimes": "⋋",
    "rightthreetimes": "⋌",
    "divideontimes": "⋇",
    "dotplus": "∔",
    "doublecap": "⋒",
    "doublecup": "⋓",
    "Cap": "⋒",
    "Cup": "⋓",
    "wr": "≀",
    # --- Brackets ---
    "langle": "⟨",
    "rangle": "⟩",
    "lceil": "⌈",
    "rceil": "⌉",
    "lfloor": "⌊",
    "rfloor": "⌋",
    "lvert": "∣",
    "rvert": "∣",
    "lVert": "‖",
    "rVert": "‖",
    "vert": "∣",
    "Vert": "‖",
    "ulcorner": "⌜",
    "urcorner": "⌝",
    "llcorner": "⌞",
    "lrcorner": "⌟",
    "lbrace": "{",
    "rbrace": "}",
    "lbrack": "[",
    "rbrack": "]",
    # --- Shapes & misc symbols ---
    "square": "□",
    "blacksquare": "■",
    "Box": "□",
    "diamond": "⋄",
    "Diamond": "◇",
    "lozenge": "◊",
    "blacklozenge": "⧫",
    "bigcirc": "○",
    "maltese": "✠",
    "checkmark": "✓",
    "S": "§",
    "P": "¶",
    "copyright": "©",
    "pounds": "£",
    "euro": "€",
    "yen": "¥",
    "celsius": "℃",
    "micro": "µ",
    "ohm": "Ω",
    "angstrom": "Å",
    "mho": "℧",
    "natural": "♮",
    "sharp": "♯",
    "flat": "♭",
    "clubsuit": "♣",
    "diamondsuit": "♢",
    "heartsuit": "♡",
    "spadesuit": "♠",
    "surd": "√",
    "imath": "ı",
    "jmath": "ȷ",
    "Finv": "Ⅎ",
    "Game": "⅁",
    "complement": "∁",
    "eth": "ð",
    "minuso": "⦵",
    "ratio": "∶",
    "colon": ":",
    "lt": "<",
    "gt": ">",
}

# Blackboard-bold letters (\mathbb{R} -> ℝ)
MATHBB_MAP: dict[str, str] = {
    "A": "𝔸", "B": "𝔹", "C": "ℂ", "D": "𝔻", "E": "𝔼",
    "F": "𝔽", "G": "𝔾", "H": "ℍ", "I": "𝕀", "J": "𝕁",
    "K": "𝕂", "L": "𝕃", "M": "𝕄", "N": "ℕ", "O": "𝕆",
    "P": "ℙ", "Q": "ℚ", "R": "ℝ", "S": "𝕊", "T": "𝕋",
    "U": "𝕌", "V": "𝕍", "W": "𝕎", "X": "𝕏", "Y": "𝕐",
    "Z": "ℤ", "0": "𝟘", "1": "𝟙",
}

# Superscript / subscript character maps
SUPERSCRIPT_MAP: dict[str, str] = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "n": "ⁿ", "i": "ⁱ", "a": "ᵃ", "b": "ᵇ", "c": "ᶜ",
    "d": "ᵈ", "e": "ᵉ", "o": "ᵒ", "x": "ˣ", "y": "ʸ",
    "t": "ᵗ", "m": "ᵐ", "k": "ᵏ", "p": "ᵖ", "s": "ˢ",
    "u": "ᵘ", "v": "ᵛ", "w": "ʷ", "z": "ᶻ", "r": "ʳ",
    "h": "ʰ", "j": "ʲ", "g": "ᵍ", "f": "ᶠ", "l": "ˡ",
}

SUBSCRIPT_MAP: dict[str, str] = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "i": "ᵢ", "o": "ₒ", "r": "ᵣ",
    "u": "ᵤ", "v": "ᵥ", "x": "ₓ", "n": "ₙ", "m": "ₘ",
    "k": "ₖ", "l": "ₗ", "p": "ₚ", "s": "ₛ", "t": "ₜ",
    "j": "ⱼ", "h": "ₕ",
}

# Standard math function names — output as plain upright text, no warning
MATH_FUNCTIONS: set[str] = {
    "sin", "cos", "tan", "cot", "sec", "csc", "cosec",
    "arcsin", "arccos", "arctan", "arccot", "arcsec", "arccsc",
    "sinh", "cosh", "tanh", "coth", "sech", "csch",
    "log", "ln", "lg", "exp", "expm1", "log10", "log2",
    "min", "max", "arg", "deg", "det", "dim", "gcd", "lcm",
    "hom", "inf", "sup", "lim", "liminf", "limsup", "Pr",
    "ker", "im", "rank", "tr", "diag", "sgn", "mod",
}

# Commands whose replacement keeps a trailing space (LaTeX swallows the space
# after a control word; for relations / operators / variables / arrows we add
# one back so `AD \perp BC` -> `AD ⊥ BC` instead of `AD ⊥BC`, and
# `\alpha + \beta` -> `α + β` instead of `α+ β`). Symbols that must hug the
# following token (e.g. \triangle ABC -> △ABC, \angle BDA -> ∠BDA) are NOT
# listed here.
_SPACED_CMDS: frozenset[str] = frozenset({
    # Greek letters (variables read better with breathing room)
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta",
    "eta", "theta", "vartheta", "iota", "kappa", "varkappa", "lambda",
    "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma",
    "varsigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
    "digamma", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma",
    "Upsilon", "Phi", "Psi", "Omega",
    # Binary operators
    "times", "div", "cdot", "pm", "mp", "ast", "star", "bullet", "circ",
    "oplus", "ominus", "otimes", "oslash", "odot", "circledast",
    "circledcirc", "circleddash", "boxplus", "boxminus", "boxtimes",
    "boxdot", "dagger", "ddagger", "dag", "ddag", "amalg", "sqcap",
    "sqcup", "uplus", "veebar", "intercal", "ltimes", "rtimes",
    "leftthreetimes", "rightthreetimes", "divideontimes", "dotplus",
    "doublecap", "doublecup", "Cap", "Cup", "wr",
    # Relations
    "perp", "parallel", "nparallel", "mid", "nmid", "shortmid",
    "parallelslant", "in", "notin", "ni", "owns", "subset", "supset",
    "subseteq", "supseteq", "nsubseteq", "nsupseteq", "subsetneq",
    "supsetneq", "sqsubset", "sqsupset", "sqsubseteq", "sqsupseteq",
    "cup", "cap", "setminus", "smallsetminus", "leq", "le", "leqq",
    "leqslant", "geq", "ge", "geqq", "geqslant", "neq", "ne", "lneq",
    "gneq", "ll", "gg", "lll", "ggg", "lesssim", "gtrsim",
    "lessapprox", "gtrapprox", "approx", "approxeq", "equiv", "sim",
    "nsim", "simeq", "cong", "ncong", "propto", "asymp", "doteq",
    "doteqdot", "triangleq", "circeq", "risingdotseq", "fallingdotseq",
    "models", "vdash", "dashv", "Vvdash", "prec", "succ", "preceq",
    "succeq", "bowtie", "smile", "frown", "between", "pitchfork",
    "backepsilon", "because", "therefore", "multimap", "ratio",
    "colon", "lt", "gt",
    # Arrows
    "to", "rightarrow", "longrightarrow", "leftarrow", "gets",
    "longleftarrow", "Rightarrow", "Longrightarrow", "Leftarrow",
    "Longleftarrow", "leftrightarrow", "longleftrightarrow",
    "Leftrightarrow", "Longleftrightarrow", "mapsto", "longmapsto",
    "hookrightarrow", "hookleftarrow", "twoheadrightarrow",
    "twoheadleftarrow", "rightarrowtail", "leftarrowtail",
    "looparrowright", "looparrowleft", "curvearrowright",
    "curvearrowleft", "circlearrowright", "circlearrowleft", "uparrow",
    "downarrow", "updownarrow", "Uparrow", "Downarrow", "Updownarrow",
    "nearrow", "searrow", "nwarrow", "swarrow", "nrightarrow",
    "nleftarrow", "nRightarrow", "nLeftarrow", "nleftrightarrow",
    "nLeftrightarrow", "leadsto", "rightsquigarrow", "leftrightsquigarrow",
    "dashrightarrow", "dashleftarrow", "Rrightarrow", "Lleftarrow",
    # Large operators
    "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "bigoplus",
    "bigotimes", "bigodot", "biguplus", "bigsqcup", "bigvee", "bigwedge",
    "partial", "nabla",
    # Logic connectives
    "forall", "exists", "nexists", "neg", "lnot", "wedge", "land",
    "vee", "lor", "barwedge", "doublebarwedge", "curlywedge", "curlyvee",
    # Misc
    "infty", "emptyset", "varnothing", "complement",
})

# Track unmapped commands seen during conversion (reported via logging)
_unknown_commands: set[str] = set()

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------
_FRAC_RE = re.compile(r"\\[cdt]?frac\{([^{}]*)\}\{([^{}]*)\}")
_BINOM_RE = re.compile(r"\\(?:binom|dbinom|tbinom)\{([^{}]*)\}\{([^{}]*)\}")
_SQRT_OPT_RE = re.compile(r"\\sqrt\[([^\]]*)\]\{([^{}]*)\}")
_SQRT_RE = re.compile(r"\\sqrt\{([^{}]*)\}")
_TEXT_CMD_RE = re.compile(
    r"\\(?:text|textrm|textit|textbf|textsf|texttt|textnormal|mathrm|mathbf|mathit|"
    r"mathsf|mathtt|mathnormal|boldsymbol|bm|operatorname|rm|bf|it|sf|tt|cal|mathcal|"
    r"mathfrak|frak|scr|mathscr)\{([^{}]*)\}"
)
_MATHBB_RE = re.compile(r"\\mathbb\{([A-Z0-9])\}")
_COLOR_CMD_RE = re.compile(r"\\(?:color|textcolor)(?:\[[^\]]*\])?\{[^{}]*\}")
_OVERLINE_RE = re.compile(r"\\overline\{([^{}]*)\}")
_UNDERLINE_RE = re.compile(r"\\underline\{([^{}]*)\}")
_ACCENT_RE = re.compile(
    r"\\(?:hat|widehat|tilde|widetilde|bar|vec|dot|ddot|acute|grave|breve|check|"
    r"overrightarrow|overleftarrow|overbrace|underbrace)\{([^{}]*)\}"
)
_OVERSSET_RE = re.compile(r"\\(?:overset|underset|stackrel)\{([^{}]*)\}\{([^{}]*)\}")
_PMOD_RE = re.compile(r"\\pmod\{([^{}]*)\}")
_UNKNOWN_CMD_ARG_RE = re.compile(r"\\([a-zA-Z]+)\{([^{}]*)\}")
_SUPERSCRIPT_GROUP_RE = re.compile(r"\^\{([^{}]*)\}")
_SUPERSCRIPT_SINGLE_RE = re.compile(r"\^(\\[a-zA-Z]+|[^\s({])")
_SUBSCRIPT_GROUP_RE = re.compile(r"_\{([^{}]*)\}")
_SUBSCRIPT_SINGLE_RE = re.compile(r"_(\\[a-zA-Z]+|[^\s({])")
_LEFT_RIGHT_RE = re.compile(r"\\(?:left|right|middle|big|Big|bigg|Bigg|bigl|bigr|Bigl|Bigr|bigm|Bigm|biggl|biggr|Biggl|Biggr)\s*")
_SPACING_RE = re.compile(r"\\(?:,|;|:|!|>|quad|qquad|enspace|thinspace|medspace|thickspace|negthinspace|displaystyle|textstyle|scriptstyle|scriptscriptstyle|limits|nolimits|displaystyle)\b")
_ESCAPED_CHAR_RE = re.compile(r"\\([%$&#_{}])")
_BACKSLASH_NEWLINE_RE = re.compile(r"\\\\")
_UNKNOWN_CMD_RE = re.compile(r"\\([a-zA-Z]+)")

# Build one alternation regex for all symbol commands, longest first.
# Trailing \s* swallows the space that terminates a LaTeX control word;
# _replace_symbol adds one back for commands in _SPACED_CMDS.
_SYMBOL_ALT = "|".join(sorted((re.escape(k) for k in LATEX_SYMBOLS), key=len, reverse=True))
_SYMBOL_RE = re.compile(r"\\(" + _SYMBOL_ALT + r")(?![a-zA-Z])\s*")


def _to_superscript(text: str) -> str:
    """Convert text to Unicode superscripts where possible."""
    out = []
    for ch in text:
        if ch in SUPERSCRIPT_MAP:
            out.append(SUPERSCRIPT_MAP[ch])
        elif ch == " ":
            continue
        else:
            return "^(" + text + ")" if len(text) > 1 else "^" + text
    return "".join(out)


def _to_subscript(text: str) -> str:
    """Convert text to Unicode subscripts where possible."""
    out = []
    for ch in text:
        if ch in SUBSCRIPT_MAP:
            out.append(SUBSCRIPT_MAP[ch])
        elif ch == " ":
            continue
        else:
            return "_(" + text + ")" if len(text) > 1 else "_" + text
    return "".join(out)


_SCRIPT_CHARS = frozenset(SUPERSCRIPT_MAP.values()) | frozenset(SUBSCRIPT_MAP.values())


def _replace_symbol(m: re.Match) -> str:
    cmd = m.group(1)
    sym = LATEX_SYMBOLS[cmd]
    if cmd not in _SPACED_CMDS:
        return sym
    # Keep operators hugging their limits: \sum_{i=1} -> ∑_(i=1), \int_0^1 -> ∫₀¹
    next_char = m.string[m.end():m.end() + 1]
    if next_char and (next_char in "_^" or next_char in _SCRIPT_CHARS):
        return sym
    return sym + " "


def _mathbb_sub(m: re.Match) -> str:
    return MATHBB_MAP.get(m.group(1), m.group(1))


def _group_super(m: re.Match) -> str:
    inner = m.group(1).strip()
    # Operator limits like ^{i=1} render better as ^(i=1)
    if "=" in inner:
        return "^(" + inner + ")"
    return _to_superscript(inner)


def _group_sub(m: re.Match) -> str:
    inner = m.group(1).strip()
    if "=" in inner:
        return "_(" + inner + ")"
    return _to_subscript(inner)


def _unknown_sub(m: re.Match) -> str:
    """Fallback for unmapped commands: keep readable name, log for triage."""
    name = m.group(1)
    if name in MATH_FUNCTIONS:
        return name
    if name not in _unknown_commands:
        _unknown_commands.add(name)
        logger.warning("latex_to_unicode: unmapped LaTeX command '\\%s' -> '%s'", name, name)
    return name


def _unknown_arg_sub(m: re.Match) -> str:
    """Unknown command with a brace argument: \\foo{bar} -> foo(bar)."""
    name, arg = m.group(1), m.group(2)
    if name in MATH_FUNCTIONS:
        return f"{name}({arg.strip()})"
    if name not in _unknown_commands:
        _unknown_commands.add(name)
        logger.warning("latex_to_unicode: unmapped LaTeX command '\\%s{...}' -> '%s(...)'", name, name)
    return f"{name}({arg.strip()})"


def latex_to_unicode(s: str) -> str:
    """
    Convert a LaTeX math string to readable Unicode text.

    Examples:
        "\\\\triangle ABC"            -> "△ABC"
        "AD \\\\perp BC"              -> "AD ⊥ BC"
        "90^\\\\circ"                  -> "90°"
        "x^{2}"                       -> "x²"
        "\\\\frac{1}{2}"              -> "1/2"
        "\\\\mathbb{R}"               -> "ℝ"

    Unmapped commands degrade to their plain name (backslash stripped)
    and are logged once via the module logger — raw LaTeX source
    never leaks through.
    """
    if not s:
        return s

    text = s

    # 1. Fractions, binomials, square roots (repeat for nesting)
    for _ in range(4):
        prev = text
        text = _FRAC_RE.sub(lambda m: f"{m.group(1).strip()}/{m.group(2).strip()}", text)
        text = _BINOM_RE.sub(lambda m: f"C({m.group(1).strip()},{m.group(2).strip()})", text)
        text = _SQRT_OPT_RE.sub(lambda m: f"√[{m.group(1).strip()}]({m.group(2).strip()})", text)
        text = _SQRT_RE.sub(lambda m: f"√({m.group(1).strip()})", text)
        if text == prev:
            break

    # 2. Font / color / accent commands: keep inner content
    for _ in range(4):
        prev = text
        text = _TEXT_CMD_RE.sub(lambda m: m.group(1), text)
        text = _COLOR_CMD_RE.sub("", text)
        text = _OVERLINE_RE.sub(lambda m: m.group(1), text)
        text = _UNDERLINE_RE.sub(lambda m: m.group(1), text)
        text = _ACCENT_RE.sub(lambda m: m.group(1), text)
        text = _OVERSSET_RE.sub(lambda m: m.group(2), text)
        if text == prev:
            break

    # 3. Blackboard bold & modulo notation
    text = _MATHBB_RE.sub(_mathbb_sub, text)
    text = _PMOD_RE.sub(lambda m: f"(mod {m.group(1).strip()})", text)
    text = re.sub(r"\\bmod\b", "mod", text)

    # 4. Superscripts / subscripts (groups first, then single tokens)
    text = _SUPERSCRIPT_GROUP_RE.sub(_group_super, text)

    def _single_super(m: re.Match) -> str:
        tok = m.group(1)
        if tok.startswith("\\"):
            name = tok[1:]
            if name in ("circ", "degree"):
                return "°"
            if name == "prime":
                return "′"
            sym = LATEX_SYMBOLS.get(name)
            if sym and sym in SUPERSCRIPT_MAP.values():
                return sym
            return sym if sym is not None else _unknown_sub(m)
        return _to_superscript(tok)

    text = _SUPERSCRIPT_SINGLE_RE.sub(_single_super, text)
    text = _SUBSCRIPT_GROUP_RE.sub(_group_sub, text)

    def _single_sub(m: re.Match) -> str:
        tok = m.group(1)
        if tok.startswith("\\"):
            return tok  # leave command subscripts for symbol replacement
        return _to_subscript(tok)

    text = _SUBSCRIPT_SINGLE_RE.sub(_single_sub, text)

    # 5. Symbol replacement (longest command names first)
    text = _SYMBOL_RE.sub(_replace_symbol, text)

    # 6. Sizing / spacing / style commands & escaped special chars
    text = _LEFT_RIGHT_RE.sub("", text)
    text = _SPACING_RE.sub("", text)
    text = _ESCAPED_CHAR_RE.sub(lambda m: m.group(1), text)
    text = _BACKSLASH_NEWLINE_RE.sub(" ", text)
    text = text.replace("\\ ", " ").replace("~", " ")

    # 7. Fallback: unknown commands keep a readable form.
    #    \\foo{bar} -> foo(bar);  bare \\foo -> foo
    for _ in range(3):
        prev = text
        text = _UNKNOWN_CMD_ARG_RE.sub(_unknown_arg_sub, text)
        if text == prev:
            break
    text = _UNKNOWN_CMD_RE.sub(_unknown_sub, text)

    # 8. Clean up residual braces and collapse whitespace
    text = text.replace("{", "").replace("}", "")
    text = re.sub(r"[ \t]+", " ", text)

    return text.strip()


def get_unknown_commands() -> set[str]:
    """Return the set of unmapped commands encountered so far."""
    return set(_unknown_commands)


# ---------------------------------------------------------------------------
# CLI scanner: audit coverage over real OCR markdown output
# ---------------------------------------------------------------------------
def scan_directory(root: str) -> None:
    """Scan *.md files under root and report LaTeX command coverage."""
    cmd_counts: dict[str, int] = {}
    files = sorted(Path(root).rglob("*.md"))
    cmd_re = re.compile(r"\\([a-zA-Z]+)")
    for f in files:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for cmd in cmd_re.findall(content):
            cmd_counts[cmd] = cmd_counts.get(cmd, 0) + 1

    covered = {c: n for c, n in cmd_counts.items() if c in LATEX_SYMBOLS}
    uncovered = {c: n for c, n in cmd_counts.items() if c not in LATEX_SYMBOLS}

    total = sum(cmd_counts.values())
    cov_total = sum(covered.values())
    print(f"Scanned {len(files)} markdown files under {root}")
    print(f"Commands found: {total} total, {len(cmd_counts)} unique")
    print(f"Coverage: {cov_total}/{total} occurrences ({100*cov_total/max(total,1):.1f}%), "
          f"{len(covered)}/{len(cmd_counts)} unique")
    if uncovered:
        print("\nUncovered commands (count, name):")
        for name, n in sorted(uncovered.items(), key=lambda kv: -kv[1]):
            print(f"  {n:5d}  \\{name}")
    else:
        print("\nAll commands are covered.")


if __name__ == "__main__":
    scan_directory(sys.argv[1] if len(sys.argv) > 1 else "batches")
