/*
 * The emoji picker's data and rules (PLAN P14-02): a built-in set in groups, a search by name, a skin tone for the ones that have tones, and a
 * short list of the ones used last. Everything here is plain functions; the browser's storage is passed in, so tests need none.
 */

export type EmojiEntry = { char: string; name: string };
export type EmojiGroup = { id: string; label: string; icon: string; items: readonly EmojiEntry[] };

/** `"😀 grinning smile"` per entry: the character, then its name and words people search by. */
const list = (raw: string): EmojiEntry[] =>
  raw
    .trim()
    .split('\n')
    .map((line) => {
      const at = line.indexOf(' ');
      return { char: line.slice(0, at), name: line.slice(at + 1).trim() };
    });

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    id: 'smileys',
    label: 'Smileys',
    icon: '😀',
    items: list(`
😀 grinning face smile
😃 smiley big eyes
😄 smile happy
😁 beaming grin
😆 laughing squint
😅 sweat smile relief
🤣 rolling on the floor laughing
😂 tears of joy laugh
🙂 slightly smiling
🙃 upside down
😉 wink
😊 blush smiling eyes
😇 angel innocent halo
🥰 smiling with hearts love
😍 heart eyes
🤩 star struck
😘 blowing kiss
😋 yum tasty
😛 tongue out
😜 winking tongue
🤪 zany crazy
🤗 hug hugging
🤔 thinking hmm
🤨 raised eyebrow skeptical
😐 neutral
😑 expressionless
😶 no mouth speechless
🙄 rolling eyes
😏 smirk
😬 grimace awkward
😮 open mouth surprised
😯 hushed
😲 astonished
😳 flushed embarrassed
🥺 pleading puppy eyes
😢 crying sad
😭 sobbing loudly crying
😤 huffing triumph
😠 angry
😡 enraged furious
🤯 mind blown exploding head
😱 screaming fear shocked
😨 fearful
😰 anxious sweat
😓 downcast sweat
😴 sleeping zzz
🤤 drooling
😷 mask sick
🤒 thermometer ill
🤕 bandage hurt
🤢 nauseated sick
🤮 vomiting
🥵 hot overheated
🥶 cold freezing
🥴 woozy dizzy
😎 cool sunglasses
🤓 nerd glasses
🧐 monocle
🫡 salute
🫠 melting face
🤐 zipper mouth secret
🤫 shushing quiet
🤭 hand over mouth giggle
🥳 partying party
🤠 cowboy
😈 smiling devil
👻 ghost
💀 skull
🤖 robot bot
🎃 jack o lantern
`),
  },
  {
    id: 'people',
    label: 'People and hands',
    icon: '👍',
    items: list(`
👍 thumbs up yes approve
👎 thumbs down no
👌 ok hand perfect
✌️ victory peace
🤞 crossed fingers luck
🤟 love you gesture
🤘 rock on horns
🤙 call me shaka
👈 pointing left
👉 pointing right
👆 pointing up
👇 pointing down
☝️ index pointing up
✋ raised hand stop
🖐️ hand fingers splayed
🖖 vulcan salute
👋 waving hand wave hello bye
🤚 raised back of hand
👏 clapping hands applause
🙌 raising hands celebration
👐 open hands
🤝 handshake deal
🙏 folded hands please thanks pray
💪 flexed biceps strong
✍️ writing hand
🤳 selfie
🖕 middle finger
👀 eyes looking
🧠 brain
🫶 heart hands
🫰 pinched fingers
🫱 rightwards hand
🫲 leftwards hand
🙋 person raising hand question
🙇 person bowing sorry
🤦 facepalm
🤷 shrug
💁 person tipping hand
🙆 person gesturing ok
🙅 person gesturing no
🧑‍💻 technologist developer coder
👩‍💻 woman technologist developer
👨‍💻 man technologist developer
🧑‍🔧 mechanic fix
🕵️ detective investigate
🦸 superhero
🧙 mage wizard
🧑‍🚀 astronaut
`),
  },
  {
    id: 'hearts',
    label: 'Hearts and symbols',
    icon: '❤️',
    items: list(`
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
💔 broken heart
💕 two hearts
💯 hundred points perfect
✅ check mark done
☑️ ballot box with check
❌ cross mark wrong
❎ cross mark button
⭕ hollow red circle
❗ exclamation mark
❓ question mark
⚠️ warning caution
🚫 prohibited no entry
⛔ no entry
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle
🔵 blue circle
🟣 purple circle
⚫ black circle
⚪ white circle
🔔 bell notification
🔕 bell with slash muted
➕ plus
➖ minus
➡️ right arrow
⬅️ left arrow
⬆️ up arrow
⬇️ down arrow
🔁 repeat
🔄 counterclockwise arrows refresh
💤 zzz sleep
💬 speech balloon
💭 thought balloon
`),
  },
  {
    id: 'celebrate',
    label: 'Celebration and work',
    icon: '🎉',
    items: list(`
🎉 party popper tada celebrate
🎊 confetti ball
🎈 balloon
🎁 gift present
🏆 trophy winner
🥇 gold medal first
🥈 silver medal second
🥉 bronze medal third
🏅 sports medal
⭐ star
🌟 glowing star
✨ sparkles
🔥 fire hot lit
💥 collision boom
⚡ high voltage zap
🚀 rocket launch ship
🛸 flying saucer
💡 light bulb idea
🔧 wrench tool fix
🔨 hammer build
🛠️ hammer and wrench tools
⚙️ gear settings
🔩 nut and bolt
🧰 toolbox
🔒 locked secure
🔓 unlocked
🔑 key
🛡️ shield security
🐛 bug
🦋 butterfly
🧪 test tube experiment
🧹 broom cleanup
📌 pushpin pin
📎 paperclip
📝 memo note
📄 page document
📁 file folder
📂 open folder
📊 bar chart
📈 chart increasing up
📉 chart decreasing down
📅 calendar date
⏰ alarm clock
⏳ hourglass waiting
🕐 one o'clock time
📦 package box
📢 loudspeaker announcement
📣 megaphone
📧 email
💻 laptop computer
🖥️ desktop computer
⌨️ keyboard
🖱️ computer mouse
📱 mobile phone
🔍 magnifying glass search
🔗 link chain
🧵 thread
💾 floppy disk save
🗑️ wastebasket trash
☕ hot beverage coffee
🍕 pizza
🍺 beer
🍻 clinking beers cheers
🍰 cake
🍪 cookie
`),
  },
  {
    id: 'nature',
    label: 'Animals and nature',
    icon: '🐶',
    items: list(`
🐶 dog face
🐱 cat face
🐭 mouse face
🐹 hamster
🐰 rabbit
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey face
🙈 see no evil monkey
🙉 hear no evil monkey
🙊 speak no evil monkey
🐔 chicken
🐧 penguin
🐦 bird
🦉 owl
🦄 unicorn
🐝 honeybee
🐢 turtle slow
🐍 snake
🐙 octopus
🐳 whale
🐬 dolphin
🐟 fish
🦈 shark
🌲 evergreen tree
🌳 deciduous tree
🌴 palm tree
🌵 cactus
🌸 cherry blossom
🌹 rose
🌻 sunflower
🍀 four leaf clover luck
🍄 mushroom
🌍 globe earth
🌙 crescent moon
☀️ sun sunny
⛅ sun behind cloud
☁️ cloud
🌧️ rain cloud
⛈️ thunderstorm
❄️ snowflake
🌈 rainbow
🌊 water wave
`),
  },
];

