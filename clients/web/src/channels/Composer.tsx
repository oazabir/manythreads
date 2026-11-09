import { Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { CreateTaskRequest, broadcastWordsIn, customEmojiNameOf, findSlashCommand, matchSlashCommands, slashMenuContext, type CustomEmoji, type FileSummary, type VoiceMeta } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchBroadcastReach, sendTyping, uploadChannelFile } from '../api/endpoints';
import { createTask, fetchChannelBoards } from '../screens/boards/api';
import { botBoardOf, branchFor } from '../screens/boards/board';
import { Avatar } from '../components/ui';
import { ClipIcon, CloseIcon, SendIcon } from '../shell/icons';
import { ShellContext } from '../shell/context';
import { useDismiss } from '../shell/useDismiss';
import { Recorder, RecorderNotice } from './voice/Recorder';
import { useRecorder } from './voice/useRecorder';
import { recorderSupported } from './voice/support';
import { SlashHelp } from './SlashHelp';
import { RemindersDialog } from '../later/RemindersDialog';
import { refreshDirectory } from '../shell/channelFeed';
import { PollDialog } from './PollDialog';
import { formFromPrefill, pollFailureText, type PollForm } from './polls';
import { channelStore } from './store';
import { availability, isActionPlan, planSlash, taskFailureText, type ActionPlan } from './slash';
import { announceChannelChanged, slashDeps } from './slashDeps';
import { runSlashAction } from './slashRun';
import { useSlashEnv, useSlashWho } from './useSlash';
import { COMPOSER_MAX_HEIGHT, codeBlock, codeSpan, insertText, linkSelection, prefixLines, wrapSelection, type Edit, type LineKind } from './composerFormat';
import { ComposerToolbar } from './ComposerToolbar';
import { TOOL_ORDER, isMac, matchBroadcast, matchLocalCommands, parseLocalCommand, toolForKey, type LocalCommand, type ToolId, type ToolLayout } from './composerTools';
import { CustomEmojiImg } from './EmojiGlyph';
import { useCustomEmoji } from './customEmoji';
import { detectEmojiTrigger, suggestEmoji } from './emojiSuggest';
import { EmojiPicker } from './EmojiPicker';
import { fileSize } from './format';
import { MAX_UPLOAD_BYTES, TOO_LARGE, filesOf, useFilesSupport } from './files';
import { handleFor, type People } from './hooks';
import { groupCountText, matchGroups, useMentionGroups } from './mentionGroups';
import { PresenceDot } from '../presence/PresenceDot';
import { remindWhen } from '../later/times';
import { SendLaterMenu } from './SendLater';
import { needsBroadcastAgreement, scheduledErrorText, scheduledStore } from './scheduled';
import { broadcastAsk, broadcastAskFromRefusal, type BroadcastAsk } from './broadcast';
import { readDraft, useServerDraft, writeDraft } from './serverDraft';

/*
 * The shared composer (channel, thread, later DMs): markdown toolbar, Enter to send and Shift+Enter for a new line, a draft kept per
 * conversation (also kept on the server, so another device shows it), @ and # pickers, and attachments (upload with progress, paste, drag and drop, remove) when the server stores files.
 */

type Trigger = { char: '@' | '#'; query: string; start: number };

