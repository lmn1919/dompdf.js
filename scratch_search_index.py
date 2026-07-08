with open("examples/index.html", "r", encoding="utf-8") as f:
    lines = f.readlines()

for idx, line in enumerate(lines, 1):
    if "doc =" in line or "var doc" in line:
        print(f"Line {idx}: {line.strip()}")
