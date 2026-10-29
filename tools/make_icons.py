"""Рисует значки Корзинки в docs/icons: белая корзинка на зелёном."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "docs" / "icons"
BG, FG, ACCENT = "#2d7a4c", "#ffffff", "#f2b632"


def draw(size, maskable):
    s = 4  # рисуем крупнее и уменьшаем — так края гладкие
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, n, n], fill=BG)
        k = 0.62  # знак внутри «безопасной» зоны
    else:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 0.22, fill=BG)
        k = 0.8
    c = n / 2
    u = n * k / 2  # половина ширины знака
    w = max(2, int(n * 0.05 * k))
    # ручка
    d.arc([c - u * 0.55, c - u * 0.95, c + u * 0.55, c + u * 0.15], 180, 360, fill=FG, width=w)
    # корзина: трапеция
    top, bot = c - u * 0.35, c + u * 0.75
    body = [(c - u, top), (c + u, top), (c + u * 0.75, bot), (c - u * 0.75, bot)]
    d.polygon(body, fill=FG)
    # прорези
    for i in (-0.45, 0, 0.45):
        x = c + u * i
        d.line([(x, top + u * 0.22), (x * 0.92 + c * 0.08, bot - u * 0.18)], fill=BG, width=int(w * 0.8))
    # жёлтый ободок сверху
    d.rounded_rectangle([c - u * 1.08, top - u * 0.1, c + u * 1.08, top + u * 0.12], radius=w, fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
draw(192, False).save(OUT / "icon-192.png")
draw(512, False).save(OUT / "icon-512.png")
draw(512, True).save(OUT / "maskable-512.png")
print("ok")
