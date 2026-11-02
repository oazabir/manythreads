// Slack's emoji names, for `reactions.add` and `reactions.remove`. A script says `name: "thumbsup"`; a reaction here is stored as the emoji character (or, for
// a picture the workspace added, `:name:`). This is a short table of the names scripts really use, not the whole of Slack's set; any other name is looked up
// among the workspace's own pictures, and a name that is neither answers `invalid_name` so the script learns it at once.

const TABLE: Readonly<Record<string, string>> = {
  '+1': '👍', thumbsup: '👍', thumbsup_all: '👍', '-1': '👎', thumbsdown: '👎', white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️',
  x: '❌', negative_squared_cross_mark: '❎', no_entry: '⛔', no_entry_sign: '🚫', warning: '⚠️', exclamation: '❗', question: '❓', grey_question: '❔',
  grey_exclamation: '❕', bangbang: '‼️', interrobang: '⁉️', tada: '🎉', confetti_ball: '🎊', rocket: '🚀', eyes: '👀', eye: '👁️', fire: '🔥', sparkles: '✨',
  star: '⭐', star2: '🌟', zap: '⚡', boom: '💥', '100': '💯', heart: '❤️', blue_heart: '💙', green_heart: '💚', yellow_heart: '💛', purple_heart: '💜',
  broken_heart: '💔', sparkling_heart: '💖', raised_hands: '🙌', clap: '👏', pray: '🙏', ok_hand: '👌', wave: '👋', muscle: '💪', point_up: '☝️',
  point_right: '👉', point_left: '👈', point_down: '👇', handshake: '🤝', v: '✌️', crossed_fingers: '🤞', facepalm: '🤦', shrug: '🤷', raised_hand: '✋',
  smile: '😄', smiley: '😃', grinning: '😀', grin: '😁', laughing: '😆', joy: '😂', rofl: '🤣', slightly_smiling_face: '🙂', upside_down_face: '🙃',
  wink: '😉', blush: '😊', heart_eyes: '😍', sunglasses: '😎', thinking_face: '🤔', thinking: '🤔', neutral_face: '😐', expressionless: '😑', confused: '😕',
  disappointed: '😞', worried: '😟', cry: '😢', sob: '😭', scream: '😱', angry: '😠', rage: '😡', sweat_smile: '😅', sleeping: '😴', zzz: '💤',
  hushed: '😯', flushed: '😳', mask: '😷', nerd_face: '🤓', partying_face: '🥳', pleading_face: '🥺', hugging_face: '🤗', see_no_evil: '🙈',
  hear_no_evil: '🙉', speak_no_evil: '🙊', skull: '💀', ghost: '👻', robot_face: '🤖', poop: '💩', bug: '🐛', beetle: '🐞', snake: '🐍', turtle: '🐢',
  dog: '🐶', cat: '🐱', unicorn_face: '🦄', penguin: '🐧', whale: '🐳', octopus: '🐙', bulb: '💡', memo: '📝', pencil: '📝', pencil2: '✏️', book: '📖',
  books: '📚', bookmark: '🔖', link: '🔗', paperclip: '📎', pushpin: '📌', round_pushpin: '📍', mag: '🔍', mag_right: '🔎', lock: '🔒', unlock: '🔓',
  key: '🔑', hammer: '🔨', wrench: '🔧', gear: '⚙️', hammer_and_wrench: '🛠️', construction: '🚧', rotating_light: '🚨', bell: '🔔', no_bell: '🔕',
  loudspeaker: '📢', mega: '📣', mailbox: '📫', email: '📧', envelope: '✉️', calendar: '📆', date: '📅', clock1: '🕐', hourglass: '⌛', hourglass_flowing_sand: '⏳',
  stopwatch: '⏱️', alarm_clock: '⏰', chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', bar_chart: '📊', clipboard: '📋', package: '📦',
  gift: '🎁', trophy: '🏆', medal: '🏅', first_place_medal: '🥇', second_place_medal: '🥈', third_place_medal: '🥉', dart: '🎯', checkered_flag: '🏁',
  triangular_flag_on_post: '🚩', flags: '🎏', coffee: '☕', tea: '🍵', beer: '🍺', beers: '🍻', pizza: '🍕', cake: '🍰', cookie: '🍪', apple: '🍎',
  sunny: '☀️', cloud: '☁️', umbrella: '☔', snowflake: '❄️', rainbow: '🌈', earth_africa: '🌍', earth_americas: '🌎', earth_asia: '🌏', moneybag: '💰',
  dollar: '💵', credit_card: '💳', gem: '💎', computer: '💻', desktop_computer: '🖥️', keyboard: '⌨️', iphone: '📱', phone: '☎️', battery: '🔋',
  electric_plug: '🔌', floppy_disk: '💾', cd: '💿', camera: '📷', movie_camera: '🎥', tv: '📺', radio: '📻', microphone: '🎤', headphones: '🎧',
  arrow_up: '⬆️', arrow_down: '⬇️', arrow_left: '⬅️', arrow_right: '➡️', arrows_counterclockwise: '🔄', recycle: '♻️', repeat: '🔁', fast_forward: '⏩',
  rewind: '⏪', pause_button: '⏸️', stop_button: '⏹️', arrow_forward: '▶️', new: '🆕', ok: '🆗', cool: '🆒', free: '🆓', sos: '🆘', up: '🆙',
  red_circle: '🔴', large_blue_circle: '🔵', large_green_circle: '🟢', large_yellow_circle: '🟡', large_orange_circle: '🟠', white_circle: '⚪', black_circle: '⚫',
  green_square: '🟩', red_square: '🟥', yellow_square: '🟨', blue_square: '🟦', one: '1️⃣', two: '2️⃣', three: '3️⃣', four: '4️⃣', five: '5️⃣', six: '6️⃣',
  seven: '7️⃣', eight: '8️⃣', nine: '9️⃣', keycap_ten: '🔟', information_source: 'ℹ️', infinity: '♾️', hash: '#️⃣', pray_tone1: '🙏',
};

/** Whether a string is an emoji character itself (a script may send `name: "👍"`): short, with a pictograph and nothing that reads as a word. */
const IS_PICTURE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|\u200D|\uFE0F|\u20E3|[#*0-9])+$/u;

export type EmojiLookup = { kind: 'unicode'; emoji: string } | { kind: 'custom'; name: string } | { kind: 'unknown' };

/**
 * The reaction a Slack emoji name means. `custom` is a name that is not in the table, to be looked up among the workspace's own pictures (the caller
 * does that, because it needs the database). Skin-tone suffixes (`thumbsup::skin-tone-3`) are dropped; colons around the name are optional.
 */
export function emojiFromSlackName(raw: unknown): EmojiLookup {
  if (typeof raw !== 'string') return { kind: 'unknown' };
  const text = raw.trim();
  if (text === '' || text.length > 64) return { kind: 'unknown' };
  if (IS_PICTURE.test(text) && !/^[0-9#*]+$/.test(text)) return { kind: 'unicode', emoji: text };
  const name = text.replace(/^:+|:+$/g, '').split('::')[0]?.toLowerCase() ?? '';
  if (!/^[a-z0-9_+-]{1,32}$/.test(name)) return { kind: 'unknown' };
  const found = Object.prototype.hasOwnProperty.call(TABLE, name) ? TABLE[name] : undefined;
  return found !== undefined ? { kind: 'unicode', emoji: found } : { kind: 'custom', name };
}