/** Entries that take a skin tone: the hand and person emoji above. */
const TONEABLE = new Set(['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🖐️', '🖖', '👋', '🤚', '👏', '🙌', '👐', '🤝', '🙏', '💪', '✍️', '🤳', '🖕', '🫶', '🫰', '🫱', '🫲', '🙋', '🙇', '🤦', '🤷', '💁', '🙆', '🙅', '🧑‍💻', '👩‍💻', '👨‍💻', '🧑‍🔧', '🦸', '🧙', '🧑‍🚀']);

/** Skin tones, in the order shown: none, then the five modifier characters. */
export const SKIN_TONES: ReadonlyArray<{ id: number; label: string; mark: string }> = [
  { id: 0, label: 'Default (yellow)', mark: '' },
  { id: 1, label: 'Light skin tone', mark: '\u{1F3FB}' },
  { id: 2, label: 'Medium-light skin tone', mark: '\u{1F3FC}' },
  { id: 3, label: 'Medium skin tone', mark: '\u{1F3FD}' },
  { id: 4, label: 'Medium-dark skin tone', mark: '\u{1F3FE}' },
  { id: 5, label: 'Dark skin tone', mark: '\u{1F3FF}' },
];

const VARIATION = /️/g;
const JOINER = '‍';

export const takesTone = (char: string): boolean => TONEABLE.has(char);

/** The emoji in the chosen skin tone; one that takes no tone (or tone 0) is returned as it is. For `🧑‍💻` the tone goes after the first person. */
export function withTone(char: string, tone: number): string {
  const mark = SKIN_TONES[tone]?.mark ?? '';
  if (mark === '' || !takesTone(char)) return char;
  const bare = char.replace(VARIATION, '');
  const parts = bare.split(JOINER);
  const first = parts[0] ?? bare;
  // the tone follows the first character of the first part (a person or a hand), and the rest of a joined emoji stays
  const head = [...first];
  const rest = parts.length > 1 ? JOINER + parts.slice(1).join(JOINER) : '';
  return `${head[0] ?? ''}${mark}${head.slice(1).join('')}${rest}`;
}

/** The built-in emoji whose name carries every word typed, in picker order. */
export function searchEmoji(query: string, limit = 60): EmojiEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: EmojiEntry[] = [];
  for (const g of EMOJI_GROUPS) {
    for (const e of g.items) {
      const name = e.name.toLowerCase();
      if (words.every((w) => name.includes(w))) {
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export const RECENT_LIMIT = 16;

/** The recent list with `char` first (it moves up when already there) and no more than `RECENT_LIMIT`. */
export function pushRecent(recent: readonly string[], char: string): string[] {
  return [char, ...recent.filter((c) => c !== char)].slice(0, RECENT_LIMIT);
}

/* ---- what the browser keeps ---------------------------------------------------------------------------------------------------------- */

const RECENT_KEY = 'manythreads.emoji.recent';
const TONE_KEY = 'manythreads.emoji.tone';

/** A string array from storage; anything else (an old format, a hand-edited value) is an empty list. */
export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 32).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export const parseTone = (raw: string | null): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < SKIN_TONES.length ? n : 0;
};

export function loadRecent(): string[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}
export function saveRecent(recent: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* storage can be blocked: the list then lasts for this page only */
  }
}
export function loadTone(): number {
  try {
    return parseTone(window.localStorage.getItem(TONE_KEY));
  } catch {
    return 0;
  }
}
export function saveTone(tone: number): void {
  try {
    window.localStorage.setItem(TONE_KEY, String(tone));
  } catch {
    /* as above */
  }
}
