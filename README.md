# Ra 2.0 (web)

Play Ra against 2–4 computer opponents in the browser: **https://grocklin.github.io/ra/**

This is a port of a Visual Basic 6 program written in 2006–08, whose AI uses neural networks to value lots and suns. Version 2.0 has a redesigned interface for phones and desktops (with dark mode, a whole-game scoring breakdown, hints, and offline play) and a retuned AI.

It is a static page with no build step. To run it locally, serve this folder with any web server, for example `python3 -m http.server`.

## The AI

- **Improved AI (2026, default):** re-tuned and retrained in self-play to be stronger and hard to exploit.
  - Against original AIs, one improved AI wins 58–61% of games, depending on the player count.
  - In simulation, an automatic search for exploiting strategies found none that wins more than its fair share against it.
- **Classic AI (2008):** the original evolved and neural-network AI, ported line by line. Choose it in Settings.
- **Easy mode:** weakens the AI opponents; hints stay at full strength.

Ra was designed by Reiner Knizia and published by Alea (1999). This is a fan-made program. The tile images come from the 2005 Uberplay edition.
