# Licence and provenance of the speech fixtures

`hello.wav` is **synthetic**. `generate.mjs` builds it from arithmetic (sine harmonics shaped by vowel formants); no recording, no text-to-speech
voice and no third-party audio was used or downloaded. It holds no speech. The author of this repository releases it, and the script that
makes it, under CC0 1.0 (no rights reserved).

The words the tests see ("This is a test voice message.") come from the fake speech engine, not from the audio.

There are deliberately **no** English, Bangla or accented-speech clips here: the sandbox that produced these tests had no text-to-speech
tool and no licensed recordings, and downloading corpora (LibriSpeech CC BY 4.0, Mozilla Common Voice CC0) was out of scope. If the owner adds
real clips, list each one here with its source, licence and credit, and add its reference text to `references.json`.
