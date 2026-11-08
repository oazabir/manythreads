# Licence and provenance of the speech fixtures

## `nadia.wav` and `rafi.wav` (real speech, CC BY 4.0)

Two short read-aloud English clips, cut from the **LibriSpeech** corpus through the Hugging Face dataset `hf-internal-testing/librispeech_asr_dummy`
(config `clean`, split `validation`, a 73-clip sample of LibriSpeech dev-clean). Both clips have the same speaker (LibriSpeech speaker 1272), so they
test "two people" only by being two different sentences.

| File | LibriSpeech id | Length | Row in the dataset |
|---|---|---|---|
| `nadia.wav` | `1272-141231-0009` | 8.6 s | 49 |
| `rafi.wav` | `1272-135031-0023` | 7.5 s | 38 |

- **Source corpus:** V. Panayotov, G. Chen, D. Povey, S. Khudanpur, "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015.
  The corpus is licensed **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/); the readings come from LibriVox volunteers, whose recordings
  are in the public domain.
- **What was changed:** the dataset serves FLAC; each file here is that audio decoded to 16 kHz, mono, 16-bit PCM in a WAV container. Nothing else
  was done to it (no trimming, no gain, no noise).
- **Credit to give wherever these files are shown or redistributed:** "LibriSpeech (Panayotov et al., 2015), CC BY 4.0, via
  hf-internal-testing/librispeech_asr_dummy; converted to 16 kHz mono WAV."
- The Hugging Face dataset card itself states no licence; the licence above is the one of the corpus it was copied from.

The words each clip holds are in `references.json`. Live checks compare against them only loosely (see `docs/plugins/meetings.md`, "Live checks").

## `hello.wav` (synthetic, no speech)

`hello.wav` is **synthetic**. `generate.mjs` builds it from arithmetic (sine harmonics shaped by vowel formants); no recording, no text-to-speech
voice and no third-party audio was used or downloaded. It holds no speech. The author of this repository releases it, and the script that
makes it, under CC0 1.0 (no rights reserved).

The words the tests see ("This is a test voice message.") come from the fake speech engine, not from the audio.

There are still no Bangla or accented-speech clips here. If the owner adds more real clips, list each one here with its source, licence and credit,
and add its reference text to `references.json`.