/** An `@` or `#` just before the caret that starts a word: what the picker completes. */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const m = /(^|[\s(])([@#])([\p{L}\p{N}_.-]{0,40})$/u.exec(text.slice(0, caret));
  if (!m) return null;
  const char = m[2] as '@' | '#';
  const query = m[3] ?? '';
  return { char, query, start: caret - query.length - 1 };
}

type Upload = {
  id: number;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  file?: FileSummary;
  /** A local thumbnail URL of an image, drawn while it uploads; revoked with the row. */
  preview?: string;
  abort?: AbortController;
};

/** What goes out with the text: the files already uploaded, the writer's "Send anyway" for `@channel` / `@here` in a big room, and the meta of a voice message. */
export type SendOptions = {
  attachments: FileSummary[];
  confirmBroadcast?: boolean;
  /** A voice message (P14-17): the clip is the one entry of `attachments`; the text is the stand-in line or the transcript. */
  voice?: VoiceMeta;
};

export type ComposerProps = {
  /** Where the draft is kept: one per channel or thread. */
  draftKey: string;
  placeholder: string;
  /** Names for the accessible label ("Message #dev"). */
  label: string;
  channelId: string;
  threadRootId: string | null;
  people: People;
  /** Channel names offered after `#`. */
  channelNames: readonly string[];
  /**
   * Called with the text and the options (see `SendOptions`); the caller shows the message at once and handles failure. `confirmBroadcast` is true when the
   * writer agreed that `@channel` or `@here` goes to a big room.
   */
  onSend: (body: string, options: SendOptions) => void;
  /** Offer the microphone button (a voice message). Off where a voice message makes no sense. It is also hidden for guests and where files or recording are not supported. */
  voice?: boolean;
  /** Focus the box when it appears (the thread panel). */
  autoFocus?: boolean;
  /** The Up arrow in an empty box: open the reader's last message of their own for editing (absent where there is nothing to edit). */
  onEditLast?: () => void;
  /**
   * Slash commands (`/ask`, `/task`, `/shrug`…): the team the conversation belongs to, and where a card made from here says it came from
   * ("#dev", "a thread in #dev", "a direct message"). Absent where a command makes no sense (a conversation with a bot): the text is then
   * posted as typed, `//` included.
   */
  slash?: { teamSlug: string; origin: string };
  /** Offer "Send later" beside Send (P14-05): the text is scheduled for this channel (or thread) and posted by a job at the chosen time. Text only. */
  sendLater?: boolean;
  /** A narrow box (the thread panel): the rarer formatting tools sit under "…". */
  compact?: boolean;
  /** Commands the screen answers itself (the Chat screen's `/new`, `/model`): offered in a menu while the first word is typed, run instead of sent. Not with `slash`. */
  commands?: readonly LocalCommand[];
};

/** One line of the picker: what to show, and the text that replaces `from`..`to` when it is chosen. A disabled one only explains itself. */
type PickItem = {
  key: string;
  label: string;
  hint: string;
  insert: string;
  from: number;
  to: number;
  disabled?: string;
  /** A person offered by the @ picker: their presence dot is drawn beside the name. */
  personId?: string;
  /** A role group offered by the @ picker (`@on-call`): drawn with a "Group" badge and the number of people it reaches. */
  group?: true;
  /** A bot offered by the @ picker: drawn with a "Bot" badge. */
  bot?: true;
  /** The heading this line sits under; a new heading is drawn when it changes from the line above. */
  section?: string;
  /** The picture drawn before the name (a person or a bot). */
  face?: { name: string; kind: 'person' | 'agent'; avatar: string | null; personId?: string };
  /** An emoji offered by `:`: the character, or a custom one drawn as its picture. */
  emoji?: { char: string | null; custom: CustomEmoji | null };
};

/** A phone-sized box: the toolbar is one "Aa" button (and Mention, Emoji) until it is opened. */
const PHONE_BAR = '(width <= 480px)';
const subscribePhone = (cb: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const mq = window.matchMedia(PHONE_BAR);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const phoneNow = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_BAR).matches;

type Notice = { tone: 'bad' | 'ok'; text: string; href?: string; linkText?: string };

/**
 * The canary of the persona suite (PLAN P12-04, Bundle E decision E32): a build made with `VITE_MANYTHREADS_CANARY=hide-composer` draws no composer anywhere, so
 * the suite must fail on exactly the steps that use one (tools/review/canary.sh). The value is read at build time; no production build sets it, so the bundler
 * drops this branch (clients/web/test/canary-build.test.ts proves the string is not in a normal build).
 */
const CANARY_HIDE_COMPOSER = import.meta.env.VITE_MANYTHREADS_CANARY === 'hide-composer';

export function Composer(props: ComposerProps) {
  if (CANARY_HIDE_COMPOSER) return null;
  return <ComposerBody {...props} />;
}

function ComposerBody({ draftKey, placeholder, label, channelId, threadRootId, people, channelNames, onSend, voice = true, autoFocus = false, onEditLast, slash, sendLater = false, compact = false, commands }: ComposerProps) {
  const filesOn = useFilesSupport(channelId);
  const guest = useContext(ShellContext)?.guest ?? false;
  const rec = useRecorder();
  const resetRecorder = rec.reset;
  const [canRecord] = useState(() => recorderSupported());
  const voiceOn = voice && canRecord && filesOn && !guest;
  const voiceActive = voiceOn && (rec.state.phase === 'recording' || rec.state.phase === 'preview');
  const [text, setText] = useState(() => readDraft(draftKey));
  // true while a "Send later" request is out; the ref is what the handlers read, the state is what the buttons show
  const scheduling = useRef(false);
  const [schedulingNow, setSchedulingNow] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // `/remind list`: the reminders this person set
  const [remindersOpen, setRemindersOpen] = useState(false);
  const navigate = useNavigate();
  // the poll dialog (the Poll tool, or /poll with nothing after it)
  const [pollOpen, setPollOpen] = useState(false);
  // a half-typed /poll (a question, fewer than two options) opens the form with those pieces in it
  const [pollInitial, setPollInitial] = useState<Partial<PollForm> | undefined>(undefined);
  const [slashSeen, setSlashSeen] = useState(false);
  // `@channel` / `@here` for a big room: the question the writer must answer before the message goes (P14-02)
  // `later` is set when the message is being scheduled, not sent: the agreement then goes with the schedule
  const [bcast, setBcast] = useState<{ ask: BroadcastAsk; body: string; files: FileSummary[]; later?: Date } | null>(null);
  const asking = useRef(false);
  const makingCard = useRef(false);
  const listId = useId();
  // the toolbar (ComposerToolbar.tsx) is always there; a phone shows one "Aa" button, the thread panel puts the rarer tools under "…"
  const phone = useSyncExternalStore(subscribePhone, phoneNow, () => false);
  const layout: ToolLayout = phone ? 'aa' : compact ? 'more' : 'full';
  const mac = useMemo(() => isMac(), []);
  const customEmoji = useCustomEmoji();
  const emojiButton = useRef<HTMLButtonElement>(null);
  const emojiPop = useRef<HTMLDivElement>(null);
  // a press on the Emoji button or inside the picker is "inside" for dismissing; anywhere else closes it
  const emojiInside = useMemo(
    () => ({ get current() { return { contains: (n: Node | null) => (emojiButton.current?.contains(n) ?? false) || (emojiPop.current?.contains(n) ?? false) } as unknown as HTMLElement; } }),
    [],
  );
  const area = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const selection = useRef<[number, number] | null>(null);
  const draftFor = useRef(draftKey);
  const focusBox = useCallback(() => void requestAnimationFrame(() => area.current?.focus()), []);
  const lastTyping = useRef(0);
  const typingOff = useRef(false);

  // A different conversation: its own draft, and nothing of the last one's files.
  useEffect(() => {
    if (draftFor.current === draftKey) return;
    draftFor.current = draftKey;
    resetRecorder();
    setText(readDraft(draftKey));
    setNotice(null);
    setDismissed(null);
    setUploads((list) => {
      list.forEach((u) => {
        u.abort?.abort();
        if (u.preview) URL.revokeObjectURL(u.preview);
      });
      return [];
    });
  }, [draftKey, resetRecorder]);
  useEffect(() => {
    const t = setTimeout(() => writeDraft(draftFor.current, text), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => () => writeDraft(draftFor.current, area.current?.value ?? ''), []);
  // the same draft on the server, for another device: read when the box opens, saved when typing pauses (serverDraft.ts)
  const forgetDraft = useServerDraft({ channelId, threadRootId, draftKey }, text, (t) => {
    setText(t);
    setCaret(t.length);
  });
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus, threadRootId]);
  useEffect(
    () => () =>
      uploadsRef.current.forEach((u) => {
        u.abort?.abort();
        if (u.preview) URL.revokeObjectURL(u.preview);
      }),
    [],
  );
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  });

  // grow with the text, up to COMPOSER_MAX_HEIGHT (about eighteen lines)
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    // not on screen (a hidden composer measures 0): leave it at its own one-line height
    el.style.height = el.scrollHeight > 0 ? `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px` : '';
  }, [text]);
  useLayoutEffect(() => {
    const el = area.current;
    const sel = selection.current;
    if (el && sel) {
      el.setSelectionRange(sel[0], sel[1]);
      selection.current = null;
    }
  });

  // ---- slash commands: a first word that starts with `/`, and the bot named after /ask ----------------------------
  const slashOn = slash !== undefined;
  useEffect(() => {
    if (slashOn && text.startsWith('/')) setSlashSeen(true);
  }, [slashOn, text]);
  const who = useSlashWho(slash?.teamSlug ?? null, channelId, slashOn && (slashSeen || text.startsWith('/')), people.me?.name ?? null, slashOn);
  const slashEnv = useSlashEnv(slash?.teamSlug ?? null, people);
  const slashContext = useMemo(() => (slashOn ? slashMenuContext(text, caret) : null), [slashOn, text, caret]);

  const trigger = useMemo(() => (slashContext ? null : detectTrigger(text, caret)), [slashContext, text, caret]);
  // `:` and two letters: the emoji list (not while a command or an @ or # word is being typed)
  const emojiTrigger = useMemo(() => (slashContext || trigger ? null : detectEmojiTrigger(text, caret)), [slashContext, trigger, text, caret]);
  // the commands a screen brings (the Chat screen), while the first word is still being typed
  const localMenu = useMemo(() => (slashOn || !commands || trigger || emojiTrigger ? [] : matchLocalCommands(commands, text)), [slashOn, commands, trigger, emojiTrigger, text]);
  // what Esc closed is remembered by where the word starts, so the menu stays shut until that word changes
  const anchor = slashContext ? (slashContext.stage === 'command' ? 0 : slashContext.from) : (trigger?.start ?? emojiTrigger?.start ?? (localMenu.length > 0 ? 0 : null));
  const groups = useMentionGroups(channelId, trigger?.char === '@');
  // `@channel` and `@here` are offered where they mean something: a channel or a thread, and not to a guest (for a guest they are plain words)
  const broadcastOk = slashOn && !guest;
  const items = useMemo<PickItem[]>(() => {
    if (anchor === null || dismissed === anchor) return [];
    if (slashContext?.stage === 'command') {
      return matchSlashCommands(slashContext.query).map((command) => {
        const can = availability(command, who);
        const next = text[slashContext.to] === ' ' ? '' : ' ';
        return {
          key: command.name,
          label: command.usage,
          hint: can.ok ? command.summary : can.reason,
          insert: `/${command.name}${next}`,
          from: 0,
          to: slashContext.to,
          ...(can.ok ? {} : { disabled: can.reason }),
        };
      });
    }
    if (slashContext?.stage === 'bot') {
      const q = slashContext.query.toLowerCase();
      const next = text[slashContext.to] === ' ' ? '' : ' ';
      return (who.bots ?? [])
        .filter((b) => q === '' || b.slug.toLowerCase().startsWith(q) || b.name.toLowerCase().includes(q))
        .slice(0, 6)
        .map((b) => ({ key: b.slug, label: b.name, hint: b.slug, insert: `${b.slug}${next}`, from: slashContext.from, to: slashContext.to }));
    }
    if (!trigger) {
      if (emojiTrigger) {
        return suggestEmoji(emojiTrigger.query, customEmoji.items).map((e) => ({
          key: `emoji:${e.custom ? `c:${e.custom.name}` : e.char}`,
          label: `:${e.code}:`,
          hint: '',
          // a custom emoji is written `:name:` and a space keeps the next word from running into it; a built-in one is the character itself
          insert: e.custom ? `:${e.custom.name}: ` : (e.char ?? ''),
          from: emojiTrigger.start,
          to: caret,
          emoji: { char: e.char, custom: e.custom },
        }));
      }
      return localMenu.map((c) => ({ key: c.name, label: c.usage ?? `/${c.name}`, hint: c.summary, insert: `/${c.name} `, from: 0, to: text.length }));
    }
    const q = trigger.query.toLowerCase();
    if (trigger.char === '@') {
      // everyone, then people, bots and role groups, each under its own heading
      const everyone: PickItem[] = broadcastOk
        ? matchBroadcast(q).map((o) => ({ key: `broadcast:${o.word}`, label: `@${o.word}`, hint: o.hint, insert: `@${o.word} `, from: trigger.start, to: caret, section: 'Everyone' }))
        : [];
      const persons: PickItem[] = people.list
        .filter((p) => q === '' || p.name.toLowerCase().includes(q) || handleFor(p, people.list).startsWith(q))
        .slice(0, 6)
        .map((p) => ({
          key: p.personId,
          label: p.name,
          hint: `@${handleFor(p, people.list)}`,
          insert: `@${handleFor(p, people.list)} `,
          from: trigger.start,
          to: caret,
          personId: p.personId,
          section: 'People',
          face: { name: p.name, kind: 'person' as const, avatar: p.avatar, personId: p.personId },
        }));
      // the team's bots (`@slug` wakes one that listens for mentions), after the people
      const bots: PickItem[] = people.bots
        .filter((b) => q === '' || b.slug.toLowerCase().startsWith(q) || b.name.toLowerCase().includes(q))
        .slice(0, 4)
        .map((b) => ({ key: `bot:${b.slug}`, label: b.name, hint: `@${b.slug}`, insert: `@${b.slug} `, from: trigger.start, to: caret, bot: true as const, section: 'Bots', face: { name: b.name, kind: 'agent' as const, avatar: b.avatar } }));
      // role groups after the people and bots: a person's own handle always wins, so a group is offered only when its word is not one of theirs
      const shown = new Set([...persons, ...bots, ...everyone].map((p) => p.insert.trim().toLowerCase()));
      const roles: PickItem[] = matchGroups(groups, q)
        .filter((g) => !shown.has(`@${g.handle}`))
        .map((g) => ({ key: `group:${g.handle}`, label: `@${g.handle}`, hint: groupCountText(g.memberCount), insert: `@${g.handle} `, from: trigger.start, to: caret, group: true as const, section: 'Groups' }));
      return [...everyone, ...persons, ...bots, ...roles];
    }
    return channelNames
      .filter((n) => q === '' || n.toLowerCase().includes(q))
      .slice(0, 6)
      .map((n) => ({ key: n, label: `#${n}`, hint: '', insert: `#${n} `, from: trigger.start, to: caret, section: 'Channels' }));
  }, [anchor, slashContext, trigger, emojiTrigger, localMenu, customEmoji.items, dismissed, people, groups, channelNames, who, text, caret, broadcastOk]);
  const open = items.length > 0;
  const active = Math.min(pick, Math.max(0, items.length - 1));
  // the menu is a scrolling list when it is long (the commands are many): keep the highlighted row in view
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);
  const menuLabel =
    slashContext?.stage === 'command' || localMenu.length > 0 ? 'Commands' : slashContext?.stage === 'bot' ? 'Bots' : emojiTrigger ? 'Emoji' : trigger?.char === '@' ? 'People' : 'Channels';

  const edit = useCallback((next: string, from: number, to = from): void => {
    setText(next);
    setCaret(to);
    selection.current = [from, to];
    area.current?.focus();
  }, []);

  /** Runs one of the pure text edits on the box's current text and selection, and puts the caret where it says. */
  const apply = (fn: (t: string, a: number, b: number) => Edit): void => {
    const el = area.current;
    if (!el) return;
    const r = fn(text, el.selectionStart, el.selectionEnd);
    edit(r.text, r.from, r.to);
  };
  const wrap = (before: string, after: string, fallback: string): void => apply((t, a, b) => wrapSelection(t, a, b, before, after, fallback));
  const lines = (kind: LineKind): void => apply((t, a, b) => prefixLines(t, a, b, kind));
  const block = (lang: string): void => apply((t, a, b) => codeBlock(t, a, b, lang));
  const putEmoji = (char: string): void => {
    setEmojiOpen(false);
    // a custom emoji is written `:name:`; a space after it keeps the next word from running into it
    apply((t, a, b) => insertText(t, a, b, customEmojiNameOf(char) ? `${char} ` : char));
  };
  const mark = (char: '@' | '#'): void => {
    const el = area.current;
    if (!el) return;
    const a = el.selectionStart;
    const lead = a > 0 && !/\s/.test(text[a - 1] ?? ' ') ? ' ' : '';
    edit(`${text.slice(0, a)}${lead}${char}${text.slice(el.selectionEnd)}`, a + lead.length + 1);
  };
  const choose = (i: number): void => {
    const it = items[i];
    if (!it) return;
    if (it.disabled) {
      // a command this person cannot use: the menu says why and leaves the text alone
      setNotice({ tone: 'bad', text: it.disabled });
      return;
    }
    const next = `${text.slice(0, it.from)}${it.insert}${text.slice(it.to)}`;
    edit(next, it.from + it.insert.length);
    setPick(0);
  };

  /** One toolbar tool (a button, or its shortcut) acting on the text and selection. */
  const runTool = (id: ToolId): void => {
    switch (id) {
      case 'bold': return wrap('**', '**', 'bold');
      case 'italic': return wrap('*', '*', 'italic');
      case 'strike': return wrap('~~', '~~', 'strike');
      case 'code': return apply((t, a, b) => codeSpan(t, a, b));
      case 'codeblock': return block('');
      case 'quote': return lines('quote');
      case 'bullet': return lines('bullet');
      case 'number': return lines('number');
      case 'link': return apply(linkSelection);
      case 'mention': return mark('@');
      case 'channel': return mark('#');
      case 'emoji': return setEmojiOpen((o) => !o);
      case 'poll':
        setPollInitial(undefined);
        setPollOpen(true);
    }
  };
  const tools = useMemo<ToolId[]>(() => TOOL_ORDER.filter((t) => t !== 'poll' || slashOn), [slashOn]);

  // ---- attachments --------------------------------------------------------------------------------------------
  const addFiles = (files: File[]): void => {
    if (!filesOn) return;
    for (const file of files) {
      const id = nextId.current++;
      // an image shows its own thumbnail from the moment it is added, from the local bytes: no wait for the upload
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploads((l) => [...l, { id, name: file.name, size: file.size, progress: 0, status: 'error', error: TOO_LARGE, preview }]);
        continue;
      }
      const abort = new AbortController();
      setUploads((l) => [...l, { id, name: file.name, size: file.size, progress: 0, status: 'uploading', preview, abort }]);
      uploadChannelFile(channelId, file, (f) => setUploads((l) => l.map((u) => (u.id === id ? { ...u, progress: f } : u))), abort.signal).then(
        (meta) => setUploads((l) => l.map((u) => (u.id === id ? { ...u, status: 'done', progress: 1, name: meta.name, file: { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime } } : u))),
        (e: unknown) => {
          if (abort.signal.aborted) return;
          const tooBig = isApiError(e) && e.status === 413;
          setUploads((l) => l.map((u) => (u.id === id ? { ...u, status: 'error', error: tooBig ? TOO_LARGE : e instanceof Error ? e.message : 'Upload failed' } : u)));
        },
      );
    }
  };
  const removeUpload = (id: number): void =>
    setUploads((l) => {
      const gone = l.find((u) => u.id === id);
      gone?.abort?.abort();
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return l.filter((u) => u.id !== id);
    });

  const uploading = uploads.some((u) => u.status === 'uploading');
  const ready = uploads.flatMap((u) => (u.status === 'done' && u.file ? [u.file] : []));
  const canSend = !uploading && (text.trim() !== '' || ready.length > 0);

  /** Empties the box after a message or a command went out. */
  const clearBox = (): void => {
    uploads.forEach((u) => {
      if (u.preview) URL.revokeObjectURL(u.preview);
    });
    forgetDraft();
    setText('');
    setUploads([]);
    setCaret(0);
    setDismissed(null);
    writeDraft(draftFor.current, '');
  };

  /** `/task`: a card on the channel's own board when it has one, else the team's default board; the box is emptied only once the card exists. */
  const makeCard = async (title: string): Promise<void> => {
    if (!slash || makingCard.current) return;
    makingCard.current = true;
    // the box may change under the request: another conversation opened, or more typing. Only the text that made the card is cleared.
    const key = draftFor.current;
    const sent = area.current?.value ?? '';
    const here = (): boolean => draftFor.current === key && area.current !== null;
    try {
      const boards = await fetchChannelBoards(channelId).catch(() => null);
      const boardId = boards ? botBoardOf(boards.items)?.id : undefined;
      const built = CreateTaskRequest.safeParse({
        title,
        description: `Created from ${slash.origin} with /task.`,
        // a chat card is not a code change: "other" has no branch to test before it can be done
        kind: 'other',
        branch: branchFor(title),
        ...(boardId ? { boardId } : {}),
      });
      if (!built.success) {
        if (here()) setNotice({ tone: 'bad', text: built.error.issues[0]?.message ?? 'The card is not complete.' });
        return;
      }
      const res = await createTask(slash.teamSlug, built.data);
      if (!here()) {
        // another conversation (or none) is showing: the old draft goes, the new box and its notice are not touched
        writeDraft(key, '');
        return;
      }
      // typing added while the card was made stays; only the command that made the card is cleared
      if ((area.current?.value ?? '') === sent) clearBox();
      const href = `/t/${slash.teamSlug}/boards?${res.task.boardId ? `board=${res.task.boardId}&` : ''}card=${res.task.id}`;
      setNotice({ tone: 'ok', text: `Card created: “${res.task.title}”.`, href, linkText: 'Open the card' });
    } catch (err) {
      if (here()) setNotice({ tone: 'bad', text: isApiError(err) ? taskFailureText(err.status, err.message) : taskFailureText(undefined, undefined) });
    } finally {
      makingCard.current = false;
    }
  };

  /** `/poll "Question" "A" "B"`: a single-choice, public poll with no closing time, asked at once. The box is emptied only once the poll exists. */
  const askPoll = async (question: string, options: string[]): Promise<void> => {
    if (makingCard.current) return;
    makingCard.current = true;
    const key = draftFor.current;
    const sent = area.current?.value ?? '';
    const here = (): boolean => draftFor.current === key && area.current !== null;
    try {
      await channelStore.createPoll(channelId, { question, options, multiple: false, anonymous: false, ...(threadRootId ? { threadRootId } : {}) });
      if (!here()) {
        writeDraft(key, '');
        return;
      }
      if ((area.current?.value ?? '') === sent) clearBox();
    } catch (err) {
      if (here()) setNotice({ tone: 'bad', text: isApiError(err) ? pollFailureText(err.status, err.message) : pollFailureText(undefined, undefined) });
    } finally {
      makingCard.current = false;
    }
  };

  /**
   * `/remind`, `/status`, `/dnd`, `/away`, `/invite`, `/leave`, `/mute`, `/topic`: each asks the route of the plugin that owns the thing (slashRun.ts).
   * The box is emptied only once it worked; when it did not, the text stays and a sentence says why.
   */
  const runAction = async (plan: ActionPlan): Promise<void> => {
    if (!slash || makingCard.current) return;
    makingCard.current = true;
    const key = draftFor.current;
    const sent = area.current?.value ?? '';
    const here = (): boolean => draftFor.current === key && area.current !== null;
    try {
      const name = slashEnv().channels.find((c) => c.id === channelId)?.name;
      const result = await runSlashAction(plan, { channelId, channelLabel: name ? `#${name}` : 'this conversation', whenText: (iso) => remindWhen(iso) }, slashDeps);
      if (result.tone === 'ok') {
        if (plan.do === 'topic' || plan.do === 'leave') announceChannelChanged(channelId);
        if (result.left) {
          void refreshDirectory(slash.teamSlug);
          navigate(`/t/${slash.teamSlug}`);
        }
      }
      if (!here()) {
        if (result.tone === 'ok') writeDraft(key, '');
        return;
      }
      if (result.tone === 'ok' && (area.current?.value ?? '') === sent) clearBox();
      setNotice({ tone: result.tone, text: result.text });
    } finally {
      makingCard.current = false;
    }
  };

  const send = (): void => {
    if (!canSend || makingCard.current || scheduling.current || asking.current || bcast) return;
    // a message of only files has no text of its own: the server wants one character, so it carries the file names
    let body = text.trim() !== '' ? text.trim() : ready.map((f) => f.name).join(', ');
    // a command the screen answers itself (/new, /model): it runs, and nothing is sent
    const own = commands && !slash && ready.length === 0 ? parseLocalCommand(commands, text) : null;
    if (own) {
      const said = own.command.run(own.arg);
      clearBox();
      setNotice(typeof said === 'string' && said !== '' ? { tone: 'ok', text: said } : null);
      return;
    }
    if (slash && text.trim() !== '') {
      const plan = planSlash(text, who, ready.length > 0, slashEnv());
      if (plan.do === 'say') {
        setNotice({ tone: 'bad', text: plan.message });
        return;
      }
      if (plan.do === 'help') {
        clearBox();
        setNotice(null);
        setHelpOpen(true);
        return;
      }
      if (plan.do === 'poll') {
        setNotice(null);
        if (plan.question === null) {
          clearBox();
          setPollInitial(plan.prefill ? formFromPrefill(plan.prefill) : undefined);
          setPollOpen(true);
        } else void askPoll(plan.question, plan.options);
        return;
      }
      if (plan.do === 'task') {
        setNotice(null);
        void makeCard(plan.title);
        return;
      }
      if (plan.do === 'remind-list') {
        clearBox();
        setNotice(null);
        setRemindersOpen(true);
        return;
      }
      if (isActionPlan(plan)) {
        setNotice(null);
        void runAction(plan);
        return;
      }
      body = plan.body;
    }
    setNotice(null);
    if (broadcastWordsIn(body).length > 0) {
      void askBroadcast(body, ready);
      return;
    }
    onSend(body, { attachments: ready });
    clearBox();
  };

  /**
   * The message uses `@channel` or `@here`: ask the server how many people that is here. Few: it goes at once. A big room: the writer is asked first (the
   * message stays in the box until they agree). If the server cannot say, the message is sent and the server decides.
   */
  const askBroadcast = async (body: string, files: FileSummary[]): Promise<void> => {
    if (asking.current) return;
    asking.current = true;
    const key = draftFor.current;
    const sent = area.current?.value ?? '';
    try {
      let ask: BroadcastAsk | null = null;
      try {
        ask = broadcastAsk(body, await fetchBroadcastReach(channelId));
      } catch {
        ask = null;
      }
      // the box changed while the answer was on its way: the person is writing something else now
      if (draftFor.current !== key || (area.current?.value ?? '') !== sent) return;
      if (ask) {
        setBcast({ ask, body, files });
        return;
      }
      onSend(body, { attachments: files });
      clearBox();
    } finally {
      asking.current = false;
    }
  };
  const confirmBroadcast = async (): Promise<void> => {
    if (!bcast || asking.current) return;
    const b = bcast;
    // the count on screen may be old (the room fills up while the question is read): count again, and if it moved, show the new number instead of sending
    asking.current = true;
    try {
      let now: BroadcastAsk | null = null;
      try {
        now = broadcastAsk(b.body, await fetchBroadcastReach(channelId));
      } catch {
        now = null; // cannot count: the server holds the rule and asks again if it must
      }
      if (now && b.ask.people !== null && now.people !== b.ask.people) {
        setBcast({ ...b, ask: now });
        return;
      }
    } finally {
      asking.current = false;
    }
    setBcast(null);
    if (b.later) {
      void scheduleFor(b.later, true);
      return;
    }
    onSend(b.body, { attachments: b.files, confirmBroadcast: true });
    clearBox();
  };
  const cancelBroadcast = (): void => {
    setBcast(null);
    area.current?.focus();
  };

  /** "Send later": the box's text is scheduled for `at` instead of posted now, and the box is emptied once the server has it. */
  const scheduleFor = async (at: Date, confirmed = false): Promise<void> => {
    if (scheduling.current) return;
    if (uploading || ready.length > 0 || uploads.length > 0) {
      setNotice({ tone: 'bad', text: 'A scheduled message can only hold text for now. Remove the attached files, or send it now.' });
      return;
    }
    let body = text.trim();
    if (body === '') return;
    if (slash) {
      const plan = planSlash(text, who, false, slashEnv());
      if (plan.do === 'say') {
        setNotice({ tone: 'bad', text: plan.message });
        return;
      }
      if (plan.do !== 'post') {
        setNotice({ tone: 'bad', text: 'Commands run at once, so they cannot be scheduled. Send it now, or start the message with two slashes to post it as text.' });
        return;
      }
      body = plan.body;
    }
    // the box may change while the request runs: only the text that was scheduled is cleared
    const key = draftFor.current;
    const sent = area.current?.value ?? '';
    // while the request runs neither Send nor Send later can fire again (the box still holds the text until the server has it)
    scheduling.current = true;
    setSchedulingNow(true);
    try {
      // `@channel` / `@here` for a big room is agreed now: nobody can be asked when the job posts it later
      if (!confirmed && broadcastWordsIn(body).length > 0) {
        let ask: BroadcastAsk | null = null;
        try {
          ask = broadcastAsk(body, await fetchBroadcastReach(channelId));
        } catch {
          ask = null; // cannot count: the server decides (409 below)
        }
        if (draftFor.current !== key || (area.current?.value ?? '') !== sent) return;
        if (ask) {
          setBcast({ ask, body, files: [], later: at });
          return;
        }
      }
      await scheduledStore.schedule(channelId, body, at, threadRootId, confirmed);
      if (draftFor.current !== key) {
        writeDraft(key, '');
        return;
      }
      if ((area.current?.value ?? '') === sent) clearBox();
      setNotice({ tone: 'ok', text: `Scheduled for ${remindWhen(at.toISOString())}.` });
    } catch (err) {
      if (draftFor.current === key && needsBroadcastAgreement(err) && isApiError(err)) {
        // the room has more people than the page counted: ask with the server's number
        setBcast({ ask: broadcastAskFromRefusal(body, err.message), body, files: [], later: at });
      } else if (draftFor.current === key) setNotice({ tone: 'bad', text: scheduledErrorText(err) });
    } finally {
      scheduling.current = false;
      setSchedulingNow(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      // a word typed in full leaves nothing to pick: "/help" and Enter runs it, "/ask coder" and Enter says what is missing (a command that
      // needs words is still completed first, so "/task" and Enter only fills in "/task ")
      const picked = items[active];
      const atEnd = caret === text.length;
      const complete =
        e.key === 'Enter' &&
        picked !== undefined &&
        !picked.disabled &&
        ((slashContext?.stage === 'command' && text.trim() === `/${picked.key}` && findSlashCommand(picked.key)?.args !== 'required') ||
          (slashContext?.stage === 'bot' && atEnd && slashContext.query.toLowerCase() === picked.key.toLowerCase()) ||
          (localMenu.length > 0 && text.trim() === `/${picked.key}`));
      if ((e.key === 'Enter' || e.key === 'Tab') && !complete) {
        e.preventDefault();
        choose(active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(anchor);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      send();
    } else if (toolForKey(e) !== null) {
      // Ctrl or Cmd with B, I or K, and Ctrl+Shift+X
      e.preventDefault();
      runTool(toolForKey(e) as ToolId);
    } else if (e.key === 'ArrowUp' && onEditLast && text === '' && uploads.length === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onEditLast();
    }
  };

  // ---- the emoji picker: a press on its button or inside it is "inside" ---------------------------------------------------
  useDismiss(emojiOpen, () => {
    setEmojiOpen(false);
    area.current?.focus();
  }, emojiInside);

  const onChange = (value: string, at: number): void => {
    setText(value);
    setCaret(at);
    setPick(0);
    setNotice(null);
    setBcast(null);
    if (!value.startsWith('/')) setDismissed((d) => (d === 0 ? null : d));
    const now = Date.now();
    if (value.trim() !== '' && !typingOff.current && now - lastTyping.current > 3_000) {
      lastTyping.current = now;
      // best effort: a server that does not know typing (404) is not asked again
      sendTyping(channelId, threadRootId).catch((err: unknown) => {
        if (isApiError(err) && err.status === 404) typingOff.current = true;
      });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesOf(e.clipboardData.files);
    if (files.length > 0 && filesOn) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: DragEvent): void => {
    setDrag(false);
    const files = filesOf(e.dataTransfer.files);
    if (files.length > 0 && filesOn) {
      e.preventDefault();
      addFiles(files);
    }
  };

  return (
    <div
      ref={root}
      className={`composer ${drag ? 'dragging' : ''}`}
      data-testid="composer"
      data-landmark={threadRootId ? 'reply-composer' : 'composer'}
      onDragOver={(e) => {
        if (filesOn && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <div className="cbox">
        <ComposerToolbar layout={layout} tools={tools} mac={mac} onRun={runTool} onCodeBlock={block} emojiOpen={emojiOpen} emojiRef={emojiButton} />
        {emojiOpen ? (
          <div ref={emojiPop} className="emp-pop">
            <EmojiPicker onPick={putEmoji} onClose={() => { setEmojiOpen(false); area.current?.focus(); }} />
          </div>
        ) : null}
        {uploads.length > 0 ? (
          <ul className="cfiles" aria-label="Attachments">
            {uploads.map((u) => (
              <li key={u.id} className={`cfile ${u.preview ? 'image' : ''} ${u.status}`} data-testid="upload" data-status={u.status}>
                {u.preview ? <img src={u.preview} alt="" className="cfile-preview" /> : null}
                <span className="cfile-name">{u.name}</span>
                <span className="cfile-size">{fileSize(u.size)}</span>
                {u.status === 'uploading' ? (
                  <span className="cfile-bar" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}>
                    <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </span>
                ) : null}
                {u.status === 'uploading' ? <span className="cfile-pct" data-vt-mask>{`${Math.round(u.progress * 100)}%`}</span> : null}
                {u.status === 'error' ? <span className="cfile-error" role="alert">{u.error}</span> : null}
                <button type="button" className="icon-btn" aria-label={`Remove ${u.name}`} onClick={() => removeUpload(u.id)}><CloseIcon /></button>
              </li>
            ))}
          </ul>
        ) : null}
        {voiceOn ? <RecorderNotice rec={rec} /> : null}
        {notice ? (
          <p className={`cnotice ${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="slash-notice">
            <span>{notice.text}</span>
            {notice.href ? <Link className="cnotice-link" to={notice.href} data-testid="slash-notice-link">{notice.linkText ?? 'Open'}</Link> : null}
          </p>
        ) : null}
        {bcast ? (
          <div
            className="cconfirm"
            role="alert"
            data-testid="broadcast-confirm"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelBroadcast();
              }
            }}
          >
            <span>{bcast.ask.text}</span>
            <button type="button" className="btn primary s" onClick={() => void confirmBroadcast()} autoFocus>Send anyway</button>
            <button type="button" className="btn s" onClick={cancelBroadcast}>Cancel</button>
          </div>
        ) : null}
        <div className={`cinput ${voiceActive ? 'vr-on' : ''}`}>
          {open ? (
            <ul className={`picker ${slashContext ? 'slash' : ''}`} id={listId} role="listbox" aria-label={menuLabel} data-testid={slashContext ? 'slash-menu' : undefined}>
              {items.map((it, i) => (
                <Fragment key={it.key}>
                  {it.section && it.section !== items[i - 1]?.section ? <li role="presentation" className="pk-head" data-testid="picker-heading">{it.section}</li> : null}
                  <li
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={it.disabled ? true : undefined}
                    className={`${i === active ? 'on' : ''} ${it.disabled ? 'off' : ''} ${it.group ? 'pk-group' : ''}`}
                    data-group={it.group ? it.key.slice(6) : undefined}
                    data-command={slashContext?.stage === 'command' ? it.key : undefined}
                    data-emoji={it.emoji ? (it.emoji.custom ? `:${it.emoji.custom.name}:` : it.emoji.char) : undefined}
                    onMouseDown={(e) => { e.preventDefault(); choose(i); }}
                  >
                    {it.face ? <Avatar name={it.face.name} kind={it.face.kind} avatar={it.face.avatar} personId={it.face.personId} /> : null}
                    {it.emoji ? <span className="pk-emoji" aria-hidden="true">{it.emoji.custom ? <CustomEmojiImg id={it.emoji.custom.id} name={it.emoji.custom.name} /> : it.emoji.char}</span> : null}
                    <span className="pk-name">{it.label}</span>
                    {it.group ? <span className="pk-badge">Group</span> : null}
                    {it.bot ? <span className="pk-badge bot">Bot</span> : null}
                    {it.personId ? <PresenceDot personId={it.personId} status /> : null}
                    {it.hint ? <small className="pk-hint">{it.hint}</small> : null}
                  </li>
                </Fragment>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${active}` : undefined}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            hidden={voiceActive}
          />
          {filesOn ? (
            <>
              <input ref={fileInput} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { addFiles(filesOf(e.target.files)); e.target.value = ''; }} />
              <button type="button" className="icon-btn clip" aria-label="Attach a file" title="Attach a file" hidden={voiceActive} onClick={() => fileInput.current?.click()}><ClipIcon /></button>
            </>
          ) : null}
          {voiceOn ? <Recorder rec={rec} channelId={channelId} showMic={text === '' && uploads.length === 0} onSend={onSend} returnFocus={focusBox} /> : null}
          <span className="sch-split" hidden={voiceActive}>
            <button type="button" className={`btn send ${canSend ? 'primary ready' : ''}`} aria-label="Send" title="Send (Enter)" disabled={!canSend || schedulingNow} onClick={send} data-testid="send"><SendIcon /></button>
            {sendLater ? <SendLaterMenu disabled={text.trim() === '' || schedulingNow} onPick={(at) => void scheduleFor(at)} /> : null}
          </span>
        </div>
      </div>
      {pollOpen ? <PollDialog channelId={channelId} threadRootId={threadRootId} {...(pollInitial ? { initial: pollInitial } : {})} onClose={() => { setPollOpen(false); area.current?.focus(); }} onDone={() => { setPollOpen(false); area.current?.focus(); }} /> : null}
      {helpOpen ? <SlashHelp who={who} onClose={() => { setHelpOpen(false); area.current?.focus(); }} /> : null}
      {remindersOpen ? <RemindersDialog onClose={() => { setRemindersOpen(false); area.current?.focus(); }} /> : null}
    </div>
  );
}
