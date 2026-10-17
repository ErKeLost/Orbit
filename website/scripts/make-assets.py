#!/usr/bin/env python3
"""Generate the favicons and the social card from the mascot + galaxy art.

Run from `website/`: python3 scripts/make-assets.py

The mascot is pastel on transparent, so at 16–32px it vanishes on a light tab.
The icons therefore put it on the site's own dark ground with a rounded square,
which is what makes it read as an app icon rather than a smudge.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
MARK = Image.open(ROOT / "src/assets/orbit-mark.png").convert("RGBA")
GALAXY = Image.open(ROOT / "src/assets/orbit-galaxy.png").convert("RGB")
PUBLIC = ROOT / "public"

ICON = 512
GROUND_TOP = (24, 19, 64)
GROUND_BOTTOM = (8, 7, 30)
INSET = 0.74
RADIUS = 0.235


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius), fill=255
    )
    return mask


def app_icon() -> Image.Image:
    # Vertical gradient ground, then a soft violet light behind the mascot.
    ground = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (ICON, ICON))
    draw = ImageDraw.Draw(gradient)
    for y in range(ICON):
        t = y / (ICON - 1)
        draw.line(
            [(0, y), (ICON, y)],
            fill=tuple(
                round(GROUND_TOP[i] * (1 - t) + GROUND_BOTTOM[i] * t) for i in range(3)
            )
            + (255,),
        )
    glow = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (ICON * 0.08, ICON * 0.02, ICON * 0.92, ICON * 0.78),
        fill=(143, 128, 255, 92),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(ICON * 0.12))
    ground.alpha_composite(gradient)
    ground.alpha_composite(glow)
    ground.putalpha(rounded_mask(ICON, RADIUS))

    mark = MARK.resize((int(ICON * INSET), int(ICON * INSET)), Image.LANCZOS)
    offset = ((ICON - mark.width) // 2, (ICON - mark.height) // 2 + int(ICON * 0.015))
    ground.alpha_composite(mark, offset)
    return ground


def font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in (
        "/System/Library/Fonts/SFNSDisplay.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def social_card() -> Image.Image:
    width, height = 1200, 630
    # Cover-crop the galaxy, the same framing the app uses for its backdrop.
    scale = max(width / GALAXY.width, height / GALAXY.height)
    art = GALAXY.resize(
        (round(GALAXY.width * scale), round(GALAXY.height * scale)), Image.LANCZOS
    )
    left = (art.width - width) // 2
    top = (art.height - height) // 2
    card = art.crop((left, top, left + width, top + height)).convert("RGBA")

    # Darken toward the centre-bottom so the wordmark has somewhere to sit.
    scrim = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(scrim)
    for y in range(height):
        t = max(0.0, (y - height * 0.18) / (height * 0.82))
        draw.line([(0, y), (width, y)], fill=(5, 4, 23, round(210 * t**1.25)))
    card.alpha_composite(scrim)

    mark = MARK.resize((132, 132), Image.LANCZOS)
    card.alpha_composite(mark, ((width - mark.width) // 2, 188))

    draw = ImageDraw.Draw(card)
    title = font(86)
    tagline = font(30)
    draw.text((width / 2, 356), "Orbit", font=title, fill=(245, 242, 255, 255), anchor="mm")
    draw.text(
        (width / 2, 436),
        "Your agent. Your machine.",
        font=tagline,
        fill=(245, 242, 255, 210),
        anchor="mm",
    )
    return card.convert("RGB")


def main() -> None:
    icon = app_icon()
    icon.save(PUBLIC / "icon-512.png", optimize=True)
    for name, size in (
        ("favicon-32.png", 32),
        ("favicon-64.png", 64),
        ("apple-touch-icon.png", 180),
        ("icon-192.png", 192),
    ):
        icon.resize((size, size), Image.LANCZOS).save(PUBLIC / name, optimize=True)
    social_card().save(PUBLIC / "social-card.png", optimize=True)
    print("wrote", ", ".join(sorted(p.name for p in PUBLIC.glob("*.png"))))


if __name__ == "__main__":
    main()
