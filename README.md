# Ra (web)

Play Ra against 2–4 computer opponents in the browser. This is a port of a Visual Basic 6 program written in 2006–08, whose AI uses neural networks for valuing lots and suns.

- **`modern/`:** the redesigned interface (phones and desktops).
- **`classic/`:** the original Windows interface, rebuilt control by control.

Both are static pages with no build step. Open `index.html` through any web server, for example `python3 -m http.server`.

## The AI

- **Classic AI (2008):** the original evolved and neural-network AI, ported line by line.
- **Improved AI (2026):** re-tuned and retrained in self-play to be stronger and hard to exploit.
  - Against original AIs, one improved AI wins 51–59% of games, depending on the player count.
  - In simulation, an automatic search for exploiting strategies found none that wins more than its fair share against it.

Ra was designed by Reiner Knizia and published by Alea (1999). This is a fan-made program. The tile images come from the 2005 Uberplay edition.
