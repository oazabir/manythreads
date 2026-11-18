# Third-party assets

## Profile picture library (50 SVG pictures, P14-24)

The built-in pictures in `clients/web/public/avatars/<id>.svg` came from the owner's `avatars/` folder (added 2026-11-02). The picker shows a credit line, and `clients/web/public/avatars/CREDITS.txt` repeats this.

| Pictures | Made by | Licence |
|---|---|---|
| People: `man-20-casual` … `man-60-formal-shaven` (15), `modest-20-formal` … `modest-60-formal` (5), `hijab-20-casual` … `hijab-60-casual` (5) | DiceBear's **Avataaars** style, designed by Pablo Stanley (https://avataaars.com/), generated with `https://api.dicebear.com/9.x/avataaars/svg` | "Free for personal and commercial use", as DiceBear's styles page says; the author's credit is inside each file's metadata and in the picker. **The owner must read DiceBear's licence page (https://www.dicebear.com/licenses/) before the pictures leave the owner's own deployment.** |
| Animals: `bot-noto-bear` … `bot-noto-tiger` (19) | **Noto Emoji** by Google (https://github.com/googlefonts/noto-emoji), fetched from `fonts.gstatic.com/s/e/notoemoji` | Apache License 2.0 for the image resources. **The licence text is kept beside the files** in `clients/web/public/avatars/LICENSE-noto-emoji.txt`. |
| Brain: `bot-brain`, `bot-brain-chip`, `bot-brain-circuit`, `bot-brain-glow`, `bot-brain-neural`, `bot-brain-orb` (6) | Original artwork drawn for this project | None to credit. |

The files in `avatars/` at the repo root are the unconverted sources (`avatars/LICENSES.md` records how each folder was made); the web app serves the copies under the ids above.

## First picture library (Flaticon, no longer offered)

The 40 built-in profile pictures of the first library in `clients/web/public/avatars/` come from [Flaticon](https://www.flaticon.com), chosen by the owner (2026-11-01). Each was fetched from Flaticon's image server at 512 pixels
and re-saved at 160 pixels as WebP. Flaticon's free licence asks for **credit to Flaticon and the icon's author** wherever the pictures are shown, which is why the picker says "Earlier pictures by Flaticon" while someone still has one of them
and why this page exists. They stay valid (anyone who chose one keeps it) but are no longer offered; this credit stays while any such value can exist. The owner must confirm that this licence (or a paid plan, if any of these icons is a premium one) covers the way manythreads is distributed before it is shared outside the
owner's own deployment.

| File | Flaticon icon |
|---|---|
| `man-1` … `man-10` | man_2202112, man_4140037, boy_1999625, man_2903405, young-man_4440953, young-boy_16683469, man_4202843, man_4140039, man_2552801, tax-inspector_3868196 |
| `hijab-1` … `hijab-5` | woman_2507657, woman_2507674, muslimah_10002456, woman_2507652, hijab_16497435 |
| `woman-1` … `woman-5` | woman_4140047, profile_3135789, woman_3278793, woman_4140060, woman_921124 |
| `bot-kitty-1`, `bot-kitty-2`, `bot-laughing-cat`, `bot-unicorn-1`, `bot-puppy-1`, `bot-puppy-2`, `bot-unicorn-2`, `bot-panda`, `bot-fox-1`, `bot-chick`, `bot-penguin`, `bot-duck`, `bot-gorilla`, `bot-fox-2`, `bot-dino`, `bot-cat`, `bot-dog`, `bot-bear`, `bot-rabbit`, `bot-lion` | kitty_763769, kitty_763718, lol_3906557, unicorn_1049968, dog_1049417, dog_1049366, unicorn_3578628, panda_1326377, meerkat_1326390, chicken_1326405, penguin_9308879, duck_9308963, gorilla_9308979, fox_9308916, dinosaur_4681809, cat_4322991, dog_4322992, bear_3940403, rabbit_3940417, lion_1760998 |

The number after the underscore is the icon's number on Flaticon (`https://www.flaticon.com/free-icon/<name>_<number>`).

## Fonts (Inter, JetBrains Mono, and the faces of the Linen and Harbor themes)

Served from `clients/web/public/fonts` (declared in `clients/web/src/styles/fonts.css`); the app never loads a font from a CDN.

| Font | Files | Licence |
|---|---|---|
| **Inter** (the default font of every screen), variable weight 100-900, by Rasmus Andersson (https://fonts.google.com/specimen/Inter) | `inter-<script>.woff2` for latin, latin-ext, vietnamese, cyrillic, cyrillic-ext, greek, greek-ext, and `inter-latin-italic`, `inter-latin-ext-italic` | SIL Open Font License 1.1; the text is `clients/web/public/fonts/OFL-Inter.txt`. |
| **JetBrains Mono** (code and terminals only), latin subset | `jetbrains-mono-latin.woff2` | SIL Open Font License 1.1. |
| **IBM Plex Sans** (Linen's text), 400, 500, 600, and **IBM Plex Mono** 400 (Linen's code), IBM; npm `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono` 5.3.0 | `ibm-plex-sans-<script>-<weight>-normal.woff2`, `ibm-plex-mono-<script>-400-normal.woff2` for latin, latin-ext, cyrillic | SIL Open Font License 1.1; `OFL-ibm-plex-sans.txt`, `OFL-ibm-plex-mono.txt`. |
| **Source Serif 4** (Linen's page and panel titles only), variable weight, Adobe; npm `@fontsource-variable/source-serif-4` 5.3.1 | `source-serif-4-<script>-wght-normal.woff2` | SIL Open Font License 1.1; `OFL-source-serif-4.txt`. |
| **Geist** (Harbor's text) and **Geist Mono** (Harbor's code), variable weight, Vercel; npm `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` 5.3.0 | `geist-<script>-wght-normal.woff2`, `geist-mono-<script>-wght-normal.woff2` | SIL Open Font License 1.1; `OFL-geist.txt`, `OFL-geist-mono.txt`. |

These are copied out of the npm packages by `clients/web/scripts/copy-fonts.mjs` (which writes `src/styles/fonts-palettes.css`); the files are committed, so a build needs no network. Only the chosen theme's text face is preloaded (`public/theme-boot.js`).

## Speech model and ffmpeg in the asr image (P32, decision D13)

The `asr` image (`deploy/images/asr`) holds third-party software; the full notice is `deploy/images/asr/NOTICE`, also inside the image at `/app/NOTICE`.

| What | Made by | Licence |
|---|---|---|
| **NVIDIA Parakeet TDT 0.6B v3** speech model (<https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>), as the int8 ONNX conversion `istupakov/parakeet-tdt-0.6b-v3-onnx` | NVIDIA (model), istupakov (conversion) | **CC-BY-4.0**: credit NVIDIA wherever the model is described (`docs/deploy.md` "Speech to text"); changes: converted to ONNX and quantised to int8, no retraining. |
| **Silero VAD** voice activity model (<https://github.com/snakers4/silero-vad>), as the ONNX copy `istupakov/silero-vad-onnx` that onnx-asr downloads | Silero team (model), istupakov (ONNX copy) | **MIT**: keep the copyright notice and licence text (`deploy/images/asr/NOTICE`, inside the image at `/app/NOTICE`); no changes. It cuts a clip into speech segments before Parakeet reads it. |
| **ffmpeg** as packaged by Debian (turns an uploaded clip into samples; run only as a separate program) | The FFmpeg developers, Debian | **GPL** (v2 or later) for Debian's build; the licence texts are in the image under `/usr/share/doc/ffmpeg/` and `/usr/share/common-licenses/`. |
| onnx-asr, onnxruntime, numpy, FastAPI, uvicorn and their dependencies | Their authors | MIT, BSD or Apache-2.0, pinned with hashes in `requirements.txt`. |
