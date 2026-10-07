from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
with Image.open(root / 'src/assets/logo.png') as image:
    image.convert('RGBA').save(root / 'build/icon.ico', format='ICO',
                              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
