"""Regenerate floor-metrics.ttf with fontTools (not needed to run the tests).

Original test glyphs, under the repository's Apache-2.0 licence. Every printable
ASCII character has a one-em advance, deliberately wider than the monospace
fallback at 13 px. Loading this file exercises real browser font measurement
without installed fonts or a network connection.
"""

from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

font = FontBuilder(1000, isTTF=True)
font.setupGlyphOrder([".notdef", "space", "box"])
font.setupCharacterMap({code: "box" for code in range(33, 127)} | {32: "space"})
glyphs = {}
for name in [".notdef", "space", "box"]:
    pen = TTGlyphPen(None)
    if name != "space":
        pen.moveTo((100, 0))
        pen.lineTo((100, 700))
        pen.lineTo((900, 700))
        pen.lineTo((900, 0))
        pen.closePath()
    glyphs[name] = pen.glyph()
font.setupGlyf(glyphs)
font.setupHorizontalMetrics({name: (1000, 0 if name == "space" else 100) for name in glyphs})
font.setupHorizontalHeader(ascent=800, descent=-200)
font.setupNameTable({"familyName": "Floor Metrics", "styleName": "Regular",
                    "uniqueFontIdentifier": "ShellPuppet Floor Metrics 1.0",
                    "fullName": "Floor Metrics Regular", "psName": "FloorMetrics-Regular",
                    "version": "Version 1.0"})
font.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
font.setupPost(isFixedPitch=1)
font.setupMaxp()
font.setupHead(created=2082844800, modified=2082844800)
font.font.recalcTimestamp = False
font.save(Path(__file__).with_name("floor-metrics.ttf"))
